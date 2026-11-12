export interface LiveSandboxModeHooks<T> {
  preflight(): Promise<void>;
  lock(): Promise<void>;
  persist(): Promise<void>;
  publish(): Promise<void>;
  verify(): Promise<T>;
  release(status: T): Promise<void>;
  failClosed(error: unknown): Promise<void>;
}

export async function applyLiveSandboxMode<T>(hooks: LiveSandboxModeHooks<T>): Promise<T> {
  await hooks.preflight();
  try {
    await hooks.lock();
    await hooks.persist();
    await hooks.publish();
    const status = await hooks.verify();
    await hooks.release(status);
    return status;
  } catch (error) {
    try {
      await hooks.failClosed(error);
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError], "Sandbox mode change and locking failed", {
        cause: recoveryError,
      });
    }
    throw error;
  }
}
