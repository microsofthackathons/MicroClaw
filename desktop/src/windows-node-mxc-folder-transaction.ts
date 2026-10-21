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

export interface WindowsNodeMxcAclLauncherResult {
  ok: boolean;
  timedOut: boolean;
  exitCode: number | string | null;
  signal: string | null;
  stderr: string;
  errorMessage: string | null;
  durationMs: number;
}

export interface WindowsNodeMxcAclVerification {
  satisfied: boolean;
  detail: string;
}

export interface WindowsNodeMxcFolderAclHooks {
  normalizePath(path: string): string;
  grant(path: string, access: "r" | "rw"): Promise<WindowsNodeMxcAclLauncherResult>;
  revoke(path: string): Promise<WindowsNodeMxcAclLauncherResult>;
  verifyGrant(path: string, access: "r" | "rw"): Promise<WindowsNodeMxcAclVerification>;
  verifyRevoked(path: string): Promise<WindowsNodeMxcAclVerification>;
}

function describeLauncherResult(result: WindowsNodeMxcAclLauncherResult): string {
  const fields = [
    `ok=${result.ok}`,
    `timedOut=${result.timedOut}`,
    `exitCode=${result.exitCode ?? "none"}`,
    `signal=${result.signal ?? "none"}`,
    `durationMs=${result.durationMs}`,
  ];
  if (result.errorMessage) fields.push(`error=${result.errorMessage}`);
  if (result.stderr) fields.push(`stderr=${result.stderr}`);
  return fields.join("; ");
}

export class WindowsNodeMxcFolderAclMutationError extends Error {
  constructor(
    readonly operation: "grant" | "revoke",
    readonly path: string,
    readonly launcher: WindowsNodeMxcAclLauncherResult,
    readonly verification: WindowsNodeMxcAclVerification,
  ) {
    super(
      `MXC ACL ${operation} failed for ${path}: launcher(${describeLauncherResult(
        launcher,
      )}); verification(${verification.detail})`,
    );
    this.name = "WindowsNodeMxcFolderAclMutationError";
  }
}

function policyAccessMap(
  policy: WindowsNodeMxcFolderPolicy,
  normalizePath: (path: string) => string,
): Map<string, { path: string; access: "ro" | "rw" }> {
  const entries = new Map<string, { path: string; access: "ro" | "rw" }>();
  for (const path of policy.ro) entries.set(normalizePath(path), { path, access: "ro" });
  for (const path of policy.rw) entries.set(normalizePath(path), { path, access: "rw" });
  return entries;
}

async function reconcileAclMutation(
  operation: "grant" | "revoke",
  path: string,
  access: "r" | "rw" | null,
  hooks: WindowsNodeMxcFolderAclHooks,
): Promise<void> {
  let launcher: WindowsNodeMxcAclLauncherResult;
  let verification: WindowsNodeMxcAclVerification;
  if (operation === "grant") {
    if (!access) throw new Error(`Missing access level for MXC ACL grant: ${path}`);
    launcher = await hooks.grant(path, access);
    verification = await hooks.verifyGrant(path, access);
  } else {
    launcher = await hooks.revoke(path);
    verification = await hooks.verifyRevoked(path);
  }
  if (!verification.satisfied) {
    throw new WindowsNodeMxcFolderAclMutationError(operation, path, launcher, verification);
  }
}

export async function replaceWindowsNodeMxcFolderAcls(
  previous: WindowsNodeMxcFolderPolicy,
  next: WindowsNodeMxcFolderPolicy,
  hooks: WindowsNodeMxcFolderAclHooks,
): Promise<void> {
  const previousAccess = policyAccessMap(previous, hooks.normalizePath);
  const nextAccess = policyAccessMap(next, hooks.normalizePath);

  const revocations = [...previousAccess.entries()]
    .filter(([key, entry]) => nextAccess.get(key)?.access !== entry.access)
    .map(([, entry]) => entry.path)
    .sort((left, right) => right.length - left.length);
  for (const path of revocations) {
    await reconcileAclMutation("revoke", path, null, hooks);
  }

  const grants = [...nextAccess.entries()]
    .filter(([key, entry]) => previousAccess.get(key)?.access !== entry.access)
    .map(([, entry]) => entry)
    .sort((left, right) => left.path.length - right.path.length);
  for (const entry of grants) {
    await reconcileAclMutation("grant", entry.path, entry.access === "rw" ? "rw" : "r", hooks);
  }
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
