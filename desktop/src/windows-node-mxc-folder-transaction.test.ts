import { describe, expect, it, vi } from "vitest";
import {
  commitWindowsNodeMxcFolderPolicyAtomically,
  describeWindowsNodeMxcFolderTransactionError,
  replaceWindowsNodeMxcFolderAcls,
  runWindowsNodeMxcFolderPolicyTransaction,
  type WindowsNodeMxcAclLauncherResult,
  type WindowsNodeMxcFolderAclHooks,
  type WindowsNodeMxcFolderPolicy,
  type WindowsNodeMxcFolderTransactionHooks,
} from "./windows-node-mxc-folder-transaction";

const previous: WindowsNodeMxcFolderPolicy = { rw: ["C:\\Old"], ro: [] };
const draft: WindowsNodeMxcFolderPolicy = { rw: ["C:\\New"], ro: [] };

const launcherResult = (
  overrides: Partial<WindowsNodeMxcAclLauncherResult> = {},
): WindowsNodeMxcAclLauncherResult => ({
  ok: true,
  timedOut: false,
  exitCode: 0,
  signal: null,
  stderr: "",
  errorMessage: null,
  durationMs: 20,
  ...overrides,
});

function createAclHooks(log: string[]): WindowsNodeMxcFolderAclHooks {
  return {
    normalizePath: (path) => path.toLowerCase(),
    grant: vi.fn(async (path, access) => {
      log.push(`grant:${path}:${access}`);
      return launcherResult();
    }),
    revoke: vi.fn(async (path) => {
      log.push(`revoke:${path}`);
      return launcherResult();
    }),
    verifyGrant: vi.fn(async (path, access) => {
      log.push(`verifyGrant:${path}:${access}`);
      return { satisfied: true, detail: "root and protected children satisfied" };
    }),
    verifyRevoked: vi.fn(async (path) => {
      log.push(`verifyRevoked:${path}`);
      return { satisfied: true, detail: "root and protected children clear" };
    }),
  };
}

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
  describe("replaceWindowsNodeMxcFolderAcls", () => {
    it("skips unchanged roots and mutates only additions or access changes", async () => {
      const log: string[] = [];
      const hooks = createAclHooks(log);

      await replaceWindowsNodeMxcFolderAcls(
        { rw: ["C:\\Desktop", "C:\\Changed"], ro: ["C:\\ReadOnly"] },
        {
          rw: ["C:\\Desktop", "C:\\Documents"],
          ro: ["C:\\ReadOnly", "C:\\Changed"],
        },
        hooks,
      );

      expect(log).toEqual([
        "revoke:C:\\Changed",
        "verifyRevoked:C:\\Changed",
        "grant:C:\\Changed:r",
        "verifyGrant:C:\\Changed:r",
        "grant:C:\\Documents:rw",
        "verifyGrant:C:\\Documents:rw",
      ]);
    });

    it("accepts a slow Documents-like grant timeout only after full ACL reconciliation", async () => {
      const log: string[] = [];
      const hooks = createAclHooks(log);
      vi.mocked(hooks.grant).mockResolvedValueOnce(
        launcherResult({
          ok: false,
          timedOut: true,
          exitCode: null,
          signal: "SIGTERM",
          stderr: "[grant] protected children scan completed after launcher timeout",
          errorMessage: "Command timed out after 10000ms",
          durationMs: 10_012,
        }),
      );
      vi.mocked(hooks.verifyGrant).mockResolvedValueOnce({
        satisfied: true,
        detail:
          "rootSufficient=true; protectedChildrenSufficient=true; protectedChildrenChecked=534",
      });

      await expect(
        replaceWindowsNodeMxcFolderAcls(
          { rw: ["C:\\Desktop"], ro: [] },
          { rw: ["C:\\Desktop", "C:\\Users\\sunt\\Documents"], ro: [] },
          hooks,
        ),
      ).resolves.toBeUndefined();
      expect(hooks.grant).toHaveBeenCalledTimes(1);
      expect(hooks.verifyGrant).toHaveBeenCalledTimes(1);
    });

    it("accepts a revoke timeout only after verified root and protected-child removal", async () => {
      const hooks = createAclHooks([]);
      vi.mocked(hooks.revoke).mockResolvedValueOnce(
        launcherResult({
          ok: false,
          timedOut: true,
          signal: "SIGTERM",
          errorMessage: "Command timed out after 10000ms",
          durationMs: 10_009,
        }),
      );
      vi.mocked(hooks.verifyRevoked).mockResolvedValueOnce({
        satisfied: true,
        detail: "rootExplicitClear=true; protectedChildrenClear=true",
      });

      await expect(
        replaceWindowsNodeMxcFolderAcls(
          { rw: ["C:\\Users\\sunt\\Documents"], ro: [] },
          { rw: [], ro: [] },
          hooks,
        ),
      ).resolves.toBeUndefined();
    });

    it("fails closed when a timed-out grant leaves a protected child incomplete", async () => {
      const hooks = createAclHooks([]);
      vi.mocked(hooks.grant).mockResolvedValueOnce(
        launcherResult({
          ok: false,
          timedOut: true,
          signal: "SIGTERM",
          errorMessage: "Command timed out after 10000ms",
          durationMs: 10_001,
        }),
      );
      vi.mocked(hooks.verifyGrant).mockResolvedValueOnce({
        satisfied: false,
        detail: "rootSufficient=true; protectedChildrenSufficient=false; protectedChildrenErrors=1",
      });

      await expect(
        replaceWindowsNodeMxcFolderAcls(
          { rw: [], ro: [] },
          { rw: ["C:\\Users\\sunt\\Documents"], ro: [] },
          hooks,
        ),
      ).rejects.toThrow(
        /timedOut=true.*protectedChildrenSufficient=false.*protectedChildrenErrors=1/,
      );
    });

    it("accepts verified absence when rollback revoke times out after removing a partial grant", async () => {
      const applyHooks = createAclHooks([]);
      vi.mocked(applyHooks.grant).mockResolvedValueOnce(
        launcherResult({
          ok: false,
          timedOut: true,
          signal: "SIGTERM",
          errorMessage: "Command timed out after 10000ms",
          durationMs: 10_003,
        }),
      );
      vi.mocked(applyHooks.verifyGrant).mockResolvedValueOnce({
        satisfied: false,
        detail: "rootSufficient=true; protectedChildrenSufficient=false",
      });
      const rollbackHooks = createAclHooks([]);
      vi.mocked(rollbackHooks.revoke).mockResolvedValueOnce(
        launcherResult({
          ok: false,
          timedOut: true,
          signal: "SIGTERM",
          errorMessage: "Command timed out after 10000ms",
          durationMs: 10_004,
        }),
      );
      vi.mocked(rollbackHooks.verifyRevoked).mockResolvedValueOnce({
        satisfied: true,
        detail: "rootExplicitClear=true; protectedChildrenClear=true",
      });

      await expect(
        commitWindowsNodeMxcFolderPolicyAtomically(
          () =>
            replaceWindowsNodeMxcFolderAcls(
              { rw: ["C:\\Desktop"], ro: [] },
              { rw: ["C:\\Desktop", "C:\\Users\\sunt\\Documents"], ro: [] },
              applyHooks,
            ),
          () => undefined,
          () =>
            replaceWindowsNodeMxcFolderAcls(
              { rw: ["C:\\Desktop", "C:\\Users\\sunt\\Documents"], ro: [] },
              { rw: ["C:\\Desktop"], ro: [] },
              rollbackHooks,
            ),
        ),
      ).rejects.toThrow(/protectedChildrenSufficient=false/);
      expect(rollbackHooks.revoke).toHaveBeenCalledWith("C:\\Users\\sunt\\Documents");
      expect(rollbackHooks.verifyRevoked).toHaveBeenCalledWith("C:\\Users\\sunt\\Documents");
    });
  });

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
