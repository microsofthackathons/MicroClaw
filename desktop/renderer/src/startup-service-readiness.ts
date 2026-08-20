type StartupServiceReadinessOptions = {
  isServiceReady: () => Promise<boolean>;
  onServiceReady: (callback: () => void) => () => void;
  completeStartup: () => void | Promise<void>;
  onError?: (error: unknown) => void;
};

export function watchStartupServiceReadiness(
  options: StartupServiceReadinessOptions,
): () => void {
  let completionStarted = false;
  const complete = () => {
    if (completionStarted) return;
    completionStarted = true;
    void Promise.resolve(options.completeStartup()).catch((error) => options.onError?.(error));
  };

  const unsubscribe = options.onServiceReady(complete);
  void options
    .isServiceReady()
    .then((ready) => {
      if (ready) complete();
    })
    .catch((error) => options.onError?.(error));
  return unsubscribe;
}
