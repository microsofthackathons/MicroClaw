import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { t, locale } from "../i18n";
import {
  AGENT_CATALOG,
  DEFAULT_ADDED_AGENT_IDS,
  type AgentCatalogEntry,
} from "../../../src/agent-catalog";

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
function resolveAgent(def: AgentCatalogEntry): Agent {
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
    isAdded: def.defaultAdded,
  };
}

export const useAgentStore = defineStore("agents", () => {
  const agentIsAdded = ref<Record<string, boolean>>(
    Object.fromEntries(AGENT_CATALOG.map((agent) => [agent.id, agent.defaultAdded])),
  );

  const remoteAgents = ref<Agent[]>([]);

  /** Reactively translated agent list — re-evaluates when locale changes. */
  const agents = computed<Agent[]>(() => {
    void locale.value; // explicit dependency on locale for reactivity
    const localAgents = AGENT_CATALOG.map((def) => ({
      ...resolveAgent(def),
      isAdded: agentIsAdded.value[def.id] ?? def.defaultAdded,
    }));
    if (remoteAgents.value.length === 0) return localAgents;
    // The gateway's agents.list only carries id/name, not the rich local
    // metadata (avatars, tags, quick tasks). Keep the local persona for any
    // id we know about and only append genuinely custom remote agents.
    const localIds = new Set(localAgents.map((a) => a.id));
    const extraRemote = remoteAgents.value
      .filter((a) => !localIds.has(a.id))
      .map((agent) => ({ ...agent, isAdded: true }));
    return [...localAgents, ...extraRemote];
  });
  const currentAgentId = ref("main");

  const addedAgents = computed(() => agents.value.filter((a) => a.isAdded));

  const marketAgents = computed(() => agents.value.filter((a) => a.id !== "main"));

  function restoreAddedAgents(agentIds?: string[]) {
    const restoredIds = new Set(Array.isArray(agentIds) ? agentIds : DEFAULT_ADDED_AGENT_IDS);
    agentIsAdded.value = Object.fromEntries(
      AGENT_CATALOG.map((def) => [def.id, def.id === "main" || restoredIds.has(def.id)]),
    );
  }

  async function toggleAgent(agentId: string) {
    if (!(agentId in agentIsAdded.value) || agentId === "main") return;
    const previous = agentIsAdded.value[agentId];
    agentIsAdded.value[agentId] = !previous;
    const addedAgentIds = AGENT_CATALOG.filter((def) => agentIsAdded.value[def.id]).map(
      (def) => def.id,
    );
    try {
      await window.openclaw.settings.set("addedAgentIds", addedAgentIds);
      if (!agentIsAdded.value[agentId] && currentAgentId.value === agentId) {
        currentAgentId.value = "main";
      }
    } catch (error) {
      agentIsAdded.value[agentId] = previous;
      throw error;
    }
  }

  function selectAgent(agentId: string) {
    currentAgentId.value = agentId;
  }

  async function fetchAgents() {
    try {
      const result = await window.openclaw.agents.list();
      remoteAgents.value = Array.isArray(result.agents) ? (result.agents as Agent[]) : [];
    } catch (error) {
      console.warn("[agents] Failed to refresh gateway agents:", error);
    }
  }

  return {
    agents,
    currentAgentId,
    addedAgents,
    marketAgents,
    restoreAddedAgents,
    toggleAgent,
    selectAgent,
    fetchAgents,
  };
});
