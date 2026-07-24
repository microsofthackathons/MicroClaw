export interface AuthManagedModelCatalogEntry {
  id: string;
  name: string;
}

export interface SwitchableModelEntry {
  providerKey: string;
  id: string;
  name: string;
  source?: "config-managed" | "auth-managed";
}

const GITHUB_COPILOT_PREFIX = "github-copilot/";

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
