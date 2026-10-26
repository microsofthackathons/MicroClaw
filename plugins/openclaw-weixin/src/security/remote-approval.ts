import net from "node:net";
import { randomUUID } from "node:crypto";

import type { WeixinMessage } from "../api/types.js";
import { MessageItemType, MessageType } from "../api/types.js";
import { getContextToken } from "../messaging/inbound.js";
import { sendMessageWeixin } from "../messaging/send.js";

const CONTRACT = "microclaw.windows-weixin-remote-approval.v1";
const MAX_FRAME_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const CHALLENGE_CODE = "[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}";
const EXACT_CANDIDATE_PATTERN = new RegExp(`^[123] ${CHALLENGE_CODE}$`, "i");
const EMBEDDED_CANDIDATE_PATTERN = /[123] [A-Z0-9]{8}/i;
const MALFORMED_CANDIDATE_PATTERN = new RegExp(
  "^[123](?:\\s+|[:-])?[A-Z0-9]{6,12}$",
  "i",
);

interface InboundSource {
  accountId: string;
  senderId: string;
  conversationId: string;
  messageId: string;
  cursor: number;
  agentId: string;
  sessionKey: string;
  direct: boolean;
  forwarded: boolean;
  quoted: boolean;
  receivedAtUnixMs: number;
  text: string;
  ambiguous: boolean;
}

interface RemoteApprovalTransportOptions {
  accountId: string;
  baseUrl: string;
  token?: string;
  error?: (message: string) => void;
}

export class WeixinRemoteApprovalTransport {
  private socket: net.Socket | null = null;
  private disposed = false;
  private buffer = "";
  private readonly pending = new Map<
    string,
    {
      resolve: (value: { consumed: boolean; acknowledgement?: string }) => void;
      timer: NodeJS.Timeout;
      consumeOnDisconnect: boolean;
    }
  >();

  constructor(private readonly options: RemoteApprovalTransportOptions) {}

  get enabled(): boolean {
    return Boolean(
      !this.disposed &&
      process.env.MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_PIPE &&
        process.env.MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_TOKEN,
    );
  }

  async start(): Promise<void> {
    if (!this.enabled || this.socket) return;
    const pipe = process.env.MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_PIPE!;
    const token = process.env.MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_TOKEN!;
    const socket = net.createConnection(pipe);
    socket.setEncoding("utf8");
    this.socket = socket;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("close", () => this.disconnect());
    socket.on("error", () => this.disconnect());
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.disconnect();
          reject(new Error("Remote approval registration timed out"));
        },
        5000,
      );
      const onRegistered = (frame: Record<string, unknown>) => {
        if (frame.type !== "registered") return;
        clearTimeout(timer);
        this.registeredListener = null;
        resolve();
      };
      this.registeredListener = onRegistered;
      socket.once("connect", () => {
        this.write({
          contract: CONTRACT,
          type: "register",
          token,
          accountId: this.options.accountId,
        });
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async intercept(params: {
    message: WeixinMessage;
    agentId: string;
    sessionKey: string;
    sourcePhase: "candidate" | "start" | "complete";
  }): Promise<boolean> {
    if (!this.enabled) return false;
    const candidate = classifyWeixinRemoteApprovalCandidate(params.message);
    if (params.sourcePhase === "candidate" && !candidate.candidateLike) return false;
    const reservedCandidate = params.sourcePhase === "candidate" && candidate.candidateLike;
    if (!this.socket) {
      try {
        await this.start();
      } catch {
        return reservedCandidate;
      }
    }
    const source = normalizeInboundSource(
      params.message,
      this.options.accountId,
      params.agentId,
      params.sessionKey,
    );
    if (!source) return reservedCandidate;
    const requestId = randomUUID();
    const result = await new Promise<{ consumed: boolean; acknowledgement?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ consumed: reservedCandidate });
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, timer, consumeOnDisconnect: reservedCandidate });
      this.write({
        contract: CONTRACT,
        type: "inbound",
        requestId,
        source: {
          ...source,
          text: params.sourcePhase === "candidate" ? candidate.text : source.text,
          ambiguous: params.sourcePhase === "candidate" && candidate.ambiguous,
          sourcePhase: params.sourcePhase,
        },
      });
    });
    if (result.acknowledgement) {
      try {
        await this.sendSystemMessage(source.senderId, result.acknowledgement);
      } catch (error) {
        this.options.error?.(`weixin remote approval acknowledgement failed: ${String(error)}`);
      }
    }
    return result.consumed;
  }

  close(): void {
    this.disposed = true;
    this.disconnect();
  }

  private disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) socket.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ consumed: pending.consumeOnDisconnect });
    }
    this.pending.clear();
    this.buffer = "";
    this.registeredListener = null;
  }

  private registeredListener: ((frame: Record<string, unknown>) => void) | null = null;

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_FRAME_BYTES) {
      this.close();
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.close();
        return;
      }
      if (frame.contract !== CONTRACT) {
        this.close();
        return;
      }
      this.registeredListener?.(frame);
      if (frame.type === "inbound-result" && typeof frame.requestId === "string") {
        const pending = this.pending.get(frame.requestId);
        if (!pending) continue;
        this.pending.delete(frame.requestId);
        clearTimeout(pending.timer);
        pending.resolve({
          consumed: frame.consumed === true,
          acknowledgement:
            typeof frame.acknowledgement === "string" ? frame.acknowledgement : undefined,
        });
        continue;
      }
      if (
        frame.type === "deliver" &&
        typeof frame.deliveryId === "string" &&
        typeof frame.to === "string" &&
        typeof frame.text === "string"
      ) {
        void this.sendSystemMessage(frame.to, frame.text)
          .then(() =>
            this.write({
              contract: CONTRACT,
              type: "delivery-result",
              deliveryId: frame.deliveryId,
              ok: true,
            }),
          )
          .catch((error) =>
            this.write({
              contract: CONTRACT,
              type: "delivery-result",
              deliveryId: frame.deliveryId,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
      }
    }
  }

  private async sendSystemMessage(to: string, text: string): Promise<void> {
    await sendMessageWeixin({
      to,
      text,
      opts: {
        baseUrl: this.options.baseUrl,
        token: this.options.token,
        contextToken: getContextToken(this.options.accountId, to),
      },
    });
  }

  private write(frame: object): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(`${JSON.stringify(frame)}\n`);
    }
  }
}

