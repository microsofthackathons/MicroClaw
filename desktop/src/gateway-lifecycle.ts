export type GatewayRestartDependencies = {
  stopClient: () => void;
  stopProcess: () => void;
  isPortOccupied: () => Promise<boolean>;
  startGateway: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
};

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
