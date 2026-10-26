export type WindowsNodeMxcFolderTransactionPhase =
  | "idle"
  | "locking"
  | "validating"
  | "persisting"
  | "starting-locked"
  | "smoking-locked"
  | "starting-active"
  | "smoking-active"
  | "promoting-active"
  | "verifying-active"
  | "starting-standard"
  | "active"
  | "locked"
  | "failed";

export interface WindowsNodeMxcFolderPolicy {
  rw: string[];
  ro: string[];
}

export function describeWindowsNodeMxcFolderTransactionError(error: unknown): string {
  const seen = new Set<unknown>();
  const describe = (value: unknown): string => {
    if (seen.has(value)) return "[cyclic error]";
    if (value && typeof value === "object") seen.add(value);
    if (value instanceof AggregateError) {
      const nested = value.errors.map((entry) => describe(entry)).join(" | ");
      return `${value.message}: ${nested}`;
    }
    if (value instanceof Error) {
      const cause =
        "cause" in value && value.cause !== undefined ? `; cause=${describe(value.cause)}` : "";
      return `${value.name}: ${value.message}${cause}`;
    }
    return String(value);
  };
  return describe(error);
}

export interface WindowsNodeMxcFolderTransactionHooks<TStatus> {
  setPhase(phase: WindowsNodeMxcFolderTransactionPhase): void;
  closeIngress(): Promise<void> | void;
  rejectPendingApprovals(): Promise<void> | void;
  revokeAuthorization(): Promise<void> | void;
  preflightExactBackend(): Promise<void>;
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
      failurePhase: WindowsNodeMxcFolderTransactionPhase;
    },
  ): Promise<void>;
}

export async function runWindowsNodeMxcFolderPolicyTransaction<TStatus>(
  draft: WindowsNodeMxcFolderPolicy,
  previous: WindowsNodeMxcFolderPolicy,
  hooks: WindowsNodeMxcFolderTransactionHooks<TStatus>,
): Promise<TStatus> {
  let persisted = false;
  let applied: WindowsNodeMxcFolderPolicy | null = null;
  let currentPhase: WindowsNodeMxcFolderTransactionPhase = "idle";
  const setPhase = (phase: WindowsNodeMxcFolderTransactionPhase) => {
    currentPhase = phase;
    hooks.setPhase(phase);
  };
  try {
    setPhase("locking");
    await hooks.closeIngress();
    await hooks.rejectPendingApprovals();
    await hooks.revokeAuthorization();

    setPhase("validating");
    await hooks.preflightExactBackend();
    const validated = await hooks.validatePolicy(draft);
    applied = validated;
    await hooks.stopCurrentGeneration();

    setPhase("persisting");
    await hooks.persistPolicy(validated, previous);
    persisted = true;

    setPhase("starting-locked");
    const locked = await hooks.startLockedGeneration(validated);
    await hooks.attestLockedGeneration(locked);

    setPhase("smoking-locked");
    await hooks.smokeLockedGeneration(locked);

    setPhase("starting-active");
    const active = await hooks.startActiveGeneration(validated);
    await hooks.attestActiveGeneration(active);

    setPhase("smoking-active");
    await hooks.smokeActiveGeneration(active);
    await hooks.mintActivationLease();

    setPhase("verifying-active");
    const verified = await hooks.verifyActiveGeneration();
    await hooks.releaseIngress(verified);
    setPhase("active");
    return verified;
  } catch (error) {
    const failurePhase = currentPhase;
    setPhase("locked");
    try {
      await hooks.lockAfterFailure(error, {
        previous,
        draft,
        applied,
        persisted,
        failurePhase,
      });
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
