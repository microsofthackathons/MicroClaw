import { createHash } from "node:crypto";
import type { WindowsNodeMxcGatewayApproval } from "./windows-node-mxc";
import {
  type WeixinRemoteApprovalConfiguration,
  type WeixinRemoteApprovalDelivery,
  type WeixinRemoteApprovalRejectionReason,
  type WeixinRemoteApprovalSecurityBinding,
  type WeixinRemoteApprovalSource,
  WindowsNodeMxcWeixinRemoteApprovalBroker,
  WEIXIN_REMOTE_APPROVAL_REPLY_MODE,
  weixinApprovalSourceSessionKey,
  weixinApprovalOriginRejection,
  weixinRemoteApprovalWireSourceRejection,
} from "./windows-node-mxc-weixin-remote-approval";
import type { AuthenticatedWeixinWireOwner } from "./weixin-account-status";
import type {
  WindowsNodeMxcWeixinRemoteApprovalServer,
  WeixinRemoteTransportDiagnostic,
} from "./windows-node-mxc-weixin-remote-approval-transport";
import { normalizeWeixinProviderInteger } from "./weixin-provider-integer";

export type WeixinRemoteDeliveryReason =
  | WeixinRemoteApprovalRejectionReason
  | "source-unavailable"
  | "security-unavailable"
  | "transport-unavailable"
  | "delivery-unconfirmed"
  | "approval-queued"
  | "approval-no-longer-pending";

export interface WeixinRemoteDeliveryState {
  state: "sending" | "sent" | "local-only" | "unconfirmed";
  reason: WeixinRemoteDeliveryReason | null;
  replyMode: typeof WEIXIN_REMOTE_APPROVAL_REPLY_MODE | "code-required" | null;
  revision: number;
}

export type WeixinRemoteDeliveryTrigger = "initial" | "source-bound" | "promoted";

export class WeixinRemoteDeliveryCoordinator {
  private tail: Promise<WeixinRemoteApprovalDelivery | null> | null = null;
  private scheduled = new Map<
    WeixinRemoteDeliveryTrigger,
    Promise<WeixinRemoteApprovalDelivery | null>
  >();

  begin(
    trigger: WeixinRemoteDeliveryTrigger,
    current: () => {
      pending: boolean;
      challengeId: string | null;
      state: WeixinRemoteDeliveryState | null;
    },
    send: () => Promise<WeixinRemoteApprovalDelivery | null>,
  ): Promise<WeixinRemoteApprovalDelivery | null> {
    const scheduled = this.scheduled.get(trigger);
    if (scheduled) return this.tail ?? scheduled;
    const previous = this.tail;
    const attempt = (async () => {
      await previous;
      const { pending, challengeId, state } = current();
      if (!pending || challengeId) return null;
      const permitted =
        trigger === "initial"
          ? state === null
          : state?.state === "local-only" &&
            (state.reason === "source-run-mismatch" ||
              (trigger === "promoted" && state.reason === "approval-queued"));
      if (!permitted) return null;
      return send();
    })();
    this.tail = attempt;
    this.scheduled.set(trigger, attempt);
    const clear = () => {
      if (this.scheduled.get(trigger) === attempt) this.scheduled.delete(trigger);
    };
    void attempt.then(clear, clear);
    return attempt;
  }
}

export function remoteApprovalDiagnosticBinding(
  approval: Pick<WindowsNodeMxcGatewayApproval, "id" | "sessionKey">,
): {
  approvalHash: string;
  sessionHash: string;
} {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
  return { approvalHash: hash(approval.id), sessionHash: hash(approval.sessionKey) };
}

