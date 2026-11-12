import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "./gateway-client";
import { WeixinQrSession } from "./weixin-connection";
import {
  shouldRevokeWeixinRemoteApprovalOwner,
  type WeixinAccountStatus,
} from "./weixin-account-status";
import { WeixinMutationCoordinator } from "./weixin-mutation-coordinator";
import { isKnownWeixinQrStartRejection, isWeixinLoginReady } from "./weixin-plugin-lifecycle";
import { WindowsNodeMxcLifecycleOperationCoordinator } from "./windows-node-mxc-lifecycle-operation";
import {
  assertWeixinLoginConfigUnchanged,
  createWeixinLoginApprovalConfiguration,
  WindowsNodeMxcWeixinAccountSession,
} from "./windows-node-mxc-weixin-login";

const source = readFileSync(resolve(process.cwd(), "src", "main.ts"), "utf8");
const accountChange = source.slice(
  source.indexOf("function assertWeixinQrLoginMutable"),
  source.indexOf("let weixinRuntimeRead:"),
);
const waitForConnection = source.slice(
  source.indexOf("async function waitForWeixinConnection"),
  source.indexOf("let weixinMutationLockRevision"),
);
const cancelHandler = source.slice(
  source.indexOf('ipcMain.handle("plugin:weixin:cancel-login"'),
  source.indexOf("// --- WeChat QR Login via Gateway"),
);
const disconnectHandler = source.slice(
  source.indexOf('ipcMain.handle("plugin:weixin:disconnect"'),
  source.indexOf(
    "registerLocalModelHandlers",
    source.indexOf('ipcMain.handle("plugin:weixin:disconnect"'),
  ),
);
const qrStartHandler = source.slice(
  source.indexOf('ipcMain.handle(\n    "plugin:weixin:login-qr-start"'),
  source.indexOf('ipcMain.handle("plugin:weixin:login-qr-wait"'),
);
const handlerJs = ts.transpileModule(
  [accountChange, waitForConnection, cancelHandler, qrStartHandler, disconnectHandler].join("\n"),
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  },
).outputText;

const owner = { accountId: "exact-bot", userId: "owner@im.wechat" };
const present = (identity = owner): WeixinAccountStatus => ({
  loggedIn: true,
  accountCount: 1,
  invariantState: "single",
  currentAccount: { ...identity },
});
const absent = (): WeixinAccountStatus => ({
  loggedIn: false,
  accountCount: 0,
  invariantState: "none",
  currentAccount: null,
});

