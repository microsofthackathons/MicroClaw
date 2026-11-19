type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asJsonObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

/** Shared by the settings UI and the Gateway write guard. */
export function removeProviderConnectionConfig(
  existing: JsonObject,
  providerKey: string,
): JsonObject {
  const models = asJsonObject(existing.models);
  const providers = asJsonObject(models.providers);
  if (!Object.hasOwn(providers, providerKey) && providerKey !== "llama-cpp") {
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
  const nextConfig = {
    ...existing,
    models: { ...models, providers: nextProviders },
    agents: nextAgents,
  };
  if (providerKey !== "llama-cpp") return nextConfig;
  const plugins = asJsonObject(existing.plugins);
  const entries = asJsonObject(plugins.entries);
  return {
    ...nextConfig,
    plugins: {
      ...plugins,
      entries: {
        ...entries,
        "llama-cpp": { ...asJsonObject(entries["llama-cpp"]), enabled: false },
      },
    },
  };
}
