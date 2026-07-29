export interface AgentCatalogEntry {
  id: string;
  name: string;
  nameKey: string;
  descKey: string;
  avatar: string;
  image: string;
  tagKeys: string[];
  taskKeys: Array<{ titleKey: string; descKey: string }>;
  installedByDefault: boolean;
  workspaceDirName?: string;
  personaProfile?: "master-archive";
}

export const AGENT_CATALOG: readonly AgentCatalogEntry[] = [
  {
    id: "main",
    name: "Assistant",
    nameKey: "store.defaultAgent",
    descKey: "store.defaultAgentDesc",
    avatar: "normal.png",
    image: "normal.png",
    tagKeys: [],
    taskKeys: [
      { titleKey: "agent.main.task.1.title", descKey: "agent.main.task.1.desc" },
      { titleKey: "agent.main.task.2.title", descKey: "agent.main.task.2.desc" },
      { titleKey: "agent.main.task.3.title", descKey: "agent.main.task.3.desc" },
    ],
    installedByDefault: true,
  },
  {
    id: "master-archive",
    name: "Master Archive",
    nameKey: "agent.masterArchive.name",
    descKey: "agent.masterArchive.desc",
    avatar: "Archaeologist.png",
    image: "Archaeologist.png",
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
    installedByDefault: false,
    workspaceDirName: "workspace-master-archive",
    personaProfile: "master-archive",
  },
  {
    id: "coder",
    name: "Coder",
    nameKey: "agent.coder.name",
    descKey: "agent.coder.desc",
    avatar: "程序猿.png",
    image: "Coder.png",
    tagKeys: ["agent.coder.tag.1", "agent.coder.tag.2", "agent.coder.tag.3"],
    taskKeys: [
      { titleKey: "agent.coder.task.1.title", descKey: "agent.coder.task.1.desc" },
      { titleKey: "agent.coder.task.2.title", descKey: "agent.coder.task.2.desc" },
      { titleKey: "agent.coder.task.3.title", descKey: "agent.coder.task.3.desc" },
    ],
    installedByDefault: false,
  },
  {
    id: "painter",
    name: "Painter",
    nameKey: "agent.painter.name",
    descKey: "agent.painter.desc",
    avatar: "梵高.png",
    image: "Painter.png",
    tagKeys: ["agent.painter.tag.1", "agent.painter.tag.2", "agent.painter.tag.3"],
    taskKeys: [
      { titleKey: "agent.painter.task.1.title", descKey: "agent.painter.task.1.desc" },
      { titleKey: "agent.painter.task.2.title", descKey: "agent.painter.task.2.desc" },
      { titleKey: "agent.painter.task.3.title", descKey: "agent.painter.task.3.desc" },
    ],
    installedByDefault: false,
  },
  {
    id: "master",
    name: "Master",
    nameKey: "agent.master.name",
    descKey: "agent.master.desc",
    avatar: "大师.png",
    image: "Diviner.png",
    tagKeys: ["agent.master.tag.1", "agent.master.tag.2", "agent.master.tag.3"],
    taskKeys: [
      { titleKey: "agent.master.task.1.title", descKey: "agent.master.task.1.desc" },
      { titleKey: "agent.master.task.2.title", descKey: "agent.master.task.2.desc" },
      { titleKey: "agent.master.task.3.title", descKey: "agent.master.task.3.desc" },
    ],
    installedByDefault: false,
  },
  {
    id: "growth-hacker",
    name: "Growth Hacker",
    nameKey: "agent.growthHacker.name",
    descKey: "agent.growthHacker.desc",
    avatar: "增长黑客.png",
    image: "Scientist.png",
    tagKeys: [
      "agent.growthHacker.tag.1",
      "agent.growthHacker.tag.2",
      "agent.growthHacker.tag.3",
    ],
    taskKeys: [
      {
        titleKey: "agent.growthHacker.task.1.title",
        descKey: "agent.growthHacker.task.1.desc",
      },
      {
        titleKey: "agent.growthHacker.task.2.title",
        descKey: "agent.growthHacker.task.2.desc",
      },
      {
        titleKey: "agent.growthHacker.task.3.title",
        descKey: "agent.growthHacker.task.3.desc",
      },
    ],
    installedByDefault: false,
  },
  {
    id: "leopard",
    name: "Leopard",
    nameKey: "agent.leopard.name",
    descKey: "agent.leopard.desc",
    avatar: "金钱豹.png",
    image: "stock.png",
    tagKeys: ["agent.leopard.tag.1", "agent.leopard.tag.2", "agent.leopard.tag.3"],
    taskKeys: [
      { titleKey: "agent.leopard.task.1.title", descKey: "agent.leopard.task.1.desc" },
      { titleKey: "agent.leopard.task.2.title", descKey: "agent.leopard.task.2.desc" },
      { titleKey: "agent.leopard.task.3.title", descKey: "agent.leopard.task.3.desc" },
    ],
    installedByDefault: false,
  },
  {
    id: "singer",
    name: "Singer",
    nameKey: "agent.singer.name",
    descKey: "agent.singer.desc",
    avatar: "Singer.png",
    image: "Singer.png",
    tagKeys: ["agent.singer.tag.1", "agent.singer.tag.2", "agent.singer.tag.3"],
    taskKeys: [
      { titleKey: "agent.singer.task.1.title", descKey: "agent.singer.task.1.desc" },
      { titleKey: "agent.singer.task.2.title", descKey: "agent.singer.task.2.desc" },
      { titleKey: "agent.singer.task.3.title", descKey: "agent.singer.task.3.desc" },
    ],
    installedByDefault: false,
  },
];

export const DEFAULT_AGENT_IDS = AGENT_CATALOG.filter(
  (agent) => agent.installedByDefault,
).map((agent) => agent.id);
