type JsonObject = Record<string, unknown>;

function asJsonObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function getPrimaryModel(config: JsonObject): string | undefined {
  const agents = asJsonObject(config.agents);
  const defaults = asJsonObject(agents?.defaults);
  const model = defaults?.model;
  if (typeof model === "string") return model;
  const modelConfig = asJsonObject(model);
  return typeof modelConfig?.primary === "string" ? modelConfig.primary : undefined;
}

export function hasConfiguredModel(config: unknown): boolean {
  const root = asJsonObject(config);
  if (!root) return false;

  const models = asJsonObject(root.models);
  const providers = asJsonObject(models?.providers);
  if (providers && Object.keys(providers).length > 0) return true;

  return getPrimaryModel(root)?.startsWith("github-copilot/") === true;
}
