import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { getAgentOwnedSkillIds, matchesSkill } from "./agent-catalog";
import { readAgentRoster } from "./agent-roster";
import { waitForAgentRosterReload } from "./gateway-lifecycle";

interface AgentGateway {
  connected: boolean;
  connectionGeneration: number;
  methods: readonly string[];
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function assertAgentRosterHotReloadAvailable(
  config: unknown,
  gateway: AgentGateway | null,
  fileSkillsChangedWithoutConfigChange = false,
): void {
  if (!gateway?.connected) throw new Error("Gateway not connected");
  if (
    !["config.get", "agents.list", "skills.status"].every((method) =>
      gateway.methods.includes(method),
    )
  )
    throw new Error("Gateway does not support verified agent hot updates");
  const mode = object(object(object(config).gateway).reload).mode;
  if (mode !== undefined && mode !== "hot" && mode !== "hybrid")
    throw new Error("Enable Gateway hot reload before changing the agent catalog");
  if (
    fileSkillsChangedWithoutConfigChange &&
    object(object(object(config).skills).load).watch === false
  )
    throw new Error(
      "Enable skills.load.watch before updating agent skill files without a config change",
    );
}

function rosterProjection(config: unknown): unknown {
  return readAgentRoster(object(config).agents)
    .map(({ id, config: agent }) => ({ id, skills: agent.skills, workspace: agent.workspace }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function appliedRevision(snapshot: unknown, expected: unknown, agentId: string): string {
  const value = object(snapshot);
  if (
    value.valid !== true ||
    typeof value.configRevisionHash !== "string" ||
    !value.configRevisionHash ||
    value.appliedConfigHash !== value.configRevisionHash ||
    !isDeepStrictEqual(rosterProjection(value.config), rosterProjection(expected))
  )
    throw new Error("Gateway has not applied the expected agent configuration");
  const actualSkills = object(object(object(value.config).skills).entries);
  const expectedSkills = object(object(object(expected).skills).entries);
  for (const skillId of getAgentOwnedSkillIds(agentId)) {
    if (object(actualSkills[skillId]).enabled !== object(expectedSkills[skillId]).enabled)
      throw new Error("Gateway has not applied the expected agent skill configuration");
  }
  return value.configRevisionHash;
}

function samePath(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(actual) === normalize(expected);
}

export async function waitForAgentRuntimeApplied(options: {
  gateway: AgentGateway;
  isCurrent: () => boolean;
  config: unknown;
  agentId: string;
  stateDir: string;
  verifyOwnedSkills?: boolean;
  timeoutMs?: number;
  now?: () => number;
}): Promise<boolean> {
  const { gateway, config, agentId, stateDir } = options;
  const now = options.now ?? (() => performance.now());
  const generation = gateway.connectionGeneration;
  const expectedIds = new Set(readAgentRoster(object(config).agents).map(({ id }) => id));
  const assertCurrent = () => {
    if (!options.isCurrent() || !gateway.connected || gateway.connectionGeneration !== generation)
      throw new Error("Gateway connection changed during the agent update");
  };
  return waitForAgentRosterReload({
    timeoutMs: options.timeoutMs ?? 45_000,
    pollMs: 100,
    now,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    isApplied: (ids) =>
      ids.size === expectedIds.size && [...ids].every((id) => expectedIds.has(id)),
    listAgentIds: async (timeoutMs) => {
      const deadline = now() + timeoutMs;
      const request = async (method: string, params?: unknown) => {
        assertCurrent();
        const remainingMs = deadline - now();
        if (remainingMs <= 0) throw new Error("Agent hot update timed out");
        const result = await gateway.request(method, params, Math.max(1, remainingMs));
        assertCurrent();
        return result;
      };
      const revision = appliedRevision(await request("config.get", {}), config, agentId);
      const roster = object(await request("agents.list"));
      if (!Array.isArray(roster.agents))
        throw new Error("Gateway returned an invalid agent roster");
      const ids = new Set<string>();
      for (const agent of roster.agents) {
        const id = object(agent).id;
        if (typeof id !== "string" || !id) throw new Error("Gateway returned an invalid agent id");
        ids.add(id);
      }
      const ownedSkills =
        options.verifyOwnedSkills !== false && expectedIds.has(agentId)
          ? getAgentOwnedSkillIds(agentId)
          : [];
      if (ownedSkills.length > 0) {
        const report = object(await request("skills.status", { agentId }));
        if (!Array.isArray(report.skills))
          throw new Error("Gateway returned an invalid skill report");
        for (const skillId of ownedSkills) {
          const skill = report.skills
            .map(object)
            .find((candidate) =>
              [candidate.skillKey, candidate.name].some(
                (name) => typeof name === "string" && matchesSkill(name, skillId),
              ),
            );
          if (
            !skill ||
            skill.disabled !== false ||
            skill.blockedByAllowlist === true ||
            skill.blockedByAgentFilter === true ||
            !samePath(skill.filePath, path.join(stateDir, "skills", skillId, "SKILL.md"))
          )
            throw new Error(`Gateway has not loaded the installed agent skill "${skillId}"`);
        }
      }
      if (appliedRevision(await request("config.get", {}), config, agentId) !== revision)
        throw new Error("Gateway configuration changed during agent verification");
      return ids;
    },
  });
}

export class AgentRosterRollbackError extends AggregateError {
  constructor(cause: unknown, rollbackError: unknown) {
    super(
      [cause, rollbackError],
      "Agent hot update failed and its configuration rollback could not be confirmed",
      { cause },
    );
    this.name = "AgentRosterRollbackError";
  }
}

export async function applyAgentRosterConfig(options: {
  originalText: string;
  config: unknown;
  readText: () => string;
  writeText: (text: string) => void;
  waitForApplied: (config: unknown) => Promise<boolean>;
}): Promise<void> {
  const { originalText, config, readText, writeText, waitForApplied } = options;
  if (readText() !== originalText)
    throw new Error("Agent configuration changed; reload the agent catalog and try again");
  const nextText = JSON.stringify(config, null, 2);
  writeText(nextText);
  try {
    if (!(await waitForApplied(config)))
      throw new Error("Gateway did not hot-apply the agent update; no restart was attempted");
  } catch (error) {
    try {
      if (readText() !== nextText)
        throw new Error("Agent configuration changed during the update; refusing to overwrite it", {
          cause: error,
        });
      writeText(originalText);
      if (!(await waitForApplied(JSON.parse(originalText))))
        throw new Error("Gateway did not hot-apply the previous agent configuration", {
          cause: error,
        });
    } catch (rollbackError) {
      throw new AgentRosterRollbackError(error, rollbackError);
    }
    throw error;
  }
}
