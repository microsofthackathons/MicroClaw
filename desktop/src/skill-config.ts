// Pure config-mutation helpers shared by the skills IPC handlers. They mutate an
// OpenClaw config object in place so a single caller can stage several changes and
// then perform ONE atomic write + ONE gateway restart. Keeping the mutation logic
// here (rather than inline in each handler) gives a single source of truth and lets
// the behaviour be unit-tested without the Electron/IPC harness.

import { resolveSkillFilterNames } from "./agent-catalog";

/** A single per-agent entry inside `config.agents.list`. */
export interface MutableAgentEntry {
  id?: unknown;
  skills?: unknown;
  [key: string]: unknown;
}

/** The subset of the OpenClaw config these helpers read/mutate. */
export interface MutableSkillsConfig {
  agents?: { list?: unknown[] } & Record<string, unknown>;
  skills?: {
    entries?: Record<string, { enabled?: boolean } & Record<string, unknown>>;
    allowBundled?: string[];
  } & Record<string, unknown>;
  [key: string]: unknown;
}

/** A staged global on/off change for one skill (keyed by skillKey/slug). */
export interface GlobalSkillChange {
  skillKey: string;
  enabled: boolean;
}

/**
 * Writes the per-agent allowlist for `agentId` into `config.agents.list[*].skills`.
 * Persists match-names (not raw slugs) so OpenClaw's frontmatter-name based filter
 * binds every eligible skill. Throws when the agent list is missing or the agent id
 * isn't present. Mutates `config` in place.
 */
export function applyAgentSkillsToConfig(
  config: MutableSkillsConfig,
  agentId: string,
  skillIds: readonly string[],
): void {
  const agents = config.agents;
  if (!agents || !Array.isArray(agents.list)) {
    throw new Error("No configured agents to update");
  }
  const entry = agents.list.find(
    (candidate: unknown): candidate is MutableAgentEntry =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { id?: unknown }).id === agentId,
  );
  if (!entry) {
    throw new Error(`Unknown agent "${agentId}"`);
  }
  entry.skills = resolveSkillFilterNames(skillIds);
}

/**
 * Applies a global on/off change for a single skill, mirroring OpenClaw's two-layer
 * gating. Turning ON clears any global disable and, for bundled skills gated by a
 * non-empty allowlist, adds the key to `allowBundled` (when the allowlist is absent
 * or empty, bundled skills are already allowed, so it's left untouched rather than
 * creating a newly restrictive allowlist). Turning OFF sets `entries[key].enabled`
 * to false. Mutates `config` in place.
 */
export function applyGlobalSkillChange(
  config: MutableSkillsConfig,
  skillKey: string,
  enabled: boolean,
  isBundled: boolean,
): void {
  if (!config.skills) config.skills = {};
  if (!config.skills.entries) config.skills.entries = {};
  if (!config.skills.entries[skillKey]) config.skills.entries[skillKey] = {};

  if (enabled) {
    config.skills.entries[skillKey].enabled = true;
    if (
      isBundled &&
      Array.isArray(config.skills.allowBundled) &&
      config.skills.allowBundled.length > 0 &&
      !config.skills.allowBundled.includes(skillKey)
    ) {
      config.skills.allowBundled.push(skillKey);
    }
  } else {
    config.skills.entries[skillKey].enabled = false;
  }
}
