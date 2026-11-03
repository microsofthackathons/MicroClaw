import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { applyCommandConsentChange, type CommandConsentMode } from "./command-consent";
import { WindowsNodeMxcLifecycleOperationCoordinator } from "./windows-node-mxc-lifecycle-operation";
import type { WindowsNodeMxcRequestedMode } from "./windows-node-mxc-modes";

const source = readFileSync(resolve(process.cwd(), "src", "main.ts"), "utf8");
const start = source.indexOf("async function applyRunningCommandConsent(");
const end = source.indexOf("async function requireEffectiveWindowsNodeMxc(", start);
if (start < 0 || end < 0) throw new Error("Cannot locate the live consent transition");
const transition = ts.transpileModule(
  `${source.slice(start, end)}\nglobalThis.testApplyRunningCommandConsent = applyRunningCommandConsent;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;

function harness(requestedMode: WindowsNodeMxcRequestedMode) {
  const events: string[] = [];
  const generation = "gateway-generation";
  const initialProof = {
    gatewayGeneration: generation,
    nodeId: "node-id",
    secretBase64: "secret",
    readinessTransitionId: "transition",
    policyFingerprint: "policy-0",
  };
  const hostState: {
    processRunning: boolean;
    processId: number;
    gatewayGeneration: string;
    requestedStrength: WindowsNodeMxcRequestedMode;
    nodeId: string;
    policyFingerprint: string;
    pendingApproval: { id: string } | null;
    activationLease: {
      mode: string;
      gatewayGeneration: string;
      policyFingerprint: string;
      expiresAtUnixMs: number;
    } | null;
  } = {
    processRunning: true,
    processId: 321,
    gatewayGeneration: generation,
    requestedStrength: requestedMode,
    nodeId: initialProof.nodeId,
    policyFingerprint: initialProof.policyFingerprint,
    pendingApproval: { id: "native-approval" },
    activationLease: null,
  };
  let savedMode: CommandConsentMode = "ask-when-needed";
  let policyRevision = 0;
  let gatewayApprovalPending = true;
  const gateway = {
    connected: true,
    connectionGeneration: 7,
    request: vi.fn(async (method: string, params: { id: string; decision: string }) => {
      events.push(`${method}:${params.id}:${params.decision}`);
      return {};
    }),
  };
  const publishPolicy = async (_gateway: typeof gateway, mode: CommandConsentMode) => {
    events.push(`policy:${mode}`);
    const policyFingerprint = `policy-${++policyRevision}`;
    hostState.policyFingerprint = policyFingerprint;
    return { ...initialProof, policyFingerprint };
  };
  const host = {
    status: () => hostState,
    respond: vi.fn((id: string, decision: string) => {
      events.push(`native:${id}:${decision}`);
      hostState.pendingApproval = null;
    }),
    revokeActivationLease: vi.fn(() => {
      events.push("lease:revoke");
      hostState.activationLease = null;
    }),
    applyLiveCommandConsentPolicy: vi.fn(publishPolicy),
    setActivationLease: vi.fn(async (mode: string, duration: number) => {
      events.push(`lease:${mode}`);
      hostState.activationLease = {
        mode,
        gatewayGeneration: generation,
        policyFingerprint: hostState.policyFingerprint,
        expiresAtUnixMs: Date.now() + duration,
      };
    }),
  };
  const status = vi.fn(async () => {
    events.push("status");
    return { effectiveEnabled: true, blockers: [] as string[] };
  });
  const context = {
    testApplyRunningCommandConsent: undefined as
      | ((previous: CommandConsentMode, next: CommandConsentMode) => Promise<void>)
      | undefined,
    gwClient: gateway,
    gatewayProcess: { pid: 123 },
    gatewayGenerationId: generation,
    gatewayHttpReadyGeneration: generation,
    gatewaySpawnedByUs: true,
    gatewayRestarting: false,
    gatewayStopPromise: null,
    explicitQuitRequested: false,
    bundledWindowsNodeGeneration: 4,
    bundledWindowsNodeHost: host,
    windowsNodeMxcApprovalProofContext: { ...initialProof },
    windowsNodeMxcWeixinContext:
      requestedMode === "off"
        ? null
        : { gatewayGeneration: generation, policyFingerprint: initialProof.policyFingerprint },
    windowsNodeMxcActivationInProgress: false,
    commandConsentUpdating: false,
    isApplicationServiceReady: () => true,
    isManagedGatewayProcessAlive: () => true,
    getWindowsNodeMxcRequestedMode: () => requestedMode,
    windowsNodeMxcLifecycleOperations: new WindowsNodeMxcLifecycleOperationCoordinator(),
    applyCommandConsentChange,
    setWindowsNodeMxcLifecycleState: (phase: string) => events.push(`phase:${phase}`),
    allPendingWindowsNodeMxcGatewayApprovals: () =>
      gatewayApprovalPending
        ? [
            {
              request: { id: "gateway-approval" },
              lifecycle: {
                cancel: async (reason: string) => {
                  events.push(`cancel:${reason}`);
                  gatewayApprovalPending = false;
                },
              },
            },
          ]
        : [],
    closeWindowsNodeMxcIngress: () => events.push("ingress:close"),
    releaseWindowsNodeMxcIngress: (released: string) => events.push(`ingress:release:${released}`),
    settingsStore: {
      get: (key: string) => {
        if (key !== "commandConsentMode") throw new Error(`Unexpected setting: ${key}`);
        return savedMode;
      },
      set: (key: string, value: CommandConsentMode) => {
        if (key !== "commandConsentMode") throw new Error(`Unexpected setting: ${key}`);
        events.push(`save:${value}`);
        savedMode = value;
      },
    },
    getWindowsNodeMxcStatus: status,
    failClosedWindowsNodeMxc: vi.fn(async () => {
      events.push("fail-closed");
    }),
    beginWindowsNodeMxcLifecycleOperation: () => events.push("begin"),
    endWindowsNodeMxcLifecycleOperation: () => events.push("end"),
    publishWeixinMutationLock: () => events.push(`mutation-lock:${context.commandConsentUpdating}`),
  };
  runInNewContext(transition, context);
  const run = () => {
    if (!context.testApplyRunningCommandConsent) throw new Error("Transition was not loaded");
    return context.testApplyRunningCommandConsent("ask-when-needed", "allow-always");
  };
  return { context, events, gateway, host, hostState, status, publishPolicy, run };
}

describe("desktop live command consent", () => {
  it.each(["off", "full", "limited-dacl"] as const)(
    "updates %s without replacing the Gateway or node",
    async (mode) => {
      const fixture = harness(mode);
      const gatewayProcess = fixture.context.gatewayProcess;
      const nodeProcessId = fixture.hostState.processId;
      await fixture.run();

      expect(fixture.context.gatewayProcess).toBe(gatewayProcess);
      expect(fixture.hostState.processId).toBe(nodeProcessId);
      expect(fixture.context.windowsNodeMxcApprovalProofContext.policyFingerprint).toBe("policy-1");
      expect(fixture.context.windowsNodeMxcWeixinContext?.policyFingerprint).toBe(
        mode === "off" ? undefined : "policy-1",
      );
      expect(fixture.events).toEqual([
        "begin",
        "mutation-lock:true",
        "phase:updating-consent",
        "ingress:close",
        "lease:revoke",
        "native:native-approval:deny",
        "cancel:command-consent-changed",
        "exec.approval.resolve:gateway-approval:deny",
        "save:allow-always",
        "policy:allow-always",
        "lease:active",
        ...(mode === "off" ? [] : ["status", "ingress:release:gateway-generation"]),
        `phase:${mode === "off" ? "idle" : "active"}`,
        "end",
        "mutation-lock:false",
      ]);
      expect(fixture.context.windowsNodeMxcActivationInProgress).toBe(false);
    },
  );

  it("restores the previous policy and media fingerprint before reopening ingress", async () => {
    const fixture = harness("full");
    fixture.host.setActivationLease.mockRejectedValueOnce(new Error("lease write failed"));
    await expect(fixture.run()).rejects.toThrow("lease write failed");

    expect(fixture.events.filter((event) => event.startsWith("policy:"))).toEqual([
      "policy:allow-always",
      "policy:ask-when-needed",
    ]);
    expect(fixture.context.settingsStore.get("commandConsentMode")).toBe("ask-when-needed");
    expect(fixture.context.windowsNodeMxcApprovalProofContext.policyFingerprint).toBe("policy-2");
    expect(fixture.context.windowsNodeMxcWeixinContext?.policyFingerprint).toBe("policy-2");
    expect(fixture.hostState.activationLease?.policyFingerprint).toBe("policy-2");
    expect(fixture.events.at(-3)).toBe("phase:active");
    expect(fixture.context.failClosedWindowsNodeMxc).not.toHaveBeenCalled();
  });

  it("fails closed if the Gateway generation changes during publication", async () => {
    const fixture = harness("full");
    fixture.host.applyLiveCommandConsentPolicy.mockImplementationOnce(async (gateway, mode) => {
      const proof = await fixture.publishPolicy(gateway, mode);
      gateway.connectionGeneration++;
      return proof;
    });
    await expect(fixture.run()).rejects.toThrow(
      "Command consent could not be applied or restored; execution is unavailable",
    );

    expect(fixture.events).toContain("fail-closed");
    expect(fixture.events).not.toContain("ingress:release:gateway-generation");
    expect(fixture.hostState.activationLease).toBeNull();
    expect(fixture.context.settingsStore.get("commandConsentMode")).toBe("ask-when-needed");
  });

  it("does not release ingress if the lease expires while checking containment", async () => {
    const fixture = harness("full");
    fixture.status.mockImplementationOnce(async () => {
      if (!fixture.hostState.activationLease) throw new Error("Missing test lease");
      fixture.hostState.activationLease.expiresAtUnixMs = Date.now() - 1;
      return { effectiveEnabled: true, blockers: [] };
    });
    await expect(fixture.run()).rejects.toThrow("activation lease is not current");

    expect(fixture.events.filter((event) => event.startsWith("policy:"))).toEqual([
      "policy:allow-always",
      "policy:ask-when-needed",
    ]);
    expect(fixture.context.windowsNodeMxcApprovalProofContext.policyFingerprint).toBe("policy-2");
    expect(
      fixture.events.filter((event) => event === "ingress:release:gateway-generation"),
    ).toHaveLength(1);
    expect(fixture.context.settingsStore.get("commandConsentMode")).toBe("ask-when-needed");
  });
});
