import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { readAgentRoster, writeAgentRoster } from "./agent-roster";
import { AgentOwnershipConfig, ensureExplicitAgentOwnership } from "./agent-roster-ownership";

const stateDir = path.resolve("fixture-state");

function migrate(config: AgentOwnershipConfig, owner = "main"): boolean {
  const roster = readAgentRoster(config.agents);
  const changed = ensureExplicitAgentOwnership(config, roster, owner, stateDir);
  writeAgentRoster(config.agents!, roster);
  return changed;
}

describe("agent ownership migration", () => {
  it("preserves the former single agent's workspace and implicit surface responsibilities", () => {
    const config: AgentOwnershipConfig = {
      agents: { entries: { main: {}, archive: {} } },
      channels: { "openclaw-weixin": { enabled: true } },
    };

    expect(migrate(config)).toBe(true);
    expect(config.agents).toEqual({
      ownership: "explicit",
      entries: { main: { workspace: path.join(stateDir, "workspace") }, archive: {} },
      defaults: { heartbeat: { agentId: "main" }, systemAgent: { agentId: "main" } },
    });
    expect(config.bindings).toEqual([
      { agentId: "main", match: { channel: "openclaw-weixin", accountId: "*" } },
    ]);
    expect(config.talk).toEqual({ agentId: "main" });
    const migrated = structuredClone(config);
    expect(migrate(config)).toBe(false);
    expect(config).toEqual(migrated);
  });

  it("preserves a non-main legacy owner and fixed session store without retired markers", () => {
    const config: AgentOwnershipConfig = {
      agents: {
        defaults: { workspace: "~/existing-workspace" },
        entries: { analyst: { default: true }, main: {} },
      },
      session: { store: "~/sessions.json" },
    };
    expect(migrate(config, "analyst")).toBe(true);
    expect(config.agents).toMatchObject({
      ownership: "explicit",
      defaults: {
        workspace: "~/existing-workspace",
        heartbeat: { agentId: "analyst" },
        systemAgent: { agentId: "analyst" },
        authInheritance: { agentId: "analyst" },
        sessionStore: { agentId: "analyst" },
      },
      entries: { analyst: { workspace: "~/existing-workspace" } },
    });
    expect(config.agents).not.toHaveProperty("entries.analyst.default");
  });

  it("does not overwrite existing surface owners or heartbeat options", () => {
    const config: AgentOwnershipConfig = {
      agents: {
        defaults: {
          heartbeat: { every: "30m" },
          systemAgent: { agentId: "analyst" },
          authInheritance: { agentId: "analyst" },
          sessionStore: { agentId: "analyst" },
        },
        entries: { main: { workspace: "~/custom" }, analyst: {} },
      },
      talk: { agentId: "analyst", mode: "manual" },
      session: { store: "~/shared.json" },
    };
    const original = structuredClone(config);
    expect(migrate(config)).toBe(true);
    expect(config.agents).toMatchObject({
      ownership: "explicit",
      defaults: original.agents!.defaults,
      entries: original.agents!.entries,
    });
    expect(config.talk).toEqual(original.talk);
  });

  it("keeps per-agent heartbeat and session stores independent", () => {
    const config: AgentOwnershipConfig = {
      agents: { entries: { main: {}, analyst: { heartbeat: { every: "1h" } } } },
      session: { store: "~/sessions/{agentId}.json" },
    };
    expect(migrate(config)).toBe(true);
    expect(config.agents).not.toHaveProperty("defaults.heartbeat");
    expect(config.agents).not.toHaveProperty("defaults.sessionStore");
  });

  it("keeps authored bindings and adds only missing active channel-wide fallbacks", () => {
    const bindings = [
      { agentId: "analyst", match: { channel: "slack", accountId: "*" } },
      { agentId: "analyst", match: { channel: "discord", accountId: "team" } },
      { type: "acp", agentId: "analyst", match: { channel: "telegram", accountId: "*" } },
    ];
    const config: AgentOwnershipConfig = {
      agents: { entries: { main: {}, analyst: {} } },
      channels: {
        slack: {},
        discord: {},
        telegram: {},
        disabled: { enabled: false },
        defaults: {},
        modelByChannel: {},
      },
      bindings,
    };
    expect(migrate(config)).toBe(true);
    expect(config.bindings).toEqual([
      ...bindings,
      { agentId: "main", match: { channel: "discord", accountId: "*" } },
      { agentId: "main", match: { channel: "telegram", accountId: "*" } },
    ]);
  });

  it.each([
    { agents: { entries: { main: {} } } },
    { agents: { ownership: "explicit", entries: { main: {}, analyst: {} } } },
  ])("does not migrate already explicit or single-agent configurations: %j", (config) => {
    const original = structuredClone(config);
    expect(migrate(config)).toBe(false);
    expect(config).toEqual(original);
  });

  it("migrates legacy list ownership without ever saving a default marker", () => {
    const config: AgentOwnershipConfig = {
      agents: { list: [{ id: "analyst", default: true }, { id: "main" }] },
    };

    expect(migrate(config, "analyst")).toBe(true);
    expect(config.agents).not.toHaveProperty("list");
    expect(config.agents).toHaveProperty("ownership", "explicit");
    expect(config.agents).toHaveProperty("defaults.systemAgent.agentId", "analyst");
    expect(
      readAgentRoster(config.agents).every(({ config: entry }) => !Object.hasOwn(entry, "default")),
    ).toBe(true);
    expect(migrate(config, "analyst")).toBe(false);
  });
});
