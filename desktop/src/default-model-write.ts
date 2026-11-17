import { isDeepStrictEqual } from "node:util";

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}
function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function onlyKeys(value: JsonObject, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** Use the unredacted source config, never the Gateway's redacted config.get view. */
export function prepareDefaultModelWrite(input: {
  gateway: { serverVersion: string | null; methods: readonly string[] };
  originalConfig: unknown;
  modelRef: string;
  baseHash: string;
  patch: JsonObject;
}): { method: "config.patch" | "config.set"; params: { baseHash: string; raw: string } } {
  const { gateway, originalConfig, modelRef, baseHash, patch } = input;
  const fallback = () => ({
    method: "config.patch" as const,
    params: { baseHash, raw: JSON.stringify(patch) },
  });
  const config = object(originalConfig);
  const mode = object(object(config.gateway).reload).mode;
  if (
    gateway.serverVersion?.split("+", 1)[0] !== "2026.10.10" ||
    !gateway.methods.includes("config.set") ||
    (mode !== undefined && mode !== "hot" && mode !== "hybrid")
  )
    return fallback();
  const agentsPatch = object(patch.agents);
  const defaultsPatch = object(agentsPatch.defaults);
  const selectorPatch = object(defaultsPatch.model);
  const allowedPatch = object(defaultsPatch.models);
  if (
    !isObject(patch.agents) ||
    !isObject(agentsPatch.defaults) ||
    !isObject(defaultsPatch.model) ||
    (Object.hasOwn(defaultsPatch, "models") && !isObject(defaultsPatch.models)) ||
    (Object.hasOwn(patch, "models") && !isObject(patch.models)) ||
    !onlyKeys(patch, ["agents", "models"]) ||
    !onlyKeys(agentsPatch, ["defaults"]) ||
    !onlyKeys(defaultsPatch, ["model", "models"]) ||
    !onlyKeys(selectorPatch, ["primary"]) ||
    selectorPatch.primary !== modelRef ||
    !onlyKeys(allowedPatch, [modelRef]) ||
    Object.values(allowedPatch).some((value) => !isDeepStrictEqual(value, {}))
  )
    return fallback();

  const providerId = modelRef.slice(0, modelRef.indexOf("/"));
  const modelId = modelRef.slice(modelRef.indexOf("/") + 1);
  const modelsPatch = object(patch.models);
  const providersPatch = object(modelsPatch.providers);
  const providerPatch = object(providersPatch[providerId]);
  const models = object(config.models);
  const providers = object(models.providers);
  const existingProvider = object(providers[providerId]);
  if (
    (Object.hasOwn(modelsPatch, "providers") && !isObject(modelsPatch.providers)) ||
    (Object.hasOwn(providersPatch, providerId) && !isObject(providersPatch[providerId])) ||
    !onlyKeys(modelsPatch, ["providers"]) ||
    !onlyKeys(providersPatch, [providerId]) ||
    !onlyKeys(providerPatch, ["models"])
  )
    return fallback();
  if (Object.hasOwn(providersPatch, providerId)) {
    const previous = Array.isArray(existingProvider.models) ? existingProvider.models : [];
    const next = providerPatch.models;
    // The catalog path supplies the existing entries plus the one verified model.
    // This restriction avoids replacing arrays that config.patch would merge by id.
    if (
      !Array.isArray(next) ||
      next.length !== previous.length + 1 ||
      !previous.every((value, index) => isDeepStrictEqual(value, next[index])) ||
      object(next.at(-1)).id !== modelId
    )
      return fallback();
  }
  const next = structuredClone(config);
  const agents = object(next.agents);
  const defaults = object(agents.defaults);
  next.agents = {
    ...agents,
    defaults: {
      ...defaults,
      model: { ...object(defaults.model), primary: modelRef },
      ...(Object.hasOwn(defaultsPatch, "models")
        ? { models: { ...object(defaults.models), ...allowedPatch } }
        : {}),
    },
  };
  if (Object.hasOwn(providersPatch, providerId)) {
    next.models = {
      ...models,
      providers: {
        ...providers,
        [providerId]: { ...existingProvider, models: providerPatch.models },
      },
    };
  }
  return { method: "config.set", params: { baseHash, raw: JSON.stringify(next) } };
}
