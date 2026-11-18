import { isDeepStrictEqual } from "node:util";
import { MODEL_APPLY_SETTLE_TIMEOUT_MS } from "./constants";
import { assertConfigWriteAllowed } from "./config-write-policy";
import { GatewayRequestError } from "./gateway-client";
import { supportsLocalModelGatewayVersion } from "./local-model-service";
import { assertModelConfigUnchanged, ModelConfigRestartRequiredError } from "./model-setup";
import { removeProviderConnectionConfig } from "./provider-connection-config";

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

/** Connection edits preserve models; removal may also clear only the removed provider's refs. */
function isManagedProviderConnectionUpdate(params: ModelConfigUpdate): boolean {
  if (
    !["provider-save", "provider-remove"].includes(params.action) ||
    !["qwen", "minimax"].includes(params.providerKey)
  )
    return false;
  const providerMap = (config: unknown) => object(object(object(config).models).providers);
  const previousProviders = providerMap(params.expectedConfig);
  const nextProviders = providerMap(params.config);
  if (params.action === "provider-remove") {
    if (
      !Object.hasOwn(previousProviders, params.providerKey) ||
      Object.hasOwn(nextProviders, params.providerKey)
    )
      return false;
    // Use the same removal as the UI so clearing the active default/fallbacks
    // does not force config.apply's slower restart-receipt processing.
    return isDeepStrictEqual(
      removeProviderConnectionConfig(object(params.expectedConfig), params.providerKey),
      params.config,
    );
  } else {
    const next = object(nextProviders[params.providerKey]);
    if (
      typeof next.apiKey !== "string" ||
      typeof next.baseUrl !== "string" ||
      typeof next.api !== "string"
    )
      return false;
    const withoutConnection = (value: unknown) => {
      const result: JsonObject = { ...object(value), models: object(value).models ?? [] };
      for (const field of ["apiKey", "baseUrl", "api"]) delete result[field];
      return result;
    };
    if (
      !isDeepStrictEqual(
        withoutConnection(previousProviders[params.providerKey]),
        withoutConnection(next),
      )
    )
      return false;
  }
  const withoutProvider = (value: unknown) => {
    const config = structuredClone(object(value));
    const models = object(config.models);
    const providers = object(models.providers);
    delete providers[params.providerKey];
    config.models = { ...models, mode: models.mode ?? "merge", providers };
    return config;
  };
  return isDeepStrictEqual(withoutProvider(params.expectedConfig), withoutProvider(params.config));
}

export function parseModelConfigUpdate(input: unknown): ModelConfigUpdate {
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
  return {
    config: params.config,
    expectedConfig: params.expectedConfig,
    action: params.action as ModelConfigUpdate["action"],
    providerKey: params.providerKey,
  };
}

export async function applyModelConfig(deps: Dependencies, input: unknown): Promise<void> {
  const params = parseModelConfigUpdate(input);
  return applyGatewayConfiguration(deps, {
    config: params.config,
    expectedConfig: params.expectedConfig,
    context: `[model-config] action=${params.action} provider=${params.providerKey}`,
    note: `${params.action}: ${params.providerKey}`,
    label: "model",
    connectionProvider: isManagedProviderConnectionUpdate(params) ? params.providerKey : undefined,
  });
}

