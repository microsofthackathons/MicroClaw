export type GatewayRestartDependencies = {
  stopClient: () => void;
  stopProcess: () => void;
  isPortOccupied: () => Promise<boolean>;
  startGateway: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
};

export type AgentRosterReloadDependencies = {
  listAgentIds: () => Promise<ReadonlySet<string>>;
  isApplied: (agentIds: ReadonlySet<string>) => boolean;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
};

export type AgentRosterApplyResult = "hot-reloaded" | "restarted" | "timed-out";

export function requiresExternalGatewayStop(
  alreadyRunning: boolean,
  rosterChanged: boolean,
  spawnedByUs: boolean,
  hasManagedProcess: boolean,
): boolean {
  return alreadyRunning && rosterChanged && !(spawnedByUs && hasManagedProcess);
}

export function isGatewayServiceReady(
  clientConnected: boolean,
  postSpawnRestartDone: boolean,
): boolean {
  return clientConnected && postSpawnRestartDone;
}

export async function waitForAgentRosterReload(
  dependencies: AgentRosterReloadDependencies,
): Promise<boolean> {
  if (dependencies.pollMs <= 0) {
    throw new Error("agent roster reload poll interval must be positive");
  }

  const attempts = Math.max(1, Math.ceil(dependencies.timeoutMs / dependencies.pollMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (dependencies.isApplied(await dependencies.listAgentIds())) return true;
    } catch {
      // A watcher-driven config swap can briefly interrupt the RPC. Retry until timeout.
    }
    if (attempt + 1 < attempts) await dependencies.sleep(dependencies.pollMs);
  }
  return false;
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
  dependencies.stopProcess();
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
