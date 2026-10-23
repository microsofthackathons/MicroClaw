type JsonObject = Record<string, unknown>;

const GITHUB_COPILOT_PROVIDER = "github-copilot";

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

/**
 * Enable the bundled GitHub Copilot provider plugin.
 * Returns true when the config was changed.
 */
export function ensureGitHubCopilotProviderPlugin(config: JsonObject): boolean {
  let changed = false;
  let plugins = asJsonObject(config.plugins);
  if (!plugins) {
    plugins = {};
    config.plugins = plugins;
    changed = true;
  }

  let entries = asJsonObject(plugins.entries);
  if (!entries) {
    entries = {};
    plugins.entries = entries;
    changed = true;
  }

  let copilotEntry = asJsonObject(entries[GITHUB_COPILOT_PROVIDER]);
  if (!copilotEntry) {
    copilotEntry = {};
    entries[GITHUB_COPILOT_PROVIDER] = copilotEntry;
    changed = true;
  }
  if (copilotEntry.enabled !== true) {
    copilotEntry.enabled = true;
    changed = true;
  }

  const allow = Array.isArray(plugins.allow) ? plugins.allow : [];
  if (!Array.isArray(plugins.allow)) {
    plugins.allow = allow;
    changed = true;
  }
  if (!allow.includes(GITHUB_COPILOT_PROVIDER)) {
    allow.push(GITHUB_COPILOT_PROVIDER);
    changed = true;
  }

  if (Array.isArray(plugins.deny) && plugins.deny.includes(GITHUB_COPILOT_PROVIDER)) {
    plugins.deny = plugins.deny.filter((id) => id !== GITHUB_COPILOT_PROVIDER);
    changed = true;
  }

  return changed;
}

export function ensureSelectedModelProviderPlugins(config: JsonObject): boolean {
  if (!getPrimaryModel(config)?.startsWith(`${GITHUB_COPILOT_PROVIDER}/`)) return false;
  return ensureGitHubCopilotProviderPlugin(config);
}
