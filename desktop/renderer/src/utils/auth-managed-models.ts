export interface AuthManagedModelCatalogEntry {
  id: string;
  name: string;
}

export interface SwitchableModelEntry {
  providerKey: string;
  id: string;
  name: string;
  source: "managed" | "custom" | "auth-managed";
}

const GITHUB_COPILOT_PREFIX = "github-copilot/";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeCopilotPrimary(value: unknown, fallbackModelRef?: string): unknown {
  if (typeof value === "string") {
    return value.startsWith(GITHUB_COPILOT_PREFIX) ? fallbackModelRef : value;
  }
  if (!isJsonObject(value)) return value;
  if (
    typeof value.primary !== "string" ||
    !value.primary.startsWith(GITHUB_COPILOT_PREFIX)
  ) {
    return value;
  }
  const next = { ...value };
  if (fallbackModelRef) next.primary = fallbackModelRef;
  else delete next.primary;
  return Object.keys(next).length > 0 ? next : undefined;
}

export function mergeGitHubCopilotModelEntries<T extends SwitchableModelEntry>(
  current: T[],
  catalog: AuthManagedModelCatalogEntry[],
): Array<T | SwitchableModelEntry> {
  const existingCopilot = current.filter(
    (model) => model.source === "auth-managed" && model.providerKey === "github-copilot",
  );
  const merged: Array<T | SwitchableModelEntry> = current.filter(
    (model) => model.source !== "auth-managed" || model.providerKey !== "github-copilot",
  );
  const seen = new Set<string>();

  for (const model of catalog) {
    if (!model.id.startsWith(GITHUB_COPILOT_PREFIX)) continue;
    const id = model.id.slice(GITHUB_COPILOT_PREFIX.length);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push({
      providerKey: "github-copilot",
      id,
      name: model.name || id,
      source: "auth-managed",
    });
  }

  for (const model of existingCopilot) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push(model);
  }
  return merged;
}

export function removeGitHubCopilotModelReferences(
  config: JsonObject,
  fallbackModelRef?: string,
): JsonObject {
  const safeFallback =
    fallbackModelRef && !fallbackModelRef.startsWith(GITHUB_COPILOT_PREFIX)
      ? fallbackModelRef
      : undefined;
  if (!isJsonObject(config.agents) || !isJsonObject(config.agents.defaults)) {
    return { ...config };
  }

  const nextDefaults = { ...config.agents.defaults };
  const model = removeCopilotPrimary(config.agents.defaults.model, safeFallback);
  if (model === undefined) delete nextDefaults.model;
  else nextDefaults.model = model;

  if (isJsonObject(config.agents.defaults.models)) {
    const models = Object.fromEntries(
      Object.entries(config.agents.defaults.models).filter(
        ([modelRef]) => !modelRef.startsWith(GITHUB_COPILOT_PREFIX),
      ),
    );
    if (Object.keys(models).length > 0) nextDefaults.models = models;
    else delete nextDefaults.models;
  }

  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: nextDefaults,
    },
  };
}
