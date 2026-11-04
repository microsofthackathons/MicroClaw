import { describe, expect, it } from "vitest";
import { readAgentRoster, writeAgentRoster } from "./agent-roster";

describe("Agent configuration roster", () => {
  it("mutates the original keyed configs while deriving IDs from keys", () => {
    const agents = { entries: { main: { id: "stale-id", name: "Assistant" } } };
    const [entry] = readAgentRoster(agents);
    expect(entry.id).toBe("main");
    entry.config.name = "Updated";
    expect(agents.entries.main.name).toBe("Updated");
  });

  it("keeps explicit ownership and strips legacy fields when storing a mixed roster", () => {
    const agents: Record<string, unknown> = {
      ownership: "explicit",
      list: [{ id: "main", default: true }],
      defaults: { heartbeat: { agentId: "main" } },
    };
    const roster = readAgentRoster(agents);
    expect(writeAgentRoster(agents, roster)).toBe(true);
    expect(agents).toEqual({
      ownership: "explicit",
      entries: { main: {} },
      defaults: { heartbeat: { agentId: "main" } },
    });
    expect(writeAgentRoster(agents, readAgentRoster(agents))).toBe(false);
  });

  it("converts legacy lists to keyed entries without retaining default markers", () => {
    const agents = { list: [{ id: "main", name: "Assistant", default: true }] };
    expect(writeAgentRoster(agents, readAgentRoster(agents))).toBe(true);
    expect(agents).toEqual({ entries: { main: { name: "Assistant" } } });
    expect(writeAgentRoster(agents, readAgentRoster(agents))).toBe(false);
  });

  it("never reintroduces retired default markers in keyed rosters", () => {
    const agents = {
      entries: {
        main: { name: "Assistant", default: true },
        "master-archive": { name: "Master Archive" },
      },
    };

    expect(writeAgentRoster(agents, readAgentRoster(agents))).toBe(true);
    expect(agents.entries.main).not.toHaveProperty("default");
    expect(agents).not.toHaveProperty("ownership");
    expect(agents).not.toHaveProperty("list");
  });

  it("preserves explicit ownership while stripping retired default markers", () => {
    const agents: Record<string, unknown> = {
      ownership: "explicit",
      entries: { main: { default: true }, "master-archive": {} },
    };

    expect(writeAgentRoster(agents, readAgentRoster(agents))).toBe(true);
    expect(agents).toEqual({
      ownership: "explicit",
      entries: { main: {}, "master-archive": {} },
    });
    expect(writeAgentRoster(agents, readAgentRoster(agents))).toBe(false);
  });

  it.each([
    { entries: [] },
    { entries: { main: null } },
    { list: {} },
    { list: [{ name: "Missing ID" }] },
  ])("rejects malformed rosters without silently dropping agents: %j", (agents) => {
    expect(() => readAgentRoster(agents)).toThrow(/Invalid/);
  });
});
