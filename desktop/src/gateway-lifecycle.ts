import { performance } from "node:perf_hooks";

export type GatewayRestartDependencies = {
  stopClient: () => void;
  stopProcess: () => void | Promise<void>;
  isPortOccupied: () => Promise<boolean>;
  startGateway: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
};

export type AgentRosterReloadDependencies = {
  listAgentIds: (timeoutMs: number) => Promise<ReadonlySet<string>>;
  isApplied: (agentIds: ReadonlySet<string>) => boolean;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
  now?: () => number;
};

export type AgentRosterApplyResult = "hot-reloaded" | "restarted" | "timed-out";

export function getGatewayStartupFailure(
  port: number,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  spawnError?: Error,
): { status: "failed" | "timeout"; message: string } {
  if (spawnError)
    return { status: "failed", message: `Gateway spawn failed: ${spawnError.message}` };
  if (exitCode !== null) {
    return {
      status: "failed",
      message:
        exitCode === 78
          ? "Gateway rejected its configuration (exit 78); see the Gateway log"
          : `Gateway exited during startup (code ${exitCode}); see the Gateway log`,
    };
  }
  if (signal !== null) {
    return { status: "failed", message: `Gateway exited during startup (signal ${signal})` };
  }
  return { status: "timeout", message: `Gateway health check timed out on port ${port}` };
}

export function getGatewayProcessStdio(
  platform: NodeJS.Platform = process.platform,
): ["overlapped" | "pipe", "pipe", "pipe", "ipc"] {
  return [platform === "win32" ? "overlapped" : "pipe", "pipe", "pipe", "ipc"];
}

export function shouldRetryGatewayStartup(
  exitCode: number | null,
  stderr: string,
  retriesRemaining: number,
): boolean {
  return (
    retriesRemaining > 0 &&
    exitCode === 1 &&
    stderr.includes("OpenClaw plugin migration inputs changed during startup convergence;") &&
    stderr.includes(
      "Restart OpenClaw so state migrations run against the final config and plugin inventory.",
    )
  );
}

export function requiresExternalGatewayStop(
  alreadyRunning: boolean,
  rosterChanged: boolean,
  spawnedByUs: boolean,
  hasManagedProcess: boolean,
): boolean {
  return alreadyRunning && rosterChanged && !(spawnedByUs && hasManagedProcess);
}

export function isGatewayServiceReady(clientConnected: boolean, lifecycleReady: boolean): boolean {
  return clientConnected && lifecycleReady;
}

export function isApplicationServiceReadyState(
  clientConnected: boolean,
  lifecycleReady: boolean,
  securityTransitionInProgress: boolean,
  protectedIngressReady: boolean,
): boolean {
  return (
    isGatewayServiceReady(clientConnected, lifecycleReady) &&
    !securityTransitionInProgress &&
    protectedIngressReady
  );
}

export async function waitForAgentRosterReload(
  dependencies: AgentRosterReloadDependencies,
): Promise<boolean> {
  if (!Number.isFinite(dependencies.pollMs) || dependencies.pollMs <= 0) {
    throw new Error("agent roster reload poll interval must be positive");
  }
  if (!Number.isFinite(dependencies.timeoutMs) || dependencies.timeoutMs < 0) {
    throw new Error("agent roster reload timeout must be finite and non-negative");
  }

  const now = dependencies.now ?? (() => performance.now());
  const deadline = now() + dependencies.timeoutMs;
  while (true) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return false;
    let readTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<null>((resolve) => {
        readTimeout = setTimeout(() => resolve(null), remainingMs);
      });
      const agentIds = await Promise.race([dependencies.listAgentIds(remainingMs), timeout]);
      if (agentIds === null || now() >= deadline) return false;
      if (dependencies.isApplied(agentIds)) return true;
    } catch {
      // A watcher-driven config swap can briefly interrupt the RPC. Retry until timeout.
    } finally {
      if (readTimeout !== undefined) clearTimeout(readTimeout);
    }
    const remainingMsAfterRead = deadline - now();
    if (remainingMsAfterRead <= 0) return false;
    await dependencies.sleep(Math.min(dependencies.pollMs, remainingMsAfterRead));
  }
}

export async function applyAgentRosterReload(
  dependencies: AgentRosterReloadDependencies & { restartGateway?: () => Promise<void> },
): Promise<AgentRosterApplyResult> {
  if (await waitForAgentRosterReload(dependencies)) return "hot-reloaded";
  if (!dependencies.restartGateway) return "timed-out";
  await dependencies.restartGateway();
  return "restarted";
}

export async function hardRestartGateway(dependencies: GatewayRestartDependencies): Promise<void> {
  if (dependencies.pollMs <= 0) {
    throw new Error("gateway restart poll interval must be positive");
  }
  dependencies.stopClient();
  await dependencies.stopProcess();
  const attempts = Math.max(1, Math.ceil(dependencies.timeoutMs / dependencies.pollMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!(await dependencies.isPortOccupied())) {
      await dependencies.startGateway();
      return;
    }
    if (attempt + 1 < attempts) {
      await dependencies.sleep(dependencies.pollMs);
    }
  }
  throw new Error("gateway port remained occupied after process stop");
}
