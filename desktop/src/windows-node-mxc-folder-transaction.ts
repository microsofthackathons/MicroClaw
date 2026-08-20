export type WindowsNodeMxcFolderTransactionPhase =
  | "idle"
  | "locking"
  | "validating"
  | "persisting"
  | "starting-locked"
  | "smoking-locked"
  | "starting-active"
  | "smoking-active"
  | "verifying-active"
  | "starting-standard"
  | "active"
  | "locked"
  | "failed";

export interface WindowsNodeMxcFolderPolicy {
  rw: string[];
  ro: string[];
}

export interface WindowsNodeMxcFolderTransactionHooks<TStatus> {
  setPhase(phase: WindowsNodeMxcFolderTransactionPhase): void;
  closeIngress(): Promise<void> | void;
  rejectPendingApprovals(): Promise<void> | void;
  revokeAuthorization(): Promise<void> | void;
  validatePolicy(
    draft: WindowsNodeMxcFolderPolicy,
  ): Promise<WindowsNodeMxcFolderPolicy> | WindowsNodeMxcFolderPolicy;
  stopCurrentGeneration(): Promise<void>;
  persistPolicy(
    next: WindowsNodeMxcFolderPolicy,
    previous: WindowsNodeMxcFolderPolicy,
  ): Promise<void>;
  startLockedGeneration(next: WindowsNodeMxcFolderPolicy): Promise<TStatus>;
  attestLockedGeneration(status: TStatus): Promise<void> | void;
  smokeLockedGeneration(status: TStatus): Promise<void>;
  startActiveGeneration(next: WindowsNodeMxcFolderPolicy): Promise<TStatus>;
  attestActiveGeneration(status: TStatus): Promise<void> | void;
  smokeActiveGeneration(status: TStatus): Promise<void>;
  mintActivationLease(): Promise<void>;
  verifyActiveGeneration(): Promise<TStatus>;
  releaseIngress(status: TStatus): Promise<void> | void;
  lockAfterFailure(
    error: unknown,
    context: {
      previous: WindowsNodeMxcFolderPolicy;
      draft: WindowsNodeMxcFolderPolicy;
      applied: WindowsNodeMxcFolderPolicy | null;
      persisted: boolean;
    },
  ): Promise<void>;
}

export async function commitWindowsNodeMxcFolderPolicyAtomically(
  apply: () => Promise<void>,
  persist: () => Promise<void> | void,
  rollback: () => Promise<void>,
): Promise<void> {
  try {
    await apply();
    await persist();
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "MXC folder policy mutation failed and its ACL rollback also failed",
        { cause: rollbackError },
      );
    }
    throw error;
  }
}

export async function runWindowsNodeMxcFolderPolicyTransaction<TStatus>(
  draft: WindowsNodeMxcFolderPolicy,
  previous: WindowsNodeMxcFolderPolicy,
  hooks: WindowsNodeMxcFolderTransactionHooks<TStatus>,
): Promise<TStatus> {
  let persisted = false;
  let applied: WindowsNodeMxcFolderPolicy | null = null;
  try {
    hooks.setPhase("locking");
    await hooks.closeIngress();
    await hooks.rejectPendingApprovals();
    await hooks.revokeAuthorization();

    hooks.setPhase("validating");
    const validated = await hooks.validatePolicy(draft);
    applied = validated;
    await hooks.stopCurrentGeneration();

    hooks.setPhase("persisting");
    await hooks.persistPolicy(validated, previous);
    persisted = true;

    hooks.setPhase("starting-locked");
    const locked = await hooks.startLockedGeneration(validated);
    await hooks.attestLockedGeneration(locked);

    hooks.setPhase("smoking-locked");
    await hooks.smokeLockedGeneration(locked);

    hooks.setPhase("starting-active");
    const active = await hooks.startActiveGeneration(validated);
    await hooks.attestActiveGeneration(active);

    hooks.setPhase("smoking-active");
    await hooks.smokeActiveGeneration(active);
    await hooks.mintActivationLease();

    hooks.setPhase("verifying-active");
    const verified = await hooks.verifyActiveGeneration();
    await hooks.releaseIngress(verified);
    hooks.setPhase("active");
    return verified;
  } catch (error) {
    hooks.setPhase("locked");
    try {
      await hooks.lockAfterFailure(error, { previous, draft, applied, persisted });
    } catch (lockError) {
      throw new AggregateError(
        [error, lockError],
        "MXC folder policy transaction failed and the locked recovery step also failed",
        { cause: lockError },
      );
    }
    throw error;
  }
}
