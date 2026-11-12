import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { WindowsNodeMxcRequestedMode } from "./windows-node-mxc-modes";
import { WindowsNodeMxcStatusCache } from "./windows-node-mxc-status-cache";
import { checkWindowsNodeMxcHealth } from "./windows-node-mxc-health-check";
import type { WindowsNodeMxcHeartbeatStatus } from "./windows-node-mxc-service";

const source = readFileSync(resolve(process.cwd(), "src", "main.ts"), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const declarations = [
  "presentWindowsNodeMxcDisplayStatus",
  "setWindowsNodeMxcLifecycleState",
  "getWindowsNodeMxcStatus",
  "getWindowsNodeMxcInspectionOptions",
  "inspectWindowsNodeMxcStatus",
  "requireEffectiveWindowsNodeMxc",
  "startHealthMonitor",
].map((name) => {
  const declaration = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!declaration) throw new Error(`Missing status function: ${name}`);
  return declaration.getText(ast);
});
const heartbeatCacheDeclaration = ast.statements.find(
  (node) =>
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(
      (declaration) => declaration.name.getText(ast) === "windowsNodeMxcHeartbeatCache",
    ),
);
if (!heartbeatCacheDeclaration) throw new Error("Missing heartbeat cache");
const js = ts.transpileModule(
  [...declarations, heartbeatCacheDeclaration.getText(ast)].join("\n"),
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  },
).outputText;

function harness(mode: WindowsNodeMxcRequestedMode) {
  let contextKey = "generation-policy-lease";
  let healthTick: (() => Promise<void>) | undefined;
  const cache = new WindowsNodeMxcStatusCache({
    key: () => contextKey,
    inspect: () => functions.inspectWindowsNodeMxcStatus(),
    publish: () => {},
  });
  const validate = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const snapshot = vi.fn(() => ({ nodeId: "a".repeat(64), ambientAccess: null }));
  const inspect = vi.fn(async (options) => ({
    desiredEnabled: mode !== "off",
    effectiveEnabled: mode !== "off" && !options.runtimeIntegrityError,
    blockers: options.runtimeIntegrityError ? [options.runtimeIntegrityError] : [],
  }));
  const inspectHeartbeat = vi.fn(
    async (options): Promise<WindowsNodeMxcHeartbeatStatus> => ({
      effectiveEnabled: mode !== "off" && !options.runtimeIntegrityError,
      gatewayPolicyState: "active",
      blockers: options.runtimeIntegrityError ? [options.runtimeIntegrityError] : [],
    }),
  );
  const setInterval = vi.fn((callback: () => Promise<void>, _interval: number) => {
    healthTick = callback;
    return 1;
  });
  const failClosed = vi.fn().mockResolvedValue(undefined);
  const renewLease = vi.fn().mockResolvedValue(undefined);
  const synchronousValidation = vi.fn(() => {
    throw new Error("Status must not invoke synchronous validation or identity");
  });
  const publishDisplay = vi.fn();
  const sendToWindow = vi.fn();
  const logError = vi.fn();
  const context = {
    Error,
    console: { error: logError },
    readConfig: () => ({}),
    getWindowsNodeMxcRequestedMode: () => mode,
    isWindowsNodeMxcDesired: () => mode !== "off",
    settingsStore: { get: () => null },
    getWindowsNodeMxcIngressBackup: () => null,
    getBundledWindowsNodeFolders: () => [],
    bundledWindowsNodeHost: {
      status: snapshot,
      validateRuntimeIntegrity: validate,
      getValidatedMxcExecutablePath: synchronousValidation,
      ensureIdentityNodeId: synchronousValidation,
      setActivationLease: renewLease,
    },
    inspectWindowsNodeMxc: inspect,
    inspectWindowsNodeMxcHeartbeat: inspectHeartbeat,
    gwClient: { connected: true },
    gatewaySpawnedByUs: true,
    isManagedGatewayProcessAlive: () => true,
    gatewayGenerationId: "generation",
    getWindowsNodeMxcDurableApprovalStore: () => ({ inspect: () => ({}) }),
    windowsNodeMxcSecurityTransitionInProgress: false,
    commandConsentUpdating: false,
    windowsNodeMxcLifecycleState: "idle",
    windowsNodeMxcLifecycleDetail: null as string | null,
    windowsNodeMxcLifecycleUpdatedAt: "",
    inspectWindowsNodeMxcHooksStatus: () => ({}),
    isExecutionRuntimeReady: () => false,
    isWindowsNodeMxcIngressReleased: () => true,
    windowsNodeMxcIngressGeneration: "generation",
    windowsNodeMxcActivationInProgress: false,
    failClosedWindowsNodeMxc: failClosed,
    captureGatewayReadinessCheckpoint: () => () => true,
    windowsNodeMxcStatusCache: cache,
    WindowsNodeMxcStatusCache,
    getWindowsNodeMxcStatusContextKey: () => contextKey,
    checkWindowsNodeMxcHealth,
    healthCheckInterval: null,
    setInterval,
    clearInterval: vi.fn(),
    HEALTH_CHECK_INTERVAL_MS: 30_000,
    explicitQuitRequested: false,
    gatewayStopPromise: null,
    gatewayRestarting: false,
    gatewayStatus: "running",
    gatewayPort: 18789,
    checkExistingGateway: vi.fn(async () => true),
    publishWindowsNodeMxcDisplayStatus: publishDisplay,
    electronLifecycleDiagnostics: { log: vi.fn() },
    summarizeLifecycleError: (message: string) => message,
    sendToWindow,
    mainWindow: {},
  };
  const functions = runInNewContext(
    `${js}\n({ presentWindowsNodeMxcDisplayStatus, setWindowsNodeMxcLifecycleState, getWindowsNodeMxcStatus, inspectWindowsNodeMxcStatus, requireEffectiveWindowsNodeMxc, startHealthMonitor, windowsNodeMxcHeartbeatCache })`,
    context,
  ) as {
    getWindowsNodeMxcStatus: () => Promise<{
      effectiveEnabled: boolean;
      lifecycleState: { phase: string; detail: string | null };
    }>;
    inspectWindowsNodeMxcStatus: () => Promise<{ effectiveEnabled: boolean }>;
    requireEffectiveWindowsNodeMxc: () => Promise<void>;
    startHealthMonitor: () => void;
    windowsNodeMxcHeartbeatCache: WindowsNodeMxcStatusCache<WindowsNodeMxcHeartbeatStatus>;
    setWindowsNodeMxcLifecycleState: (phase: string, detail?: string | null) => void;
    presentWindowsNodeMxcDisplayStatus: (snapshot: {
      status: {
        effectiveEnabled: boolean;
        lifecycleState: { phase: string; detail: string | null };
      };
      verifiedAt: number;
      refreshing: boolean;
      error: null;
    }) => { status: { lifecycleState: { phase: string; detail: string | null } } };
  };
  return {
    ...functions,
    validate,
    snapshot,
    inspect,
    inspectHeartbeat,
    failClosed,
    renewLease,
    synchronousValidation,
    cache,
    publishDisplay,
    sendToWindow,
    logError,
    setInterval,
    runHealthTick: () => {
      if (!healthTick) throw new Error("Health monitor was not started");
      return healthTick();
    },
    changeContext: () => {
      contextKey += "-changed";
    },
    setLifecycleFailure: (detail: string) => {
      context.windowsNodeMxcLifecycleState = "failed";
      context.windowsNodeMxcLifecycleDetail = detail;
    },
  };
}

