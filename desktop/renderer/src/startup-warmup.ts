export type StartupWarmupResult = "skipped" | "deduplicated" | "completed" | "failed";

type StartupWarmupOptions = {
  showSetup: boolean;
  needsSetup: () => Promise<boolean>;
  beginWarming: () => boolean;
  warmUpAgent: () => Promise<unknown>;
  finishWarming: () => void;
  markConnected: () => void;
  onError?: (error: unknown) => void;
};

export async function runStartupWarmup(
  options: StartupWarmupOptions,
): Promise<StartupWarmupResult> {
  if (options.showSetup) {
    options.markConnected();
    return "skipped";
  }

  try {
    if (await options.needsSetup()) {
      options.markConnected();
      return "skipped";
    }
  } catch (error) {
    options.onError?.(error);
    options.markConnected();
    return "skipped";
  }

  if (!options.beginWarming()) return "deduplicated";

  try {
    await options.warmUpAgent();
    return "completed";
  } catch (error) {
    options.onError?.(error);
    return "failed";
  } finally {
    options.finishWarming();
    options.markConnected();
  }
}