export async function applyGatewayConfiguration(
  deps: Dependencies,
  params: {
    config: unknown;
    expectedConfig: unknown;
    context: string;
    note: string;
    label: "model" | "plugin";
    connectionProvider?: string;
  },
): Promise<void> {
  deps.assertMutable();
  assertConfigWriteAllowed(params.config, params.expectedConfig);
  assertModelConfigUnchanged(params.expectedConfig, deps.readConfig());
  const gateway = deps.gateway();
  if (!gateway?.connected || !supportsLocalModelGatewayVersion(gateway.serverVersion))
    throw new Error(
      `Applying ${params.label} settings requires a connected, supported OpenClaw Gateway`,
    );
  if (!["config.get", "config.apply"].every((method) => gateway.methods.includes(method)))
    throw new Error(`Gateway cannot hot-apply ${params.label} settings`);
  const generation = gateway.connectionGeneration;
  const assertCurrent = () => {
    deps.assertMutable();
    if (
      deps.gateway() !== gateway ||
      !gateway.connected ||
      gateway.connectionGeneration !== generation
    )
      throw new Error(
        `Gateway connection changed; reload ${params.label} settings before retrying`,
      );
  };
  const context = params.context;
  const snapshot = object(await gateway.request("config.get", {}));
  assertCurrent();
  assertModelConfigUnchanged(params.expectedConfig, deps.readConfig());
  if (snapshot.valid !== true || typeof snapshot.hash !== "string" || !snapshot.hash)
    throw new Error("The Gateway configuration is unavailable or invalid");
  const reloadMode = object(object(object(params.expectedConfig).gateway).reload).mode;
  // Verified against the pinned 2026.10.10 handler. Older runtimes retain config.apply.
  // config.set still validates and revision-guards the write; the loop below confirms
  // the exact runtime revision before the surrounding MXC transaction can resume.
  const useConnectionSet = Boolean(
    params.connectionProvider &&
    gateway.serverVersion?.split("+", 1)[0] === "2026.10.10" &&
    gateway.methods.includes("config.set") &&
    (reloadMode === undefined || reloadMode === "hot" || reloadMode === "hybrid"),
  );
  const writeMethod = useConnectionSet ? "config.set" : "config.apply";
  let targetHash = snapshot.hash;
  const assertRequestedPluginsSaved = () => {
    if (
      !isDeepStrictEqual(object(params.config).plugins, object(params.expectedConfig).plugins) &&
      !isDeepStrictEqual(object(deps.readConfig()).plugins, object(params.config).plugins)
    )
      throw new Error("The saved plugin settings do not match the requested settings");
  };
  deps.log(`${context} status=applying method=${writeMethod}`);
  try {
    if (!isDeepStrictEqual(params.config, params.expectedConfig)) {
      const result = object(
        await gateway.request(
          writeMethod,
          {
            baseHash: snapshot.hash,
            raw: JSON.stringify(params.config),
            ...(useConnectionSet ? {} : { note: params.note }),
          },
          MODEL_APPLY_SETTLE_TIMEOUT_MS,
        ),
      );
      assertCurrent();
      if (result.ok !== true || typeof result.hash !== "string" || !result.hash)
        throw new Error(`The saved ${params.label} configuration could not be confirmed`);
      if (object(object(object(result.sentinel).payload).stats).requiresRestart === true) {
        assertRequestedPluginsSaved();
        throw new ModelConfigRestartRequiredError(result.hash);
      }
      targetHash = result.hash;
    }
    const deadline = Date.now() + MODEL_APPLY_SETTLE_TIMEOUT_MS;
    while (true) {
      const applied = object(
        await gateway.request("config.get", {}, Math.max(1, deadline - Date.now())),
      );
      assertCurrent();
      if (applied.valid !== true || applied.hash !== targetHash)
        throw new Error(
          `The ${params.label} configuration changed while applying; reload settings`,
        );
      if (
        typeof applied.configRevisionHash === "string" &&
        applied.configRevisionHash &&
        applied.appliedConfigHash === applied.configRevisionHash
      ) {
        assertRequestedPluginsSaved();
        if (useConnectionSet) {
          const providers = (config: unknown) => object(object(object(config).models).providers);
          const savedConfig = deps.readConfig();
          const savedProviders = providers(savedConfig);
          const expectedProviders = providers(params.config);
          const providerKey = params.connectionProvider!;
          const saved = object(savedProviders[providerKey]);
          const expected = object(expectedProviders[providerKey]);
          if (
            Object.hasOwn(savedProviders, providerKey) !==
              Object.hasOwn(expectedProviders, providerKey) ||
            !["apiKey", "baseUrl", "api"].every((field) =>
              isDeepStrictEqual(saved[field], expected[field]),
            )
          )
            throw new Error("The saved provider connection does not match the requested settings");
          if (
            !Object.hasOwn(expectedProviders, providerKey) &&
            !isDeepStrictEqual(object(savedConfig).agents, object(params.config).agents)
          )
            throw new Error("The saved model references do not match the requested removal");
        }
        deps.log(`${context} status=hot-applied`);
        return;
      }
      if (Date.now() >= deadline)
        throw new Error(`The ${params.label} configuration is still being applied`);
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
      `${params.label === "model" ? "Model" : "Plugin"} configuration application could not be confirmed. It may have been saved; reload settings before retrying. No restart or retry was attempted by MicroClaw.`,
      { cause },
    );
  }
}