export function exactWeixinApprovalSource(
  configuration: WeixinRemoteApprovalConfiguration,
  source: WeixinRemoteApprovalSource | undefined,
  approval: WindowsNodeMxcGatewayApproval,
  wireOwner: AuthenticatedWeixinWireOwner | null,
): WeixinRemoteDeliveryReason | null {
  const owner = configuration.owner;
  if (!configuration.enabled || !owner) return "disabled";
  if (!approval.origin) return "source-origin-unavailable";
  if (!source) return "source-unavailable";
  if (!source.direct || source.forwarded || source.quoted) return "source-not-direct";
  const ownerReason = weixinRemoteApprovalWireSourceRejection(configuration, source, wireOwner);
  if (ownerReason) return ownerReason;
  if (
    normalizeWeixinProviderInteger(source.cursor) === null ||
    normalizeWeixinProviderInteger(source.messageId) === null
  ) {
    return "source-metadata-invalid";
  }
  if (source.sessionKey !== weixinApprovalSourceSessionKey(approval))
    return "source-session-mismatch";
  if (source.agentId !== (approval.agent ?? "")) return "source-agent-mismatch";
  return weixinApprovalOriginRejection(approval, source);
}

export function findWeixinApprovalSource(
  sources: ReadonlyMap<string, WeixinRemoteApprovalSource>,
  approval: WindowsNodeMxcGatewayApproval,
): WeixinRemoteApprovalSource | undefined {
  return approval.origin ? sources.get(weixinApprovalSourceSessionKey(approval)) : undefined;
}

export function bindWeixinApprovalRun(
  sources: Map<string, WeixinRemoteApprovalSource>,
  inbound: WeixinRemoteApprovalSource & { runId?: string },
  gatewayGeneration: string,
): WeixinRemoteApprovalSource | null {
  if (!inbound.runId || !inbound.direct || inbound.forwarded || inbound.quoted) return null;
  for (const [key, source] of sources) {
    if (
      source.gatewayGeneration !== gatewayGeneration ||
      source.accountId !== inbound.accountId ||
      source.senderId !== inbound.senderId ||
      source.conversationId !== inbound.conversationId ||
      source.messageId !== inbound.messageId ||
      source.cursor !== inbound.cursor ||
      source.agentId !== inbound.agentId ||
      (source.providerSessionKey ?? source.sessionKey) !== inbound.sessionKey
    )
      continue;
    const bound = { ...source, runIds: [...new Set([...(source.runIds ?? []), inbound.runId])] };
    sources.set(key, bound);
    return bound;
  }
  return null;
}

