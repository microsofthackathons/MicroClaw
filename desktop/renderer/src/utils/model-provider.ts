export type ModelApiFormat = "openai-chat" | "openai-responses" | "anthropic";
export type ModelInputCapability = "text" | "image";
export type ModelReasoningEffort =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive";

export interface ModelProviderInput {
  providerKey: string;
  baseUrl: string;
  apiKey: string;
  apiFormat: ModelApiFormat;
  modelName: string;
  input?: ModelInputCapability[];
}

export interface ModelProviderUpdate extends ModelProviderInput {
  originalModelName: string;
  displayName: string;
  reasoningEffort: ModelReasoningEffort;
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

function getPrimaryModel(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const selector = asJsonObject(value);
  return typeof selector.primary === "string" ? selector.primary : undefined;
}

function replacePrimaryModel(value: unknown, modelRef?: string): unknown {
  if (typeof value === "string") return modelRef;
  const selector = { ...asJsonObject(value) };
  if (modelRef) selector.primary = modelRef;
  else delete selector.primary;
  return Object.keys(selector).length > 0 ? selector : undefined;
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

function updateModelDefaults(
  existingDefaults: JsonObject,
  oldModelRef: string,
  newModelRef: string,
  reasoningEffort?: ModelReasoningEffort,
): JsonObject {
  const nextDefaults = { ...existingDefaults };
  if (getPrimaryModel(existingDefaults.model) === oldModelRef) {
    nextDefaults.model = replacePrimaryModel(existingDefaults.model, newModelRef);
  }

  const existingModelDefaults = asJsonObject(existingDefaults.models);
  const oldModelDefaults = asJsonObject(existingModelDefaults[oldModelRef]);
  const newModelDefaults = asJsonObject(existingModelDefaults[newModelRef]);
  const nextModelDefaults = { ...existingModelDefaults };
  if (oldModelRef !== newModelRef) delete nextModelDefaults[oldModelRef];

  const nextEntry = {
    ...oldModelDefaults,
    ...newModelDefaults,
  };
  if (reasoningEffort) {
    const params = { ...asJsonObject(nextEntry.params) };
    if (reasoningEffort === "off") delete params.thinking;
    else params.thinking = reasoningEffort;
    if (Object.keys(params).length > 0) nextEntry.params = params;
    else delete nextEntry.params;
  }

  if (Object.keys(nextEntry).length > 0) nextModelDefaults[newModelRef] = nextEntry;
  else delete nextModelDefaults[newModelRef];
  if (Object.keys(nextModelDefaults).length > 0) nextDefaults.models = nextModelDefaults;
  else delete nextDefaults.models;
  return nextDefaults;
}

function writeProviderModel(
  existing: JsonObject,
  input: ModelProviderInput,
  options: {
    originalModelName: string;
    displayName: string;
    reasoningEffort?: ModelReasoningEffort;
    select: boolean;
  },
): JsonObject {
  const providerKey = input.providerKey.trim();
  const modelName = input.modelName.trim();
  const originalModelName = options.originalModelName.trim();
  const oldModelRef = `${providerKey}/${originalModelName}`;
  const newModelRef = `${providerKey}/${modelName}`;
  const existingModelsConfig = asJsonObject(existing.models);
  const existingProviders = asJsonObject(existingModelsConfig.providers);
  const existingProvider = asJsonObject(existingProviders[providerKey]);
  const existingProviderModels = Array.isArray(existingProvider.models)
    ? existingProvider.models
    : [];
  const originalModel = existingProviderModels.find(
    (model) => isJsonObject(model) && model.id === originalModelName,
  );
  const targetModel = existingProviderModels.find(
    (model) => isJsonObject(model) && model.id === modelName,
  );
  const model: JsonObject = {
    ...asJsonObject(originalModel),
    ...asJsonObject(targetModel),
    id: modelName,
    name: options.displayName.trim() || modelName,
  };
  if (input.apiFormat === "anthropic") delete model.input;
  else model.input = normalizeModelInput(input.input);
  if (options.reasoningEffort) {
    if (options.reasoningEffort === "off") delete model.reasoning;
    else model.reasoning = true;
  }

  const originalModelIndex = existingProviderModels.findIndex(
    (entry) => isJsonObject(entry) && entry.id === originalModelName,
  );
  const targetModelIndex = existingProviderModels.findIndex(
    (entry) => isJsonObject(entry) && entry.id === modelName,
  );
  const providerModels = existingProviderModels.filter(
    (entry) =>
      !isJsonObject(entry) || (entry.id !== originalModelName && entry.id !== modelName),
  );
  const insertionIndex =
    originalModelIndex >= 0
      ? originalModelIndex
      : targetModelIndex >= 0
        ? targetModelIndex
        : providerModels.length;
  providerModels.splice(Math.min(insertionIndex, providerModels.length), 0, model);

  const existingAgents = asJsonObject(existing.agents);
  const existingDefaults = asJsonObject(existingAgents.defaults);
  let nextDefaults = updateModelDefaults(
    existingDefaults,
    oldModelRef,
    newModelRef,
    options.reasoningEffort,
  );
  if (options.select) {
    nextDefaults = {
      ...nextDefaults,
      model: replacePrimaryModel(nextDefaults.model, newModelRef),
    };
  }

  return {
    ...existing,
    models: {
      ...existingModelsConfig,
      mode: existingModelsConfig.mode ?? "merge",
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

export function mergeModelProviderConfig(
  existing: JsonObject,
  input: ModelProviderInput,
): JsonObject {
  return writeProviderModel(existing, input, {
    originalModelName: input.modelName,
    displayName: input.modelName,
    select: true,
  });
}

export function updateModelProviderConfig(
  existing: JsonObject,
  input: ModelProviderUpdate,
): JsonObject {
  return writeProviderModel(existing, input, {
    originalModelName: input.originalModelName,
    displayName: input.displayName,
    reasoningEffort: input.reasoningEffort,
    select: false,
  });
}

export function selectPrimaryModelConfig(
  existing: JsonObject,
  modelRef: string,
  options: { ensureAllowed?: boolean } = {},
): JsonObject {
  const existingAgents = asJsonObject(existing.agents);
  const existingDefaults = asJsonObject(existingAgents.defaults);
  const nextDefaults: JsonObject = {
    ...existingDefaults,
    model: replacePrimaryModel(existingDefaults.model, modelRef),
  };
  if (options.ensureAllowed) {
    const existingAllowedModels = asJsonObject(existingDefaults.models);
    nextDefaults.models = {
      ...existingAllowedModels,
      [modelRef]: asJsonObject(existingAllowedModels[modelRef]),
    };
  }
  return {
    ...existing,
    agents: {
      ...existingAgents,
      defaults: nextDefaults,
    },
  };
}

export function removeModelProviderConfig(
  existing: JsonObject,
  providerKey: string,
  modelName: string,
  fallbackModelRef?: string,
): JsonObject {
  const modelRef = `${providerKey}/${modelName}`;
  const existingModelsConfig = asJsonObject(existing.models);
  const existingProviders = asJsonObject(existingModelsConfig.providers);
  const existingProvider = asJsonObject(existingProviders[providerKey]);
  const existingProviderModels = Array.isArray(existingProvider.models)
    ? existingProvider.models
    : [];
  if (!existingProviderModels.some((model) => isJsonObject(model) && model.id === modelName)) {
    throw new Error(`Model "${modelRef}" is not configured`);
  }

  const remainingModels = existingProviderModels.filter(
    (model) => !isJsonObject(model) || model.id !== modelName,
  );
  const nextProviders = { ...existingProviders };
  if (remainingModels.length > 0) {
    nextProviders[providerKey] = { ...existingProvider, models: remainingModels };
  } else {
    delete nextProviders[providerKey];
  }

  const existingAgents = asJsonObject(existing.agents);
  const existingDefaults = asJsonObject(existingAgents.defaults);
  const nextDefaults = { ...existingDefaults };
  if (getPrimaryModel(existingDefaults.model) === modelRef) {
    const replacement = fallbackModelRef && fallbackModelRef !== modelRef ? fallbackModelRef : undefined;
    const nextSelector = replacePrimaryModel(existingDefaults.model, replacement);
    if (nextSelector === undefined) delete nextDefaults.model;
    else nextDefaults.model = nextSelector;
  }
  const existingAllowedModels = asJsonObject(existingDefaults.models);
  if (Object.prototype.hasOwnProperty.call(existingAllowedModels, modelRef)) {
    const nextAllowedModels = { ...existingAllowedModels };
    delete nextAllowedModels[modelRef];
    if (Object.keys(nextAllowedModels).length > 0) nextDefaults.models = nextAllowedModels;
    else delete nextDefaults.models;
  }

  return {
    ...existing,
    models: {
      ...existingModelsConfig,
      providers: nextProviders,
    },
    agents: {
      ...existingAgents,
      defaults: nextDefaults,
    },
  };
}
