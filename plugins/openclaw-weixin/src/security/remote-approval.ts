import net from "node:net";
import { createHash, randomUUID } from "node:crypto";

import type { WeixinMessage } from "../api/types.js";
import { MessageItemType, MessageType } from "../api/types.js";
import { getContextToken } from "../messaging/inbound.js";
import { sendMessageWeixin } from "../messaging/send.js";
import { isActiveWeixinAccount } from "../auth/accounts.js";
import { normalizeProviderInteger, providerMetadataShape, type ProviderFieldShape } from "../api/provider-metadata.js";

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
  cursor: string;
  agentId: string;
  sessionKey: string;
  direct: boolean;
  forwarded: boolean;
  quoted: boolean;
  receivedAtUnixMs: number;
  text: string;
  ambiguous: boolean;
  sentAtUnixMs?: number;
}

interface RemoteApprovalTransportOptions {
  accountId: string;
  baseUrl: string;
  token?: string;
  error?: (message: string) => void;
  diagnostic?: (record: { code: string; phase: string; sessionHash: string; hasProviderSendTime: boolean; metadataProvenance: string; messageId: ProviderFieldShape; seq: ProviderFieldShape }) => void;
}

export class WeixinRemoteApprovalTransport {
  private socket: net.Socket | null = null;
  private disposed = false;
  private buffer = "";
  private activeApproval: { challengeId: string; to: string; expiresAtUnixMs: number } | null = null;
  private reminderAt = 0;
  private reminderCount = 0;
  private approvalDeliveryRevision = 0;
  private readonly terminalChallenges = new Map<string, number>();
  private readonly pending = new Map<
    string,
    {
      resolve: (value: { consumed: boolean; acknowledgement?: string }) => void;
      timer: NodeJS.Timeout;
      consumeOnDisconnect: boolean;
      activeChallengeId: string | null;
    }
  >();

  constructor(private readonly options: RemoteApprovalTransportOptions) {}

  private isActiveAccount(): boolean {
    return (
      Boolean(this.options.token?.trim()) &&
      isActiveWeixinAccount(this.options.accountId, this.options.token)
    );
  }

  get enabled(): boolean {
    return Boolean(
      !this.disposed &&
      process.env.MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_PIPE &&
        process.env.MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_TOKEN,
    );
  }

  shouldReserveInbound(message: WeixinMessage): boolean {
    return this.enabled && (this.isActiveOwnerMessage(message) || classifyWeixinRemoteApprovalCandidate(message).candidateLike);
  }

