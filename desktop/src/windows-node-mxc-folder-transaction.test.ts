import { describe, expect, it, vi } from "vitest";
import {
  describeWindowsNodeMxcFolderTransactionError,
  runWindowsNodeMxcFolderPolicyTransaction,
  type WindowsNodeMxcFolderPolicy,
  type WindowsNodeMxcFolderTransactionHooks,
} from "./windows-node-mxc-folder-transaction";

const previous: WindowsNodeMxcFolderPolicy = { rw: ["C:\\Old"], ro: [] };
const draft: WindowsNodeMxcFolderPolicy = { rw: ["C:\\New"], ro: [] };

function createHooks(log: string[]): WindowsNodeMxcFolderTransactionHooks<string> {
  const step = <T>(name: string, value?: T) =>
    vi.fn(async () => {
      log.push(name);
      return value as T;
    });
  return {
    setPhase: (phase) => log.push(`phase:${phase}`),
    closeIngress: step("closeIngress"),
    rejectPendingApprovals: step("rejectPendingApprovals"),
    revokeAuthorization: step("revokeAuthorization"),
    preflightExactBackend: step("preflightExactBackend"),
    validatePolicy: step("validatePolicy", draft),
    stopCurrentGeneration: step("stopCurrentGeneration"),
    persistPolicy: step("persistPolicy"),
    startLockedGeneration: step("startLockedGeneration", "locked"),
    attestLockedGeneration: step("attestLockedGeneration"),
    smokeLockedGeneration: step("smokeLockedGeneration"),
    startActiveGeneration: step("startActiveGeneration", "active"),
    attestActiveGeneration: step("attestActiveGeneration"),
    smokeActiveGeneration: step("smokeActiveGeneration"),
    mintActivationLease: step("mintActivationLease"),
    verifyActiveGeneration: step("verifyActiveGeneration", "verified"),
    releaseIngress: step("releaseIngress"),
    lockAfterFailure: step("lockAfterFailure"),
  };
}

describe("runWindowsNodeMxcFolderPolicyTransaction", () => {
  it("releases ingress only after both generations and final verification succeed", async () => {
    const log: string[] = [];
    const result = await runWindowsNodeMxcFolderPolicyTransaction(
      draft,
      previous,
      createHooks(log),
    );

    expect(result).toBe("verified");
    expect(log).toEqual([
      "phase:locking",
      "closeIngress",
      "rejectPendingApprovals",
      "revokeAuthorization",
      "phase:validating",
      "preflightExactBackend",
      "validatePolicy",
      "stopCurrentGeneration",
      "phase:persisting",
      "persistPolicy",
      "phase:starting-locked",
      "startLockedGeneration",
      "attestLockedGeneration",
      "phase:smoking-locked",
      "smokeLockedGeneration",
      "phase:starting-active",
      "startActiveGeneration",
      "attestActiveGeneration",
      "phase:smoking-active",
      "smokeActiveGeneration",
      "mintActivationLease",
      "phase:verifying-active",
      "verifyActiveGeneration",
      "releaseIngress",
      "phase:active",
    ]);
  });

  it.each([
    "closeIngress",
    "rejectPendingApprovals",
    "revokeAuthorization",
    "preflightExactBackend",
    "validatePolicy",
    "stopCurrentGeneration",
    "persistPolicy",
    "startLockedGeneration",
    "attestLockedGeneration",
    "smokeLockedGeneration",
    "startActiveGeneration",
    "attestActiveGeneration",
    "smokeActiveGeneration",
    "mintActivationLease",
    "verifyActiveGeneration",
    "releaseIngress",
  ] as const)("fails locked when %s fails", async (failure) => {
    const log: string[] = [];
    const hooks = createHooks(log);
    vi.mocked(hooks[failure]).mockRejectedValueOnce(new Error(`${failure} failed`));

    await expect(runWindowsNodeMxcFolderPolicyTransaction(draft, previous, hooks)).rejects.toThrow(
      `${failure} failed`,
    );
    expect(hooks.lockAfterFailure).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        previous,
        draft,
        applied: [
          "closeIngress",
          "rejectPendingApprovals",
          "revokeAuthorization",
          "preflightExactBackend",
          "validatePolicy",
        ].includes(failure)
          ? null
          : draft,
        persisted: [
          "startLockedGeneration",
          "attestLockedGeneration",
          "smokeLockedGeneration",
          "startActiveGeneration",
          "attestActiveGeneration",
          "smokeActiveGeneration",
          "mintActivationLease",
          "verifyActiveGeneration",
          "releaseIngress",
        ].includes(failure),
        failurePhase: expect.any(String),
      }),
    );
    expect(log).not.toContain("phase:active");
    expect(log).toContain("phase:locked");
  });

  it("reports both the transaction and locked-recovery failures", async () => {
    const hooks = createHooks([]);
    vi.mocked(hooks.persistPolicy).mockRejectedValueOnce(new Error("persist failed"));
    vi.mocked(hooks.lockAfterFailure).mockRejectedValueOnce(new Error("lock failed"));

    await expect(runWindowsNodeMxcFolderPolicyTransaction(draft, previous, hooks)).rejects.toThrow(
      "locked recovery step also failed",
    );
    expect(hooks.lockAfterFailure).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ failurePhase: "persisting" }),
    );
  });

  it("preserves nested AggregateError diagnostics without dropping launcher details", () => {
    const grantError = new Error(
      "MXC ACL grant failed: timedOut=true; stderr=protected child access denied",
    );
    const rollbackError = new AggregateError(
      [new Error("revoke timed out"), new Error("protectedChildrenClear=false")],
      "rollback failed",
    );
    const error = new AggregateError(
      [grantError, rollbackError],
      "MXC folder policy mutation failed and its ACL rollback also failed",
    );

    expect(describeWindowsNodeMxcFolderTransactionError(error)).toBe(
      "MXC folder policy mutation failed and its ACL rollback also failed: " +
        "Error: MXC ACL grant failed: timedOut=true; stderr=protected child access denied | " +
        "rollback failed: Error: revoke timed out | Error: protectedChildrenClear=false",
    );
  });
});
