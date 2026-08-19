import { describe, expect, it } from "vitest";
// @ts-expect-error The compatibility preload is intentionally external ESM for the Gateway child.
import * as replayCompat from "./openclaw-approval-replay-compat.mjs";

const {
  APPROVAL_PROOF_CONTRACT,
  APPROVAL_PROOF_TTL_MS,
  PINNED_CALL_SOURCE,
  PINNED_FUNCTION_SOURCE,
  PINNED_NODE_GATEWAY_ALLOW_ALWAYS_SOURCE,
  PINNED_NODE_GATEWAY_ALLOW_ONCE_SOURCE,
  PINNED_NODE_GATEWAY_BRIDGED_ALLOW_ONCE_SOURCE,
  PINNED_NODE_GATEWAY_MINT_INSERT_SOURCE,
  createWindowsNodeMxcApprovalProofMinter,
  patchPinnedOpenClawGateway,
  patchPinnedOpenClawNodeGateway,
  shouldInitializeApprovalPreload,
} = replayCompat;

describe("OpenClaw node approval replay compatibility", () => {
  it("backports the upstream replay identity binding", () => {
    const patched = patchPinnedOpenClawGateway(
      `${PINNED_FUNCTION_SOURCE}\nfixture\n${PINNED_CALL_SOURCE}`,
    );

    expect(patched).toContain("isApprovalReplayNodeSystemRun");
    expect(patched).toContain("callParams: params");
    expect(patched).toContain("loadDeviceIdentityIfPresent()");
    expect(patched).not.toContain(PINNED_FUNCTION_SOURCE);
  });

  it("fails closed when the pinned source shape drifts", () => {
    expect(() => patchPinnedOpenClawGateway("unrecognized source")).toThrow(
      "did not match exactly once",
    );
    expect(() =>
      patchPinnedOpenClawGateway(
        `${PINNED_FUNCTION_SOURCE}\n${PINNED_FUNCTION_SOURCE}\n${PINNED_CALL_SOURCE}`,
      ),
    ).toThrow("did not match exactly once");
  });
});

describe("pinned OpenClaw node approval proof backport", () => {
  const source = [
    PINNED_NODE_GATEWAY_MINT_INSERT_SOURCE,
    PINNED_NODE_GATEWAY_ALLOW_ONCE_SOURCE,
    PINNED_NODE_GATEWAY_ALLOW_ALWAYS_SOURCE,
    PINNED_NODE_GATEWAY_BRIDGED_ALLOW_ONCE_SOURCE,
  ].join("\n");

  it("injects a proof only into approved replay branches", () => {
    const patched = patchPinnedOpenClawNodeGateway(source);

    expect(patched.match(/microclawApprovalProof =/g)).toHaveLength(2);
    expect(patched).toContain("manager.consumeAllowOnce(runId)");
    expect(patched).toContain(
      "approved && requestedDecision === \"allow-once\" && clientHasApprovals(opts.client)) {\n\t\treturn systemRunApprovalRequired(runId);",
    );
    expect(patched).toContain("plan: runtimeContext.plan");
    expect(patched).toContain("nodeId: targetNodeId");
    expect(patched.indexOf("consumeAllowOnce(runId)")).toBeLessThan(
      patched.indexOf("microclawApprovalProof ="),
    );
  });

  it.each([
    PINNED_NODE_GATEWAY_MINT_INSERT_SOURCE,
    PINNED_NODE_GATEWAY_ALLOW_ONCE_SOURCE,
    PINNED_NODE_GATEWAY_ALLOW_ALWAYS_SOURCE,
    PINNED_NODE_GATEWAY_BRIDGED_ALLOW_ONCE_SOURCE,
  ])("fails closed when a pinned source fragment drifts", (fragment) => {
    expect(() =>
      patchPinnedOpenClawNodeGateway(
        source.replace(fragment, `${fragment.slice(0, -1)}/* drift */`),
      ),
    ).toThrow(/did not match exactly once/);
  });

  it("fails closed when a pinned source fragment appears more than once", () => {
    expect(() =>
      patchPinnedOpenClawNodeGateway(`${source}\n${PINNED_NODE_GATEWAY_ALLOW_ONCE_SOURCE}`),
    ).toThrow(/did not match exactly once/);
  });
});

