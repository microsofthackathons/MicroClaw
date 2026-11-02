import * as path from "node:path";
import { AgentConfigEntry } from "./agent-roster";

export interface AgentOwnershipConfig {
  agents?: Record<string, unknown>;
  channels?: unknown;
  bindings?: unknown;
  talk?: unknown;
  session?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasChannelWideBinding(bindings: unknown[], channel: string): boolean {
  return bindings.some((binding) => {
    if (!isRecord(binding) || binding.type === "acp" || !isRecord(binding.match)) return false;
    const match = binding.match;
    return (
      typeof match.channel === "string" &&
      match.channel.trim().toLowerCase() === channel &&
      typeof match.accountId === "string" &&
      match.accountId.trim() === "*" &&
      match.peer === undefined &&
      !(typeof match.guildId === "string" && match.guildId.trim()) &&
      !(typeof match.teamId === "string" && match.teamId.trim()) &&
      (!Array.isArray(match.roles) || match.roles.length === 0)
    );
  });
}

export function ensureExplicitAgentOwnership(
  config: AgentOwnershipConfig,
  roster: AgentConfigEntry[],
  legacyDefaultAgentId: string,
  stateDir: string,
): boolean {
  const agents = config.agents;
  if (!agents || agents.ownership !== undefined || roster.length < 2) {
    return false;
  }
  const owner = roster.find(({ id }) => id === legacyDefaultAgentId)?.config;
  if (!owner) throw new Error("Cannot migrate agent ownership because the legacy owner is missing");
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  if (
    !Object.hasOwn(owner, "workspace") ||
    (typeof owner.workspace === "string" && !owner.workspace.trim())
  ) {
    owner.workspace =
      typeof defaults.workspace === "string" && defaults.workspace.trim()
        ? defaults.workspace
        : path.join(stateDir, "workspace");
  }

  if (config.bindings === undefined || Array.isArray(config.bindings)) {
    const bindings: unknown[] = [...(config.bindings ?? [])];
    const channels = isRecord(config.channels) ? config.channels : {};
    for (const [rawChannel, channelConfig] of Object.entries(channels)) {
      const channel = rawChannel.trim().toLowerCase();
      if (
        !channel ||
        channel === "defaults" ||
        channel === "modelbychannel" ||
        (isRecord(channelConfig) && channelConfig.enabled === false) ||
        hasChannelWideBinding(bindings, channel)
      ) {
        continue;
      }
      bindings.push({ agentId: legacyDefaultAgentId, match: { channel, accountId: "*" } });
    }
    if (bindings.length > 0) config.bindings = bindings;
  }

  if (agents.defaults === undefined || isRecord(agents.defaults)) {
    const materialize = (key: string) => {
      const current = defaults[key];
      if (current === undefined || (isRecord(current) && !Object.hasOwn(current, "agentId"))) {
        defaults[key] = { ...(isRecord(current) ? current : {}), agentId: legacyDefaultAgentId };
      }
    };
    if (defaults.heartbeat === undefined && !roster.some(({ config: entry }) => entry.heartbeat)) {
      materialize("heartbeat");
    }
    materialize("systemAgent");
    if (legacyDefaultAgentId !== "main") materialize("authInheritance");
    const store = isRecord(config.session) ? config.session.store : undefined;
    if (typeof store === "string" && store.trim() && !store.includes("{agentId}")) {
      materialize("sessionStore");
    }
    agents.defaults = defaults;
  }
  if (config.talk === undefined || isRecord(config.talk)) {
    const talk = config.talk ?? {};
    if (!Object.hasOwn(talk, "agentId")) {
      config.talk = { ...talk, agentId: legacyDefaultAgentId };
    }
  }
  agents.ownership = "explicit";
  return true;
}
