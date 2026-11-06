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
import { classifyMxcProbe } from "./windows-node-mxc";
import {
  inspectWindowsNodeMxc,
  isWindowsNodeMxcSmokePassed,
  preflightWindowsNodeMxcBackend,
  preflightWindowsNodeMxcExactBackend,
  runWindowsNodeMxcSmoke,
  type WindowsNodeMxcGateway,
} from "./windows-node-mxc-service";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      _options: object,
      callback: (error: Error, stdout: string, stderr: string) => void,
    ) => callback(new Error("Test backend probe failed"), "", ""),
  ),
}));

const transitionId = "12345678-1234-4234-8234-123456789abc";
const generation = "generation-test-001";
const nodeId = "b".repeat(64);
const strongProbe = classifyMxcProbe(0, JSON.stringify({ tier: "base-container" }), "");
const limitedProbe = classifyMxcProbe(
  0,
  JSON.stringify({ tier: "appcontainer-dacl", needsDaclAugmentation: true }),
  "",
);

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
    vi.mocked(execFile).mockClear();
  });
  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("returns Off without waiting for Gateway agent or node readiness", async () => {
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
    expect(execFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      requestedMode: "off",
      effectiveStrength: "off",
      desiredEnabled: false,
      effectiveEnabled: false,
      effectiveToolsState: "unverified",
      selectedNode: null,
      probe: null,
      fullAvailability: null,
      limitedAvailability: null,
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

  it.each(["full", "limited-dacl"] as const)(
    "still verifies Gateway readiness and fails closed for %s",
    async (requestedMode) => {
      const request = vi.fn(async () => {
        throw new Error("Test Gateway is unavailable");
      });
      const result = await inspectWindowsNodeMxc({
        requestedMode,
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
      expect(result.effectiveEnabled).toBe(false);
      expect(result.blockers).toContain(
        "Could not list Gateway nodes: Test Gateway is unavailable",
      );
    },
  );
});

describe("Windows Node MXC readiness smoke", () => {
  it.each(["cwd-sensitive-root", "cwd-outside-approved-roots"])(
    "accepts the bundled host's structured %s rejection before execution",
    async (errorCode) => {
      const response = deniedCwdResponse(errorCode);
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
    },
  );

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

  it("runs only the scratch-based minimal execution smoke for Limited mode", async () => {
    let now = 1_000;
    const logs: string[] = [];
    const request = vi.fn(async (_method: string, envelope: unknown) => {
      const call = envelope as { command: string; params: Record<string, unknown> };
      if (call.command === "system.run") {
        throw new Error("Limited mode must not run the Full outside-root denial smoke");
      }
      if (call.command === "system.run.prepare") {
        now += 60_000;
        return { payload: { plan: preparedPlan() } };
      }
      if (call.command === WINDOWS_NODE_MXC_READINESS_COMMAND) {
        const proof = call.params.microclawReadinessProof as { issuedAtUnixMs: number };
        expect(proof.issuedAtUnixMs).toBe(now);
        expect(call.params.cwd).toBeNull();
        expect(call.params.systemRunPlan).toMatchObject({
          cwd: null,
          cwdBinding: WINDOWS_NODE_MXC_SCRATCH_BINDING,
        });
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

    const smoke = await runWindowsNodeMxcSmoke(
      { connected: true, request } as unknown as WindowsNodeMxcGateway,
      generation,
      nodeId,
      "settings-fingerprint",
      limitedProbe,
      authorization(),
      "limited-dacl",
      "d".repeat(64),
      { now: () => now, log: (message) => logs.push(message) },
    );

    expect(smoke.profile).toBe("limited-minimal-smoke");
    expect(smoke.deniedOutsideRoot).toBeNull();
    expect(smoke.execution.outcome).toBe("passed");
    expect(logs).toContainEqual(expect.stringContaining("proofIssueToDispatchMs=0"));
    expect(request.mock.calls.map((call) => (call[1] as { command: string }).command)).toEqual([
      "system.run.prepare",
      WINDOWS_NODE_MXC_READINESS_COMMAND,
    ]);
  });

  it("fails the minimal smoke when deterministic output does not match", async () => {
    const request = vi.fn(async (_method: string, envelope: unknown) => {
      const call = envelope as { command: string };
      if (call.command === "system.run.prepare") return { payload: { plan: preparedPlan() } };
      return { payload: { stdout: "unexpected", stderr: "", exitCode: 0, timedOut: false } };
    });
    const smoke = await runWindowsNodeMxcSmoke(
      { connected: true, request } as unknown as WindowsNodeMxcGateway,
      generation,
      nodeId,
      "settings-fingerprint",
      limitedProbe,
      authorization(),
      "limited-dacl",
      "d".repeat(64),
    );

    expect(smoke.execution.outcome).toBe("failed");
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
    const degraded = classifyMxcProbe(
      0,
      JSON.stringify({ tier: "appcontainer-dacl", needsDaclAugmentation: true }),
      "",
    );

    await expect(
      runWindowsNodeMxcSmoke(gateway, generation, nodeId, "settings", degraded, authorization()),
    ).rejects.toThrow(/cannot enforce the configured filesystem roots/);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("Windows Node MXC exact-backend preflight", () => {
  it("accepts a proven exact backend", async () => {
    const probe = classifyMxcProbe(
      0,
      JSON.stringify({
        tier: "base-container",
        probes: { baseContainerApiPresent: true },
      }),
      "",
    );
    const runner = vi.fn(async () => probe);

    await expect(
      preflightWindowsNodeMxcExactBackend("C:\\MXC\\wxc-exec.exe", runner),
    ).resolves.toBe(probe);
    expect(runner).toHaveBeenCalledWith("C:\\MXC\\wxc-exec.exe");
  });

  it("accepts appcontainer-dacl only for an explicit Limited request", async () => {
    const probe = classifyMxcProbe(
      0,
      JSON.stringify({ tier: "appcontainer-dacl", needsDaclAugmentation: true }),
      "",
    );
    await expect(
      preflightWindowsNodeMxcBackend("C:\\MXC\\wxc-exec.exe", "limited-dacl", async () => probe),
    ).resolves.toBe(probe);
    await expect(
      preflightWindowsNodeMxcBackend("C:\\MXC\\wxc-exec.exe", "full", async () => probe),
    ).rejects.toThrow(/exact-containment backend/);
  });

  it("reports the unavailable OS API and compiled-out BFS backend before startup", async () => {
    const probe = classifyMxcProbe(
      0,
      JSON.stringify({
        tier: "appcontainer-dacl",
        needsDaclAugmentation: true,
        probes: {
          baseContainerApiPresent: false,
          bfscfgPresent: false,
          bfsCompiledIn: false,
        },
      }),
      "",
    );

    await expect(
      preflightWindowsNodeMxcExactBackend("C:\\MXC\\wxc-exec.exe", async () => probe),
    ).rejects.toThrow(
      /Base Container API is unavailable.*built without the appcontainer-bfs backend.*cannot safely install or emulate/,
    );
  });
});
