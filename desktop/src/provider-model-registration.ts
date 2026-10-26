import { GatewayRequestError } from "./gateway-client";
import { MODEL_APPLY_SETTLE_TIMEOUT_MS } from "./constants";
import { supportsLocalModelGatewayVersion } from "./local-model-service";
import { assertModelConfigUnchanged } from "./model-setup";
import type { ProviderCatalogInput, ProviderCatalogResult } from "./provider-model-catalog";
import { assertChatModelSupported } from "./provider-model-capabilities";

type JsonObject = Record<string, unknown>;

export interface ProviderCatalogSelection {
  modelRef: string;
  expectedConfig: unknown;
}

export function parseProviderCatalogSelection(input: unknown): ProviderCatalogSelection {
  const params = object(input);
  if (
    Object.keys(params).some((key) => key !== "modelRef" && key !== "expectedConfig") ||
    !Object.hasOwn(params, "expectedConfig") ||
    typeof params.modelRef !== "string" ||
    params.modelRef.length > 1024 ||
    !/^(qwen|minimax)\/[^\s\\*]+$/.test(params.modelRef)
  )
    throw new Error("Choose an exact managed provider model and supply the original configuration");
  return { modelRef: params.modelRef, expectedConfig: params.expectedConfig };
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
  discover(input: ProviderCatalogInput): Promise<ProviderCatalogResult>;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function provider(config: unknown, id: string): JsonObject {
  return object(object(object(object(config).models).providers)[id]);
}

function contains(config: unknown, providerId: string, modelId: string): boolean {
  const models = provider(config, providerId).models;
  return Array.isArray(models) && models.some((model) => object(model).id === modelId);
}

/** Register live catalog definitions without changing defaults, agent policies or sessions. */
export async function registerProviderCatalogModel(
  deps: Dependencies,
  modelRef: string,
  expectedConfig: unknown,
): Promise<unknown> {
  const match = /^(qwen|minimax)\/([^\s\\*]+)$/.exec(modelRef);
  if (!match) return expectedConfig;
  const [, providerId, modelId] = match;
  assertChatModelSupported(modelRef);
  assertModelConfigUnchanged(expectedConfig, deps.readConfig());
  if (contains(expectedConfig, providerId, modelId)) return expectedConfig;
  deps.assertMutable();
  const saved = provider(expectedConfig, providerId);
  if (typeof saved.baseUrl !== "string" || typeof saved.apiKey !== "string")
    throw new Error("Configure this provider's endpoint and API key before selecting a model");
  const gateway = deps.gateway();
  if (!gateway?.connected || !supportsLocalModelGatewayVersion(gateway.serverVersion))
    throw new Error("Model registration requires a connected, supported OpenClaw Gateway");
  if (!["config.get", "config.patch"].every((method) => gateway.methods.includes(method)))
    throw new Error("Gateway cannot apply model catalog updates");
  const generation = gateway.connectionGeneration;
  const assertCurrent = () => {
    deps.assertMutable();
    if (
      deps.gateway() !== gateway ||
      !gateway.connected ||
      gateway.connectionGeneration !== generation
    )
      throw new Error("Gateway connection changed; reload the model catalog");
  };
  const result = await deps.discover({ baseUrl: saved.baseUrl, apiKey: saved.apiKey });
  assertCurrent();
  assertModelConfigUnchanged(expectedConfig, deps.readConfig());
  if (!result.ok) throw new Error(`Could not load the provider model catalog (${result.error})`);
  if (!result.models.includes(modelId))
    throw new Error("The selected model is not in the authenticated provider catalog");
  const snapshot = object(await gateway.request("config.get", {}));
  assertCurrent();
  assertModelConfigUnchanged(expectedConfig, deps.readConfig());
  if (snapshot.valid !== true || typeof snapshot.hash !== "string" || !snapshot.hash)
    throw new Error("The Gateway configuration is unavailable or invalid");
  const existing = Array.isArray(saved.models) ? saved.models : [];
  const models = [...existing, { id: modelId, name: modelId, input: ["text"] }];
  try {
    const patched = object(
      await gateway.request("config.patch", {
        baseHash: snapshot.hash,
        raw: JSON.stringify({ models: { providers: { [providerId]: { models } } } }),
      }),
    );
    assertCurrent();
    if (patched.ok !== true || !contains(patched.config, providerId, modelId))
      throw new Error("The registered model could not be confirmed");
    if (object(object(object(patched.sentinel).payload).stats).requiresRestart === true)
      throw new Error("This Gateway requires a restart to apply the saved model catalog");
    const deadline = Date.now() + MODEL_APPLY_SETTLE_TIMEOUT_MS;
    while (true) {
      const applied = object(
        await gateway.request("config.get", {}, Math.max(1, deadline - Date.now())),
      );
      assertCurrent();
      if (applied.valid !== true || !contains(applied.config, providerId, modelId))
        throw new Error("The saved model catalog changed; reload before selecting");
      if (
        typeof applied.configRevisionHash === "string" &&
        applied.configRevisionHash &&
        applied.appliedConfigHash === applied.configRevisionHash
      ) {
        const current = deps.readConfig();
        const currentProvider = provider(current, providerId);
        if (
          currentProvider.baseUrl !== saved.baseUrl ||
          currentProvider.apiKey !== saved.apiKey ||
          !contains(current, providerId, modelId)
        )
          throw new Error("Provider configuration changed while applying the model catalog");
        return structuredClone(current);
      }
      if (Date.now() >= deadline) throw new Error("The model catalog is still being applied");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (cause) {
    if (
      cause instanceof GatewayRequestError &&
      (cause.code === "INVALID_REQUEST" || cause.code === "FORBIDDEN")
    )
      throw cause;
    throw new Error(
      "Model catalog registration could not be confirmed. It may have been saved; reload before selecting. No restart or retry was attempted.",
      { cause },
    );
  }
}
