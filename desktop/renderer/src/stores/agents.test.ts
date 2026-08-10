import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/i18n";
import { useAgentStore } from "./agents";

describe("agent store", () => {
  const agentsList = vi.fn();
  const agentsAdd = vi.fn();
  const agentsRemove = vi.fn();

  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("en-US");
    agentsList.mockReset().mockResolvedValue({ agents: [{ id: "main", name: "Assistant" }] });
    agentsAdd.mockReset();
    agentsRemove.mockReset();
    window.openclaw = {
      agents: {
        list: agentsList,
        add: agentsAdd,
        remove: agentsRemove,
      },
    } as unknown as typeof window.openclaw;
  });

  it("shows only the OpenClaw roster in the sidebar", async () => {
    const store = useAgentStore();

    expect(store.agents.map((agent) => agent.id)).toEqual(["main"]);

    agentsList.mockResolvedValueOnce({
      agents: [
        { id: "main", name: "Assistant" },
        { id: "custom", name: "Custom Agent" },
      ],
    });
    await store.fetchAgents();
    expect(store.agents.map((agent) => agent.id)).toEqual(["main", "custom"]);
  });

  it("adds Master Archive to OpenClaw before showing it in the sidebar", async () => {
    const store = useAgentStore();
    const marketAgent = store.marketAgents.find((entry) => entry.id === "master-archive");

    expect(marketAgent).toMatchObject({
      name: "Master Archive",
      isAdded: false,
      tags: ["File Organization", "Batch Conversion", "Document Digests"],
    });
    expect(marketAgent?.quickTasks).toHaveLength(3);

    agentsAdd.mockResolvedValueOnce({
      agents: [
        { id: "main", name: "Assistant" },
        { id: "master-archive", name: "Master Archive" },
      ],
    });
    await store.addAgent("master-archive");

    expect(agentsAdd).toHaveBeenCalledWith("master-archive");
    expect(store.agents.map((agent) => agent.id)).toEqual(["main", "master-archive"]);
    expect(store.marketAgents.find((agent) => agent.id === "master-archive")?.isAdded).toBe(true);
  });

  it("keeps the roster unchanged when Add fails", async () => {
    const store = useAgentStore();
    agentsAdd.mockRejectedValueOnce(new Error("Gateway restart failed"));

    await expect(store.addAgent("master-archive")).rejects.toThrow("Gateway restart failed");
    expect(store.agents.map((agent) => agent.id)).toEqual(["main"]);
    expect(store.marketAgents.find((agent) => agent.id === "master-archive")?.isAdded).toBe(false);
  });

  it("removes an agent and selects main when the removed agent was active", async () => {
    const store = useAgentStore();
    agentsList.mockResolvedValueOnce({
      agents: [
        { id: "main", name: "Assistant" },
        { id: "master-archive", name: "Master Archive" },
      ],
    });
    await store.fetchAgents();
    store.selectAgent("master-archive");
    agentsRemove.mockResolvedValueOnce({
      agents: [{ id: "main", name: "Assistant" }],
    });

    await store.removeAgent("master-archive");

    expect(agentsRemove).toHaveBeenCalledWith("master-archive");
    expect(store.agents.map((agent) => agent.id)).toEqual(["main"]);
    expect(store.currentAgentId).toBe("main");
    expect(store.marketAgents.find((agent) => agent.id === "master-archive")?.isAdded).toBe(false);
  });

  it("keeps the installed agent when Remove fails", async () => {
    const store = useAgentStore();
    agentsList.mockResolvedValueOnce({
      agents: [
        { id: "main", name: "Assistant" },
        { id: "master-archive", name: "Master Archive" },
      ],
    });
    await store.fetchAgents();
    agentsRemove.mockRejectedValueOnce(new Error("Gateway restart failed"));

    await expect(store.removeAgent("master-archive")).rejects.toThrow("Gateway restart failed");
    expect(store.agents.map((agent) => agent.id)).toEqual(["main", "master-archive"]);
  });

  it("preserves the last real roster when refresh fails", async () => {
    const store = useAgentStore();
    agentsList.mockResolvedValueOnce({
      agents: [{ id: "custom", name: "Custom Agent" }],
    });
    await store.fetchAgents();
    agentsList.mockRejectedValueOnce(new Error("Gateway not connected"));
    await store.fetchAgents();

    expect(store.agents.map((agent) => agent.id)).toEqual(["custom"]);
  });
});