function harness(mode: "full" | "limited-dacl" | "off" = "full") {
  const events: string[] = [];
  let account = present();
  let lifecycleBusy = false;
  const mutations = new WeixinMutationCoordinator();
  const lifecycle = new WindowsNodeMxcLifecycleOperationCoordinator();
  const previousRemote = {
    enabled: true,
    owner: { ...owner, contract: "test-contract", boundAt: "2026-01-01T00:00:00Z" },
  };
  const settings = new Map<string, unknown>([
    ["windowsNodeMxcWeixinRemoteApproval", previousRemote],
  ]);
  const readAccount = vi.fn(() => structuredClone(account));
  const request = vi.fn(async (_method: string, _params: unknown, _timeout: number) => {
    events.push("logout");
    account = absent();
    return { cleared: true, loggedOut: true };
  });
  const gateway = {
    connected: true,
    connectionGeneration: 7,
    request,
    weixinResumeAfterLogin: vi.fn(async () => ({ resumed: true })),
    getChannelsStatus: vi.fn(async () => ({
      channels: { "openclaw-weixin": { enabled: true } },
    })),
    weixinLoginQrStart: vi.fn(async (_params?: { force?: boolean }) => {
      events.push("request-qr");
      return {
        qrDataUrl: "https://example.test/qr",
        sessionKey: "qr-session",
        message: "Scan QR",
      };
    }),
    weixinLoginQrWait: vi.fn<
      () => Promise<{
        connected: boolean;
        accountId?: string;
        pending?: boolean;
        cancelled?: boolean;
        message: string;
      }>
    >(),
    weixinLoginQrCancel: vi.fn(async (_sessionKey: string) => ({ cancelled: true })),
  };
  const transport = { close: vi.fn() };
  const host = {
    revokeActivationLease: vi.fn(() => events.push("revoke-lease")),
    setActivationLease: vi.fn(async () => {
      events.push("renew-lease");
    }),
    status: () => ({ pendingApproval: null }),
    respond: vi.fn(),
  };
  const broker = { configure: vi.fn() };
  const requireEffective = vi.fn(async () => undefined);
  const serviceReady = vi.fn(() => true);
  const readinessCurrent = vi.fn(() => true);
  const getStatus = vi.fn(async () => ({ effectiveEnabled: true }));
  const attest = vi.fn((status: { effectiveEnabled: boolean }) => {
    events.push("attest");
    if (!status.effectiveEnabled) throw new Error("containment not effective");
  });
  const release = vi.fn(() => events.push("release-ingress"));
  const failClosed = vi.fn(async () => {
    events.push("fail-closed");
  });
  const closeTransport = vi.fn();
  const invalidateRemote = vi.fn();
  const qr = new WeixinQrSession();
  const handlers = new Map<
    string,
    (event: unknown, params?: { accountId?: string; force?: boolean }) => Promise<unknown>
  >();
  const config = { plugins: { entries: { "openclaw-weixin": { enabled: true } } } };
  const context = {
    Error,
    structuredClone,
    ipcMain: {
      handle: (
        name: string,
        callback: (
          event: unknown,
          params?: { accountId?: string; force?: boolean },
        ) => Promise<unknown>,
      ) => handlers.set(name, callback),
    },
    assertTrustedRendererIpc: vi.fn(),
    WindowsNodeMxcWeixinAccountSession,
    assertWeixinLoginConfigUnchanged,
    createWeixinLoginApprovalConfiguration,
    shouldRevokeWeixinRemoteApprovalOwner,
    isKnownWeixinQrStartRejection,
    isWeixinLoginReady,
    isWindowsNodeMxcDesired: () => mode !== "off",
    getWindowsNodeMxcRequestedMode: () => mode,
    assertWindowsNodeMxcConfigurationMutable: vi.fn(() => {
      if (mode !== "off" || lifecycleBusy) throw new Error("MXC configuration locked");
    }),
    localModelService: { assertIdle: vi.fn() },
    sessionModelService: { assertIdle: vi.fn() },
    activeModelSessions: new Set<string>(),
    githubCopilotLoginInProgress: false,
    commandConsentUpdating: false,
    requireEffectiveWindowsNodeMxc: requireEffective,
    captureGatewayReadinessCheckpoint: () => readinessCurrent,
    gwClient: gateway,
    gatewayGenerationId: "gateway-generation",
    gatewayProcess: { pid: 123 },
    windowsNodeMxcApprovalProofContext: { policyFingerprint: "policy" },
    windowsNodeMxcWeixinRemoteApprovalServer: transport,
    windowsNodeMxcWeixinLogin: null,
    windowsNodeMxcActivationInProgress: false,
    weixinLoginProcess: null,
    weixinQrCancellation: null,
    weixinRuntimeRead: null,
    getWindowsNodeMxcFolderPolicy: () => ({ ro: ["C:\\Docs"], rw: ["C:\\Work"] }),
    readConfig: () => config,
    settingsStore: {
      get: (key: string) => settings.get(key),
      set: vi.fn((key: string, value: unknown) => {
        if (
          key === "windowsNodeMxcWeixinRemoteApproval" &&
          !(value as { enabled: boolean }).enabled
        )
          events.push("disable-remote");
        settings.set(key, value);
      }),
    },
    migrateWeixinRemoteApprovalConfiguration: (value: unknown) => structuredClone(value),
    readAuthenticatedWeixinWireOwner: () =>
      account.loggedIn && account.currentAccount?.userId
        ? { accountId: account.currentAccount.accountId, userId: account.currentAccount.userId }
        : null,
    readWeixinAccountStatus: readAccount,
    getWeixinRemoteApprovalActivationOptions: () => ({
      weixinEnabled: true,
      enableAvailable: true,
      invariantState: account.invariantState,
      account: account.currentAccount,
    }),
    getOpenClawStateDir: () => "fixture-state",
    isManagedGatewayProcessAlive: () => true,
    windowsNodeMxcLifecycleOperations: lifecycle,
    beginWindowsNodeMxcLifecycleOperation: () => {
      if (lifecycleBusy) throw new Error("Another MXC lifecycle operation is in progress");
      mutations.assertActivationAvailable(false);
      lifecycleBusy = true;
    },
    endWindowsNodeMxcLifecycleOperation: () => {
      lifecycleBusy = false;
    },
    isApplicationServiceReady: serviceReady,
    sendToWindow: vi.fn(),
    mainWindow: {},
    setWindowsNodeMxcLifecycleState: vi.fn(),
    closeWindowsNodeMxcIngress: vi.fn(() => events.push("close-ingress")),
    bundledWindowsNodeHost: host,
    allPendingWindowsNodeMxcGatewayApprovals: () => [],
    windowsNodeMxcWeixinRemoteApprovalBroker: broker,
    invalidateWindowsNodeMxcWeixinRemoteApproval: invalidateRemote,
    getWindowsNodeMxcStatus: getStatus,
    assertWindowsNodeMxcBaseReady: attest,
    releaseWindowsNodeMxcIngress: release,
    failClosedWindowsNodeMxc: failClosed,
    electronLifecycleDiagnostics: { log: vi.fn() },
    summarizeLifecycleError: (error: unknown) =>
      error instanceof Error ? error.message : String(error),
    weixinMutations: mutations,
    weixinQrSession: qr,
    closeWindowsNodeMxcWeixinRemoteApproval: closeTransport,
    reconcileWindowsNodeMxcWeixinRemoteApprovalOwner: vi.fn(),
  };
  runInNewContext(handlerJs, context);
  const invoke = (params = { accountId: owner.accountId }) => {
    const handler = handlers.get("plugin:weixin:disconnect");
    if (!handler) throw new Error("Disconnect IPC handler was not registered");
    return handler({}, params);
  };
  const cancel = () => {
    const handler = handlers.get("plugin:weixin:cancel-login");
    if (!handler) throw new Error("Cancel IPC handler was not registered");
    return handler({});
  };
  const startQr = (params = { force: false }) => {
    const handler = handlers.get("plugin:weixin:login-qr-start");
    if (!handler) throw new Error("QR start IPC handler was not registered");
    return handler({}, params);
  };
  return {
    invoke,
    cancel,
    startQr,
    context,
    events,
    settings,
    previousRemote,
    gateway,
    host,
    broker,
    lifecycle,
    mutations,
    request,
    requireEffective,
    serviceReady,
    readinessCurrent,
    getStatus,
    attest,
    release,
    failClosed,
    closeTransport,
    invalidateRemote,
    transport,
    qr,
    readAccount,
    setAccount: (next: WeixinAccountStatus) => {
      account = next;
    },
  };
}