describe("main-process Windows node MXC status", () => {
  it.each(["full"] as const)(
    "awaits fresh asynchronous validation before inspecting %s",
    async (mode) => {
      const test = harness(mode);
      let release!: () => void;
      test.validate.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const status = test.getWindowsNodeMxcStatus();
      await Promise.resolve();
      expect(test.validate).toHaveBeenCalledWith();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(test.snapshot).not.toHaveBeenCalled();
      expect(test.inspect).not.toHaveBeenCalled();
      release();
      await status;
      expect(test.snapshot).toHaveBeenCalledTimes(1);
      expect(test.inspect).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedMode: mode,
          bundledHost: { nodeId: "a".repeat(64), ambientAccess: null },
          runtimeIntegrityError: undefined,
        }),
      );
      expect(test.synchronousValidation).not.toHaveBeenCalled();
    },
  );

  it("does not validate the backend merely to inspect Off status", async () => {
    const test = harness("off");
    await expect(test.getWindowsNodeMxcStatus()).resolves.toMatchObject({
      effectiveEnabled: false,
    });
    expect(test.validate).not.toHaveBeenCalled();
    expect(test.synchronousValidation).not.toHaveBeenCalled();
    expect(test.inspect).toHaveBeenCalledWith(
      expect.objectContaining({ requestedMode: "off", runtimeIntegrityError: undefined }),
    );
  });

  it("preserves a failed Off lifecycle in fresh and displayed status", async () => {
    const test = harness("off");
    test.setLifecycleFailure("Cron resume acknowledgement timed out");
    const status = await test.getWindowsNodeMxcStatus();
    expect(status.lifecycleState).toMatchObject({
      phase: "failed",
      detail: "Cron resume acknowledgement timed out",
    });
    expect(
      test.presentWindowsNodeMxcDisplayStatus({
        status,
        verifiedAt: 100,
        refreshing: false,
        error: null,
      }).status.lifecycleState,
    ).toMatchObject({
      phase: "failed",
      detail: "Cron resume acknowledgement timed out",
    });
  });

  it("reports an unreadable display context without failing a lifecycle update", () => {
    const test = harness("off");
    vi.spyOn(test.cache, "snapshot").mockImplementationOnce(() => {
      throw new Error("Status context unavailable");
    });
    expect(() => test.setWindowsNodeMxcLifecycleState("idle")).not.toThrow();
    expect(test.publishDisplay).toHaveBeenCalledExactlyOnceWith({
      status: null,
      verifiedAt: null,
      refreshing: false,
      error: "Status context unavailable",
    });
    expect(test.logError).toHaveBeenCalledWith(
      "[windows-node-mxc] Could not publish lifecycle status:",
      "Status context unavailable",
    );
    expect(test.sendToWindow).toHaveBeenCalledWith(
      expect.anything(),
      "windows-node-mxc:lifecycle-state",
      expect.objectContaining({ phase: "idle" }),
    );
  });

  it("keeps a lifecycle update independent of failed display-error publication", () => {
    const test = harness("off");
    test.publishDisplay.mockImplementation(() => {
      throw new Error("Display unavailable");
    });
    expect(() => test.setWindowsNodeMxcLifecycleState("idle")).not.toThrow();
    expect(test.publishDisplay).toHaveBeenCalledTimes(2);
    expect(test.logError).toHaveBeenCalledTimes(2);
    expect(test.sendToWindow).toHaveBeenCalledWith(
      expect.anything(),
      "windows-node-mxc:lifecycle-state",
      expect.objectContaining({ phase: "idle" }),
    );
  });

  it.each(["full"] as const)("preserves runtime integrity errors in %s status", async (mode) => {
    const test = harness(mode);
    test.validate.mockRejectedValue(new Error("resource tree hash mismatch"));
    await expect(test.getWindowsNodeMxcStatus()).resolves.toMatchObject({
      effectiveEnabled: false,
    });
    expect(test.inspect).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeIntegrityError: "resource tree hash mismatch",
      }),
    );
    expect(test.synchronousValidation).not.toHaveBeenCalled();
  });

  it("revalidates every enabled ingress check rather than trusting a previous snapshot", async () => {
    const test = harness("full");
    await test.requireEffectiveWindowsNodeMxc();
    expect(test.renewLease).toHaveBeenCalledTimes(1);
    test.validate.mockRejectedValue(new Error("resource tree hash mismatch"));
    await expect(test.requireEffectiveWindowsNodeMxc()).rejects.toThrow("execution is blocked");
    expect(test.validate).toHaveBeenCalledTimes(2);
    expect(test.validate).toHaveBeenLastCalledWith();
    expect(test.failClosed).toHaveBeenCalledWith(
      "Runtime attestation drifted: resource tree hash mismatch",
    );
    expect(test.renewLease).toHaveBeenCalledTimes(1);
  });

  it("uses only the heartbeat inspector for periodic checks and renews the lease", async () => {
    const test = harness("full");
    test.startHealthMonitor();
    expect(test.setInterval).toHaveBeenCalledWith(expect.any(Function), 30_000);
    await test.runHealthTick();
    await test.runHealthTick();
    expect(test.inspect).not.toHaveBeenCalled();
    expect(test.inspectHeartbeat).toHaveBeenCalledTimes(2);
    expect(test.validate).toHaveBeenCalledTimes(2);
    expect(test.renewLease).toHaveBeenCalledTimes(2);
    expect(test.renewLease).toHaveBeenLastCalledWith("active", 120_000);
    expect(test.failClosed).not.toHaveBeenCalled();
    expect(test.cache.snapshot().status).toBeNull();
    expect(test.publishDisplay).not.toHaveBeenCalled();
  });

  it("does not share a pending or failed full inspection with the heartbeat", async () => {
    const test = harness("full");
    let finish!: (value: Awaited<ReturnType<typeof test.inspect>>) => void;
    test.inspect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const fullStatus = test.getWindowsNodeMxcStatus();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(test.inspect).toHaveBeenCalledOnce();
    test.startHealthMonitor();
    await test.runHealthTick();
    expect(test.renewLease).toHaveBeenCalledOnce();
    expect(test.cache.snapshot().refreshing).toBe(true);
    finish({ desiredEnabled: true, effectiveEnabled: false, blockers: ["SDK probe timed out"] });
    await fullStatus;
    await test.runHealthTick();
    expect(test.renewLease).toHaveBeenCalledTimes(2);
    expect(test.failClosed).not.toHaveBeenCalled();
    expect(test.cache.snapshot().status?.effectiveEnabled).toBe(false);
    expect(test.windowsNodeMxcHeartbeatCache.snapshot().status?.effectiveEnabled).toBe(true);
  });

  it("refreshes heartbeat evidence if the configuration changes during inspection", async () => {
    const test = harness("full");
    test.inspectHeartbeat.mockImplementationOnce(async () => {
      test.changeContext();
      return { effectiveEnabled: true, gatewayPolicyState: "active", blockers: [] };
    });
    test.startHealthMonitor();
    await test.runHealthTick();
    expect(test.inspectHeartbeat).toHaveBeenCalledTimes(2);
    expect(test.renewLease).toHaveBeenCalledOnce();
    expect(test.failClosed).not.toHaveBeenCalled();
  });

  it("still locks the periodic heartbeat on a runtime integrity failure", async () => {
    const test = harness("full");
    test.validate.mockRejectedValue(new Error("resource tree hash mismatch"));
    test.startHealthMonitor();
    await test.runHealthTick();
    expect(test.inspect).not.toHaveBeenCalled();
    expect(test.inspectHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeIntegrityError: "resource tree hash mismatch" }),
    );
    expect(test.renewLease).not.toHaveBeenCalled();
    expect(test.failClosed).toHaveBeenCalledWith("Readiness drifted: resource tree hash mismatch");
  });
});
