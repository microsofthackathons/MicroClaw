import type { WindowsNodeMxcApprovalDecision } from "./windows-node-mxc";

export const WINDOWS_NODE_MXC_APPROVAL_TIMEOUT_MS = 60_000;
export type MxcApprovalOrigin = "desktop" | "wechat" | "timeout" | "gateway";
export type MxcApprovalTerminal =
  | {
      status: "accepted";
      decision: WindowsNodeMxcApprovalDecision;
      origin: MxcApprovalOrigin;
      durableSaved?: boolean;
      warning?: "durable-persistence-failed";
    }
  | {
      status: "unconfirmed" | "cancelled";
      origin: MxcApprovalOrigin;
      reason: string;
    };

export function mxcApprovalDeadline(
  receivedAtUnixMs: number,
  gatewayExpiresAtUnixMs?: number,
): number {
  return Math.min(
    receivedAtUnixMs + WINDOWS_NODE_MXC_APPROVAL_TIMEOUT_MS,
    gatewayExpiresAtUnixMs ?? Number.POSITIVE_INFINITY,
  );
}

export async function commitMxcApprovalDecision(params: {
  decision: WindowsNodeMxcApprovalDecision;
  origin: MxcApprovalOrigin;
  expiresAtUnixMs: number;
  now: () => number;
  resolveGateway: (decision: "allow-once" | "deny") => Promise<void>;
  persistDurable: (() => Promise<void>) | null;
  persistenceError: (error: unknown) => void;
}): Promise<Extract<MxcApprovalTerminal, { status: "accepted" }>> {
  const timedOut = params.now() >= params.expiresAtUnixMs || params.origin === "timeout";
  const decision = timedOut ? "deny" : params.decision;
  const origin = timedOut ? "timeout" : params.origin;
  if (decision === "allow-always" && !params.persistDurable) {
    throw new Error("This command cannot persist an exact durable approval");
  }
  await params.resolveGateway(decision === "allow-always" ? "allow-once" : decision);
  if (decision === "allow-always" && params.persistDurable) {
    try {
      await params.persistDurable();
    } catch (error) {
      params.persistenceError(error);
      return {
        status: "accepted",
        decision: "allow-once",
        origin,
        durableSaved: false,
        warning: "durable-persistence-failed",
      };
    }
  }
  return {
    status: "accepted",
    decision,
    origin,
    ...(decision === "allow-always" ? { durableSaved: true } : {}),
  };
}

export class WindowsNodeMxcApprovalLifecycle {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private resolving = false;
  private terminal: MxcApprovalTerminal | null = null;

  constructor(
    readonly expiresAtUnixMs: number,
    private readonly hooks: {
      resolve: (
        decision: WindowsNodeMxcApprovalDecision,
        origin: MxcApprovalOrigin,
      ) => Promise<Extract<MxcApprovalTerminal, { status: "accepted" }>>;
      terminal: (outcome: MxcApprovalTerminal) => Promise<void>;
      error: (stage: "resolution" | "receipt", error: unknown) => void;
      now?: () => number;
    },
  ) {}

  get pending(): boolean {
    return this.terminal === null;
  }

  start(): void {
    if (this.timer || this.terminal) return;
    this.timer = setTimeout(
      () => {
        void this.decide("deny", "timeout").catch((error) => {
          if (!this.resolving && !this.terminal) this.hooks.error("resolution", error);
        });
      },
      Math.max(0, this.expiresAtUnixMs - this.now()),
    );
    this.timer.unref?.();
  }

  async decide(decision: WindowsNodeMxcApprovalDecision, origin: MxcApprovalOrigin): Promise<void> {
    if (this.terminal) throw new Error("This MXC approval is no longer pending");
    if (this.resolving) throw new Error("This MXC approval already has a decision in progress");
    this.resolving = true;
    const timedOut = this.now() >= this.expiresAtUnixMs || origin === "timeout";
    try {
      const outcome = await this.hooks.resolve(
        timedOut ? "deny" : decision,
        timedOut ? "timeout" : origin,
      );
      await this.finish(outcome);
    } catch (error) {
      this.hooks.error("resolution", error);
      await this.finish({
        status: "unconfirmed",
        origin: timedOut ? "timeout" : origin,
        reason: "resolution-failed",
      });
      throw error;
    } finally {
      this.resolving = false;
    }
  }

  async observe(decision: "allow-once" | "deny" | null): Promise<void> {
    if (this.terminal || this.resolving) return;
    await this.finish(
      decision
        ? { status: "accepted", decision, origin: "gateway" }
        : { status: "cancelled", origin: "gateway", reason: "gateway-resolution-unclassified" },
    );
  }

  async cancel(reason: string): Promise<void> {
    if (this.terminal || this.resolving) return;
    await this.finish({ status: "cancelled", origin: "gateway", reason });
  }

  private now(): number {
    return this.hooks.now?.() ?? Date.now();
  }

  private async finish(outcome: MxcApprovalTerminal): Promise<void> {
    if (this.terminal) return;
    this.terminal = outcome;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      await this.hooks.terminal(outcome);
    } catch (error) {
      this.hooks.error("receipt", error);
    }
  }
}

export function renderMxcApprovalTerminal(
  outcome: MxcApprovalTerminal,
  locale: "en-US" | "zh-CN",
): string {
  if (outcome.status !== "accepted") {
    return locale === "zh-CN"
      ? `MicroClaw 安全审批结果：${outcome.status === "cancelled" ? "已取消" : "决策未确认"}（${outcome.origin}）。未确认批准或拒绝；不会自动重试。`
      : `MicroClaw Security Approval RESULT: ${outcome.status} (${outcome.origin}). No approval or denial confirmed; no automatic retry.`;
  }
  const labels = {
    "allow-once": locale === "zh-CN" ? "仅允许一次" : "allowed once",
    "allow-always":
      locale === "zh-CN" ? "已保存此精确范围的永久审批" : "always allowed for this exact scope",
    deny: locale === "zh-CN" ? "已拒绝" : "denied",
  };
  const warning = outcome.warning
    ? locale === "zh-CN"
      ? " 永久审批保存失败，仅本次决策已接受。"
      : " Durable approval was not saved; only the current decision was accepted."
    : "";
  return locale === "zh-CN"
    ? `MicroClaw 安全审批结果：${labels[outcome.decision]}（${outcome.origin}）。权限决策已接受；这不代表命令执行成功。${warning}`
    : `MicroClaw Security Approval RESULT: ${labels[outcome.decision]} (${outcome.origin}). Permission decision accepted; this is not command execution success.${warning}`;
}
