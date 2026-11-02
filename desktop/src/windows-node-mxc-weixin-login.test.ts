import { describe, expect, it, vi } from "vitest";
import {
  assertWeixinLoginConfigUnchanged,
  createWeixinLoginApprovalConfiguration,
  WindowsNodeMxcWeixinAccountSession,
  type WindowsNodeMxcWeixinAccountOutcome,
} from "./windows-node-mxc-weixin-login";
import { WindowsNodeMxcLifecycleOperationCoordinator } from "./windows-node-mxc-lifecycle-operation";
import { WeixinQrSession } from "./weixin-connection";
import type { WeixinRemoteApprovalActivationOptions } from "./windows-node-mxc-weixin-remote-approval-activation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const events: string[] = [];
  const hooks = {
    pause: vi.fn(async () => {
      events.push("pause");
    }),
    complete: vi.fn(async (_outcome: WindowsNodeMxcWeixinAccountOutcome) => {
      events.push("attest-and-release");
    }),
    failClosed: vi.fn(async (_error: unknown) => {
      events.push("fail-closed");
    }),
    settled: vi.fn((_error: unknown) => {
      events.push("settled");
    }),
    assertCurrent: vi.fn(),
  };
  return { hooks, events, login: new WindowsNodeMxcWeixinAccountSession(hooks) };
}