describe("actual guarded WeChat QR startup", () => {
  it("does not start a QR while command consent settings are changing", async () => {
    const h = harness();
    h.context.commandConsentUpdating = true;
    expect(await h.startQr()).toMatchObject({
      ok: false,
      message: expect.stringContaining("Command consent settings are being applied"),
    });
    expect(h.gateway.weixinLoginQrStart).not.toHaveBeenCalled();
  });

  it.each(["full", "limited-dacl"] as const)(
    "returns the QR in %s without a preflight scan, but waits for fresh attestation before resuming",
    async (mode) => {
      const h = harness(mode);
      h.setAccount(absent());
      h.requireEffective.mockImplementation(() => new Promise(() => {}));
      let finishLogin!: (value: { connected: boolean; accountId: string; message: string }) => void;
      h.gateway.weixinLoginQrWait.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishLogin = resolve;
          }),
      );
      let finishAttestation!: (value: { effectiveEnabled: boolean }) => void;
      h.getStatus.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishAttestation = resolve;
          }),
      );

      const starting = h.startQr();
      await vi.waitFor(() => expect(h.gateway.weixinLoginQrStart).toHaveBeenCalledOnce());
      expect(await starting).toMatchObject({ ok: true, sessionKey: "qr-session" });
      expect(h.requireEffective).not.toHaveBeenCalled();
      expect(h.serviceReady).toHaveBeenCalled();
      expect(h.readinessCurrent).toHaveBeenCalledOnce();
      for (const step of ["close-ingress", "revoke-lease", "disable-remote"]) {
        expect(h.events).toContain(step);
        expect(h.events.indexOf(step)).toBeLessThan(h.events.indexOf("request-qr"));
      }
      expect(h.broker.configure).toHaveBeenLastCalledWith({ enabled: false, owner: null });
      expect(h.host.setActivationLease).not.toHaveBeenCalled();
      expect(h.getStatus).not.toHaveBeenCalled();
      expect(h.release).not.toHaveBeenCalled();
      expect(h.lifecycle.active).toBe(true);

      h.setAccount(present());
      finishLogin({ connected: true, accountId: owner.accountId, message: "Connected" });
      await vi.waitFor(() => expect(h.getStatus).toHaveBeenCalledOnce());
      expect(h.release).not.toHaveBeenCalled();
      expect(h.lifecycle.active).toBe(true);
      expect(h.qr.status.state).toBe("waiting");
      finishAttestation({ effectiveEnabled: true });
      await vi.waitFor(() => expect(h.qr.status.state).toBe("connected"));
      expect(h.release).toHaveBeenCalledOnce();
      expect(h.lifecycle.active).toBe(false);
    },
  );

  it.each(["service", "checkpoint"] as const)(
    "rejects a QR request when current MXC %s readiness is unavailable",
    async (gate) => {
      const h = harness();
      h.setAccount(absent());
      if (gate === "service") h.serviceReady.mockReturnValue(false);
      else h.readinessCurrent.mockReturnValue(false);
      expect(await h.startQr()).toMatchObject({
        ok: false,
        message: expect.stringContaining("MXC readiness"),
      });
      expect(h.gateway.weixinLoginQrStart).not.toHaveBeenCalled();
      expect(h.host.revokeActivationLease).not.toHaveBeenCalled();
      expect(h.requireEffective).not.toHaveBeenCalled();
      expect(h.lifecycle.active).toBe(false);
    },
  );

  it("fails closed if the fresh post-login attestation rejects containment", async () => {
    const h = harness();
    h.getStatus.mockResolvedValueOnce({ effectiveEnabled: false });
    h.gateway.weixinLoginQrWait.mockResolvedValueOnce({
      connected: true,
      accountId: owner.accountId,
      message: "Connected",
    });
    expect(await h.startQr()).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(h.qr.status.state).toBe("error"));
    expect(h.getStatus).toHaveBeenCalledOnce();
    expect(h.failClosed).toHaveBeenCalledOnce();
    expect(h.release).not.toHaveBeenCalled();
    expect(h.lifecycle.active).toBe(false);
  });

  it("rejects runtime drift during the channel check before requesting a QR", async () => {
    const h = harness();
    h.gateway.getChannelsStatus.mockImplementationOnce(async () => {
      h.gateway.connectionGeneration++;
      return { channels: { "openclaw-weixin": { enabled: true } } };
    });
    expect(await h.startQr()).toMatchObject({
      ok: false,
      message: expect.stringContaining("runtime changed"),
    });
    expect(h.gateway.weixinLoginQrStart).not.toHaveBeenCalled();
    expect(h.failClosed).toHaveBeenCalledOnce();
    expect(h.release).not.toHaveBeenCalled();
  });

  it("keeps Off-mode QR startup free of MXC gates and leases", async () => {
    const h = harness("off");
    h.serviceReady.mockReturnValue(false);
    h.readinessCurrent.mockReturnValue(false);
    h.gateway.weixinLoginQrWait.mockResolvedValueOnce({
      connected: true,
      accountId: owner.accountId,
      message: "Connected",
    });
    expect(await h.startQr()).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(h.qr.status.state).toBe("connected"));
    expect(h.requireEffective).not.toHaveBeenCalled();
    expect(h.readinessCurrent).not.toHaveBeenCalled();
    expect(h.host.revokeActivationLease).not.toHaveBeenCalled();
    expect(h.getStatus).not.toHaveBeenCalled();
  });
});