describe("Windows Node MXC approval proof minter", () => {
  const secret = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("base64");
  const plan = {
    argv: ["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", "echo café"],
    cwd: "C:\\Users\\Test\\Work",
    commandText: "echo café",
    commandPreview:
      "[declare-access]rw:C:\\Users\\Test\\Work[/declare-access] echo café",
    agentId: "main",
    sessionKey: "agent:main:main",
  };

  it("matches the fixed cross-language proof vector", () => {
    const minter = createWindowsNodeMxcApprovalProofMinter(
      {
        secretBase64: secret,
        gatewayGeneration: "generation-test-001",
        policyFingerprint: "a".repeat(64),
        nodeId: "b".repeat(64),
      },
      {
        now: () => 1_735_689_600_000,
        randomUUID: () => "12345678-1234-4234-8234-123456789abc",
      },
    );

    expect(
      minter.mint({
        approvalId: "approval-001",
        nodeId: "B".repeat(64),
        plan,
      }),
    ).toEqual({
      contract: APPROVAL_PROOF_CONTRACT,
      approvalId: "approval-001",
      nonce: "12345678-1234-4234-8234-123456789abc",
      gatewayGeneration: "generation-test-001",
      policyFingerprint: "a".repeat(64),
      nodeId: "b".repeat(64),
      planSha256: "4782770b7a3fa8db392ebaf6d0de8552586af5a251eebce502c6c36ddee9ad53",
      issuedAtUnixMs: 1_735_689_600_000,
      expiresAtUnixMs: 1_735_689_600_000 + APPROVAL_PROOF_TTL_MS,
      signature: "1011191f87cbd0ecbe947c3f8e965574c6359afa4c2c7c3d220e3127f521e560",
    });
  });

  describe("approval preload process scope", () => {
    it("initializes only once in the Gateway main process", () => {
      const enabled = { MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT: "1" };
      expect(shouldInitializeApprovalPreload(enabled, true)).toBe(true);
      expect(
        shouldInitializeApprovalPreload(
          {
            ...enabled,
            MICROCLAW_MXC_APPROVAL_PRELOAD_INITIALIZED: "1",
          },
          false,
        ),
      ).toBe(false);
      expect(() => shouldInitializeApprovalPreload(enabled, false)).toThrow(/main thread/);
      expect(shouldInitializeApprovalPreload({}, true)).toBe(false);
    });
  });

  it("rejects malformed contexts, wrong nodes, and incomplete plans", () => {
    expect(() =>
      createWindowsNodeMxcApprovalProofMinter({
        secretBase64: Buffer.alloc(31).toString("base64"),
        gatewayGeneration: "generation",
        policyFingerprint: "a".repeat(64),
        nodeId: "b".repeat(64),
      }),
    ).toThrow(/256 bits/);

    const minter = createWindowsNodeMxcApprovalProofMinter({
      secretBase64: secret,
      gatewayGeneration: "generation",
      policyFingerprint: "a".repeat(64),
      nodeId: "b".repeat(64),
    });
    expect(() =>
      minter.mint({ approvalId: "approval", nodeId: "c".repeat(64), plan }),
    ).toThrow(/node binding/);
    expect(() =>
      minter.mint({
        approvalId: "approval",
        nodeId: "b".repeat(64),
        plan: { ...plan, sessionKey: null },
      }),
    ).toThrow(/sessionKey/);
  });

  it("mints a fresh nonce for each approved execution", () => {
    let nonce = 0;
    const minter = createWindowsNodeMxcApprovalProofMinter(
      {
        secretBase64: secret,
        gatewayGeneration: "generation",
        policyFingerprint: "a".repeat(64),
        nodeId: "b".repeat(64),
      },
      { randomUUID: () => `nonce-${++nonce}` },
    );

    const first = minter.mint({
      approvalId: "approval-1",
      nodeId: "b".repeat(64),
      plan,
    });
    const second = minter.mint({
      approvalId: "approval-2",
      nodeId: "b".repeat(64),
      plan,
    });

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.signature).not.toBe(second.signature);
  });
});
