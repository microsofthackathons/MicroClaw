import {
  assertConfigWriteAllowed,
  assertInitialModelSetupChange,
  assertWindowsNodeMxcSearchOnlyChange,
} from "./config-write-policy";
import { parseModelConfigUpdate, type ModelConfigUpdate } from "./model-config-application";
import { assertModelConfigUnchanged } from "./model-setup";
import {
  applyWindowsNodeCommandPolicy,
  validateWindowsNodeMxcGatewayPolicy,
} from "./windows-node-mxc";
import { assertWindowsNodeMxcModelOnlyChange } from "./windows-node-mxc-model-config";

interface ConfigWriteDependencies {
  readConfig(): unknown;
  configFileExists(): boolean;
  isMxcEnabled(): boolean;
  assertMutable(setup: boolean): void;
  requireActiveContainment(): Promise<void>;
  isGatewayConnected(): boolean;
  isGatewayRunning(): boolean;
  assertGatewayPortAvailable(port: number): Promise<void>;
  defaultGatewayPort: number;
  nodeId(): string;
  persist(config: Record<string, unknown>): void;
  applyModel(params: ModelConfigUpdate): Promise<void>;
  applySearch(config: unknown, expectedConfig: unknown, assertCurrent: () => void): Promise<void>;
  startServices(): Promise<void>;
}

function readCurrent(deps: ConfigWriteDependencies): unknown {
  const config = deps.readConfig();
  if (config === null && deps.configFileExists()) {
    throw new Error("The existing Gateway configuration is unreadable");
  }
  return config;
}

function writeIntent(
  value: unknown,
): { kind: "initial-setup"; providerKey: string } | { kind: "search-settings" } | null {
  if (value === undefined) return null;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    "kind" in value &&
    value.kind === "search-settings"
  )
    return { kind: "search-settings" };
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "kind" && key !== "providerKey") ||
    !("kind" in value) ||
    value.kind !== "initial-setup" ||
    !("providerKey" in value) ||
    typeof value.providerKey !== "string"
  ) {
    throw new Error("Invalid configuration write intent");
  }
  return { kind: "initial-setup", providerKey: value.providerKey };
}

function gatewayPort(config: Record<string, unknown>, fallback: number): number {
  const gateway = config.gateway;
  if (!gateway || typeof gateway !== "object" || Array.isArray(gateway)) {
    throw new Error("Gateway configuration is required for initial setup");
  }
  const port = "port" in gateway ? gateway.port : fallback;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Gateway port is invalid");
  }
  return port;
}

export async function writeGuardedConfig(
  deps: ConfigWriteDependencies,
  config: unknown,
  expectedConfig?: unknown,
  intent?: unknown,
): Promise<void> {
  const parsedIntent = writeIntent(intent);
  const setup = parsedIntent?.kind === "initial-setup" ? parsedIntent : null;
  const search = parsedIntent?.kind === "search-settings";
  const mxcEnabled = deps.isMxcEnabled();
  deps.assertMutable(Boolean(setup));
  const current = readCurrent(deps);
  assertConfigWriteAllowed(config, current);
  if ((mxcEnabled || setup || search) && expectedConfig === undefined) {
    throw new Error("Reload the Gateway configuration before saving");
  }
  if (expectedConfig !== undefined) assertModelConfigUnchanged(expectedConfig, current);

  const assertLifecycle = () => {
    deps.assertMutable(Boolean(setup));
    if (deps.isMxcEnabled() !== mxcEnabled) {
      throw new Error("Containment mode changed while saving; reload settings and retry");
    }
  };
  const assertCurrent = () => {
    assertLifecycle();
    if (expectedConfig !== undefined) assertModelConfigUnchanged(expectedConfig, readCurrent(deps));
  };

  if (setup) {
    const params = parseModelConfigUpdate({
      config,
      expectedConfig,
      action: "provider-save",
      providerKey: setup.providerKey,
    });
    assertInitialModelSetupChange(current, config, params.providerKey);
    if (deps.isGatewayConnected()) {
      assertWindowsNodeMxcModelOnlyChange(current ?? {}, config);
      await deps.applyModel(params);
      return;
    }
    if (deps.isGatewayRunning()) {
      throw new Error("Wait for the managed Gateway to finish starting before completing setup");
    }
    await deps.assertGatewayPortAvailable(gatewayPort(config, deps.defaultGatewayPort));
    assertCurrent();
    if (deps.isGatewayConnected() || deps.isGatewayRunning()) {
      throw new Error("Gateway started while completing setup; reload and retry");
    }
    deps.persist(applyWindowsNodeCommandPolicy(config, deps.nodeId()));
    try {
      await deps.startServices();
    } catch (cause) {
      throw new Error(
        "Initial settings were saved, but the Gateway could not be started. Retry Gateway startup.",
        { cause },
      );
    }
    return;
  }

  if (mxcEnabled || search) {
    assertWindowsNodeMxcSearchOnlyChange(current, config);
    if (mxcEnabled) await deps.requireActiveContainment();
    assertCurrent();
    const policy = validateWindowsNodeMxcGatewayPolicy(config, deps.nodeId(), "active");
    if (!policy.ready) {
      throw new Error(`Gateway command routing is not ready: ${policy.blockers.join("; ")}`);
    }
    await deps.applySearch(config, expectedConfig, assertLifecycle);
    return;
  }

  assertCurrent();
  deps.persist(applyWindowsNodeCommandPolicy(config, deps.nodeId()));
}
