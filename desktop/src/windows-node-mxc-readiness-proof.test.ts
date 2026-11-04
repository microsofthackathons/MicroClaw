import { describe, expect, it } from "vitest";
import {
  WINDOWS_NODE_MXC_READINESS_AGENT_ID,
  WINDOWS_NODE_MXC_READINESS_PROBES,
  WINDOWS_NODE_MXC_READINESS_PROOF_CONTRACT,
  WINDOWS_NODE_MXC_READINESS_PROOF_TTL_MS,
  WINDOWS_NODE_MXC_SCRATCH_BINDING,
  createWindowsNodeMxcReadinessProofMinter,
  windowsNodeMxcReadinessSessionKey,
  type WindowsNodeMxcReadinessPlan,
} from "./windows-node-mxc-readiness-proof";

const transitionId = "12345678-1234-4234-8234-123456789abc";
const secret = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("base64");

function plan(): WindowsNodeMxcReadinessPlan {
  const kind = "execution";
  const argv = [...WINDOWS_NODE_MXC_READINESS_PROBES[kind]];
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

function minter() {
  return createWindowsNodeMxcReadinessProofMinter(
    {
      secretBase64: secret,
      gatewayGeneration: "generation-test-001",
      policyFingerprint: "a".repeat(64),
      nodeId: "b".repeat(64),
      readinessTransitionId: transitionId,
    },
    {
      now: () => 1_735_689_600_000,
      randomUUID: () => "12345678-1234-4234-8234-123456789abd",
    },
  );
}

describe("Windows Node MXC internal readiness proof", () => {
  it("binds the exact fixed probe to transition, generation, policy, node, and plan", () => {
    const proof = minter().mint({
      transitionId,
      nodeId: "B".repeat(64),
      probeKind: "execution",
      plan: plan(),
    });

    expect(proof).toEqual({
      contract: WINDOWS_NODE_MXC_READINESS_PROOF_CONTRACT,
      transitionId,
      nonce: "12345678-1234-4234-8234-123456789abd",
      gatewayGeneration: "generation-test-001",
      policyFingerprint: "a".repeat(64),
      nodeId: "b".repeat(64),
      probeKind: "execution",
      planSha256: "35fc1fc5eb08a374a0247f7dde073db0ca0578d26158bbd6fdc5110ac6e50bda",
      issuedAtUnixMs: 1_735_689_600_000,
      expiresAtUnixMs: 1_735_689_600_000 + WINDOWS_NODE_MXC_READINESS_PROOF_TTL_MS,
      signature: "223e2c971807546fe05478ebf9e28790b3b6339a92504e7f9fd6a559aab167c7",
    });
  });

  it.each([
    ["argv", { argv: [...plan().argv, "extra"] }],
    ["cwd", { cwd: "C:\\Windows" }],
    ["declaration", { declaredAccess: [{ access: "ro" as const, path: "C:\\Work" }] }],
    ["agent", { agentId: "main" }],
    ["session", { sessionKey: "agent:main:main" }],
    ["scratch", { cwdBinding: "C:\\Work" }],
    ["preview", { commandPreview: "execution" }],
    ["executable", { executablePath: "C:\\Windows\\System32\\whoami.exe" }],
  ])("rejects altered %s identity", (_label, changed) => {
    expect(() =>
      minter().mint({
        transitionId,
        nodeId: "b".repeat(64),
        probeKind: "execution",
        plan: { ...plan(), ...changed },
      }),
    ).toThrow(/exact built-in probe/);
  });

  it("rejects wrong transition, node, probe kind, and malformed contexts", () => {
    expect(() =>
      minter().mint({
        transitionId: "12345678-1234-4234-8234-123456789abe",
        nodeId: "b".repeat(64),
        probeKind: "execution",
        plan: plan(),
      }),
    ).toThrow(/outside the current transition/);
    expect(() =>
      minter().mint({
        transitionId,
        nodeId: "d".repeat(64),
        probeKind: "execution",
        plan: plan(),
      }),
    ).toThrow(/outside the current transition/);
    expect(() =>
      minter().mint({
        transitionId,
        nodeId: "b".repeat(64),
        probeKind: "hostname" as never,
        plan: plan(),
      }),
    ).toThrow(/outside the current transition/);
    expect(() =>
      createWindowsNodeMxcReadinessProofMinter({
        secretBase64: Buffer.alloc(31).toString("base64"),
        gatewayGeneration: "generation",
        policyFingerprint: "a".repeat(64),
        nodeId: "b".repeat(64),
        readinessTransitionId: transitionId,
      }),
    ).toThrow(/256 bits/);
  });
});
