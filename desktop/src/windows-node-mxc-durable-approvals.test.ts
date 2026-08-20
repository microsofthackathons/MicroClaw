import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WINDOWS_NODE_MXC_APPROVAL_PLAN_CONTRACT,
  WINDOWS_NODE_MXC_DURABLE_APPROVALS_CONTRACT,
  WindowsNodeMxcDurableApprovalStore,
  consumeExactDurableApproval,
  durableApprovalIdentityFromGateway,
  durableApprovalMatches,
  type WindowsNodeMxcDurableApprovalIdentity,
} from "./windows-node-mxc-durable-approvals";
import type { WindowsNodeMxcGatewayApproval } from "./windows-node-mxc";

const filePath = "C:\\State\\durable-approvals.json";
const writes: string[] = [];
const identity: WindowsNodeMxcDurableApprovalIdentity = {
  executablePath: "C:\\Windows\\System32\\cmd.exe",
  executableSha256: "a".repeat(64),
  argv: ["cmd.exe", "/d", "/c", "echo ok"],
  commandText: 'cmd.exe /d /c "echo ok"',
  cwdBinding: "C:\\Work",
  declaredAccess: [{ access: "rw", path: "C:\\Work" }],
  agentId: "main",
  sessionKey: "agent:main:session-1",
  policyFingerprint: "b".repeat(64),
};

function store(initial: unknown = null) {
  let contents = initial === null ? null : JSON.stringify(initial);
  const instance = new WindowsNodeMxcDurableApprovalStore(filePath, {
    now: () => new Date("2026-08-20T00:00:00.000Z"),
    createId: () => "approval-1",
    existsFile: (target) => target === filePath && contents !== null,
    readFile: () => contents ?? "",
    writeFile: async (_target, next) => {
      writes.push(next);
      contents = next;
    },
  });
  return instance;
}

afterEach(() => {
  writes.length = 0;
});

describe("WindowsNodeMxcDurableApprovalStore", () => {
  it("persists, matches, touches, revokes, and revokes all atomically", async () => {
    const approvals = store();
    const added = await approvals.add(identity);
    expect(added).toMatchObject({
      id: "approval-1",
      approvalPlanContract: WINDOWS_NODE_MXC_APPROVAL_PLAN_CONTRACT,
      lastUsedAt: null,
    });
    expect(approvals.findExact(identity)?.id).toBe("approval-1");

    await approvals.touch("approval-1");
    expect(approvals.inspect().records[0].lastUsedAt).toBe("2026-08-20T00:00:00.000Z");
    await approvals.revoke("approval-1");
    expect(approvals.inspect().records).toEqual([]);

    await approvals.add(identity);
    await approvals.revokeAll();
    expect(approvals.inspect().records).toEqual([]);
    expect(writes).toHaveLength(5);
  });

  it("treats legacy, malformed, and stale records as non-authorizing", () => {
    expect(store([]).inspect()).toMatchObject({ records: [], invalidRecords: 1 });
    const malformed = store({
      contract: WINDOWS_NODE_MXC_DURABLE_APPROVALS_CONTRACT,
      records: [{ schemaVersion: 0 }],
    });
    expect(malformed.findExact(identity)).toBeNull();
    expect(malformed.inspect().warning).toContain("authorize nothing");
  });

  it.each([
    ["argv", { argv: [...identity.argv, "changed"] }],
    ["cwd", { cwdBinding: "C:\\Other" }],
    ["access", { declaredAccess: [{ access: "ro" as const, path: "C:\\Work" }] }],
    ["hash", { executableSha256: "c".repeat(64) }],
    ["agent", { agentId: "coder" }],
    ["session", { sessionKey: "agent:main:session-2" }],
    ["policy", { policyFingerprint: "d".repeat(64) }],
    ["path", { executablePath: "C:\\Other\\cmd.exe" }],
  ])("rejects an exact-identity %s mismatch", async (_label, change) => {
    const approvals = store();
    const record = await approvals.add(identity);
    expect(durableApprovalMatches(record, { ...identity, ...change })).toBe(false);
  });

  it("builds an eligible identity only from a fully bound prepared plan", () => {
    const approval: WindowsNodeMxcGatewayApproval = {
      id: "request-1",
      command: identity.commandText,
      executable: "cmd.exe",
      arguments: identity.argv.slice(1),
      executablePath: identity.executablePath,
      executableSha256: identity.executableSha256,
      canonicalCwd: identity.cwdBinding,
      agent: identity.agentId,
      sessionKey: identity.sessionKey,
      declaredAccess: identity.declaredAccess,
      allowedDecisions: ["deny", "allow-once", "allow-always"],
    };
    expect(durableApprovalIdentityFromGateway(approval, identity.policyFingerprint)).toEqual(
      identity,
    );
    expect(
      durableApprovalIdentityFromGateway(
        { ...approval, executableSha256: "not-a-hash" },
        identity.policyFingerprint,
      ),
    ).toBeNull();
  });

  it("serializes concurrent writes instead of losing records", async () => {
    const approvals = store();
    await Promise.all([
      approvals.add(identity),
      approvals.add({
        ...identity,
        executablePath: "C:\\Windows\\System32\\hostname.exe",
        executableSha256: "e".repeat(64),
        argv: ["hostname.exe"],
        commandText: "hostname.exe",
      }),
    ]);
    expect(approvals.inspect().records).toHaveLength(2);
  });

  it("prompts once for a new tuple, zero times for its exact repeat, and again for a change", async () => {
    const approvals = store();
    let prompts = 0;
    const needsPrompt = (candidate: WindowsNodeMxcDurableApprovalIdentity) => {
      const needed = approvals.findExact(candidate) === null;
      if (needed) prompts++;
      return needed;
    };

    expect(needsPrompt(identity)).toBe(true);
    await approvals.add(identity);
    expect(needsPrompt(identity)).toBe(false);
    expect(needsPrompt({ ...identity, argv: [...identity.argv, "changed"] })).toBe(true);
    expect(prompts).toBe(2);
  });

  it("does not persist allow-once or deny decisions without an explicit durable add", () => {
    const approvals = store();
    expect(approvals.list()).toEqual([]);
    expect(approvals.findExact(identity)).toBeNull();
  });

  it("rechecks revocation before resolving a pending exact approval", async () => {
    const approvals = store();
    const added = await approvals.add(identity);
    await approvals.revoke(added.id);
    const resolveOnce = vi.fn();

    expect(
      await consumeExactDurableApproval(approvals, identity, added.id, resolveOnce, vi.fn()),
    ).toBe(false);
    expect(resolveOnce).not.toHaveBeenCalled();
  });
});
