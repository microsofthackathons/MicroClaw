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

  it("preserves legacy default selection when no ownership migration exists", () => {
    const agents = { list: [{ id: "other", default: true }, { id: "main" }] };
    expect(writeAgentRoster(agents, readAgentRoster(agents))).toBe(false);
    expect(agents.list[0].default).toBe(true);
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
