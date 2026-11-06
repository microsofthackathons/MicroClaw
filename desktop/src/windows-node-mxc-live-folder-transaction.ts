import type { WindowsNodeMxcFolderPolicy } from "./windows-node-mxc-folder-transaction";

export interface LiveFolderPolicyHooks<T> {
  validate(draft: WindowsNodeMxcFolderPolicy): Promise<WindowsNodeMxcFolderPolicy>;
  confirm?(): Promise<void>;
  lock(): Promise<void>;
  persist(policy: WindowsNodeMxcFolderPolicy): Promise<void>;
  publish(policy: WindowsNodeMxcFolderPolicy): Promise<void>;
  verify(): Promise<T>;
  release(status: T): Promise<void>;
  failClosed(error: unknown): Promise<void>;
  timing?(stage: string, elapsedMs: number): void;
}

export async function applyLiveFolderPolicy<T>(
  draft: WindowsNodeMxcFolderPolicy,
  hooks: LiveFolderPolicyHooks<T>,
): Promise<T> {
  const timed = async <V>(stage: string, operation: () => Promise<V>): Promise<V> => {
    const start = Date.now();
    try {
      return await operation();
    } finally {
      hooks.timing?.(stage, Date.now() - start);
    }
  };
  const policy = await timed("validate", () => hooks.validate(draft));
  if (hooks.confirm) await timed("confirm", hooks.confirm);
  try {
    await timed("lock", hooks.lock);
    await timed("persist", () => hooks.persist(policy));
    await timed("publish-and-acknowledge", () => hooks.publish(policy));
    const status = await timed("verify", hooks.verify);
    await timed("release", () => hooks.release(status));
    return status;
  } catch (error) {
    try {
      await hooks.failClosed(error);
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        "Live folder policy update and locking failed",
        { cause: recoveryError },
      );
    }
    throw error;
  }
}
