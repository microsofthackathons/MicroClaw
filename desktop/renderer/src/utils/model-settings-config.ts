import {
  normalizeModelInput,
  resolveApiValue,
  type ModelApiFormat,
  type ModelInputCapability,
} from "./model-provider";

export type ModelReasoningEffort =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive";

export interface SettingsModelEntry {
  providerKey: string;
  id: string;
  name: string;
  baseUrl?: string;
  apiKey?: string;
  apiFormat?: ModelApiFormat;
  reasoningEffort?: ModelReasoningEffort;
  input?: ModelInputCapability[];
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asJsonObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

function getModelRef(model: Pick<SettingsModelEntry, "providerKey" | "id">): string {
  return `${model.providerKey}/${model.id}`;
}

function normalizeReasoningEffort(value: unknown): ModelReasoningEffort {
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "adaptive"
  ) {
    return value;
  }
  return "off";
}

export function buildSettingsModelConfig(
  models: SettingsModelEntry[],
  existingProviders: JsonObject,
  existingModelDefaults: JsonObject,
): { providers: JsonObject; modelDefaults: JsonObject } {
  const providers: JsonObject = {};

  for (const model of models) {
    const apiFormat = model.apiFormat ?? "openai-chat";
    const api = resolveApiValue(apiFormat);
    const baseUrl = model.baseUrl ?? "";
    const apiKey = model.apiKey ?? "";
    const existingOutput = providers[model.providerKey];
    let provider: JsonObject;

    if (isJsonObject(existingOutput)) {
      if (
        existingOutput.baseUrl !== (baseUrl || undefined) ||
        existingOutput.apiKey !== apiKey ||
        existingOutput.api !== api
      ) {
        throw new Error(`Models in provider "${model.providerKey}" must share provider settings`);
      }
      provider = existingOutput;
    } else {
      provider = {
        ...asJsonObject(existingProviders[model.providerKey]),
        ...(baseUrl ? { baseUrl } : {}),
        apiKey,
        api,
        models: [],
      };
      if (!baseUrl) delete provider.baseUrl;
      providers[model.providerKey] = provider;
    }

    const reasoningEffort = normalizeReasoningEffort(model.reasoningEffort);
    const existingProvider = asJsonObject(existingProviders[model.providerKey]);
    const existingModels = Array.isArray(existingProvider.models) ? existingProvider.models : [];
    const existingModel = existingModels.find(
      (entry) => isJsonObject(entry) && entry.id === model.id,
    );
    const serializedModel: JsonObject = {
      ...asJsonObject(existingModel),
      id: model.id,
      name: model.name,
    };
    if (reasoningEffort !== "off") {
      serializedModel.reasoning = true;
    } else {
      delete serializedModel.reasoning;
    }
    if (apiFormat !== "anthropic") {
      serializedModel.input = normalizeModelInput(model.input);
    } else {
      delete serializedModel.input;
    }
    (provider.models as JsonObject[]).push(serializedModel);
  }

  const activeModelRefs = new Set(models.map(getModelRef));
  const managedProviderKeys = new Set([
    ...Object.keys(existingProviders),
    ...Object.keys(providers),
  ]);
  const modelDefaults: JsonObject = {};

  for (const [modelRef, modelConfig] of Object.entries(existingModelDefaults)) {
    const providerKey = modelRef.split("/")[0];
    if (!managedProviderKeys.has(providerKey) || activeModelRefs.has(modelRef)) {
      modelDefaults[modelRef] = modelConfig;
    }
  }

  for (const model of models) {
    const modelRef = getModelRef(model);
    const reasoningEffort = normalizeReasoningEffort(model.reasoningEffort);
    const existingConfig = modelDefaults[modelRef];
    if (reasoningEffort === "off") {
      if (!isJsonObject(existingConfig)) continue;
      const nextConfig = { ...existingConfig };
      const params = { ...asJsonObject(nextConfig.params) };
      delete params.thinking;
      if (Object.keys(params).length > 0) {
        nextConfig.params = params;
      } else {
        delete nextConfig.params;
      }
      if (Object.keys(nextConfig).length > 0) {
        modelDefaults[modelRef] = nextConfig;
      } else {
        delete modelDefaults[modelRef];
      }
      continue;
    }

    const nextConfig = { ...asJsonObject(existingConfig) };
    nextConfig.params = {
      ...asJsonObject(nextConfig.params),
      thinking: reasoningEffort,
    };
    modelDefaults[modelRef] = nextConfig;
  }

  return { providers, modelDefaults };
}
