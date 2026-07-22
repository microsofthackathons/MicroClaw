export type ModelApiFormat = "openai-chat" | "openai-responses" | "anthropic";
export type ModelInputCapability = "text" | "image";

export interface ModelProviderInput {
  providerKey: string;
  baseUrl: string;
  apiKey: string;
  apiFormat: ModelApiFormat;
  modelName: string;
  input?: ModelInputCapability[];
}

export type ModelProviderValidationError =
  | "providerKeyRequired"
  | "invalidProviderKey"
  | "modelNameRequired"
  | "baseUrlRequired"
  | "invalidBaseUrl"
  | "apiKeyRequired"
  | "invalidCredentialReference";

type JsonObject = Record<string, unknown>;

const PROVIDER_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const CREDENTIAL_REFERENCE_PATTERN = /^\$\{([A-Z][A-Z0-9_]*)\}$/;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asJsonObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

export function getCredentialReferenceName(value: string): string | null {
  return CREDENTIAL_REFERENCE_PATTERN.exec(value.trim())?.[1] ?? null;
}

export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function validateModelProviderInput(
  input: ModelProviderInput,
  options: { requireApiKey?: boolean } = {},
): ModelProviderValidationError | null {
  const providerKey = input.providerKey.trim();
  const modelName = input.modelName.trim();
  const baseUrl = input.baseUrl.trim();
  const apiKey = input.apiKey.trim();

  if (!providerKey) return "providerKeyRequired";
  if (!PROVIDER_KEY_PATTERN.test(providerKey)) return "invalidProviderKey";
  if (!modelName) return "modelNameRequired";
  if (!baseUrl) return "baseUrlRequired";
  if (!isValidHttpUrl(baseUrl)) return "invalidBaseUrl";
  if (options.requireApiKey !== false && !apiKey) return "apiKeyRequired";
  if (
    (apiKey.includes("${") || apiKey.includes("}")) &&
    getCredentialReferenceName(apiKey) === null
  ) {
    return "invalidCredentialReference";
  }
  return null;
}

export function resolveApiValue(apiFormat: ModelApiFormat): string {
  if (apiFormat === "anthropic") return "anthropic-messages";
  if (apiFormat === "openai-responses") return "openai-responses";
  return "openai-completions";
}

export function normalizeModelInput(value: unknown): ModelInputCapability[] {
  if (!Array.isArray(value)) return ["text"];
  const capabilities = value.filter(
    (item): item is ModelInputCapability => item === "text" || item === "image",
  );
  return capabilities.length > 0 ? capabilities : ["text"];
}

export function mergeModelProviderConfig(
  existing: JsonObject,
  input: ModelProviderInput,
): JsonObject {
  const providerKey = input.providerKey.trim();
  const modelName = input.modelName.trim();
  const modelRef = `${providerKey}/${modelName}`;
  const existingModels = asJsonObject(existing.models);
  const existingProviders = asJsonObject(existingModels.providers);
  const existingAgents = asJsonObject(existing.agents);
  const existingDefaults = asJsonObject(existingAgents.defaults);
  const existingDefaultModel = asJsonObject(existingDefaults.model);
  const existingProvider = asJsonObject(existingProviders[providerKey]);
  const existingProviderModels = Array.isArray(existingProvider.models)
    ? existingProvider.models
    : [];
  const existingModelIndex = existingProviderModels.findIndex(
    (model) => isJsonObject(model) && model.id === modelName,
  );
  const existingModel =
    existingModelIndex >= 0 ? asJsonObject(existingProviderModels[existingModelIndex]) : null;

  const model: JsonObject = {
    ...(existingModel ?? {}),
    id: modelName,
    name: typeof existingModel?.name === "string" ? existingModel.name : modelName,
  };
  if (!existingModel && input.apiFormat !== "anthropic") {
    model.input = normalizeModelInput(input.input);
  }
  const providerModels =
    existingModelIndex >= 0
      ? existingProviderModels.map((entry, index) => (index === existingModelIndex ? model : entry))
      : [...existingProviderModels, model];

  const nextDefaults: JsonObject = {
    ...existingDefaults,
    model: {
      ...existingDefaultModel,
      primary: modelRef,
    },
  };

  return {
    ...existing,
    models: {
      ...existingModels,
      mode: existingModels.mode ?? "merge",
      providers: {
        ...existingProviders,
        [providerKey]: {
          ...existingProvider,
          baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
          apiKey: input.apiKey.trim(),
          api: resolveApiValue(input.apiFormat),
          models: providerModels,
        },
      },
    },
    agents: {
      ...existingAgents,
      defaults: nextDefaults,
    },
  };
}
