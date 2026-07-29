import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/i18n";
import { useAgentStore } from "./agents";

describe("agent store", () => {
  const settingsSet = vi.fn();
  const agentsList = vi.fn();

  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("en-US");
    settingsSet.mockReset().mockResolvedValue(undefined);
    agentsList.mockReset().mockResolvedValue({ agents: [] });
    window.openclaw = {
      settings: { set: settingsSet },
      agents: { list: agentsList },
    } as unknown as typeof window.openclaw;
  });

  it("offers and persists Master Archive as an addable specialist agent", async () => {
    const store = useAgentStore();
    const agent = store.marketAgents.find((entry) => entry.id === "master-archive");

    expect(agent).toMatchObject({
      name: "Master Archive",
      isAdded: false,
      tags: ["File Organization", "Batch Conversion", "Document Digests"],
    });
    expect(agent?.quickTasks).toHaveLength(3);

    await store.toggleAgent("master-archive");

    expect(store.addedAgents.some((entry) => entry.id === "master-archive")).toBe(true);
    expect(settingsSet).toHaveBeenCalledWith(
      "addedAgentIds",
      expect.arrayContaining(["main", "coder", "master-archive"]),
    );
  });

  it("restores saved selections and clears stale remote agents", async () => {
    const store = useAgentStore();
    store.restoreAddedAgents(["main", "master-archive"]);

    expect(store.addedAgents.map((agent) => agent.id)).toEqual(["main", "master-archive"]);

    agentsList.mockResolvedValueOnce({ agents: [{ id: "custom", name: "Custom" }] });
    await store.fetchAgents();
    expect(store.agents.some((agent) => agent.id === "custom")).toBe(true);

    agentsList.mockRejectedValueOnce(new Error("Gateway not connected"));
    await store.fetchAgents();
    expect(store.agents.some((agent) => agent.id === "custom")).toBe(true);

    agentsList.mockResolvedValueOnce({ agents: [] });
    await store.fetchAgents();
    expect(store.agents.some((agent) => agent.id === "custom")).toBe(false);
  });

  it("falls back to main when the active agent is removed", async () => {
    const store = useAgentStore();
    store.restoreAddedAgents(["main", "master-archive"]);
    store.selectAgent("master-archive");

    await store.toggleAgent("master-archive");

    expect(store.currentAgentId).toBe("main");
    expect(store.addedAgents.map((agent) => agent.id)).toEqual(["main"]);
  });
});
