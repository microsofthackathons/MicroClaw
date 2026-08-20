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

function plan(kind: "hostname" | "powershell"): WindowsNodeMxcReadinessPlan {
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
      probeKind: "hostname",
      plan: plan("hostname"),
    });

    expect(proof).toEqual({
      contract: WINDOWS_NODE_MXC_READINESS_PROOF_CONTRACT,
      transitionId,
      nonce: "12345678-1234-4234-8234-123456789abd",
      gatewayGeneration: "generation-test-001",
      policyFingerprint: "a".repeat(64),
      nodeId: "b".repeat(64),
      probeKind: "hostname",
      planSha256: "1cf9d0658d325540aba0d944d8d00937b2c86626a6a814cbc9017a2ab63c2c45",
      issuedAtUnixMs: 1_735_689_600_000,
      expiresAtUnixMs: 1_735_689_600_000 + WINDOWS_NODE_MXC_READINESS_PROOF_TTL_MS,
      signature: "7c964f4e5c2c0f169eb295185edf317f609cbdfe105b29ec29980bebb577744d",
    });
  });

  it.each([
    ["argv", { argv: [...plan("hostname").argv, "extra"] }],
    ["cwd", { cwd: "C:\\Windows" }],
    ["declaration", { declaredAccess: [{ access: "ro" as const, path: "C:\\Work" }] }],
    ["agent", { agentId: "main" }],
    ["session", { sessionKey: "agent:main:main" }],
    ["scratch", { cwdBinding: "C:\\Work" }],
    ["preview", { commandPreview: "hostname" }],
    ["executable", { executablePath: "C:\\Windows\\System32\\whoami.exe" }],
  ])("rejects altered %s identity", (_label, changed) => {
    expect(() =>
      minter().mint({
        transitionId,
        nodeId: "b".repeat(64),
        probeKind: "hostname",
        plan: { ...plan("hostname"), ...changed },
      }),
    ).toThrow(/exact built-in probe/);
  });

  it("rejects wrong transition, node, probe kind, and malformed contexts", () => {
    expect(() =>
      minter().mint({
        transitionId: "12345678-1234-4234-8234-123456789abe",
        nodeId: "b".repeat(64),
        probeKind: "hostname",
        plan: plan("hostname"),
      }),
    ).toThrow(/outside the current transition/);
    expect(() =>
      minter().mint({
        transitionId,
        nodeId: "d".repeat(64),
        probeKind: "hostname",
        plan: plan("hostname"),
      }),
    ).toThrow(/outside the current transition/);
    expect(() =>
      minter().mint({
        transitionId,
        nodeId: "b".repeat(64),
        probeKind: "powershell",
        plan: plan("hostname"),
      }),
    ).toThrow(/exact built-in probe/);
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
