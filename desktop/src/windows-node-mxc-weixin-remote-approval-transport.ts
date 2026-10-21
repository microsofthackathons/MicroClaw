import net from "node:net";
import { randomUUID } from "node:crypto";

import {
  WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT,
  type WeixinRemoteApprovalSource,
} from "./windows-node-mxc-weixin-remote-approval";

const MAX_FRAME_BYTES = 64 * 1024;
const DELIVERY_TIMEOUT_MS = 10_000;

export interface WeixinRemoteApprovalInboundEnvelope extends WeixinRemoteApprovalSource {
  text: string;
  ambiguous: boolean;
  sourcePhase: "candidate" | "start" | "complete";
}

interface RegisteredClient {
  accountId: string;
  socket: net.Socket;
  pendingDeliveries: Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
      delivered?: () => void;
    }
  >;
}

type ClientFrame =
  | {
      contract: typeof WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT;
      type: "register";
      token: string;
      accountId: string;
    }
  | {
      contract: typeof WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT;
      type: "inbound";
      requestId: string;
      source: WeixinRemoteApprovalInboundEnvelope;
    }
  | {
      contract: typeof WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT;
      type: "delivery-result";
      deliveryId: string;
      ok: boolean;
      error?: string;
    };

export class WindowsNodeMxcWeixinRemoteApprovalServer {
  private server: net.Server | null = null;
  private readonly clients = new Map<string, RegisteredClient>();

  constructor(
    private readonly pipeName: string,
    private readonly token: string,
    private readonly onInbound: (
      source: WeixinRemoteApprovalInboundEnvelope,
    ) => Promise<{ consumed: boolean; acknowledgement?: string; approvalActive?: boolean }>,
    private readonly onDisconnect?: (accountId: string) => void,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.pipeName);
    });
  }

  isRegistered(accountId: string): boolean {
    const client = this.clients.get(accountId.trim().toLowerCase());
    return Boolean(client && !client.socket.destroyed);
  }

  async deliver(params: {
    accountId: string;
    to: string;
    text: string;
    approval?: { challengeId: string; expiresAtUnixMs: number };
    terminalChallengeId?: string;
    onDelivered?: () => void;
    timeoutMs?: number;
  }): Promise<void> {
    const timeoutMs = params.timeoutMs ?? DELIVERY_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DELIVERY_TIMEOUT_MS) {
      throw new Error("Invalid bounded WeChat delivery timeout");
    }
    const client = this.clients.get(params.accountId.trim().toLowerCase());
    if (!client || client.socket.destroyed) {
      throw new Error("The WeChat remote approval transport is unavailable");
    }
    const deliveryId = randomUUID();
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.pendingDeliveries.delete(deliveryId);
        reject(new Error("The WeChat remote approval message timed out"));
      }, timeoutMs);
      client.pendingDeliveries.set(deliveryId, {
        resolve,
        reject,
        timer,
        delivered: params.onDelivered,
      });
    });
    this.write(client.socket, {
      contract: WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT,
      type: "deliver",
      deliveryId,
      to: params.to,
      text: params.text,
      ...(params.approval ? { approval: params.approval } : {}),
      ...(params.terminalChallengeId ? { terminalChallengeId: params.terminalChallengeId } : {}),
    });
    await promise;
  }

  close(): void {
    for (const client of this.clients.values()) {
      for (const pending of client.pendingDeliveries.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("The WeChat remote approval transport was closed"));
      }
      client.pendingDeliveries.clear();
      client.socket.destroy();
      this.onDisconnect?.(client.accountId);
    }
    this.clients.clear();
    this.server?.close();
    this.server = null;
  }

  private accept(socket: net.Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    let registered: RegisteredClient | null = null;
    let destroyed = false;
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      if (registered && this.clients.get(registered.accountId) === registered) {
        this.clients.delete(registered.accountId);
        this.onDisconnect?.(registered.accountId);
      }
      if (registered) {
        for (const pending of registered.pendingDeliveries.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("The WeChat remote approval transport disconnected"));
        }
        registered.pendingDeliveries.clear();
      }
      socket.destroy();
    };
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
        destroy();
        return;
      }
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let frame: ClientFrame;
        try {
          frame = JSON.parse(line) as ClientFrame;
        } catch {
          destroy();
          return;
        }
        if (frame.contract !== WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT) {
          destroy();
          return;
        }
        if (!registered) {
          if (frame.type !== "register" || frame.token !== this.token || !frame.accountId.trim()) {
            destroy();
            return;
          }
          const accountId = frame.accountId.trim().toLowerCase();
          this.clients.get(accountId)?.socket.destroy();
          registered = { accountId, socket, pendingDeliveries: new Map() };
          this.clients.set(accountId, registered);
          this.write(socket, {
            contract: WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT,
            type: "registered",
          });
          continue;
        }
        if (frame.type === "delivery-result") {
          const pending = registered.pendingDeliveries.get(frame.deliveryId);
          if (!pending) continue;
          registered.pendingDeliveries.delete(frame.deliveryId);
          clearTimeout(pending.timer);
          if (frame.ok) {
            pending.delivered?.();
            pending.resolve();
          } else pending.reject(new Error(frame.error || "WeChat remote approval delivery failed"));
          continue;
        }
        if (frame.type !== "inbound" || !frame.requestId || !frame.source) {
          destroy();
          return;
        }
        if (!isInboundEnvelope(frame.source)) {
          destroy();
          return;
        }
        if (frame.source.accountId.trim().toLowerCase() !== registered.accountId) {
          destroy();
          return;
        }
        void this.onInbound(frame.source)
          .then((result) => {
            this.write(socket, {
              contract: WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT,
              type: "inbound-result",
              requestId: frame.requestId,
              ...result,
            });
          })
          .catch(() => {
            this.write(socket, {
              contract: WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT,
              type: "inbound-result",
              requestId: frame.requestId,
              consumed: true,
              acknowledgement: "MicroClaw Security Approval: invalid or unavailable.",
            });
          });
      }
    });
    socket.on("close", destroy);
    socket.on("error", destroy);
  }

  private write(socket: net.Socket, frame: object): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
  }
}

function isInboundEnvelope(value: unknown): value is WeixinRemoteApprovalInboundEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return (
    typeof source.accountId === "string" &&
    typeof source.senderId === "string" &&
    typeof source.conversationId === "string" &&
    typeof source.messageId === "string" &&
    typeof source.cursor === "number" &&
    Number.isSafeInteger(source.cursor) &&
    typeof source.agentId === "string" &&
    typeof source.sessionKey === "string" &&
    typeof source.direct === "boolean" &&
    typeof source.forwarded === "boolean" &&
    typeof source.quoted === "boolean" &&
    typeof source.receivedAtUnixMs === "number" &&
    Number.isSafeInteger(source.receivedAtUnixMs) &&
    (source.sentAtUnixMs === undefined ||
      (typeof source.sentAtUnixMs === "number" &&
        Number.isSafeInteger(source.sentAtUnixMs) &&
        source.sentAtUnixMs >= 0)) &&
    typeof source.text === "string" &&
    typeof source.ambiguous === "boolean" &&
    (source.sourcePhase === "candidate" ||
      source.sourcePhase === "start" ||
      source.sourcePhase === "complete")
  );
}
