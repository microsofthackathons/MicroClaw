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

export const useAgentStore = defineStore("agents", () => {
  const agentIsAdded = ref<Record<string, boolean>>(
    Object.fromEntries(AGENT_DEFS.map((d) => [d.id, d.isAdded])),
  );

  const remoteAgents = ref<Agent[]>([]);

  /** Reactively translated agent list — re-evaluates when locale changes. */
  const agents = computed<Agent[]>(() => {
    void locale.value; // explicit dependency on locale for reactivity
    if (remoteAgents.value.length > 0) return remoteAgents.value;
    return AGENT_DEFS.map((def) => ({
      ...resolveAgent(def),
      isAdded: agentIsAdded.value[def.id] ?? def.isAdded,
    }));
  });
  const currentAgentId = ref("main");

  const addedAgents = computed(() => agents.value.filter((a) => a.isAdded));

  const marketAgents = computed(() => agents.value.filter((a) => a.id !== "main"));

  function toggleAgent(agentId: string) {
    if (agentId in agentIsAdded.value) {
      agentIsAdded.value[agentId] = !agentIsAdded.value[agentId];
    }
  }

  function selectAgent(agentId: string) {
    currentAgentId.value = agentId;
  }

  async function fetchAgents() {
    try {
      const result = await window.openclaw.agents.list();
      if (result.agents && result.agents.length > 0) {
        remoteAgents.value = result.agents as Agent[];
      }
    } catch {
      // Gateway may not support agents.list yet — keep defaults
    }
  }

  return {
    agents,
    currentAgentId,
    addedAgents,
    marketAgents,
    toggleAgent,
    selectAgent,
    fetchAgents,
  };
});