  private isActiveOwnerMessage(message: WeixinMessage): boolean {
    return Boolean(this.activeApproval && Date.now() < this.activeApproval.expiresAtUnixMs &&
      message.message_type === MessageType.USER && !message.group_id &&
      typeof message.to_user_id === "string" && message.to_user_id.trim() &&
      typeof message.from_user_id === "string" &&
      message.from_user_id.trim().toLowerCase() === this.activeApproval.to);
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
    sourcePhase: "candidate" | "start" | "run" | "complete";
    runId?: string;
    isActive?: () => boolean;
  }): Promise<boolean> {
    if (!this.enabled) return false;
    const candidate = classifyWeixinRemoteApprovalCandidate(params.message);
    const activeOwner = this.isActiveOwnerMessage(params.message);
    const reservedCandidate = params.sourcePhase === "candidate" && this.shouldReserveInbound(params.message);
    if (!this.socket) {
      try {
        await this.start();
      } catch {
        this.options.error?.("weixin-remote-approval reason=transport-registration-unavailable");
        if (activeOwner) await this.remindLocally();
        return reservedCandidate;
      }
    }
    if (!this.isActiveAccount() || (params.isActive && !params.isActive())) {
      return reservedCandidate;
    }
    const normalized = normalizeInboundSourceResult(
      params.message,
      this.options.accountId,
      params.agentId,
      params.sessionKey,
    );
    this.options.diagnostic?.({
      code: normalized.source ? "source-normalized" : normalized.reason,
      phase: params.sourcePhase,
      sessionHash: createHash("sha256").update(params.sessionKey).digest("hex").slice(0, 16),
      hasProviderSendTime: Number.isSafeInteger(params.message.create_time_ms),
      ...providerMetadataShape(params.message),
    });
    const source = normalized.source;
    if (!source) {
      if (activeOwner) await this.remindLocally();
      return reservedCandidate;
    }
    const requestId = randomUUID();
    const result = await new Promise<{ consumed: boolean; acknowledgement?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ consumed: reservedCandidate });
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, {
        resolve, timer, consumeOnDisconnect: reservedCandidate,
        activeChallengeId: this.activeApproval?.challengeId ?? null,
      });
      this.write({
        contract: CONTRACT,
        type: "inbound",
        requestId,
        source: {
          ...source,
          text: params.sourcePhase === "candidate" ? candidate.text : source.text,
          ambiguous: params.sourcePhase === "candidate" && candidate.ambiguous,
          sourcePhase: params.sourcePhase,
          ...(params.sourcePhase === "run" ? { runId: params.runId } : {}),
        },
      });
    });
    if (
      result.acknowledgement &&
      this.isActiveAccount() &&
      (!params.isActive || params.isActive())
    ) {
      try {
        await this.sendSystemMessage(source.senderId, result.acknowledgement);
      } catch {
        this.options.error?.("weixin-remote-approval reason=acknowledgement-delivery-unconfirmed");
      }
    }
    if (activeOwner && !result.consumed && this.activeApproval) await this.remindLocally();
    return result.consumed || Boolean(activeOwner && this.activeApproval);
  }

  close(): void {
    this.disposed = true;
    this.activeApproval = null;
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
        if (frame.approvalActive === false && this.activeApproval?.challengeId === pending.activeChallengeId) {
          this.activeApproval = null;
        }
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
        const terminalChallengeId = typeof frame.terminalChallengeId === "string" ? frame.terminalChallengeId : null;
        if (terminalChallengeId) {
          this.terminalChallenges.set(terminalChallengeId, Date.now() + 120_000);
          for (const [id, expiry] of this.terminalChallenges) {
            if (expiry <= Date.now() || this.terminalChallenges.size > 256) this.terminalChallenges.delete(id);
          }
        }
        if (terminalChallengeId && this.activeApproval?.challengeId === terminalChallengeId) {
          this.activeApproval = null;
        }
        if (!this.isActiveAccount()) {
          this.write({
            contract: CONTRACT,
            type: "delivery-result",
            deliveryId: frame.deliveryId,
            ok: false,
            error: "WeChat account changed before remote approval delivery",
          });
          continue;
        }
        const approval = frame.approval && typeof frame.approval === "object"
          ? frame.approval as Record<string, unknown> : null;
        const deliveryRevision = approval ? ++this.approvalDeliveryRevision : null;
        const deliverySocket = this.socket;
        void this.sendSystemMessage(frame.to, frame.text)
          .then(() => {
            if (!this.disposed && this.socket === deliverySocket && this.socket &&
              deliveryRevision === this.approvalDeliveryRevision &&
              approval && typeof approval.challengeId === "string" &&
              !this.terminalChallenges.has(approval.challengeId) &&
              typeof approval.expiresAtUnixMs === "number" &&
              Number.isSafeInteger(approval.expiresAtUnixMs) && approval.expiresAtUnixMs > Date.now()) {
              this.activeApproval = {
                challengeId: approval.challengeId,
                to: frame.to.trim().toLowerCase(),
                expiresAtUnixMs: approval.expiresAtUnixMs,
              };
              this.reminderAt = 0;
              this.reminderCount = 0;
            }
            this.write({
              contract: CONTRACT,
              type: "delivery-result",
              deliveryId: frame.deliveryId,
              ok: true,
            });
          })
          .catch(() =>
            this.write({
              contract: CONTRACT,
              type: "delivery-result",
              deliveryId: frame.deliveryId,
              ok: false,
              error: "weixin-delivery-failed",
            }),
          );
      }

    }
  }

  private async remindLocally(): Promise<void> {
    if (!this.activeApproval || this.reminderCount >= 3 || Date.now() - this.reminderAt < 5_000) return;
    this.reminderAt = Date.now();
    this.reminderCount++;
    try {
      await this.sendSystemMessage(this.activeApproval.to,
        "MicroClaw Security Approval: no decision. Reply 1 CODE (once), 2 CODE (exact always), or 3 CODE (deny), using the current prompt's code, or use the Desktop. Original deadline unchanged.");
    } catch {
      this.options.error?.("weixin-remote-approval reason=reminder-delivery-unconfirmed");
    }
  }

  private async sendSystemMessage(to: string, text: string): Promise<void> {
    if (!this.isActiveAccount()) {
      throw new Error("WeChat account changed before remote approval delivery");
    }
    await sendMessageWeixin({
      to,
      text,
      opts: {
        baseUrl: this.options.baseUrl,
        token: this.options.token,
        contextToken: getContextToken(this.options.accountId, to),
        isActive: () => this.isActiveAccount(),
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
  return normalizeInboundSourceResult(message, accountId, agentId, sessionKey).source;
}

export function normalizeInboundSourceResult(
  message: WeixinMessage,
  accountId: string,
  agentId: string,
  sessionKey: string,
): { source: InboundSource; reason: null } | { source: null; reason: string } {
  const senderId = typeof message.from_user_id === "string" ? message.from_user_id.trim() : "";
  const messageId = normalizeProviderInteger(message.message_id);
  const cursor = normalizeProviderInteger(message.seq);
  if (message.item_list !== undefined && !Array.isArray(message.item_list)) return { source: null, reason: "provider-items-invalid" };
  const textItems = message.item_list?.filter((item) => item.type === MessageItemType.TEXT) ?? [];
  const text =
    textItems.length === 1 && message.item_list?.length === 1
      ? (textItems[0]?.text_item?.text ?? "")
      : "";
  if (!accountId.trim() || !senderId.toLowerCase().endsWith("@im.wechat")) return { source: null, reason: "provider-identity-invalid" };
  if (messageId === null) return { source: null, reason: "provider-message-id-unavailable" };
  if (cursor === null) return { source: null, reason: "provider-cursor-unavailable" };
  if (!agentId.trim() || !sessionKey.trim()) return { source: null, reason: "route-unavailable" };
  const quoted = textItems.some((item) => Boolean(item.ref_msg));
  const forwarded = message.message_type !== MessageType.USER;
  const direct = message.message_type === MessageType.USER && !message.group_id &&
    typeof message.to_user_id === "string" && Boolean(message.to_user_id.trim());
  return { reason: null, source: {
    accountId: accountId.trim().toLowerCase(),
    senderId: senderId.toLowerCase(),
    conversationId: senderId.toLowerCase(),
    messageId,
    cursor,
    agentId: agentId.trim(),
    sessionKey: sessionKey.trim(),
    direct,
    forwarded: Boolean(forwarded),
    quoted,
    receivedAtUnixMs: Date.now(),
    text,
    ambiguous: false,
    ...(Number.isSafeInteger(message.create_time_ms) && message.create_time_ms! >= 0
      ? { sentAtUnixMs: message.create_time_ms } : {}),
  } };
}

export function classifyWeixinRemoteApprovalCandidate(message: WeixinMessage): {
  candidateLike: boolean;
  ambiguous: boolean;
  text: string;
} {
  const items = Array.isArray(message.item_list) ? message.item_list : [];
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
