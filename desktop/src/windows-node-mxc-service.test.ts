import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WINDOWS_NODE_MXC_READINESS_AGENT_ID,
  WINDOWS_NODE_MXC_READINESS_COMMAND,
  WINDOWS_NODE_MXC_READINESS_PROBES,
  WINDOWS_NODE_MXC_SCRATCH_BINDING,
  windowsNodeMxcReadinessSessionKey,
} from "./windows-node-mxc-readiness-proof";
import {
  applyWindowsNodeCommandPolicy,
  classifyMxcProbe,
  WINDOWS_NODE_MXC_NODE_COMMANDS,
} from "./windows-node-mxc";
import type { BundledWindowsNodeHostStatus } from "./bundled-windows-node-host";
import {
  inspectWindowsNodeMxc,
  inspectWindowsNodeMxcHeartbeat,
  isWindowsNodeMxcSmokePassed,
  preflightWindowsNodeMxcBackend,
  preflightWindowsNodeMxcExactBackend,
  runWindowsNodeMxcSmoke,
  type WindowsNodeMxcGateway,
  type InspectWindowsNodeMxcOptions,
  type StoredWindowsNodeMxcSmoke,
} from "./windows-node-mxc-service";
import { checkWindowsNodeMxcHealth } from "./windows-node-mxc-health-check";

const backendProbe = vi.hoisted(() => ({ output: "", timedOut: false }));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) =>
      backendProbe.timedOut
        ? callback(Object.assign(new Error("Test probe timeout"), { killed: true }), "", "")
        : backendProbe.output
          ? callback(null, backendProbe.output, "")
          : callback(new Error("Test backend probe failed"), "", ""),
  ),
}));

const transitionId = "12345678-1234-4234-8234-123456789abc";
const generation = "generation-test-001";
const nodeId = "b".repeat(64);
const probeFor = (tier: string, supported = tier === "base-container") =>
  classifyMxcProbe(
    0,
    JSON.stringify({
      contract: "microclaw.mxc-sdk-probe.v1",
      supported,
      windowsUnsupported: false,
      probeErrored: false,
      needsDaclAugmentation: false,
      supportsProtectedPathDenies: supported && tier === "base-container",
      tier,
      warnings: [],
      reasons: [],
    }),
    "",
  );
const strongProbe = probeFor("base-container");
const retiredDaclProbe = probeFor("appcontainer-dacl", false);

function preparedPlan() {
  const probeKind = "execution";
  const argv = [...WINDOWS_NODE_MXC_READINESS_PROBES[probeKind]];
  return {
    argv,
    cwd: null,
    commandText: argv.join(" "),
    commandPreview: null,
    agentId: WINDOWS_NODE_MXC_READINESS_AGENT_ID,
    sessionKey: windowsNodeMxcReadinessSessionKey(transitionId),
    executablePath: argv[0],
    executableSha256: "c".repeat(64),
    cwdBinding: WINDOWS_NODE_MXC_SCRATCH_BINDING,
    declaredAccess: [],
  };
}

function authorization() {
  return {
    transitionId,
    proofContext: {
      secretBase64: Buffer.alloc(32, 7).toString("base64"),
      gatewayGeneration: generation,
      policyFingerprint: "a".repeat(64),
      nodeId,
      readinessTransitionId: transitionId,
    },
  };
}

function deniedCwdResponse(errorCode = "cwd-outside-approved-roots") {
  return {
    ok: true,
    nodeId,
    command: "system.run",
    payload: {
      success: false,
      exitCode: null,
      timedOut: false,
      error: `${errorCode}: The requested working directory is not allowed.`,
      errorCode,
      executionState: "rejectedBeforeExecution",
    },
    payloadJSON: null as string | null,
  };
}

function readinessRequestWithCwdResponse(response: unknown) {
  return vi.fn(async (_method: string, envelope: unknown) => {
    const call = envelope as { command: string };
    if (call.command === "system.run") return response;
    if (call.command === "system.run.prepare") return { payload: { plan: preparedPlan() } };
    if (call.command === WINDOWS_NODE_MXC_READINESS_COMMAND) {
      return {
        payload: {
          stdout: "MICROCLAW_MXC_EXECUTION_OK",
          stderr: "",
          exitCode: 0,
          timedOut: false,
        },
      };
    }
    throw new Error(`Unexpected command ${call.command}`);
  });
}