describe("guarded MXC WeChat login", () => {
  it.each(["connected", "cancelled", "disconnected"] as const)(
    "reattests in place before releasing ownership (outcome=%s)",
    async (outcome) => {
      const { login, hooks, events } = fixture();
      await login.start();
      login.assertWaiting();
      expect(hooks.assertCurrent).toHaveBeenCalledOnce();
      expect(hooks.complete).not.toHaveBeenCalled();
      await login.finish(outcome);
      expect(events).toEqual(["pause", "attest-and-release", "settled"]);
      expect(hooks.assertCurrent).toHaveBeenCalledTimes(2);
      expect(hooks.complete).toHaveBeenCalledExactlyOnceWith(outcome);
      expect(hooks.settled).toHaveBeenCalledExactlyOnceWith(null);
      expect(() => login.assertWaiting()).toThrow("restoring containment");
    },
  );

  it("joins cancellation after success without changing the consumed outcome", async () => {
    const { login, hooks } = fixture();
    const ready = deferred<void>();
    hooks.complete.mockImplementationOnce(() => ready.promise);
    await login.start();
    const completion = login.finish("connected");
    expect(login.finish("cancelled")).toBe(completion);
    await vi.waitFor(() => expect(hooks.complete).toHaveBeenCalledWith("connected"));
    expect(hooks.settled).not.toHaveBeenCalled();
    ready.resolve();
    await completion;
    expect(hooks.complete).toHaveBeenCalledOnce();
  });

  it("waits for the pause before cancelling a pending start", async () => {
    const { login, hooks, events } = fixture();
    const pause = deferred<void>();
    hooks.pause.mockImplementationOnce(() => pause.promise);
    const starting = login.start();
    const finishing = login.finish("cancelled");
    expect(hooks.complete).not.toHaveBeenCalled();
    pause.resolve();
    await starting;
    await finishing;
    expect(events).toEqual(["attest-and-release", "settled"]);
  });

  it.each(["pause", "complete"] as const)(
    "fails closed and releases ownership on %s failure",
    async (stage) => {
      const { login, hooks } = fixture();
      const error = new Error(`${stage} failed`);
      hooks[stage].mockRejectedValueOnce(error);
      await expect(login.finish("connected")).rejects.toBe(error);
      expect(hooks.failClosed).toHaveBeenCalledExactlyOnceWith(error);
      expect(hooks.settled).toHaveBeenCalledExactlyOnceWith(error);
      if (stage !== "complete") expect(hooks.complete).not.toHaveBeenCalled();
    },
  );

  it("stops an unconfirmed writer without treating the outcome as a successful cancellation", async () => {
    const { login, hooks } = fixture();
    const error = new Error("RPC outcome unknown");
    await login.start();
    await expect(login.finish("cancelled", error)).rejects.toBe(error);
    expect(hooks.complete).not.toHaveBeenCalled();
    expect(hooks.failClosed).toHaveBeenCalledWith(error);
  });

  it("surfaces both the original and recovery errors", async () => {
    const { login, hooks } = fixture();
    hooks.complete.mockRejectedValueOnce(new Error("attestation failed"));
    hooks.failClosed.mockRejectedValueOnce(new Error("stop failed"));
    await expect(login.finish("connected")).rejects.toBeInstanceOf(AggregateError);
    expect(hooks.settled).toHaveBeenCalledWith(expect.any(AggregateError));
  });

  it("rejects stale runtime ownership before a QR mutation", async () => {
    const { login, hooks } = fixture();
    hooks.assertCurrent.mockImplementationOnce(() => {
      throw new Error("generation changed");
    });
    await login.start();
    expect(() => login.assertWaiting()).toThrow("generation changed");
  });

  it("holds the lifecycle across QR polling and rejects competing model/folder/mode changes", async () => {
    const coordinator = new WindowsNodeMxcLifecycleOperationCoordinator();
    const lease = coordinator.acquire<void>(
      { kind: "login-weixin" },
      {
        beforeStart() {},
        afterSettled() {},
      },
    );
    if (lease.joined) throw new Error("unexpected joined login");
    const { hooks } = fixture();
    hooks.settled.mockImplementation((error) => (error ? lease.fail(error) : lease.succeed()));
    const login = new WindowsNodeMxcWeixinAccountSession(hooks);
    const qr = new WeixinQrSession();
    const result = deferred<{ connected: boolean; message: string }>();
    await qr.start(
      async () => {
        await login.start();
        return {
          ok: true,
          sessionKey: "test-session",
          qrDataUrl: "https://example.test/qr",
          message: "Scan",
        };
      },
      async () => {
        const terminal = await result.promise;
        await login.finish(terminal.connected ? "connected" : "cancelled");
        return terminal;
      },
    );
    for (const descriptor of [
      { kind: "login-weixin" },
      { kind: "disconnect-weixin" },
      { kind: "update-model" },
      { kind: "apply-folder-policy" },
      { kind: "set-enabled", requestedMode: "off" },
    ] as const) {
      expect(() =>
        coordinator.acquire(descriptor, { beforeStart() {}, afterSettled() {} }),
      ).toThrow("already in progress");
    }
    expect(qr.status.state).toBe("waiting");
    result.resolve({ connected: true, message: "Connected" });
    await lease.promise;
    await vi.waitFor(() => expect(qr.status.state).toBe("connected"));
    expect(coordinator.active).toBe(false);
  });

  it("cancels the exact QR and drains its poll before restoring the same runtime", async () => {
    const { login, hooks, events } = fixture();
    const qr = new WeixinQrSession();
    const result = deferred<{ connected: boolean; cancelled: boolean; message: string }>();
    let cancelling = false;
    await qr.start(
      async () => {
        await login.start();
        return {
          ok: true,
          sessionKey: "exact-session",
          qrDataUrl: "https://example.test/qr",
          message: "Scan",
        };
      },
      async () => {
        const terminal = await result.promise;
        if (!cancelling) await login.finish(terminal.connected ? "connected" : "cancelled");
        events.push("poll-drained");
        return terminal;
      },
    );
    cancelling = true;
    await qr.cancel(async (key) => {
      expect(key).toBe("exact-session");
      events.push("cancel-confirmed");
      result.resolve({ connected: false, cancelled: true, message: "Cancelled" });
    });
    await login.finish("cancelled");
    expect(events).toEqual([
      "pause",
      "cancel-confirmed",
      "poll-drained",
      "attest-and-release",
      "settled",
    ]);
    expect(hooks.complete).toHaveBeenCalledWith("cancelled");
    expect(qr.status.state).toBe("idle");
  });

  it("requires unchanged complete configuration, not merely unchanged mode", () => {
    const before = {
      plugins: { entries: { weixin: { enabled: true } } },
      tools: { allow: ["exec"] },
    };
    expect(() => assertWeixinLoginConfigUnchanged(before, structuredClone(before))).not.toThrow();
    expect(() =>
      assertWeixinLoginConfigUnchanged(before, {
        ...before,
        tools: { allow: ["exec", "read"] },
      }),
    ).toThrow("configuration changed");
  });
});

describe("post-login remote authority", () => {
  const options: WeixinRemoteApprovalActivationOptions = {
    weixinEnabled: true,
    linkedAccountCount: 1,
    authenticatedAccountCount: 1,
    invariantState: "single",
    account: { accountId: "new-bot", userId: "new@im.wechat" },
    enableAvailable: true,
    unavailableReason: null,
  };

  it("binds only the authenticated single account and never inherits durable consent", () => {
    const configuration = createWeixinLoginApprovalConfiguration(options);
    expect(configuration.enabled).toBe(true);
    expect(configuration.owner).toMatchObject(options.account!);
    expect(configuration.owner?.boundAt).not.toBe(new Date(0).toISOString());
    expect(configuration).not.toHaveProperty("consentScope");
  });

  it.each([
    { weixinEnabled: false },
    { enableAvailable: false },
    { account: null },
    { invariantState: "multiple" as const },
    { invariantState: "invalid" as const },
  ])("rejects an ineligible account: %j", (change) => {
    expect(() => createWeixinLoginApprovalConfiguration({ ...options, ...change })).toThrow(
      "eligible authenticated account",
    );
  });
});