export function normalizeInboundSource(
  message: WeixinMessage,
  accountId: string,
  agentId: string,
  sessionKey: string,
): InboundSource | null {
  const senderId = message.from_user_id?.trim() ?? "";
  const messageId = message.message_id;
  const cursor = message.seq;
  const textItems = message.item_list?.filter((item) => item.type === MessageItemType.TEXT) ?? [];
  const text =
    textItems.length === 1 && message.item_list?.length === 1
      ? (textItems[0]?.text_item?.text ?? "")
      : "";
  if (
    !accountId.trim() ||
    !senderId ||
    !senderId.toLowerCase().endsWith("@im.wechat") ||
    !Number.isSafeInteger(messageId) ||
    !Number.isSafeInteger(cursor) ||
    !agentId.trim() ||
    !sessionKey.trim()
  ) {
    return null;
  }
  const quoted = textItems.some((item) => Boolean(item.ref_msg));
  const forwarded = message.message_type !== MessageType.USER;
  const direct = message.message_type === MessageType.USER && !message.group_id && Boolean(message.to_user_id);
  return {
    accountId: accountId.trim().toLowerCase(),
    senderId: senderId.toLowerCase(),
    conversationId: senderId.toLowerCase(),
    messageId: String(messageId),
    cursor: cursor!,
    agentId: agentId.trim(),
    sessionKey: sessionKey.trim(),
    direct,
    forwarded: Boolean(forwarded),
    quoted,
    receivedAtUnixMs: Date.now(),
    text,
    ambiguous: false,
  };
}

export function classifyWeixinRemoteApprovalCandidate(message: WeixinMessage): {
  candidateLike: boolean;
  ambiguous: boolean;
  text: string;
} {
  const items = message.item_list ?? [];
  const textItems = items.filter((item) => item.type === MessageItemType.TEXT);
  const exactSingleText =
    items.length === 1 && textItems.length === 1 ? (textItems[0]?.text_item?.text ?? "") : null;
  if (exactSingleText != null && EXACT_CANDIDATE_PATTERN.test(exactSingleText)) {
    return { candidateLike: true, ambiguous: false, text: exactSingleText };
  }
  const combinedText = textItems.map((item) => item.text_item?.text ?? "").join("\n");
  const candidateLike =
    EMBEDDED_CANDIDATE_PATTERN.test(combinedText) ||
    MALFORMED_CANDIDATE_PATTERN.test(combinedText);
  return {
    candidateLike,
    ambiguous: candidateLike,
    text: combinedText,
  };
}
