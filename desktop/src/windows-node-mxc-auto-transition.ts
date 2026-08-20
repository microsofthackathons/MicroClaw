import type { WindowsNodeMxcFolderTransactionPhase } from "./windows-node-mxc-folder-transaction";

export interface WindowsNodeMxcAutomaticTransitionHooks<TStatus> {
  setPhase(phase: WindowsNodeMxcFolderTransactionPhase, detail?: string | null): void;
  closeIngress(): Promise<void> | void;
  startLockedGeneration(): Promise<TStatus>;
  smokeLockedGeneration(status: TStatus): Promise<void>;
  startActiveGeneration(): Promise<TStatus>;
  smokeActiveGeneration(status: TStatus): Promise<void>;
  mintActivationLease(): Promise<void>;
  verifyActiveGeneration(): Promise<TStatus>;
  releaseIngress(status: TStatus): Promise<void> | void;
  lockAfterFailure(error: unknown): Promise<void>;
}

export async function runWindowsNodeMxcAutomaticTransition<TStatus>(
  hooks: WindowsNodeMxcAutomaticTransitionHooks<TStatus>,
): Promise<TStatus> {
  try {
    await hooks.closeIngress();

    hooks.setPhase("starting-locked");
    const locked = await hooks.startLockedGeneration();

    hooks.setPhase("smoking-locked");
    await hooks.smokeLockedGeneration(locked);

    hooks.setPhase("starting-active");
    const active = await hooks.startActiveGeneration();

    hooks.setPhase("smoking-active");
    await hooks.smokeActiveGeneration(active);
    await hooks.mintActivationLease();

    hooks.setPhase("verifying-active");
    const verified = await hooks.verifyActiveGeneration();
    await hooks.releaseIngress(verified);
    hooks.setPhase("active");
    return verified;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    hooks.setPhase("locked", detail);
    await hooks.lockAfterFailure(error);
    throw error;
  }
}
