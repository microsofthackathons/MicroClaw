import { isModelProviderSupported } from "../../../src/model-provider-policy";

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

export function getDefaultAgentModelOverride(
  config: unknown,
): { agentId: string; modelRef: string } | null {
  const agents = asJsonObject(asJsonObject(config).agents);
  const entries = Array.isArray(agents.list) ? agents.list.filter(isJsonObject) : [];
  const defaultAgent = entries.find((agent) => agent.default === true) ?? entries[0];
  const modelRef = getPrimaryModel(defaultAgent?.model);
  if (typeof defaultAgent?.id !== "string" || !modelRef?.trim()) return null;
  return { agentId: defaultAgent.id, modelRef };
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
  if (!PROVIDER_KEY_PATTERN.test(providerKey) || !isModelProviderSupported(providerKey))
    return "invalidProviderKey";
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

export function matchesProviderConnection(config: unknown, input: ModelProviderInput): boolean {
  const provider = asJsonObject(
    asJsonObject(asJsonObject(asJsonObject(config).models).providers)[input.providerKey.trim()],
  );
  return (
    typeof provider.baseUrl === "string" &&
    provider.baseUrl.trim().replace(/\/+$/, "") === input.baseUrl.trim().replace(/\/+$/, "") &&
    typeof provider.apiKey === "string" &&
    provider.apiKey.trim() === input.apiKey.trim() &&
    provider.api === resolveApiValue(input.apiFormat)
  );
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

  if (
    Object.keys(nextEntry).length > 0 ||
    Object.hasOwn(existingModelDefaults, oldModelRef) ||
    Object.hasOwn(existingModelDefaults, newModelRef)
  )
    nextModelDefaults[newModelRef] = nextEntry;
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
    (entry) => !isJsonObject(entry) || (entry.id !== originalModelName && entry.id !== modelName),
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
  const allowed = asJsonObject(nextDefaults.models);
  if (!options.select && Object.keys(allowed).length && !Object.hasOwn(allowed, newModelRef)) {
    nextDefaults.models = { ...allowed, [newModelRef]: {} };
  }
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
  options: { select?: boolean; displayName?: string } = {},
): JsonObject {
  return writeProviderModel(existing, input, {
    originalModelName: input.modelName,
    displayName: options.displayName ?? input.modelName,
    select: options.select ?? true,
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
    const replacement =
      fallbackModelRef && fallbackModelRef !== modelRef ? fallbackModelRef : undefined;
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

export function removeProviderConnectionConfig(
  existing: JsonObject,
  providerKey: string,
): JsonObject {
  const models = asJsonObject(existing.models);
  const providers = asJsonObject(models.providers);
  if (!Object.hasOwn(providers, providerKey)) {
    throw new Error(`Provider "${providerKey}" is not configured`);
  }
  const nextProviders = { ...providers };
  delete nextProviders[providerKey];

  const belongsToProvider = (value: unknown) =>
    typeof value === "string" && value.startsWith(`${providerKey}/`);
  const clearModelReferences = (value: unknown): unknown => {
    if (!isJsonObject(value)) return value;
    const scope = { ...value };
    if (belongsToProvider(scope.model)) {
      delete scope.model;
    } else if (isJsonObject(scope.model)) {
      const selector = { ...scope.model };
      if (belongsToProvider(selector.primary)) delete selector.primary;
      if (Array.isArray(selector.fallbacks)) {
        const remaining = selector.fallbacks.filter((model) => !belongsToProvider(model));
        if (remaining.length !== selector.fallbacks.length) {
          if (remaining.length) selector.fallbacks = remaining;
          else delete selector.fallbacks;
        }
      }
      if (Object.keys(selector).length) scope.model = selector;
      else delete scope.model;
    }
    if (isJsonObject(scope.models)) {
      const remaining = Object.fromEntries(
        Object.entries(scope.models).filter(([modelRef]) => !belongsToProvider(modelRef)),
      );
      if (Object.keys(remaining).length !== Object.keys(scope.models).length) {
        if (Object.keys(remaining).length) scope.models = remaining;
        else delete scope.models;
      }
    }
    return scope;
  };
  const agents = asJsonObject(existing.agents);
  const nextAgents = { ...agents };
  if (Object.hasOwn(agents, "defaults")) {
    nextAgents.defaults = clearModelReferences(agents.defaults);
  }
  if (Array.isArray(agents.list)) nextAgents.list = agents.list.map(clearModelReferences);
  if (isJsonObject(agents.entries)) {
    nextAgents.entries = Object.fromEntries(
      Object.entries(agents.entries).map(([id, agent]) => [id, clearModelReferences(agent)]),
    );
  }
  return {
    ...existing,
    models: { ...models, providers: nextProviders },
    agents: nextAgents,
  };
}