describe("actual guarded WeChat disconnect IPC handler", () => {
  it("does not disconnect while command consent settings are changing", async () => {
    const h = harness();
    h.context.commandConsentUpdating = true;
    await expect(h.invoke()).rejects.toThrow("Command consent settings are being applied");
    expect(h.request).not.toHaveBeenCalled();
  });

  it.each(["off", "full"] as const)(
    "disconnects in %s without replacing the Gateway",
    async (mode) => {
      const h = harness(mode);
      expect(await h.invoke()).toEqual({ ok: true });
      expect(h.context.assertTrustedRendererIpc).toHaveBeenCalledOnce();
      expect(h.request).toHaveBeenCalledExactlyOnceWith(
        "channels.logout",
        { channel: "openclaw-weixin", accountId: owner.accountId },
        10_000,
      );
      expect(h.readAccount()).toEqual(absent());
      expect(h.settings.get("windowsNodeMxcWeixinRemoteApproval")).toEqual({
        enabled: false,
        owner: null,
      });
      expect(h.lifecycle.active).toBe(false);
      expect(h.failClosed).not.toHaveBeenCalled();
      if (mode === "full") {
        expect(h.requireEffective).toHaveBeenCalledExactlyOnceWith(true);
        expect(h.events.indexOf("close-ingress")).toBeLessThan(h.events.indexOf("logout"));
        expect(h.events.indexOf("disable-remote")).toBeLessThan(h.events.indexOf("logout"));
        expect(h.events.indexOf("revoke-lease")).toBeLessThan(h.events.indexOf("logout"));
        expect(h.events.indexOf("logout")).toBeLessThan(h.events.indexOf("renew-lease"));
        expect(h.events.indexOf("attest")).toBeLessThan(h.events.indexOf("release-ingress"));
        expect(h.context.setWindowsNodeMxcLifecycleState).toHaveBeenCalledWith(
          "disconnecting-weixin",
          expect.any(String),
        );
        expect(h.context.setWindowsNodeMxcLifecycleState).toHaveBeenLastCalledWith("active");
        expect(h.closeTransport).not.toHaveBeenCalled();
        expect(h.transport.close).not.toHaveBeenCalled();
        expect(h.gateway.weixinResumeAfterLogin).not.toHaveBeenCalled();
      } else {
        expect(h.requireEffective).not.toHaveBeenCalled();
        expect(h.invalidateRemote).toHaveBeenCalledWith("weixin-logout");
        expect(h.host.revokeActivationLease).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects a stale requested account before acquiring a lifecycle or issuing logout", async () => {
    const h = harness();
    expect(await h.invoke({ accountId: "replacement" })).toEqual({
      ok: false,
      error: "The WeChat account changed; refresh its status first",
    });
    expect(h.requireEffective).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.host.revokeActivationLease).not.toHaveBeenCalled();
  });

  it("does not restore the former owner's remote authority if the account changed before locking", async () => {
    const h = harness();
    h.requireEffective.mockImplementationOnce(async () => {
      h.setAccount(present({ accountId: "replacement", userId: "replacement@im.wechat" }));
    });
    expect(await h.invoke()).toEqual({
      ok: false,
      error: "The WeChat account changed; refresh its status first",
    });
    expect(h.request).not.toHaveBeenCalled();
    expect(h.gateway.weixinResumeAfterLogin).toHaveBeenCalledOnce();
    expect(h.settings.get("windowsNodeMxcWeixinRemoteApproval")).toEqual({
      enabled: false,
      owner: null,
    });
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("restores the unchanged account and its prior authority after a known rejected logout", async () => {
    const h = harness();
    h.request.mockRejectedValueOnce(new GatewayRequestError("Not permitted", "FORBIDDEN"));
    expect(await h.invoke()).toEqual({ ok: false, error: "Not permitted" });
    expect(h.gateway.weixinResumeAfterLogin).toHaveBeenCalledOnce();
    expect(h.settings.get("windowsNodeMxcWeixinRemoteApproval")).toEqual(h.previousRemote);
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.failClosed).not.toHaveBeenCalled();
    expect(h.mutations.loginRequiresRestart).toBe(false);
  });

  it("restores the unchanged account when the Gateway explicitly reports it was not cleared", async () => {
    const h = harness();
    h.request.mockResolvedValueOnce({ cleared: false, loggedOut: false });
    expect(await h.invoke()).toEqual({ ok: false, error: "WeChat logout was not confirmed" });
    expect(h.gateway.weixinResumeAfterLogin).toHaveBeenCalledOnce();
    expect(h.settings.get("windowsNodeMxcWeixinRemoteApproval")).toEqual(h.previousRemote);
    expect(h.failClosed).not.toHaveBeenCalled();
  });

  it.each(["unknown RPC outcome", "account still present", "generation changed"] as const)(
    "fails closed and never reopens ingress for %s",
    async (failure) => {
      const h = harness();
      h.request.mockImplementationOnce(async () => {
        if (failure === "unknown RPC outcome") throw new Error("Gateway timed out");
        if (failure === "generation changed") {
          h.setAccount(absent());
          h.gateway.connectionGeneration++;
        }
        return { cleared: true, loggedOut: true };
      });
      await expect(h.invoke()).rejects.toThrow();
      expect(h.failClosed).toHaveBeenCalledOnce();
      expect(h.release).not.toHaveBeenCalled();
      expect(h.settings.get("windowsNodeMxcWeixinRemoteApproval")).toEqual({
        enabled: false,
        owner: null,
      });
      expect(h.mutations.loginRequiresRestart).toBe(true);
      expect(h.lifecycle.active).toBe(false);
    },
  );

  it("rejects a pending QR before pausing or mutating the account", async () => {
    const h = harness();
    h.mutations.beginQr();
    await expect(h.invoke()).rejects.toThrow("Finish or cancel the pending WeChat account change");
    expect(h.request).not.toHaveBeenCalled();
    expect(h.host.revokeActivationLease).not.toHaveBeenCalled();
  });

  it("does not let QR cancellation settle an in-flight disconnect guard", async () => {
    const h = harness();
    let finish!: (value: { cleared: boolean; loggedOut: boolean }) => void;
    h.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const disconnect = h.invoke();
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledOnce());
    expect(h.lifecycle.active).toBe(true);
    expect(h.context.windowsNodeMxcWeixinLogin).toBeNull();
    const cancellation = h.cancel();
    await Promise.resolve();
    expect(h.release).not.toHaveBeenCalled();
    await expect(h.invoke()).rejects.toThrow("already in progress");
    h.setAccount(absent());
    finish({ cleared: true, loggedOut: true });
    expect(await disconnect).toEqual({ ok: true });
    await cancellation;
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.lifecycle.active).toBe(false);
  });

  it("disconnects and opens a new QR in the same MXC generation, then reattests after login", async () => {
    const h = harness();
    expect(await h.invoke()).toEqual({ ok: true });
    let finish!: (value: { connected: boolean; accountId: string; message: string }) => void;
    h.gateway.weixinLoginQrWait.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const originalGateway = h.context.gwClient;
    const result = await h.startQr();
    expect(result).toMatchObject({
      ok: true,
      qrDataUrl: "https://example.test/qr",
      sessionKey: "qr-session",
    });
    expect(h.lifecycle.active).toBe(true);
    expect(h.qr.status.state).toBe("waiting");
    expect(h.gateway.weixinLoginQrStart).toHaveBeenCalledExactlyOnceWith({ force: false });
    expect(h.context.gwClient).toBe(originalGateway);
    expect(h.gateway.connectionGeneration).toBe(7);
    h.setAccount(present());
    finish({ connected: true, accountId: owner.accountId, message: "Connected" });
    await vi.waitFor(() => expect(h.qr.status.state).toBe("connected"));
    expect(h.lifecycle.active).toBe(false);
    expect(h.settings.get("windowsNodeMxcWeixinRemoteApproval")).toMatchObject({
      enabled: true,
      owner,
    });
    expect(h.release).toHaveBeenCalledTimes(2);
    expect(h.context.gwClient).toBe(originalGateway);
    expect(h.gateway.connectionGeneration).toBe(7);
    expect(h.failClosed).not.toHaveBeenCalled();
  });

  it("cancels a fresh QR after logout and restores MXC without resurrecting the old owner", async () => {
    const h = harness();
    await h.invoke();
    let finish!: (value: { connected: boolean; cancelled: boolean; message: string }) => void;
    h.gateway.weixinLoginQrWait.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    h.gateway.weixinLoginQrCancel.mockImplementationOnce(async () => {
      finish({ connected: false, cancelled: true, message: "Cancelled" });
      return { cancelled: true };
    });
    await h.startQr();
    expect(h.qr.status.state).toBe("waiting");
    await h.cancel();
    expect(h.gateway.weixinLoginQrCancel).toHaveBeenCalledExactlyOnceWith("qr-session");
    expect(h.qr.status.state).toBe("idle");
    expect(h.lifecycle.active).toBe(false);
    expect(h.settings.get("windowsNodeMxcWeixinRemoteApproval")).toEqual({
      enabled: false,
      owner: null,
    });
    expect(h.release).toHaveBeenCalledTimes(2);
    expect(h.failClosed).not.toHaveBeenCalled();
  });
});
