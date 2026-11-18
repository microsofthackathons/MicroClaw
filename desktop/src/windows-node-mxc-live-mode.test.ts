import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { applyLiveSandboxMode, type LiveSandboxModeHooks } from "./windows-node-mxc-live-mode";

const mainSource = readFileSync(resolve(process.cwd(), "src", "main.ts"), "utf8");
const transitionStart = mainSource.indexOf("async function changeWindowsNodeMxcMode(");
const transitionEnd = mainSource.indexOf(
  "async function applyRunningWindowsNodeMxcFolders(",
  transitionStart,
);
if (transitionStart < 0 || transitionEnd < 0) {
  throw new Error("Cannot locate the live sandbox mode transition");
}
const transitionJs = ts.transpileModule(
  `${mainSource.slice(transitionStart, transitionEnd)}
  globalThis.testChangeWindowsNodeMxcMode = changeWindowsNodeMxcMode;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;

function hooks() {
  const calls: string[] = [];
  const step = (name: string) =>
    vi.fn(async () => {
      calls.push(name);
    });
  const status = { active: true };
  const operations: LiveSandboxModeHooks<typeof status> = {
    preflight: step("preflight"),
    lock: step("lock"),
    persist: step("persist"),
    publish: step("publish"),
    verify: vi.fn(async () => {
      calls.push("verify");
      return status;
    }),
    release: vi.fn(async () => {
      calls.push("release");
    }),
    failClosed: vi.fn(async () => {
      calls.push("failClosed");
    }),
  };
  return { calls, operations, status };
}

describe("live sandbox mode transaction", () => {
  it("locks before persisting, publishes and verifies before releasing", async () => {
    const { calls, operations, status } = hooks();
    await expect(applyLiveSandboxMode(operations)).resolves.toBe(status);
    expect(calls).toEqual(["preflight", "lock", "persist", "publish", "verify", "release"]);
    expect(operations.release).toHaveBeenCalledWith(status);
  });

  it("does not mutate or relock when preflight fails", async () => {
    const { calls, operations } = hooks();
    const error = new Error("unsupported");
    vi.mocked(operations.preflight).mockRejectedValue(error);
    await expect(applyLiveSandboxMode(operations)).rejects.toBe(error);
    expect(calls).toEqual([]);
    expect(operations.failClosed).not.toHaveBeenCalled();
  });

  it.each(["lock", "persist", "publish", "verify", "release"] as const)(
    "fails closed if %s fails",
    async (stage) => {
      const { calls, operations } = hooks();
      const error = new Error(`${stage} failed`);
      vi.mocked(operations[stage]).mockRejectedValue(error);
      await expect(applyLiveSandboxMode(operations)).rejects.toBe(error);
      expect(calls.at(-1)).toBe("failClosed");
      expect(operations.failClosed).toHaveBeenCalledWith(error);
      if (stage !== "release") expect(operations.release).not.toHaveBeenCalled();
    },
  );

  it("reports both the transition and recovery failure", async () => {
    const { operations } = hooks();
    const transitionError = new Error("publish failed");
    const recoveryError = new Error("lock failed");
    vi.mocked(operations.publish).mockRejectedValue(transitionError);
    vi.mocked(operations.failClosed).mockRejectedValue(recoveryError);
    await expect(applyLiveSandboxMode(operations)).rejects.toMatchObject({
      errors: [transitionError, recoveryError],
      cause: recoveryError,
    });
  });

  function modeReleaseHarness(previousMode: "off" | "full") {
    const events: string[] = [];
    const generation = "gateway-generation";
    const proof = {
      gatewayGeneration: generation,
      nodeId: "node",
      secretBase64: "secret",
      readinessTransitionId: "transition",
      policyFingerprint: "policy",
    };
    const hostStatus = {
      processRunning: true,
      processId: 321,
      gatewayGeneration: generation,
      requestedStrength: previousMode as "off" | "full",
      policyFingerprint: proof.policyFingerprint,
    };
    const rollback = vi.fn(() => events.push("instructions:rollback"));
    const synchronize = vi.fn((enabled: boolean) => {
      events.push(`instructions:${enabled}`);
      return { updatedFiles: [], rollback };
    });
    const release = vi.fn(() => events.push("ingress:release"));
    let captured: LiveSandboxModeHooks<unknown> | undefined;
    const context = {
      testChangeWindowsNodeMxcMode: undefined as
        | ((params: { enabled: boolean }) => Promise<unknown>)
        | undefined,
      windowsNodeMxcUnsupportedWindows: null,
      getWindowsNodeMxcSelection: () => ({ requestedMode: previousMode }),
      getWindowsNodeMxcRequestedMode: () => previousMode,
      isApplicationServiceReady: () => true,
      gwClient: { connected: true, connectionGeneration: 7 },
      gatewayProcess: { pid: 123 },
      gatewayGenerationId: generation,
      gatewayHttpReadyGeneration: generation,
      gatewaySpawnedByUs: true,
      isManagedGatewayProcessAlive: () => true,
      bundledWindowsNodeGeneration: 4,
      bundledWindowsNodeHost: { status: () => hostStatus },
      windowsNodeMxcApprovalProofContext: proof,
      settingsStore: { get: () => ({}) },
      migrateWeixinRemoteApprovalConfiguration: () => ({}),
      agentRosterChangeInProgress: false,
      windowsNodeMxcLifecycleState: "idle",
      windowsNodeMxcActivationInProgress: true,
      beginWindowsNodeMxcLifecycleOperation: vi.fn(),
      endWindowsNodeMxcLifecycleOperation: vi.fn(),
      notifyRendererApplicationReady: vi.fn(),
      windowsNodeMxcLifecycleOperations: {
        run: async (
          _descriptor: unknown,
          operation: () => Promise<unknown>,
          hooks: { beforeStart: () => void; afterSettled: () => void },
        ) => {
          hooks.beforeStart();
          try {
            return await operation();
          } finally {
            hooks.afterSettled();
          }
        },
      },
      applyLiveSandboxMode: async (hooks: LiveSandboxModeHooks<unknown>) => {
        captured = hooks;
        return null;
      },
      synchronizeWindowsNodeInstructionsForMode: synchronize,
      releaseWindowsNodeMxcIngress: release,
      setWindowsNodeMxcLifecycleState: (phase: string) => events.push(`phase:${phase}`),
    };
    runInNewContext(transitionJs, context);
    return {
      context,
      events,
      hostStatus,
      synchronize,
      release,
      rollback,
      async capture(enabled: boolean) {
        await context.testChangeWindowsNodeMxcMode!({ enabled });
        if (!captured) throw new Error("Mode transition hooks were not captured");
        hostStatus.requestedStrength = enabled ? "full" : "off";
        return captured;
      },
    };
  }

  describe("live sandbox mode guidance", () => {
    it.each([
      { previous: "off" as const, enabled: true },
      { previous: "full" as const, enabled: false },
    ])("synchronizes guidance before reopening ingress when enabled=$enabled", async (params) => {
      const fixture = modeReleaseHarness(params.previous);
      const transition = await fixture.capture(params.enabled);
      await transition.release(null);

      expect(fixture.events).toEqual([
        `instructions:${params.enabled}`,
        "ingress:release",
        `phase:${params.enabled ? "active" : "idle"}`,
      ]);
      expect(fixture.synchronize).toHaveBeenCalledExactlyOnceWith(params.enabled);
      expect(fixture.rollback).not.toHaveBeenCalled();
    });

    it("does not reopen ingress if synchronizing instructions fails", async () => {
      const fixture = modeReleaseHarness("full");
      const transition = await fixture.capture(false);
      fixture.synchronize.mockImplementationOnce(() => {
        throw new Error("SOUL update failed");
      });
      await expect(transition.release(null)).rejects.toThrow("SOUL update failed");
      expect(fixture.release).not.toHaveBeenCalled();
    });

    it("rolls instructions back if reopening ingress fails", async () => {
      const fixture = modeReleaseHarness("off");
      const transition = await fixture.capture(true);
      fixture.release.mockImplementationOnce(() => {
        throw new Error("ingress failed");
      });
      await expect(transition.release(null)).rejects.toThrow("ingress failed");
      expect(fixture.rollback).toHaveBeenCalledOnce();
    });

    it("surfaces both ingress and instruction rollback failures", async () => {
      const fixture = modeReleaseHarness("off");
      const transition = await fixture.capture(true);
      const ingressError = new Error("ingress failed");
      const rollbackError = new Error("rollback failed");
      fixture.release.mockImplementationOnce(() => {
        throw ingressError;
      });
      fixture.rollback.mockImplementationOnce(() => {
        throw rollbackError;
      });
      await expect(transition.release(null)).rejects.toMatchObject({
        errors: [ingressError, rollbackError],
        cause: rollbackError,
      });
    });

    it("rejects a mode change while an agent roster change is in progress", async () => {
      const fixture = modeReleaseHarness("off");
      fixture.context.agentRosterChangeInProgress = true;
      await expect(fixture.capture(true)).rejects.toThrow(
        "Wait for the current agent roster change to finish",
      );
      expect(fixture.synchronize).not.toHaveBeenCalled();
    });
  });
});