describe("Windows Node MXC status inspection", () => {
  let dataRoot: string;
  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-mxc-status-"));
    backendProbe.output = "";
    backendProbe.timedOut = false;
    vi.mocked(execFile).mockClear();
  });
  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("returns Off without waiting for Gateway readiness while checking local MXC availability", async () => {
    const request = vi.fn(() => new Promise<never>(() => {}));
    const result = await inspectWindowsNodeMxc({
      requestedMode: "off",
      desiredEnabled: false,
      selectedNodeId: nodeId,
      config: {},
      gateway: { connected: true, request },
      managedGateway: true,
      gatewayGeneration: generation,
      environment: { OPENCLAW_WXC_EXEC: process.execPath },
      appData: dataRoot,
      localAppData: dataRoot,
      userProfile: dataRoot,
    });

    expect(request).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      requestedMode: "off",
      effectiveStrength: "off",
      desiredEnabled: false,
      effectiveEnabled: false,
      selectedNode: null,
      probe: { outcome: "error" },
      fullAvailability: { available: false },
    });
  });

  it("probes enabled status and fails closed if the probe fails", async () => {
    const result = await inspectWindowsNodeMxc({
      requestedMode: "full",
      desiredEnabled: true,
      selectedNodeId: nodeId,
      config: {},
      gateway: null,
      managedGateway: false,
      gatewayGeneration: generation,
      environment: { OPENCLAW_WXC_EXEC: process.execPath },
      appData: dataRoot,
      localAppData: dataRoot,
      userProfile: dataRoot,
    });
    expect(execFile).toHaveBeenCalledOnce();
    expect(result.probe).toMatchObject({
      outcome: "error",
      reason: expect.stringContaining("Test backend probe failed"),
    });
    expect(result.fullAvailability?.available).toBe(false);
    expect(result.effectiveEnabled).toBe(false);
  });

  it("still verifies Gateway readiness and fails closed when Full is requested", async () => {
    const request = vi.fn(async (_method: string, _params?: unknown) => {
      throw new Error("Test Gateway is unavailable");
    });
    const result = await inspectWindowsNodeMxc({
      requestedMode: "full",
      desiredEnabled: true,
      selectedNodeId: nodeId,
      config: {},
      gateway: { connected: true, request },
      managedGateway: true,
      gatewayGeneration: generation,
      environment: {},
      appData: dataRoot,
      localAppData: dataRoot,
      userProfile: dataRoot,
      runtimeIntegrityError: "Test runtime is unavailable",
    });

    expect(request).toHaveBeenCalledWith("node.list", {});
    expect(request.mock.calls.map(([method]) => method)).not.toContain("tools.effective");
    expect(request.mock.calls.map(([method]) => method)).not.toContain("sessions.list");
    expect(result.effectiveEnabled).toBe(false);
    expect(result.blockers).toContain("Could not list Gateway nodes: Test Gateway is unavailable");
  });

  async function fullRouteFixture() {
    backendProbe.output = JSON.stringify({
      contract: "microclaw.mxc-sdk-probe.v1",
      supported: true,
      windowsUnsupported: false,
      probeErrored: false,
      needsDaclAugmentation: false,
      supportsProtectedPathDenies: true,
      tier: "base-container",
      warnings: [],
      reasons: [],
    });
    const attestation = {
      contract: "microclaw.windows-cwd.v1",
      approvedRootOnly: true,
      canonicalFinalPath: true,
      rejectsReparseComponents: true,
      durableApprovalBindsCwd: false,
      durableApprovalBindsDeclaredAccess: false,
      launchTimeRevalidation: true,
      omittedCwdUsesIsolatedScratch: true,
      hostFallbackAbsent: true,
      activationLeaseContract: "microclaw.windows-activation.v1",
      generationBoundActivation: true,
      policyBoundActivation: true,
      launchTimeLeaseRevalidation: true,
      approvalProofContract: "microclaw.windows-node-approval.v2",
      activeRunsRequireApprovalProof: true,
      approvalProofOneUse: true,
      approvalProofBindsPreparedPlan: true,
      approvalProofPlanContract: "microclaw.windows-node-approval-plan.v2",
      approvalProofBindsExecutableContent: true,
      approvalProofBindsActivation: true,
      launchTimeApprovalProofRevalidation: true,
      durableApprovalStoreProtected: true,
      durableApprovalsPresent: false,
      readinessProofContract: "microclaw.windows-node-readiness.v1",
      readinessProofBindsTransition: true,
      readinessProofBindsPreparedPlan: true,
      readinessProofExactBuiltInsOnly: true,
      readinessProofOneUse: true,
      launchTimeReadinessProofRevalidation: true,
      exactFilesystemIsolationRequired: true,
      degradedIsolationTierRejected: true,
      requestedContainmentStrength: "full",
      folderPolicyIsExclusiveBoundary: true,
      durableApprovalsAllowed: true,
      ambientAssessmentBound: false,
      outboundNetworkEnabled: true,
    };
    const request = vi.fn(async (method: string) => {
      if (method === "node.list")
        return {
          nodes: [
            {
              id: nodeId,
              platform: "win32",
              connected: true,
              paired: true,
              commands: [...WINDOWS_NODE_MXC_NODE_COMMANDS],
            },
          ],
        };
      if (method === "node.invoke") return { payload: attestation };
      throw new Error(`Unexpected Gateway request: ${method}`);
    });
    const fingerprint = "a".repeat(64);
    const bundledHost = {
      processRunning: true,
      processId: 123,
      hostPath: process.execPath,
      sdkProbePath: process.execPath,
      runtimeVersion: "1.0.1",
      cwdPolicyContract: "microclaw.windows-cwd.v1",
      displayName: "MicroClaw Bundled Windows Node",
      helperRevision: "f0592215f27100d9ecece33d3069daac76a4125c",
      pendingApproval: null,
      lastError: null,
      nodeId,
      gatewayGeneration: generation,
      policyFingerprint: fingerprint,
      activationLease: {
        contract: "microclaw.windows-activation.v1",
        mode: "active",
        gatewayGeneration: generation,
        policyFingerprint: fingerprint,
        expiresAtUnixMs: Date.now() + 60_000,
      },
      requestedStrength: "full",
      effectiveTier: "base-container",
      ambientAccess: null,
    } satisfies BundledWindowsNodeHostStatus;
    const options = {
      requestedMode: "full" as const,
      desiredEnabled: true,
      selectedNodeId: nodeId,
      config: applyWindowsNodeCommandPolicy({ agents: { entries: { main: {} } } }, nodeId),
      gateway: { connected: true, request: request as WindowsNodeMxcGateway["request"] },
      managedGateway: true,
      gatewayGeneration: generation,
      bundledHost,
      appData: dataRoot,
      localAppData: dataRoot,
      userProfile: dataRoot,
    };
    const initial = await inspectWindowsNodeMxc(options);
    if (!initial.settingsFingerprint) throw new Error("Missing test settings fingerprint");
    const smoke = {
      profile: "full-smoke",
      gatewayGeneration: generation,
      nodeId,
      settingsFingerprint: initial.settingsFingerprint,
      probeTier: "base-container",
      containmentStrength: "full",
      ambientAccessHash: null,
      checkedAt: new Date().toISOString(),
      execution: { outcome: "passed", reason: "contained execution verified" },
      deniedOutsideRoot: { outcome: "passed", reason: "outside-root denial verified" },
    } satisfies StoredWindowsNodeMxcSmoke;
    const readyOptions: InspectWindowsNodeMxcOptions = { ...options, storedSmoke: smoke };
    return { options: readyOptions, request, bundledHost, smoke, attestation };
  }

  it("accepts a fully attested Full route without querying tool inventory APIs", async () => {
    const { options, request } = await fullRouteFixture();
    const result = await inspectWindowsNodeMxc(options);

    expect(result).toMatchObject({
      effectiveEnabled: true,
      gatewayPolicyState: "active",
      cwdAttestationReady: true,
      blockers: [],
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "node.list",
      "node.invoke",
      "node.list",
      "node.invoke",
    ]);
  });

  it("renews repeated heartbeats without probing, even if a fresh SDK probe would time out", async () => {
    const { options, request } = await fullRouteFixture();
    vi.mocked(execFile).mockClear();
    request.mockClear();
    backendProbe.timedOut = true;
    const renewLease = vi.fn(async () => undefined);
    const failClosed = vi.fn(async () => undefined);
    for (let tick = 0; tick < 3; tick += 1) {
      await expect(
        checkWindowsNodeMxcHealth({
          isCurrent: () => true,
          inspect: () => inspectWindowsNodeMxcHeartbeat(options),
          renewLease,
          failClosed,
        }),
      ).resolves.toBe(true);
    }
    expect(execFile).not.toHaveBeenCalled();
    expect(renewLease).toHaveBeenCalledTimes(3);
    expect(failClosed).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "node.list",
      "node.invoke",
      "node.list",
      "node.invoke",
      "node.list",
      "node.invoke",
    ]);

    const readiness = await inspectWindowsNodeMxc(options);
    expect(execFile).toHaveBeenCalledOnce();
    expect(readiness.effectiveEnabled).toBe(false);
    expect(readiness.probe?.reason).toContain("probe timed out");
    await expect(inspectWindowsNodeMxcHeartbeat(options)).resolves.toEqual({
      effectiveEnabled: true,
      gatewayPolicyState: "active",
      blockers: [],
    });
    expect(execFile).toHaveBeenCalledOnce();
  });

  type FullRouteFixture = Awaited<ReturnType<typeof fullRouteFixture>>;
  it.each([
    [
      "missing host",
      (f) => {
        f.options.bundledHost = undefined;
      },
    ],
    [
      "stopped host",
      (f) => {
        f.options.bundledHost = { ...f.bundledHost, processRunning: false };
      },
    ],
    [
      "missing PID",
      (f) => {
        f.options.bundledHost = { ...f.bundledHost, processId: null };
      },
    ],
    [
      "different host generation",
      (f) => {
        f.options.bundledHost = { ...f.bundledHost, gatewayGeneration: "old" };
      },
    ],
    [
      "different node identity",
      (f) => {
        f.options.bundledHost = { ...f.bundledHost, nodeId: "c".repeat(64) };
      },
    ],
    [
      "host mode",
      (f) => {
        f.options.bundledHost = { ...f.bundledHost, requestedStrength: "off" };
      },
    ],
    [
      "unverified tier",
      (f) => {
        f.options.bundledHost = { ...f.bundledHost, effectiveTier: null };
      },
    ],
    [
      "weaker tier",
      (f) => {
        f.options.bundledHost = { ...f.bundledHost, effectiveTier: "appcontainer-dacl" };
      },
    ],
    [
      "missing lease",
      (f) => {
        f.options.bundledHost = { ...f.bundledHost, activationLease: null };
      },
    ],
    [
      "expired lease",
      (f) => {
        f.options.bundledHost = {
          ...f.bundledHost,
          activationLease: { ...f.bundledHost.activationLease, expiresAtUnixMs: Date.now() - 1 },
        };
      },
    ],
    [
      "wrong lease policy",
      (f) => {
        f.options.bundledHost = {
          ...f.bundledHost,
          activationLease: { ...f.bundledHost.activationLease, policyFingerprint: "old" },
        };
      },
    ],
    [
      "runtime integrity failure",
      (f) => {
        f.options.runtimeIntegrityError = "Runtime hash mismatch";
      },
    ],
    [
      "missing smoke",
      (f) => {
        f.options.storedSmoke = null;
      },
    ],
    [
      "stale smoke",
      (f) => {
        f.options.storedSmoke = { ...f.smoke, gatewayGeneration: "old" };
      },
    ],
    [
      "failed smoke",
      (f) => {
        f.options.storedSmoke = {
          ...f.smoke,
          execution: { outcome: "failed", reason: "Containment failed" },
        };
      },
    ],
    [
      "mismatched smoke tier",
      (f) => {
        f.options.storedSmoke = { ...f.smoke, probeTier: "appcontainer-dacl" };
      },
    ],
    [
      "unmanaged Gateway",
      (f) => {
        f.options.managedGateway = false;
      },
    ],
    [
      "disconnected Gateway",
      (f) => {
        if (!f.options.gateway) throw new Error("Missing test Gateway");
        f.options.gateway.connected = false;
      },
    ],
    [
      "route drift",
      (f) => {
        f.options.config = {};
      },
    ],
    [
      "invalid node attestation",
      (f) => {
        f.attestation.hostFallbackAbsent = false;
      },
    ],
  ] satisfies [string, (fixture: FullRouteFixture) => void][])(
    "rejects heartbeat with %s without launching an SDK probe",
    async (_name, mutate) => {
      const fixture = await fullRouteFixture();
      vi.mocked(execFile).mockClear();
      mutate(fixture);
      const result = await inspectWindowsNodeMxcHeartbeat(fixture.options);
      expect(result.effectiveEnabled).toBe(false);
      expect(result.blockers.length).toBeGreaterThan(0);
      expect(execFile).not.toHaveBeenCalled();
    },
  );
});

