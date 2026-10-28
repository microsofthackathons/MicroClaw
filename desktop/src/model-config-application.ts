import { isDeepStrictEqual } from "node:util";
import { MODEL_APPLY_SETTLE_TIMEOUT_MS } from "./constants";
import { assertConfigWriteAllowed } from "./config-write-policy";
import { GatewayRequestError } from "./gateway-client";
import { supportsLocalModelGatewayVersion } from "./local-model-service";
import { assertModelConfigUnchanged } from "./model-setup";

type JsonObject = Record<string, unknown>;

const actions = [
  "provider-save",
  "provider-remove",
  "model-remove",
  "copilot-prepare",
  "copilot-save",
  "copilot-disconnect",
] as const;

export interface ModelConfigUpdate {
  config: unknown;
  expectedConfig: unknown;
  action: (typeof actions)[number];
  providerKey: string;
}

interface Dependencies {
  gateway(): {
    connected: boolean;
    serverVersion: string | null;
    connectionGeneration?: number;
    methods: readonly string[];
    request(method: string, params?: JsonObject, timeoutMs?: number): Promise<unknown>;
  } | null;
  readConfig(): unknown;
  assertMutable(): void;
  log(message: string): void;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

export async function applyModelConfig(deps: Dependencies, input: unknown): Promise<void> {
  const params = object(input);
  if (
    Object.keys(params).some(
      (key) => !["config", "expectedConfig", "action", "providerKey"].includes(key),
    ) ||
    !Object.hasOwn(params, "config") ||
    !Object.hasOwn(params, "expectedConfig") ||
    !actions.some((action) => action === params.action) ||
    typeof params.providerKey !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(params.providerKey)
  )
    throw new Error("Supply the model configuration, original configuration and change reason");
  deps.assertMutable();
  assertConfigWriteAllowed(params.config, params.expectedConfig);
  assertModelConfigUnchanged(params.expectedConfig, deps.readConfig());
  const gateway = deps.gateway();
  if (!gateway?.connected || !supportsLocalModelGatewayVersion(gateway.serverVersion))
    throw new Error("Applying model settings requires a connected, supported OpenClaw Gateway");
  if (!["config.get", "config.apply"].every((method) => gateway.methods.includes(method)))
    throw new Error("Gateway cannot hot-apply model settings");
  const generation = gateway.connectionGeneration;
  const assertCurrent = () => {
    deps.assertMutable();
    if (
      deps.gateway() !== gateway ||
      !gateway.connected ||
      gateway.connectionGeneration !== generation
    )
      throw new Error("Gateway connection changed; reload model settings before retrying");
  };
  const context = `[model-config] action=${params.action} provider=${params.providerKey}`;
  const snapshot = object(await gateway.request("config.get", {}));
  assertCurrent();
  assertModelConfigUnchanged(params.expectedConfig, deps.readConfig());
  if (snapshot.valid !== true || typeof snapshot.hash !== "string" || !snapshot.hash)
    throw new Error("The Gateway configuration is unavailable or invalid");
  let targetHash = snapshot.hash;
  deps.log(`${context} status=applying`);
  try {
    if (!isDeepStrictEqual(params.config, params.expectedConfig)) {
      const result = object(
        await gateway.request(
          "config.apply",
          {
            baseHash: snapshot.hash,
            raw: JSON.stringify(params.config),
            note: `${params.action}: ${params.providerKey}`,
          },
          MODEL_APPLY_SETTLE_TIMEOUT_MS,
        ),
      );
      assertCurrent();
      if (result.ok !== true || typeof result.hash !== "string" || !result.hash)
        throw new Error("The saved model configuration could not be confirmed");
      if (object(object(object(result.sentinel).payload).stats).requiresRestart === true)
        throw new Error("Gateway reported that a restart is required to apply these settings");
      targetHash = result.hash;
    }
    const deadline = Date.now() + MODEL_APPLY_SETTLE_TIMEOUT_MS;
    while (true) {
      const applied = object(
        await gateway.request("config.get", {}, Math.max(1, deadline - Date.now())),
      );
      assertCurrent();
      if (applied.valid !== true || applied.hash !== targetHash)
        throw new Error("The model configuration changed while applying; reload settings");
      if (
        typeof applied.configRevisionHash === "string" &&
        applied.configRevisionHash &&
        applied.appliedConfigHash === applied.configRevisionHash
      ) {
        deps.log(`${context} status=hot-applied`);
        return;
      }
      if (Date.now() >= deadline) throw new Error("The model configuration is still being applied");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (cause) {
    deps.log(`${context} status=unconfirmed`);
    if (
      cause instanceof GatewayRequestError &&
      (cause.code === "INVALID_REQUEST" || cause.code === "FORBIDDEN")
    )
      throw cause;
    throw new Error(
      "Model configuration application could not be confirmed. It may have been saved; reload settings before retrying. No restart or retry was attempted by MicroClaw.",
      { cause },
    );
  }
}
