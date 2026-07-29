import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { t, locale } from "../i18n";

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

/** Raw agent definition — stores i18n keys, not translated strings. */
interface AgentDef {
  id: string;
  nameKey: string;
  descKey: string;
  avatar: string;
  image: string;
  tagKeys: string[];
  taskKeys: { titleKey: string; descKey: string }[];
  isAdded: boolean;
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

/** Resolve an AgentDef into an Agent with translated strings (reactive via computed). */
function resolveAgent(def: AgentDef): Agent {
  return {
    id: def.id,
    name: t(def.nameKey),
    description: t(def.descKey),
    avatar: def.avatar,
    image: def.image,
    tags: def.tagKeys.map((k) => t(k)),
    quickTasks: def.taskKeys.map((tk) => ({
      title: t(tk.titleKey),
      desc: t(tk.descKey),
    })),
    isAdded: def.isAdded,
  };
}

const AGENT_DEFS: AgentDef[] = [
  {
    id: "main",
    nameKey: "store.defaultAgent",
    descKey: "store.defaultAgentDesc",
    avatar: getAvatarUrl("normal.png"),
    image: getAvatarUrl("normal.png"),
    tagKeys: [],
    taskKeys: [
      { titleKey: "agent.main.task.1.title", descKey: "agent.main.task.1.desc" },
      { titleKey: "agent.main.task.2.title", descKey: "agent.main.task.2.desc" },
      { titleKey: "agent.main.task.3.title", descKey: "agent.main.task.3.desc" },
    ],
    isAdded: true,
  },
  {
    id: "master-archive",
    nameKey: "agent.masterArchive.name",
    descKey: "agent.masterArchive.desc",
    avatar: getAvatarUrl("Archaeologist.png"),
    image: getAvatarUrl("Archaeologist.png"),
    tagKeys: [
      "agent.masterArchive.tag.1",
      "agent.masterArchive.tag.2",
      "agent.masterArchive.tag.3",
    ],
    taskKeys: [
      {
        titleKey: "agent.masterArchive.task.1.title",
        descKey: "agent.masterArchive.task.1.desc",
      },
      {
        titleKey: "agent.masterArchive.task.2.title",
        descKey: "agent.masterArchive.task.2.desc",
      },
      {
        titleKey: "agent.masterArchive.task.3.title",
        descKey: "agent.masterArchive.task.3.desc",
      },
    ],
    isAdded: false,
  },
  {
    id: "coder",
    nameKey: "agent.coder.name",
    descKey: "agent.coder.desc",
    avatar: getAvatarUrl("程序猿.png"),
    image: getAvatarUrl("Coder.png"),
    tagKeys: ["agent.coder.tag.1", "agent.coder.tag.2", "agent.coder.tag.3"],
    taskKeys: [
      { titleKey: "agent.coder.task.1.title", descKey: "agent.coder.task.1.desc" },
      { titleKey: "agent.coder.task.2.title", descKey: "agent.coder.task.2.desc" },
      { titleKey: "agent.coder.task.3.title", descKey: "agent.coder.task.3.desc" },
    ],
    isAdded: true,
  },
  {
    id: "painter",
    nameKey: "agent.painter.name",
    descKey: "agent.painter.desc",
    avatar: getAvatarUrl("梵高.png"),
    image: getAvatarUrl("Painter.png"),
    tagKeys: ["agent.painter.tag.1", "agent.painter.tag.2", "agent.painter.tag.3"],
    taskKeys: [
      { titleKey: "agent.painter.task.1.title", descKey: "agent.painter.task.1.desc" },
      { titleKey: "agent.painter.task.2.title", descKey: "agent.painter.task.2.desc" },
      { titleKey: "agent.painter.task.3.title", descKey: "agent.painter.task.3.desc" },
    ],
    isAdded: false,
  },
  {
    id: "master",
    nameKey: "agent.master.name",
    descKey: "agent.master.desc",
    avatar: getAvatarUrl("大师.png"),
    image: getAvatarUrl("Diviner.png"),
    tagKeys: ["agent.master.tag.1", "agent.master.tag.2", "agent.master.tag.3"],
    taskKeys: [
      { titleKey: "agent.master.task.1.title", descKey: "agent.master.task.1.desc" },
      { titleKey: "agent.master.task.2.title", descKey: "agent.master.task.2.desc" },
      { titleKey: "agent.master.task.3.title", descKey: "agent.master.task.3.desc" },
    ],
    isAdded: false,
  },
  {
    id: "growth-hacker",
    nameKey: "agent.growthHacker.name",
    descKey: "agent.growthHacker.desc",
    avatar: getAvatarUrl("增长黑客.png"),
    image: getAvatarUrl("Scientist.png"),
    tagKeys: ["agent.growthHacker.tag.1", "agent.growthHacker.tag.2", "agent.growthHacker.tag.3"],
    taskKeys: [
      { titleKey: "agent.growthHacker.task.1.title", descKey: "agent.growthHacker.task.1.desc" },
      { titleKey: "agent.growthHacker.task.2.title", descKey: "agent.growthHacker.task.2.desc" },
      { titleKey: "agent.growthHacker.task.3.title", descKey: "agent.growthHacker.task.3.desc" },
    ],
    isAdded: false,
  },
  {
    id: "leopard",
    nameKey: "agent.leopard.name",
    descKey: "agent.leopard.desc",
    avatar: getAvatarUrl("金钱豹.png"),
    image: getAvatarUrl("stock.png"),
    tagKeys: ["agent.leopard.tag.1", "agent.leopard.tag.2", "agent.leopard.tag.3"],
    taskKeys: [
      { titleKey: "agent.leopard.task.1.title", descKey: "agent.leopard.task.1.desc" },
      { titleKey: "agent.leopard.task.2.title", descKey: "agent.leopard.task.2.desc" },
      { titleKey: "agent.leopard.task.3.title", descKey: "agent.leopard.task.3.desc" },
    ],
    isAdded: false,
  },
  {
    id: "singer",
    nameKey: "agent.singer.name",
    descKey: "agent.singer.desc",
    avatar: getAvatarUrl("Singer.png"),
    image: getAvatarUrl("Singer.png"),
    tagKeys: ["agent.singer.tag.1", "agent.singer.tag.2", "agent.singer.tag.3"],
    taskKeys: [
      { titleKey: "agent.singer.task.1.title", descKey: "agent.singer.task.1.desc" },
      { titleKey: "agent.singer.task.2.title", descKey: "agent.singer.task.2.desc" },
      { titleKey: "agent.singer.task.3.title", descKey: "agent.singer.task.3.desc" },
    ],
    isAdded: false,
  },
];

const DEFAULT_ADDED_AGENT_IDS = AGENT_DEFS.filter((def) => def.isAdded).map((def) => def.id);

export const useAgentStore = defineStore("agents", () => {
  const agentIsAdded = ref<Record<string, boolean>>(
    Object.fromEntries(AGENT_DEFS.map((d) => [d.id, d.isAdded])),
  );

  const remoteAgents = ref<Agent[]>([]);

  /** Reactively translated agent list — re-evaluates when locale changes. */
  const agents = computed<Agent[]>(() => {
    void locale.value; // explicit dependency on locale for reactivity
    const localAgents = AGENT_DEFS.map((def) => ({
      ...resolveAgent(def),
      isAdded: agentIsAdded.value[def.id] ?? def.isAdded,
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
      AGENT_DEFS.map((def) => [def.id, def.id === "main" || restoredIds.has(def.id)]),
    );
  }

  async function toggleAgent(agentId: string) {
    if (!(agentId in agentIsAdded.value) || agentId === "main") return;
    const previous = agentIsAdded.value[agentId];
    agentIsAdded.value[agentId] = !previous;
    const addedAgentIds = AGENT_DEFS.filter((def) => agentIsAdded.value[def.id]).map(
      (def) => def.id,
    );
    try {
      await window.openclaw.settings.set("addedAgentIds", addedAgentIds);
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
