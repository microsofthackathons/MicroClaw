import { describe, expect, it, vi } from "vitest";
import {
  commitWindowsNodeMxcFolderPolicyAtomically,
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

  describe("commitWindowsNodeMxcFolderPolicyAtomically", () => {
    it("rolls ACLs back when persistence fails", async () => {
      const log: string[] = [];
      await expect(
        commitWindowsNodeMxcFolderPolicyAtomically(
          async () => {
            log.push("apply");
          },
          () => {
            log.push("persist");
            throw new Error("persist failed");
          },
          async () => {
            log.push("rollback");
          },
        ),
      ).rejects.toThrow("persist failed");
      expect(log).toEqual(["apply", "persist", "rollback"]);
    });

    it("reports a rollback failure without hiding the original mutation failure", async () => {
      await expect(
        commitWindowsNodeMxcFolderPolicyAtomically(
          async () => {
            throw new Error("grant failed");
          },
          () => undefined,
          async () => {
            throw new Error("rollback failed");
          },
        ),
      ).rejects.toMatchObject({
        message: "MXC folder policy mutation failed and its ACL rollback also failed",
        errors: [
          expect.objectContaining({ message: "grant failed" }),
          expect.objectContaining({ message: "rollback failed" }),
        ],
      });
    });
  });

  it.each([
    "closeIngress",
    "rejectPendingApprovals",
    "revokeAuthorization",
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
        applied: ["closeIngress", "rejectPendingApprovals", "revokeAuthorization", "validatePolicy"].includes(
          failure,
        )
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
  });
});
