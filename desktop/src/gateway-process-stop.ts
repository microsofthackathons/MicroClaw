import type { ChildProcess } from "node:child_process";

export type GatewayProcessStopMode = "already-exited" | "graceful" | "forced";

export async function stopGatewayChildProcess(options: {
  child: ChildProcess;
  timeoutMs: number;
  forceTimeoutMs: number;
  forceStop: () => void | Promise<void>;
  onForceStop: (reason: "timeout" | "request-failed", error?: unknown) => void;
}): Promise<GatewayProcessStopMode> {
  const { child } = options;
  if (options.timeoutMs <= 0 || options.forceTimeoutMs <= 0) {
    throw new Error("Gateway shutdown timeouts must be positive");
  }
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  if (hasExited()) return "already-exited";

  let exited = false;
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const onExit = () => {
    exited = true;
    resolveExit();
  };
  child.once("exit", onExit);
  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    if (exited || hasExited()) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exit.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  try {
    let requestFailed = false;
    let requestError: unknown;
    try {
      if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
        throw new Error("Gateway stdin lifeline is unavailable");
      }
      child.stdin.end();
    } catch (error) {
      requestFailed = true;
      requestError = error;
    }
    if (exited || hasExited()) return "graceful";
    if (!requestFailed && (await waitForExit(options.timeoutMs))) return "graceful";

    options.onForceStop(requestFailed ? "request-failed" : "timeout", requestError);
    try {
      await options.forceStop();
    } catch (error) {
      if (!exited && !hasExited()) throw error;
    }
    if (!(await waitForExit(options.forceTimeoutMs))) {
      throw new Error(`Could not confirm Gateway process ${child.pid ?? "unknown"} exited`);
    }
    return "forced";
  } finally {
    child.removeListener("exit", onExit);
  }
}
