import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { t, resolveSupportedLocale } from "./i18n";
import { classifyMxcProbe, type MxcProbeResult } from "./windows-node-mxc";
import {
  createWindowsNodeMxcSelection,
  type WindowsNodeMxcRequestedMode,
} from "./windows-node-mxc-modes";
import { WindowsNodeMxcLifecycleOperationCoordinator } from "./windows-node-mxc-lifecycle-operation";
import {
  preflightWindowsNodeMxcBackend,
  probeWindowsNodeMxcAutomaticMode,
} from "./windows-node-mxc-service";
import {
  assertNativeWeixinRemoteApprovalAuthority,
  planWeixinRemoteApprovalNativeTransition,
} from "./windows-node-mxc-weixin-remote-approval-consent";
import {
  planWeixinRemoteApprovalTransition,
  revalidateAutomaticWeixinRemoteApprovalSelection,
  type WeixinRemoteApprovalActivationOptions,
} from "./windows-node-mxc-weixin-remote-approval-activation";
import { WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT } from "./windows-node-mxc-weixin-remote-approval";

const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
const handlerSource = source.slice(
  source.search(/ipcMain\.handle\(\s*"windows-node-mxc:set-enabled"/u),
  source.search(/ipcMain\.handle\(\s*"windows-node-mxc:approval-respond"/u),
);
const handlerJs = ts.transpileModule(handlerSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const probe = (tier: string) => classifyMxcProbe(0, JSON.stringify({ tier }), "");
const owner = { accountId: "exact-bot@im.wechat", userId: "exact-user@im.wechat" };
const eligible = (): WeixinRemoteApprovalActivationOptions => ({
  weixinEnabled: true,
  linkedAccountCount: 1,
  authenticatedAccountCount: 1,
  invariantState: "single",
  account: { ...owner },
  enableAvailable: true,
  unavailableReason: null,
});
const noAccount = (): WeixinRemoteApprovalActivationOptions => ({
  ...eligible(),
  linkedAccountCount: 0,
  authenticatedAccountCount: 0,
  invariantState: "none",
  account: null,
  enableAvailable: false,
  unavailableReason: "no-account",
});

function harness(initialMode: WindowsNodeMxcRequestedMode = "off") {
  let invoke!: (event: unknown, params: unknown) => Promise<unknown>;
  const saved = new Map<string, unknown>([
    ["windowsNodeMxcSelection", createWindowsNodeMxcSelection(initialMode, true)],
    ["windowsNodeMxcFolders", { rw: ["C:\\Work"], ro: ["C:\\Docs"] }],
    ["windowsNodeMxcToolBackups", {}],
  ]);
  const settingsStore = {
    get: (key: string) => saved.get(key),
    set: vi.fn((key: string, value: unknown) => saved.set(key, value)),
    delete: vi.fn((key: string) => saved.delete(key)),
  };
  const getSelection = () =>
    saved.get("windowsNodeMxcSelection") as ReturnType<typeof createWindowsNodeMxcSelection>;
  const getStatus = vi.fn(async () => ({
    requestedMode: getSelection().requestedMode,
    desiredEnabled: getSelection().requestedMode !== "off",
  }));
  const probeRunner = vi
    .fn<() => Promise<MxcProbeResult>>()
    .mockResolvedValue(probe("base-container"));
  const nativeDialog = vi.fn().mockResolvedValue({ response: 1 });
  const readOptions = vi
    .fn<() => WeixinRemoteApprovalActivationOptions>()
    .mockReturnValue(noAccount());
  const coordinator = new WindowsNodeMxcLifecycleOperationCoordinator();
  const stop = vi.fn().mockResolvedValue(undefined);
  const start = vi.fn().mockResolvedValue(undefined);
  const revokeLease = vi.fn();
  const persistRemote = vi.fn();
  const writeConfig = vi.fn();
  const revokeApprovals = vi.fn();
  const ready = vi.fn(async () => getStatus());
  const prepare = vi.fn(async (mode: "full" | "limited-dacl") => {
    const result = await preflightWindowsNodeMxcBackend("fixture-runtime", mode, probeRunner);
    return { effectiveTier: result.tier, ambientAccess: null };
  });
  const app = { getPath: () => "fixture-data", relaunch: vi.fn(), quit: vi.fn(), exit: vi.fn() };
  const window = { isDestroyed: () => false, close: vi.fn(), webContents: { send: vi.fn() } };
  const context = {
    ipcMain: {
      handle: (_channel: string, callback: typeof invoke) => {
        invoke = callback;
      },
    },
    assertTrustedRendererIpc: vi.fn(),
    assertNativeWeixinRemoteApprovalAuthority,
    windowsNodeMxcLifecycleOperations: coordinator,
    windowsNodeMxcLifecycleOperationHooks: () => ({ beforeStart: vi.fn(), afterSettled: vi.fn() }),
    localModelService: { assertIdle: vi.fn() },
    sessionModelService: { assertIdle: vi.fn() },
    migrateWeixinRemoteApprovalConfiguration: () => ({ enabled: false, owner: null }),
    settingsStore,
    getWindowsNodeMxcSelection: getSelection,
    getWindowsNodeMxcRequestedMode: () => getSelection().requestedMode,
    getWindowsNodeMxcStatus: getStatus,
    isWindowsNodeMxcDesired: () => getSelection().requestedMode !== "off",
    gwClient: { connected: true },
    gatewaySpawnedByUs: true,
    isManagedGatewayProcessAlive: () => true,
    readConfig: () => ({ gateway: { port: 18789 } }),
    probeWindowsNodeMxcAutomaticMode: () =>
      probeWindowsNodeMxcAutomaticMode("fixture-runtime", probeRunner),
    bundledWindowsNodeHost: {
      getValidatedMxcExecutablePath: () => "fixture-runtime",
      revokeActivationLease: revokeLease,
      ensureIdentityNodeId: vi.fn(() => "exact-node"),
    },
    planWeixinRemoteApprovalNativeTransition,
    getWeixinRemoteApprovalActivationOptions: readOptions,
    resolveSupportedLocale,
    mainT: t,
    mainWindow: window,
    dialog: { showMessageBox: nativeDialog },
    createWindowsNodeMxcSelection,
    shouldSuspendWindowsNodeMxcCronBeforePreflight: (current: string, next: string) =>
      current === "off" && next !== "off",
    gatewayPort: 18789,
    DEFAULT_PORT: 18789,
    setWindowsNodeMxcLifecycleState: vi.fn(),
    setGatewayStatus: vi.fn(),
    closeWindowsNodeMxcIngress: vi.fn(),
    windowsNodeMxcActivationInProgress: false,
    sendToWindow: vi.fn(),
    stopGatewayForSecurityTransition: stop,
    prepareWindowsNodeMxcContainment: prepare,
    windowsNodeMxcReadinessTransitionId: "exact-transition",
    electronLifecycleDiagnostics: { log: vi.fn() },
    summarizeLifecycleError: (message: string) => message,
    applyWindowsNodeMxcGatewayPolicy: (config: unknown) => ({ config, backups: {} }),
    planWeixinRemoteApprovalTransition,
    revalidateAutomaticWeixinRemoteApprovalSelection,
    persistWindowsNodeMxcWeixinRemoteApprovalPlan: persistRemote,
    withWindowsNodeMxcDurableApprovalLock: (operation: () => unknown) => operation(),
    getWindowsNodeMxcDurableApprovalStore: () => ({ revokeAll: revokeApprovals }),
    writeConfigTextAtomically: writeConfig,
    runAutomaticWindowsNodeMxcReadiness: ready,
    stopBundledWindowsNodeHost: vi.fn(),
    randomUUID: () => "exact-token",
    app,
    path: { join: (...parts: string[]) => parts.join("\\") },
    fs: { mkdirSync: vi.fn() },
    createWindowsNodeMxcCronResumeFence: () => ({}),
    restoreWindowsNodeMxcGatewayPolicy: (config: unknown) => config,
    startGateway: start,
    waitForManagedGatewayConnection: vi.fn().mockResolvedValue(undefined),
    waitForWindowsNodeMxcCronResumeAcknowledgement: vi.fn().mockResolvedValue(undefined),
    failClosedWindowsNodeMxc: vi.fn().mockResolvedValue(undefined),
    notifyRendererApplicationReady: vi.fn(),
  };
  runInNewContext(handlerJs, context);
  return {
    invoke: (enabled: boolean) => invoke({}, { enabled }),
    raw: (request: unknown) => invoke({}, request),
    context,
    saved,
    settingsStore,
    nativeDialog,
    coordinator,
    probeRunner,
    stop,
    start,
    revokeLease,
    persistRemote,
    writeConfig,
    revokeApprovals,
    ready,
    prepare,
    readOptions,
  };
}

describe("actual main-process sandbox-toggle IPC handler", () => {
  it.each(["full", "limited-dacl", "off"] as const)(
    "cancels from %s before any persistent mutation, process restart, lease or approval revocation",
    async (initialMode) => {
      const h = harness(initialMode);
      h.nativeDialog.mockResolvedValue({ response: 0 });
      const before = [...h.saved];
      await h.invoke(initialMode === "off");
      expect([...h.saved]).toEqual(before);
      for (const effect of [
        h.settingsStore.set,
        h.settingsStore.delete,
        h.stop,
        h.start,
        h.revokeLease,
        h.persistRemote,
        h.writeConfig,
        h.revokeApprovals,
        h.ready,
        h.prepare,
        h.context.closeWindowsNodeMxcIngress,
      ])
        expect(effect).not.toHaveBeenCalled();
      expect(h.nativeDialog).toHaveBeenCalledOnce();
      expect(h.coordinator.active).toBe(false);
    },
  );

  it.each(["base-container", "appcontainer-bfs", "appcontainer-dacl"])(
    "automatically selects %s, revalidates that selection, and restarts only the backend",
    async (tier) => {
      const h = harness();
      h.probeRunner.mockResolvedValue(probe(tier));
      await h.invoke(true);
      const expected = tier === "appcontainer-dacl" ? "limited-dacl" : "full";
      expect(h.probeRunner).toHaveBeenCalledTimes(2);
      expect(h.prepare).toHaveBeenCalledExactlyOnceWith(expected);
      expect(h.nativeDialog).toHaveBeenCalledOnce();
      expect(h.saved.get("windowsNodeMxcSelection")).toMatchObject({
        requestedMode: expected,
        limitedFilesystemAcknowledgedAt: expected === "limited-dacl" ? expect.any(String) : null,
      });
      expect(h.saved.get("windowsNodeMxcFolders")).toEqual({ rw: ["C:\\Work"], ro: ["C:\\Docs"] });
      expect(h.stop).toHaveBeenCalledOnce();
      expect(h.ready).toHaveBeenCalledOnce();
      expect(h.context.app.relaunch).not.toHaveBeenCalled();
      expect(h.context.app.quit).not.toHaveBeenCalled();
      expect(h.context.app.exit).not.toHaveBeenCalled();
      expect(h.context.mainWindow.close).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      invariantState: "none",
      account: null,
      enableAvailable: false,
      unavailableReason: "no-account",
    },
    { account: { ...owner, accountId: "replacement-account" } },
    { account: { ...owner, userId: "replacement-user" } },
    { weixinEnabled: false },
    { enableAvailable: false, unavailableReason: "account-disabled" },
  ] satisfies Partial<WeixinRemoteApprovalActivationOptions>[])(
    "activates sandboxing once without rebinding a changed WeChat owner: %j",
    async (change) => {
      const changed: WeixinRemoteApprovalActivationOptions = { ...eligible(), ...change };
      for (const stage of ["confirmation", "locked"] as const) {
        const h = harness();
        h.readOptions.mockReturnValue(eligible());
        const replaceAccount = () => h.readOptions.mockReturnValue(changed);
        if (stage === "confirmation") {
          h.nativeDialog.mockImplementation(async () => {
            replaceAccount();
            return { response: 1 };
          });
        } else {
          h.prepare.mockImplementation(async () => {
            replaceAccount();
            return { effectiveTier: "base-container", ambientAccess: null };
          });
        }
        await h.invoke(true);
        expect(h.saved.get("windowsNodeMxcSelection")).toMatchObject({ requestedMode: "full" });
        expect(h.nativeDialog).toHaveBeenCalledOnce();
        expect(h.prepare).toHaveBeenCalledOnce();
        expect(h.stop).toHaveBeenCalledOnce();
        expect(h.ready).toHaveBeenCalledOnce();
        expect(h.persistRemote).toHaveBeenCalledExactlyOnceWith(
          { action: "persist", configuration: { enabled: false, owner: null } },
          "activation-disabled",
        );
        expect(h.context.electronLifecycleDiagnostics.log).toHaveBeenCalledWith(
          "mxc-weixin-enrollment-disabled",
          {
            stage,
            reason: !changed.weixinEnabled
              ? "channel-disabled"
              : (changed.unavailableReason ?? "owner-no-longer-eligible"),
          },
        );
        expect(h.context.app.relaunch).not.toHaveBeenCalled();
      }
    },
  );

  it("does not opportunistically enroll an account that appears after the initial selection", async () => {
    const h = harness();
    h.readOptions.mockReturnValueOnce(noAccount()).mockReturnValue(eligible());
    await h.invoke(true);
    expect(h.ready).toHaveBeenCalledOnce();
    expect(h.nativeDialog).toHaveBeenCalledOnce();
    expect(h.persistRemote).toHaveBeenCalledExactlyOnceWith(
      { action: "persist", configuration: { enabled: false, owner: null } },
      "activation-disabled",
    );
  });

  it("enrolls only the still-identical eligible owner at the locked boundary without durable scope", async () => {
    const h = harness();
    h.readOptions.mockReturnValue(eligible());
    await h.invoke(true);
    expect(h.readOptions).toHaveBeenCalledTimes(3);
    expect(h.persistRemote).toHaveBeenCalledExactlyOnceWith(
      {
        action: "persist",
        configuration: {
          enabled: true,
          owner: {
            ...owner,
            contract: WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT,
            boundAt: expect.any(String),
          },
        },
      },
      "activation-disabled",
    );
    expect(h.ready).toHaveBeenCalledOnce();
    expect(h.nativeDialog).toHaveBeenCalledOnce();
  });

  it.each(["confirmation", "locked"] as const)(
    "does not turn a WeChat account read failure at %s into successful activation",
    async (stage) => {
      const h = harness();
      h.readOptions.mockReturnValueOnce(eligible());
      if (stage === "locked") h.readOptions.mockReturnValueOnce(eligible());
      h.readOptions.mockImplementationOnce(() => {
        throw new Error("Account read failed");
      });
      await expect(h.invoke(true)).rejects.toThrow("Account read failed");
      expect(h.ready).not.toHaveBeenCalled();
      expect(h.persistRemote).not.toHaveBeenCalled();
      expect(h.saved.get("windowsNodeMxcSelection")).toMatchObject({ requestedMode: "off" });
      expect(h.nativeDialog).toHaveBeenCalledOnce();
    },
  );

  it.each([
    classifyMxcProbe(null, "", "", "failed probe"),
    classifyMxcProbe(0, JSON.stringify({ supported: false }), ""),
  ])("rejects failed/no-tier probes before confirmation or mutation: %j", async (result) => {
    const h = harness();
    h.probeRunner.mockResolvedValue(result);
    await expect(h.invoke(true)).rejects.toThrow("No supported MXC sandbox");
    expect(h.nativeDialog).not.toHaveBeenCalled();
    expect(h.settingsStore.set).not.toHaveBeenCalled();
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.coordinator.active).toBe(false);
  });

  it.each([
    ["base-container", "appcontainer-dacl"],
    ["appcontainer-dacl", "base-container"],
  ])(
    "does not substitute %s with changed %s capability under the same confirmation",
    async (before, after) => {
      const h = harness();
      h.probeRunner.mockResolvedValueOnce(probe(before)).mockResolvedValueOnce(probe(after));
      await expect(h.invoke(true)).rejects.toThrow("No eligible MXC");
      expect(h.nativeDialog).toHaveBeenCalledOnce();
      expect(h.probeRunner).toHaveBeenCalledTimes(2);
      expect(h.saved.get("windowsNodeMxcSelection")).toMatchObject({ requestedMode: "off" });
      expect(h.persistRemote).not.toHaveBeenCalled();
      expect(h.ready).not.toHaveBeenCalled();
      expect(h.start).toHaveBeenCalledOnce();
    },
  );

  it("keeps an existing Full selection on an activation failure instead of downgrading or going Off", async () => {
    const h = harness("full");
    h.probeRunner.mockResolvedValue(probe("appcontainer-dacl"));
    await expect(h.invoke(true)).rejects.toThrow("No eligible MXC exact-containment");
    expect(h.probeRunner).toHaveBeenCalledOnce();
    expect(h.prepare).toHaveBeenCalledExactlyOnceWith("full");
    expect(h.saved.get("windowsNodeMxcSelection")).toMatchObject({ requestedMode: "full" });
    expect(h.context.failClosedWindowsNodeMxc).toHaveBeenCalledOnce();
    expect(h.start).not.toHaveBeenCalled();
  });

  it("turns Off through the existing standard-backend lifecycle without deleting folders or remembered commands", async () => {
    const h = harness("full");
    await h.invoke(false);
    expect(h.nativeDialog).toHaveBeenCalledOnce();
    expect(h.saved.get("windowsNodeMxcSelection")).toMatchObject({ requestedMode: "off" });
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.persistRemote).toHaveBeenCalledWith(
      { action: "persist", configuration: { enabled: false, owner: null } },
      "mxc-off",
    );
    expect(h.revokeApprovals).not.toHaveBeenCalled();
    expect(h.probeRunner).not.toHaveBeenCalled();
    expect(h.context.app.relaunch).not.toHaveBeenCalled();
  });

  it("reports an Off restart failure without relaunching Electron or claiming a ready backend", async () => {
    const h = harness("full");
    h.start.mockRejectedValueOnce(new Error("Standard backend startup failed"));
    await expect(h.invoke(false)).rejects.toThrow("Standard backend startup failed");
    expect(h.context.setGatewayStatus).toHaveBeenCalledWith("failed");
    expect(h.context.notifyRendererApplicationReady).not.toHaveBeenCalled();
    expect(h.context.app.relaunch).not.toHaveBeenCalled();
    expect(h.context.mainWindow.close).not.toHaveBeenCalled();
    expect(h.coordinator.active).toBe(false);
  });

  it("does not retry or select a weaker tier after active-readiness failure", async () => {
    const h = harness();
    h.ready.mockRejectedValueOnce(new Error("Active readiness failed"));
    await expect(h.invoke(true)).rejects.toThrow("Active readiness failed");
    expect(h.saved.get("windowsNodeMxcSelection")).toMatchObject({ requestedMode: "full" });
    expect(h.prepare).toHaveBeenCalledExactlyOnceWith("full");
    expect(h.nativeDialog).toHaveBeenCalledOnce();
    expect(h.start).not.toHaveBeenCalled();
    expect(h.coordinator.active).toBe(false);
  });

  it("joins duplicate On requests during native confirmation and rejects a conflicting Off request", async () => {
    const h = harness();
    let decide!: (value: { response: number }) => void;
    h.nativeDialog.mockReturnValue(
      new Promise((resolve) => {
        decide = resolve;
      }),
    );
    const first = h.invoke(true);
    await vi.waitFor(() => expect(h.nativeDialog).toHaveBeenCalledOnce());
    const duplicate = h.invoke(true);
    await expect(h.invoke(false)).rejects.toThrow("Another Windows Node + MXC lifecycle");
    decide({ response: 0 });
    await Promise.all([first, duplicate]);
    expect(h.nativeDialog).toHaveBeenCalledOnce();
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.coordinator.active).toBe(false);
  });

  it.each([
    { enabled: "yes" },
    {},
    { enabled: true, requestedMode: "limited-dacl" },
    { enabled: true, remoteApproval: { enabled: true, owner: {} } },
  ])(
    "rejects invalid or renderer-authoritative requests before acquiring the lifecycle: %j",
    async (request) => {
      const h = harness();
      await expect(h.raw(request)).rejects.toThrow();
      expect(h.coordinator.active).toBe(false);
      expect(h.nativeDialog).not.toHaveBeenCalled();
      expect(h.settingsStore.set).not.toHaveBeenCalled();
    },
  );
});