describe("Windows Node MXC readiness smoke", () => {
  it("accepts the bundled host's structured outside-root rejection before execution", async () => {
    const response = deniedCwdResponse("cwd-outside-approved-roots");
    response.payloadJSON = JSON.stringify(response.payload);
    const request = readinessRequestWithCwdResponse(response);
    const smoke = await runWindowsNodeMxcSmoke(
      { connected: true, request } as unknown as WindowsNodeMxcGateway,
      generation,
      nodeId,
      "settings-fingerprint",
      strongProbe,
      authorization(),
    );

    expect(smoke.deniedOutsideRoot?.outcome).toBe("passed");
    expect(smoke.execution.outcome).toBe("passed");
    expect(isWindowsNodeMxcSmokePassed(smoke)).toBe(true);
    expect(request.mock.calls).toHaveLength(3);
  });

  it("accepts structured rejection without a duplicate serialized payload", async () => {
    const request = readinessRequestWithCwdResponse(deniedCwdResponse());
    const smoke = await runWindowsNodeMxcSmoke(
      { connected: true, request } as unknown as WindowsNodeMxcGateway,
      generation,
      nodeId,
      "settings-fingerprint",
      strongProbe,
      authorization(),
    );

    expect(isWindowsNodeMxcSmokePassed(smoke)).toBe(true);
  });

  it("accepts the wire rejection after the Windows node serializer omits null fields", async () => {
    const response = deniedCwdResponse();
    const { exitCode: _exitCode, ...payload } = response.payload;
    const request = readinessRequestWithCwdResponse({
      ...response,
      payload,
      payloadJSON: JSON.stringify(payload),
    });
    const logs: string[] = [];
    const smoke = await runWindowsNodeMxcSmoke(
      { connected: true, request } as unknown as WindowsNodeMxcGateway,
      generation,
      nodeId,
      "settings-fingerprint",
      strongProbe,
      authorization(),
      "full",
      null,
      { log: (message) => logs.push(message) },
    );

    expect(isWindowsNodeMxcSmokePassed(smoke)).toBe(true);
    expect(logs).toContainEqual(expect.stringContaining("protected-cwd-proof outcome=passed"));
    expect(logs).toContainEqual(expect.stringContaining('"exitCode":"missing"'));
    expect(logs.join("\n")).not.toContain(payload.error);
  });

  it.each([
    ["successful execution", { success: true, exitCode: 0 }],
    ["failed execution", { exitCode: 1, executionState: undefined }],
    ["a numeric exit code on a rejection", { exitCode: 0 }],
    ["a string exit code on a rejection", { exitCode: "0" }],
    ["missing rejection state", { executionState: undefined }],
    ["an unrelated policy denial", { errorCode: "approval-denied" }],
    ["an obsolete custom-root denial", { errorCode: "cwd-sensitive-root" }],
    ["an extended error code", { errorCode: "cwd-outside-approved-roots-extra" }],
    ["timeout", { timedOut: true }],
    ["missing error code", { errorCode: undefined }],
    ["missing error message", { error: undefined }],
    ["an empty error message", { error: "" }],
    ["contradictory command output", { stdout: "command actually ran" }],
    ["a mismatched error message", { error: "approval-denied: Not a CWD rejection" }],
    ["a denial string in command output", { errorCode: undefined, stdout: "cwd-sensitive-root" }],
  ])("fails closed for %s instead of an explicit CWD rejection", async (_label, payload) => {
    const response = deniedCwdResponse();
    const request = readinessRequestWithCwdResponse({
      ...response,
      payload: { ...response.payload, ...(payload as Record<string, unknown>) },
    });
    const smoke = await runWindowsNodeMxcSmoke(
      { connected: true, request } as unknown as WindowsNodeMxcGateway,
      generation,
      nodeId,
      "settings-fingerprint",
      strongProbe,
      authorization(),
    );

    expect(smoke.deniedOutsideRoot?.outcome).toBe("failed");
    expect(isWindowsNodeMxcSmokePassed(smoke)).toBe(false);
  });

  it.each([
    ["an unsuccessful RPC result", { ok: false }],
    ["the wrong command", { command: "system.run.prepare" }],
    ["another node", { nodeId: "d".repeat(64) }],
    ["an RPC error", { error: "transport disconnected" }],
    ["malformed serialized payload", { payloadJSON: "{" }],
    ["a mismatched serialized payload", { payloadJSON: '{"success":true}' }],
    ["a non-string serialized payload", { payloadJSON: 42 }],
  ])("fails closed for %s", async (_label, envelope) => {
    const request = readinessRequestWithCwdResponse({
      ...deniedCwdResponse(),
      ...(envelope as Record<string, unknown>),
    });
    const smoke = await runWindowsNodeMxcSmoke(
      { connected: true, request } as unknown as WindowsNodeMxcGateway,
      generation,
      nodeId,
      "settings-fingerprint",
      strongProbe,
      authorization(),
    );

    expect(isWindowsNodeMxcSmokePassed(smoke)).toBe(false);
  });

  it("uses only proof-bound internal probe commands and never requests an attended approval", async () => {
    const request = vi.fn(async (_method: string, envelope: unknown) => {
      const call = envelope as {
        command: string;
        params: Record<string, unknown>;
      };
      if (call.command === "system.run" && call.params.cwd === "C:\\Windows") {
        throw new Error("cwd-outside-approved-roots");
      }
      if (call.command === "system.run.prepare") {
        const wirePlan: Record<string, unknown> = { ...preparedPlan() };
        delete wirePlan.cwd;
        delete wirePlan.commandPreview;
        return { payload: { plan: wirePlan } };
      }
      if (call.command === WINDOWS_NODE_MXC_READINESS_COMMAND) {
        return {
          payload: {
            stdout: "MICROCLAW_MXC_EXECUTION_OK",
            stderr: "",
            exitCode: 0,
            timedOut: false,
          },
        };
      }
      throw new Error(`Unexpected command ${call.command}`);
    });
    const gateway = { connected: true, request } as unknown as WindowsNodeMxcGateway;

    const smoke = await runWindowsNodeMxcSmoke(
      gateway,
      generation,
      nodeId,
      "settings-fingerprint",
      strongProbe,
      authorization(),
    );

    expect(smoke.profile).toBe("full-smoke");
    expect(smoke.deniedOutsideRoot?.outcome).toBe("passed");
    expect(smoke.execution.outcome).toBe("passed");
    const envelopes = request.mock.calls.map((call) => call[1] as Record<string, unknown>);
    expect(envelopes.map((entry) => entry.command)).toEqual([
      "system.run",
      "system.run.prepare",
      WINDOWS_NODE_MXC_READINESS_COMMAND,
    ]);
    const readinessCalls = envelopes.filter(
      (entry) => entry.command === WINDOWS_NODE_MXC_READINESS_COMMAND,
    );
    expect(readinessCalls).toHaveLength(1);
    for (const envelope of readinessCalls) {
      const params = envelope.params as Record<string, unknown>;
      expect(params.agentId).toBe(WINDOWS_NODE_MXC_READINESS_AGENT_ID);
      expect(params.sessionKey).toBe(windowsNodeMxcReadinessSessionKey(transitionId));
      expect(params.cwd).toBeNull();
      expect(params.systemRunPlan).toMatchObject({ cwd: null, commandPreview: null });
      expect(params).toHaveProperty("microclawReadinessProof");
      expect(params).not.toHaveProperty("approved");
      expect(params).not.toHaveProperty("approvalDecision");
    }
  });

  it("rejects retired DACL-tier smoke before invoking the node", async () => {
    const request = vi.fn();
    await expect(
      runWindowsNodeMxcSmoke(
        { connected: true, request } as unknown as WindowsNodeMxcGateway,
        generation,
        nodeId,
        "settings-fingerprint",
        retiredDaclProbe,
        authorization(),
      ),
    ).rejects.toThrow(/BaseContainer/);
    expect(request).not.toHaveBeenCalled();
  });

  it("fails before node invocation for stale generation, node, or transition authorization", async () => {
    const request = vi.fn();
    const gateway = { connected: true, request } as unknown as WindowsNodeMxcGateway;

    await expect(
      runWindowsNodeMxcSmoke(
        gateway,
        "another-generation",
        nodeId,
        "settings",
        strongProbe,
        authorization(),
      ),
    ).rejects.toThrow(/does not match/);
    await expect(
      runWindowsNodeMxcSmoke(
        gateway,
        generation,
        "d".repeat(64),
        "settings",
        strongProbe,
        authorization(),
      ),
    ).rejects.toThrow(/does not match/);
    await expect(
      runWindowsNodeMxcSmoke(gateway, generation, nodeId, "settings", strongProbe, {
        ...authorization(),
        transitionId: "12345678-1234-4234-8234-123456789abe",
      }),
    ).rejects.toThrow(/does not match/);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects degraded containment before invoking the node", async () => {
    const request = vi.fn();
    const gateway = { connected: true, request } as unknown as WindowsNodeMxcGateway;
    const degraded = retiredDaclProbe;

    await expect(
      runWindowsNodeMxcSmoke(gateway, generation, nodeId, "settings", degraded, authorization()),
    ).rejects.toThrow(/BaseContainer/);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("Windows Node MXC exact-backend preflight", () => {
  it("requires a fresh SDK probe each time Full activation is preflighted", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce(strongProbe)
      .mockResolvedValueOnce(classifyMxcProbe(null, "", "", "probe timed out"));
    await expect(
      preflightWindowsNodeMxcBackend("C:\\MXC\\host.exe", "full", runner),
    ).resolves.toEqual(strongProbe);
    await expect(
      preflightWindowsNodeMxcBackend("C:\\MXC\\host.exe", "full", runner),
    ).rejects.toThrow("No eligible MXC exact-containment backend");
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("accepts a proven exact backend", async () => {
    const probe = strongProbe;
    const runner = vi.fn(async () => probe);

    await expect(
      preflightWindowsNodeMxcExactBackend("C:\\MXC\\wxc-exec.exe", runner),
    ).resolves.toBe(probe);
    expect(runner).toHaveBeenCalledWith("C:\\MXC\\wxc-exec.exe");
  });

  it("rejects retired appcontainer-dacl output regardless of requested mode", async () => {
    await expect(
      preflightWindowsNodeMxcExactBackend("C:\\MXC\\wxc-exec.exe", async () => retiredDaclProbe),
    ).rejects.toThrow(/exact-containment backend/);
  });

  it("reports retired DACL evidence before startup", async () => {
    const probe = classifyMxcProbe(
      0,
      JSON.stringify({
        contract: "microclaw.mxc-sdk-probe.v1",
        supported: false,
        windowsUnsupported: false,
        probeErrored: false,
        needsDaclAugmentation: true,
        supportsProtectedPathDenies: false,
        tier: "appcontainer-dacl",
        warnings: [],
        reasons: ["Legacy DACL mode is retired"],
      }),
      "",
    );

    await expect(
      preflightWindowsNodeMxcExactBackend("C:\\MXC\\wxc-exec.exe", async () => probe),
    ).rejects.toThrow(/Legacy DACL mode is retired/);
  });
});
