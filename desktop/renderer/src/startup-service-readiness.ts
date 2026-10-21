type StartupServiceReadinessOptions = {
  isServiceReady: () => Promise<boolean>;
  onServiceReady: (callback: () => void) => () => void;
  readinessEpoch?: () => number;
  completeStartup: () => void | Promise<void>;
  onError?: (error: unknown) => void;
};

export function watchStartupServiceReadiness(options: StartupServiceReadinessOptions): () => void {
  let completionEpoch: number | undefined;
  const complete = () => {
    const epoch = options.readinessEpoch?.() ?? 0;
    if (completionEpoch === epoch) return;
    completionEpoch = epoch;
    void Promise.resolve(options.completeStartup()).catch((error) => options.onError?.(error));
  };

  const unsubscribe = options.onServiceReady(complete);
  const initialEpoch = options.readinessEpoch?.() ?? 0;
  void options
    .isServiceReady()
    .then((ready) => {
      if (ready && initialEpoch === (options.readinessEpoch?.() ?? 0)) complete();
    })
    .catch((error) => options.onError?.(error));
  return unsubscribe;
}
