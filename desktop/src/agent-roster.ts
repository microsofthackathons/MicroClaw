export interface AgentConfigEntry {
  id: string;
  config: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function usesKeyedAgentRoster(agents: Record<string, unknown>): boolean {
  return agents.entries !== undefined || agents.ownership === "explicit";
}

/** Returns references to the stored configs, not copies, for in-place mutations. */
export function readAgentRoster(agents: unknown): AgentConfigEntry[] {
  if (agents === undefined) return [];
  if (!isRecord(agents)) throw new Error("Invalid agents configuration");
  if (agents.entries !== undefined) {
    if (!isRecord(agents.entries)) throw new Error("Invalid agents.entries configuration");
    return Object.entries(agents.entries).map(([id, config]) => {
      if (!id.trim() || !isRecord(config)) {
        throw new Error(`Invalid agent entry "${id}" in agents.entries`);
      }
      return { id, config };
    });
  }
  if (agents.list === undefined) return [];
  if (!Array.isArray(agents.list)) throw new Error("Invalid agents.list configuration");
  return agents.list.map((config) => {
    if (!isRecord(config) || typeof config.id !== "string" || !config.id.trim()) {
      throw new Error("Invalid agent entry in agents.list");
    }
    return { id: config.id, config };
  });
}

/** Preserve the runtime's schema; never undo doctor's explicit-ownership migration. */
export function writeAgentRoster(
  agents: Record<string, unknown>,
  roster: AgentConfigEntry[],
): boolean {
  const before = JSON.stringify(agents);
  if (usesKeyedAgentRoster(agents)) {
    agents.entries = Object.fromEntries(
      roster.map(({ id, config }) => [
        id,
        Object.fromEntries(
          Object.entries(config).filter(([key]) => key !== "id" && key !== "default"),
        ),
      ]),
    );
    delete agents.list;
  } else {
    agents.list = roster.map(({ id, config }) => ({ ...config, id }));
  }
  return before !== JSON.stringify(agents);
}