export async function deliverWeixinRemoteApproval(params: {
  approval: WindowsNodeMxcGatewayApproval;
  configuration: WeixinRemoteApprovalConfiguration;
  source: WeixinRemoteApprovalSource | undefined;
  security: WeixinRemoteApprovalSecurityBinding | null;
  server: WindowsNodeMxcWeixinRemoteApprovalServer | null;
  broker: WindowsNodeMxcWeixinRemoteApprovalBroker;
  readWireOwner: () => AuthenticatedWeixinWireOwner | null;
  expiresAtUnixMs: number;
  locale: "en-US" | "zh-CN";
  queued?: boolean;
  isPending: () => boolean;
  challenge: (delivery: WeixinRemoteApprovalDelivery) => void;
  state: (state: WeixinRemoteDeliveryState) => void;
  diagnostic: (reason: WeixinRemoteDeliveryReason | "prompt-delivered") => void;
  deliveryDiagnostic?: (diagnostic: WeixinRemoteTransportDiagnostic) => void;
}): Promise<WeixinRemoteApprovalDelivery | null> {
  let revision = 0;
  const publish = (
    state: WeixinRemoteDeliveryState["state"],
    reason: WeixinRemoteDeliveryReason | null,
    replyMode: WeixinRemoteDeliveryState["replyMode"] = null,
  ) => {
    if (params.isPending()) params.state({ state, reason, replyMode, revision: ++revision });
    if (reason) params.diagnostic(reason);
  };
  const originReason = exactWeixinApprovalSource(
    params.configuration,
    params.source,
    params.approval,
    params.readWireOwner(),
  );
  if (originReason) {
    publish("local-only", originReason);
    return null;
  }
  const source = params.source;
  if (!source) throw new Error("Validated WeChat source is unavailable");
  const server = params.server;
  if (!server?.isRegistered(source.accountId)) {
    publish("local-only", "transport-unavailable");
    return null;
  }
  const notifyLocalOnly = async (reason: WeixinRemoteDeliveryReason) => {
    publish("local-only", reason);
    if (!params.isPending()) return;
    if (!params.broker.isAuthenticatedSource(source)) {
      publish("local-only", "source-owner-unavailable");
      return;
    }
    const presentationOnly =
      reason === "presentation-unsupported" || reason === "presentation-sensitive";
    const detail = presentationOnly
      ? params.locale === "zh-CN"
        ? "此命令无法在微信中安全展示或审批，请在桌面允许或拒绝"
        : "This command cannot be safely displayed or approved on WeChat; allow or deny on Desktop"
      : params.locale === "zh-CN"
        ? "另有一个请求须在桌面处理"
        : "Another request needs a Desktop decision";
    const text =
      params.locale === "zh-CN"
        ? `MicroClaw 安全审批：${detail}（${reason}）。未授予任何权限，原截止时间不变；稍后会通知结果。`
        : `MicroClaw Security Approval: ${detail} (${reason}). No permission granted; original deadline unchanged. A result will follow.`;
    try {
      await server.deliver({
        accountId: source.accountId,
        to: source.senderId,
        text,
        kind: "fallback",
        onDiagnostic: params.deliveryDiagnostic,
      });
    } catch {
      publish("unconfirmed", "delivery-unconfirmed");
    }
  };
  if (!params.security) {
    await notifyLocalOnly("security-unavailable");
    return null;
  }
  if (params.queued) {
    await notifyLocalOnly("approval-queued");
    return null;
  }
  const result = params.broker.createChallengeResult({
    source,
    requests: [{ approval: params.approval }],
    security: params.security,
    expiresAtUnixMs: params.expiresAtUnixMs,
    locale: params.locale,
  });
  if (result.status === "rejected") {
    await notifyLocalOnly(result.reason);
    return null;
  }
  const { delivery } = result;
  params.challenge(delivery);
  const replyMode = WEIXIN_REMOTE_APPROVAL_REPLY_MODE;
  publish("sending", null, replyMode);
  let acknowledged = false;
  try {
    if (!params.isPending()) {
      params.broker.invalidateChallenge(delivery.challengeId, "approval-no-longer-pending");
      params.diagnostic("approval-no-longer-pending");
      return null;
    }
    if (!params.broker.isAuthenticatedSource(source)) {
      params.broker.invalidateChallenge(delivery.challengeId, "source-owner-unavailable");
      publish("local-only", "source-owner-unavailable");
      return null;
    }
    await server.deliver({
      accountId: delivery.accountId,
      kind: "prompt",
      to: delivery.senderId,
      text: delivery.text,
      approval: { challengeId: delivery.challengeId, expiresAtUnixMs: delivery.expiresAtUnixMs },
      onDiagnostic: params.deliveryDiagnostic,
      onDelivered: () => {
        if (!params.isPending()) return;
        acknowledged = params.broker.markDelivered(delivery.challengeId);
        if (acknowledged) {
          publish("sent", null, replyMode);
          params.diagnostic("prompt-delivered");
        }
      },
    });
    if (!params.isPending()) {
      params.broker.invalidateChallenge(delivery.challengeId, "approval-no-longer-pending");
      return null;
    }
    if (!acknowledged) {
      publish("local-only", "approval-no-longer-pending");
      return null;
    }
    return delivery;
  } catch {
    params.broker.invalidateChallenge(delivery.challengeId, "delivery-unconfirmed");
    publish("unconfirmed", "delivery-unconfirmed");
    return null;
  }
}
