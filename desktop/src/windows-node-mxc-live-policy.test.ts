import { describe, expect, it } from "vitest";
import { WindowsNodeMxcPolicyAuthority } from "./windows-node-mxc-live-policy";
import { computeWindowsNodeMxcApprovalPlanSha256 } from "./windows-node-mxc-readiness-proof";
import { fingerprintSecuritySettings } from "./windows-node-mxc-service";
import { normalizeWindowsNodeMxcGatewayApproval } from "./windows-node-mxc";
// @ts-expect-error The Gateway preload is external ESM.
import * as compat from "./openclaw-approval-replay-compat.mjs";

const plan = {
  argv: ["C:\\Windows\\System32\\hostname.exe"],
  cwd: null,
  commandText: "C:\\Windows\\System32\\hostname.exe",
  commandPreview: null,
  agentId: "main",
  sessionKey: "agent:main:test",
  executablePath: "C:\\Windows\\System32\\hostname.exe",
  executableSha256: "a".repeat(64),
  cwdBinding: "isolated-scratch:v1",
  declaredAccess: [],
};

function fixture(generation = "gateway-1") {
  const authority = new WindowsNodeMxcPolicyAuthority(generation);
  let text = "";
  const read = compat.createWindowsNodeMxcLivePolicyReader(
    {
      path: "unused",
      publicKey: authority.publicKey,
      gatewayGeneration: "gateway-1",
    },
    () => text,
  );
  return {
    authority,
    read,
    set: (envelope: unknown) => {
      text = JSON.stringify(envelope);
    },
  };
}

describe("authenticated live folder policy", () => {
  it("preserves the exact prepared-plan digest through the desktop approval bridge", () => {
    const prepared = { ...plan, policyFingerprint: "c".repeat(64) };
    const approval = normalizeWindowsNodeMxcGatewayApproval(
      {
        id: "request-1",
        allowedDecisions: ["deny", "allow-once"],
        request: { host: "node", nodeId: "b".repeat(64), systemRunPlan: prepared },
      },
      "b".repeat(64),
    );
    expect(approval?.planSha256).toBe(compat.computeWindowsNodeMxcApprovalPlanSha256(prepared));
    expect(approval?.policyFingerprint).toBe(prepared.policyFingerprint);
  });
  it("verifies the Electron signature and rejects tampering and rollback", () => {
    const f = fixture();
    const first = f.authority.issue('{"approvedRoots":[]}');
    f.set(first.envelope);
    expect(f.read()).toEqual(first.policy);
    expect(f.read()).toBe(f.read());
    f.set({ ...first.envelope, signature: Buffer.alloc(64).toString("base64") });
    expect(() => f.read()).toThrow(/signature/);
    const next = f.authority.issue('{"approvedRoots":[{"path":"C:\\\\Work","access":"ReadOnly"}]}');
    f.set(next.envelope);
    expect(f.read().revision).toBe(2);
    f.set(first.envelope);
    expect(() => f.read()).toThrow(/revision/);
    f.set({ ...next.envelope, payload: next.envelope.payload.replace("ReadOnly", "ReadWrite") });
    expect(() => f.read()).toThrow(/signature/);
  });

  it("rejects a correctly signed policy from another generation", () => {
    const f = fixture("other-generation");
    f.set(f.authority.issue("{}").envelope);
    expect(() => f.read()).toThrow(/generation/);
  });

  it("bridges only the exact approved plan across a folder revision", () => {
    const f = fixture();
    const first = f.authority.issue('{"approvedRoots":[]}');
    const prepared = { ...plan, policyFingerprint: first.policy.policyFingerprint };
    const hash = computeWindowsNodeMxcApprovalPlanSha256(prepared);
    expect(hash).toBe(compat.computeWindowsNodeMxcApprovalPlanSha256(prepared));
    let now = Date.now();
    const expiry = now + 30_000;
    f.set(first.envelope);
    const minter = compat.createWindowsNodeMxcApprovalProofMinter(
      {
        secretBase64: Buffer.alloc(32, 1).toString("base64"),
        gatewayGeneration: "gateway-1",
        nodeId: "b".repeat(64),
        policyFingerprint: first.policy.policyFingerprint,
      },
      { readPolicy: f.read, now: () => now },
    );
    const mint = (approvalId = "approval-1", candidate = prepared) =>
      minter.mint({ approvalId, plan: candidate, nodeId: "b".repeat(64) });
    expect(mint().policyFingerprint).toBe(first.policy.policyFingerprint);
    const next = f.authority.issue(
      '{"approvedRoots":[{"path":"C:\\\\Work","access":"ReadWrite"}]}',
      {
        approvalId: "approval-1",
        planSha256: hash,
        expiresAtUnixMs: expiry,
      },
    );
    f.set(next.envelope);
    expect(mint().policyFingerprint).toBe(next.policy.policyFingerprint);
    expect(() => mint("approval-other")).toThrow(/stale/);
    expect(() => mint("approval-1", { ...prepared, sessionKey: "other-session" })).toThrow(/stale/);
    now = expiry;
    expect(() => mint()).toThrow(/stale/);
    expect(
      mint("new-request", { ...prepared, policyFingerprint: next.policy.policyFingerprint })
        .policyFingerprint,
    ).toBe(next.policy.policyFingerprint);
  });

  it("rejects expired approval bindings before signing", () => {
    expect(() =>
      fixture().authority.issue("{}", {
        approvalId: "one",
        planSha256: "a".repeat(64),
        expiresAtUnixMs: 1,
      }),
    ).toThrow(/expired/);
  });

  it("keeps activation evidence across live folder changes, but not runtime changes", () => {
    const before = { SystemRunSandboxEnabled: true, SandboxCustomFolders: [] };
    const after = { ...before, SandboxCustomFolders: [{ Path: "C:\\Work", Access: 2 }] };
    expect(fingerprintSecuritySettings(before, true)).toBe(
      fingerprintSecuritySettings(after, true),
    );
    expect(fingerprintSecuritySettings(before)).not.toBe(fingerprintSecuritySettings(after));
    expect(fingerprintSecuritySettings(before, true)).not.toBe(fingerprintSecuritySettings(before));
    expect(fingerprintSecuritySettings(before, true)).not.toBe(
      fingerprintSecuritySettings({ ...after, SystemRunSandboxEnabled: false }, true),
    );
  });
});
