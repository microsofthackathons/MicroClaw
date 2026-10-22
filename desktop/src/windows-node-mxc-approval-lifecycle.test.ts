import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitMxcApprovalDecision,
  mxcApprovalDeadline,
  renderMxcApprovalTerminal,
  WindowsNodeMxcApprovalLifecycle,
  type MxcApprovalTerminal,
} from "./windows-node-mxc-approval-lifecycle";

describe("authoritative MXC permission lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  function setup() {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const resolveGateway = vi.fn().mockResolvedValue(undefined);
    const persistDurable = vi.fn().mockResolvedValue(undefined);
    const terminal = vi
      .fn<(outcome: MxcApprovalTerminal) => Promise<void>>()
      .mockResolvedValue(undefined);
    const error = vi.fn();
    const lifecycle = new WindowsNodeMxcApprovalLifecycle(61_000, {
      resolve: (decision, origin) =>
        commitMxcApprovalDecision({
          decision,
          origin,
          expiresAtUnixMs: 61_000,
          now: Date.now,
          resolveGateway,
          persistDurable,
          persistenceError: error,
        }),
      terminal,
      error,
    });
    lifecycle.start();
    return { lifecycle, resolveGateway, persistDurable, terminal, error };
  }

  it.each(["desktop", "wechat"] as const)(
    "accepts once/always/deny with the real commit helper from %s",
    async (origin) => {
      for (const decision of ["allow-once", "allow-always", "deny"] as const) {
        const state = setup();
        await state.lifecycle.decide(decision, origin);
        expect(state.resolveGateway).toHaveBeenCalledExactlyOnceWith(
          decision === "allow-always" ? "allow-once" : decision,
        );
        expect(state.persistDurable).toHaveBeenCalledTimes(decision === "allow-always" ? 1 : 0);
        expect(state.terminal).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            status: "accepted",
            decision,
            origin,
          }),
        );
        expect(state.lifecycle.pending).toBe(false);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(state.resolveGateway).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("performs a real deny resolution at the original timeout, once", async () => {
    const state = setup();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(state.resolveGateway).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.resolveGateway).toHaveBeenCalledExactlyOnceWith("deny");
    expect(state.terminal).toHaveBeenCalledExactlyOnceWith({
      status: "accepted",
      decision: "deny",
      origin: "timeout",
    });
    await expect(state.lifecycle.decide("allow-once", "wechat")).rejects.toThrow(
      "no longer pending",
    );
  });

  it("keeps the first in-flight decision and does not claim cancellation or retry an unknown outcome", async () => {
    const state = setup();
    let accept!: () => void;
    state.resolveGateway.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const once = state.lifecycle.decide("allow-once", "desktop");
    await expect(state.lifecycle.decide("allow-always", "wechat")).rejects.toThrow("in progress");
    await state.lifecycle.cancel("transport-disconnected");
    expect(state.terminal).not.toHaveBeenCalled();
    accept();
    await once;
    expect(state.terminal).toHaveBeenCalledTimes(1);
    expect(state.resolveGateway).toHaveBeenCalledTimes(1);
    expect(state.persistDurable).not.toHaveBeenCalled();
  });

  it("reports unconfirmed resolution, never accepted denial, when the Gateway outcome is unknown", async () => {
    const state = setup();
    state.resolveGateway.mockRejectedValue(new Error("connection lost"));
    await expect(state.lifecycle.decide("deny", "desktop")).rejects.toThrow("connection lost");
    expect(state.terminal).toHaveBeenCalledExactlyOnceWith({
      status: "unconfirmed",
      origin: "desktop",
      reason: "resolution-failed",
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(state.resolveGateway).toHaveBeenCalledTimes(1);
  });

  it("reports accepted-once rather than falsely saved Always if persistence fails", async () => {
    const state = setup();
    state.persistDurable.mockRejectedValue(new Error("disk full"));
    await state.lifecycle.decide("allow-always", "wechat");
    expect(state.terminal).toHaveBeenCalledExactlyOnceWith({
      status: "accepted",
      decision: "allow-once",
      origin: "wechat",
      durableSaved: false,
      warning: "durable-persistence-failed",
    });
    expect(state.error).toHaveBeenCalledTimes(1);
  });

  it("does not complete Always or release its decision fence before durable persistence finishes", async () => {
    const state = setup();
    let persist!: () => void;
    state.persistDurable.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          persist = resolve;
        }),
    );
    const decision = state.lifecycle.decide("allow-always", "wechat");
    await Promise.resolve();
    await Promise.resolve();
    expect(state.resolveGateway).toHaveBeenCalledExactlyOnceWith("allow-once");
    expect(state.terminal).not.toHaveBeenCalled();
    persist();
    await decision;
    expect(state.terminal).toHaveBeenCalledExactlyOnceWith({
      status: "accepted",
      decision: "allow-always",
      origin: "wechat",
      durableSaved: true,
    });
  });

  it("rechecks the deadline immediately before Gateway dispatch and never persists an expired grant", async () => {
    const state = setup();
    vi.setSystemTime(61_000);
    await state.lifecycle.decide("allow-always", "wechat");
    expect(state.resolveGateway).toHaveBeenCalledExactlyOnceWith("deny");
    expect(state.persistDurable).not.toHaveBeenCalled();
    expect(state.terminal).toHaveBeenCalledExactlyOnceWith({
      status: "accepted",
      decision: "deny",
      origin: "timeout",
    });
  });

  it("does not turn a receipt failure or duplicate external event into another permission decision", async () => {
    const state = setup();
    state.terminal.mockRejectedValue(new Error("phone disconnected"));
    await state.lifecycle.decide("deny", "desktop");
    await state.lifecycle.observe("allow-once");
    await state.lifecycle.cancel("shutdown");
    expect(state.resolveGateway).toHaveBeenCalledTimes(1);
    expect(state.terminal).toHaveBeenCalledTimes(1);
    expect(state.error).toHaveBeenCalledWith("receipt", expect.any(Error));
  });

  it("preserves an earlier Gateway deadline without extending the local UI window", () => {
    expect(mxcApprovalDeadline(1_000)).toBe(61_000);
    expect(mxcApprovalDeadline(1_000, 31_000)).toBe(31_000);
    expect(mxcApprovalDeadline(1_000, 121_000)).toBe(61_000);
  });

  it.each(["en-US", "zh-CN"] as const)(
    "makes receipts about accepted permission, not command success (%s)",
    (locale) => {
      const text = renderMxcApprovalTerminal(
        { status: "accepted", decision: "allow-always", origin: "wechat", durableSaved: true },
        locale,
      );
      expect(text).toMatch(
        locale === "en-US" ? /not command execution success/ : /不代表命令执行成功/,
      );
      expect(text).toContain("wechat");
    },
  );
});
