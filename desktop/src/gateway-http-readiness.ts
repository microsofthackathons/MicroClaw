export type GatewayHttpReadinessOptions = {
  probe: () => Promise<boolean>;
  isProcessAlive: () => boolean;
  timeoutMs: number;
  pollIntervalMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

export async function waitForGatewayHttpReadiness(
  options: GatewayHttpReadinessOptions,
): Promise<boolean> {
  if (options.timeoutMs <= 0 || options.pollIntervalMs <= 0) {
    throw new Error("Gateway HTTP readiness timings must be positive");
  }

  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + options.timeoutMs;

  while (now() < deadline) {
    if (!options.isProcessAlive()) return false;
    if (await options.probe()) return true;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(options.pollIntervalMs, remainingMs));
  }
  return false;
}
