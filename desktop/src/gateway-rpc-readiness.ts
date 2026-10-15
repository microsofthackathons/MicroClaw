export type GatewayRpcReadinessResult = {
  attempts: number;
  elapsedMs: number;
};

export type GatewayRpcReadinessOptions = {
  probe: (timeoutMs: number) => Promise<void>;
  isCurrent: () => boolean;
  timeoutMs: number;
  attemptTimeoutMs: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  onAttemptFailure?: (error: unknown, attempt: number) => void;
};

export class GatewayRpcReadinessCancelledError extends Error {
  constructor() {
    super("Gateway RPC readiness was cancelled because the managed generation changed");
    this.name = "GatewayRpcReadinessCancelledError";
  }
}

export async function waitForGatewayRpcReadiness(
  options: GatewayRpcReadinessOptions,
): Promise<GatewayRpcReadinessResult> {
  if (options.timeoutMs <= 0 || options.attemptTimeoutMs <= 0) {
    throw new Error("Gateway RPC readiness timeouts must be positive");
  }
  if (options.initialBackoffMs <= 0 || options.maxBackoffMs < options.initialBackoffMs) {
    throw new Error("Gateway RPC readiness backoff is invalid");
  }

  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  const deadline = startedAt + options.timeoutMs;
  let attempts = 0;
  let backoffMs = options.initialBackoffMs;
  let lastError: unknown = new Error("Gateway RPC probe has not completed");

  while (now() < deadline) {
    assertCurrent(options.isCurrent);
    attempts += 1;
    const remainingMs = Math.max(1, deadline - now());
    try {
      await options.probe(Math.min(options.attemptTimeoutMs, remainingMs));
      assertCurrent(options.isCurrent);
      return { attempts, elapsedMs: now() - startedAt };
    } catch (error) {
      assertCurrent(options.isCurrent);
      lastError = error;
      options.onAttemptFailure?.(error, attempts);
    }

    const remainingMsAfterProbe = deadline - now();
    if (remainingMsAfterProbe <= 0) break;
    await sleep(Math.min(backoffMs, remainingMsAfterProbe));
    backoffMs = Math.min(backoffMs * 2, options.maxBackoffMs);
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Gateway authenticated RPC readiness timed out after ${options.timeoutMs}ms (${attempts} attempts): ${detail}`,
  );
}

export async function startAfterGatewayRpcReady(
  options: GatewayRpcReadinessOptions & {
    start: () => Promise<void>;
    onReady?: (result: GatewayRpcReadinessResult) => void;
  },
): Promise<GatewayRpcReadinessResult> {
  const result = await waitForGatewayRpcReadiness(options);
  assertCurrent(options.isCurrent);
  options.onReady?.(result);
  await options.start();
  return result;
}

function assertCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new GatewayRpcReadinessCancelledError();
}
