import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { t, locale } from "../i18n";
import { AGENT_CATALOG, type AgentCatalogEntry } from "../../../src/agent-catalog";

export interface QuickTask {
  title: string;
  desc: string;
}

export interface Agent {
  id: string;
  name: string;
  description?: string;
  avatar?: string;
  image?: string;
  tags?: string[];
  quickTasks?: QuickTask[];
  isAdded?: boolean;
}

interface RuntimeAgent {
  id: string;
  name: string;
  description?: string;
}

// Static import of avatar assets
const avatarModules = import.meta.glob("../assets/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function getAvatarUrl(filename: string): string {
  const key = `../assets/${filename}`;
  return avatarModules[key] || "";
}

/** Resolve a catalog entry into an Agent with translated strings. */
function resolveCatalogAgent(def: AgentCatalogEntry, isAdded: boolean): Agent {
  return {
    id: def.id,
    name: t(def.nameKey),
    description: t(def.descKey),
    avatar: getAvatarUrl(def.avatar),
    image: getAvatarUrl(def.image),
    tags: def.tagKeys.map((k) => t(k)),
    quickTasks: def.taskKeys.map((tk) => ({
      title: t(tk.titleKey),
      desc: t(tk.descKey),
    })),
    isAdded,
  };
}

function normalizeRuntimeAgents(value: unknown): RuntimeAgent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof (candidate as { id?: unknown }).id !== "string"
    ) {
      return [];
    }
    const id = (candidate as { id: string }).id;
    const nameValue = (candidate as { name?: unknown }).name;
    const descriptionValue = (candidate as { description?: unknown }).description;
    return [
      {
        id,
        name: typeof nameValue === "string" && nameValue ? nameValue : id,
        ...(typeof descriptionValue === "string"
          ? { description: descriptionValue }
          : {}),
      },
    ];
  });
}

export const useAgentStore = defineStore("agents", () => {
  const remoteAgents = ref<RuntimeAgent[]>([{ id: "main", name: "Assistant" }]);
  const currentAgentId = ref("main");
  const pendingAgentAdds = new Set<string>();
  const installedAgentIds = computed(() => new Set(remoteAgents.value.map((agent) => agent.id)));

  const agents = computed<Agent[]>(() => {
    void locale.value;
    return remoteAgents.value.map((runtimeAgent) => {
      const catalogAgent = AGENT_CATALOG.find((agent) => agent.id === runtimeAgent.id);
      if (catalogAgent) {
        return resolveCatalogAgent(catalogAgent, true);
      }
      return {
        ...runtimeAgent,
        avatar: getAvatarUrl("normal.png"),
        image: getAvatarUrl("normal.png"),
        isAdded: true,
      };
    });
  });

  const marketAgents = computed(() => {
    void locale.value;
    return AGENT_CATALOG.filter((agent) => agent.id !== "main").map((agent) =>
      resolveCatalogAgent(agent, installedAgentIds.value.has(agent.id)),
    );
  });

  function selectAgent(agentId: string) {
    currentAgentId.value = agentId;
  }

  async function addAgent(agentId: string) {
    if (installedAgentIds.value.has(agentId) || pendingAgentAdds.has(agentId)) return;
    pendingAgentAdds.add(agentId);
    try {
      const result = await window.openclaw.agents.add(agentId);
      if (!Array.isArray(result.agents)) {
        throw new Error("OpenClaw returned an invalid agent roster");
      }
      remoteAgents.value = normalizeRuntimeAgents(result.agents);
    } finally {
      pendingAgentAdds.delete(agentId);
    }
  }

  async function fetchAgents() {
    try {
      const result = await window.openclaw.agents.list();
      if (Array.isArray(result.agents)) {
        remoteAgents.value = normalizeRuntimeAgents(result.agents);
      }
    } catch (error) {
      console.warn("[agents] Failed to refresh gateway agents:", error);
    }
  }

  return {
    agents,
    currentAgentId,
    marketAgents,
    selectAgent,
    addAgent,
    fetchAgents,
  };
});
