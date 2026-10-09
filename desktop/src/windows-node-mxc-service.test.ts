import { describe, expect, it, vi } from "vitest";
import {
  WINDOWS_NODE_MXC_READINESS_AGENT_ID,
  WINDOWS_NODE_MXC_READINESS_COMMAND,
  WINDOWS_NODE_MXC_READINESS_PROBES,
  WINDOWS_NODE_MXC_SCRATCH_BINDING,
  windowsNodeMxcReadinessSessionKey,
} from "./windows-node-mxc-readiness-proof";
import { classifyMxcProbe } from "./windows-node-mxc";
import {
  preflightWindowsNodeMxcBackend,
  preflightWindowsNodeMxcExactBackend,
  runWindowsNodeMxcSmoke,
  type WindowsNodeMxcGateway,
} from "./windows-node-mxc-service";

const transitionId = "12345678-1234-4234-8234-123456789abc";
const generation = "generation-test-001";
const nodeId = "b".repeat(64);
const strongProbe = classifyMxcProbe(0, JSON.stringify({ tier: "base-container" }), "");

function preparedPlan(probeKind: "hostname" | "powershell") {
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

describe("Windows Node MXC readiness smoke", () => {
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
        const command = call.params.command as string[];
        const kind = command[0].toLowerCase().endsWith("\\cmd.exe") ? "hostname" : "powershell";
        const wirePlan: Record<string, unknown> = { ...preparedPlan(kind) };
        delete wirePlan.cwd;
        delete wirePlan.commandPreview;
        return { payload: { plan: wirePlan } };
      }
      if (call.command === WINDOWS_NODE_MXC_READINESS_COMMAND) {
        const kind = call.params.probeKind as "hostname" | "powershell";
        const marker =
          kind === "hostname" ? "MICROCLAW_MXC_HOSTNAME_OK" : "MICROCLAW_MXC_POWERSHELL_OK";
        return { payload: { stdout: marker, stderr: "", exitCode: 0, timedOut: false } };
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

    expect(smoke.deniedOutsideRoot.outcome).toBe("passed");
    expect(smoke.hostname.outcome).toBe("passed");
    expect(smoke.powershell.outcome).toBe("passed");
    const envelopes = request.mock.calls.map((call) => call[1] as Record<string, unknown>);
    expect(envelopes.map((entry) => entry.command)).toEqual([
      "system.run",
      "system.run.prepare",
      WINDOWS_NODE_MXC_READINESS_COMMAND,
      "system.run.prepare",
      WINDOWS_NODE_MXC_READINESS_COMMAND,
    ]);
    const readinessCalls = envelopes.filter(
      (entry) => entry.command === WINDOWS_NODE_MXC_READINESS_COMMAND,
    );
    expect(readinessCalls).toHaveLength(2);
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
      preflightWindowsNodeMxcBackend(
        "C:\\MXC\\wxc-exec.exe",
        "limited-dacl",
        async () => probe,
      ),
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
