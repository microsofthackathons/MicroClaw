import { isDeepStrictEqual } from "node:util";
import type { WeixinRemoteApprovalActivationOptions } from "./windows-node-mxc-weixin-remote-approval-activation";
import {
  normalizeWeixinRemoteApprovalOwner,
  type WeixinRemoteApprovalConfiguration,
} from "./windows-node-mxc-weixin-remote-approval";

export function assertWeixinLoginConfigUnchanged(before: unknown, after: unknown): void {
  if (!isDeepStrictEqual(before, after))
    throw new Error(
      "Gateway configuration changed during WeChat account change; execution remains locked",
    );
}

export function createWeixinLoginApprovalConfiguration(
  options: WeixinRemoteApprovalActivationOptions,
): WeixinRemoteApprovalConfiguration {
  if (
    !options.weixinEnabled ||
    !options.enableAvailable ||
    options.invariantState !== "single" ||
    !options.account
  )
    throw new Error("WeChat sign-in did not produce one eligible authenticated account");
  return {
    enabled: true,
    owner: normalizeWeixinRemoteApprovalOwner(
      options.account.accountId,
      options.account.userId,
      new Date().toISOString(),
    ),
  };
}

export type WindowsNodeMxcWeixinAccountOutcome = "connected" | "cancelled" | "disconnected";

/** Owns the pause across a complete account change, not just one IPC call. */
export class WindowsNodeMxcWeixinAccountSession {
  private starting: Promise<void> | null = null;
  private completion: Promise<void> | null = null;

  constructor(
    private readonly hooks: {
      pause(): Promise<void>;
      complete(outcome: WindowsNodeMxcWeixinAccountOutcome): Promise<void>;
      failClosed(error: unknown): Promise<void>;
      settled(error: unknown | null): void;
      assertCurrent(): void;
    },
  ) {}

  get finishing(): boolean {
    return this.completion !== null;
  }

  assertWaiting(): void {
    if (this.finishing)
      throw new Error("WeChat account change is restoring containment; wait for it to finish");
    this.hooks.assertCurrent();
  }

  start(): Promise<void> {
    this.starting ??= Promise.resolve().then(() => this.hooks.pause());
    return this.starting;
  }

  finish(outcome: WindowsNodeMxcWeixinAccountOutcome, failure?: unknown): Promise<void> {
    if (this.completion) return this.completion;
    this.completion = (async () => {
      let failed: unknown | null = null;
      try {
        await this.start();
        if (failure !== undefined) throw failure;
        this.hooks.assertCurrent();
        await this.hooks.complete(outcome);
      } catch (error) {
        failed = error;
        try {
          await this.hooks.failClosed(error);
        } catch (lockingError) {
          failed = new AggregateError(
            [error, lockingError],
            "WeChat account change and containment recovery failed",
          );
        }
        throw failed;
      } finally {
        this.hooks.settled(failed);
      }
    })();
    return this.completion;
  }
}
