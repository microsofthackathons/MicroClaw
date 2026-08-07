// The complete universe of skill IDs shipped by MicroClaw: the union of the
// certified/bundled skills (SKILL_CATALOG) and the managed skills
// (MANAGED_SKILL_CATALOG), alphabetically sorted. This MUST be kept in sync with
// `deployer/skill_catalog.py` (SKILL_CATALOG + MANAGED_SKILL_CATALOG) — adding or
// removing a skill there requires the same change here.
export const ALL_SKILL_IDS: readonly string[] = [
  "1password",
  "blucli",
  "canvas",
  "coding-agent",
  "desktop-organizer",
  "excel-xlsx",
  "healthcheck",
  "mcporter",
  "nano-pdf",
  "obsidian",
  "officecli",
  "openai-whisper",
  "openhue",
  "oracle",
  "powerpoint-pptx",
  "security-practice",
  "session-logs",
  "sherpa-onnx-tts",
  "skill-creator",
  "songsee",
  "sonoscli",
  "video-frames",
  "word-docx",
];

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
  skills: readonly string[];
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
    skills: [...ALL_SKILL_IDS],
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
    skills: [...ALL_SKILL_IDS],
    workspaceDirName: "workspace-master-archive",
    personaProfile: "master-archive",
  },
  {
    id: "code-geek",
    name: "Code Geek",
    nameKey: "agent.codeGeek.name",
    descKey: "agent.codeGeek.desc",
    avatar: "程序猿.png",
    image: "Coder.png",
    tagKeys: ["agent.codeGeek.tag.1", "agent.codeGeek.tag.2", "agent.codeGeek.tag.3"],
    taskKeys: [
      { titleKey: "agent.codeGeek.task.1.title", descKey: "agent.codeGeek.task.1.desc" },
      { titleKey: "agent.codeGeek.task.2.title", descKey: "agent.codeGeek.task.2.desc" },
      { titleKey: "agent.codeGeek.task.3.title", descKey: "agent.codeGeek.task.3.desc" },
    ],
    installedByDefault: false,
    skills: [...ALL_SKILL_IDS],
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
    skills: [...ALL_SKILL_IDS],
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
    skills: [...ALL_SKILL_IDS],
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
    skills: [...ALL_SKILL_IDS],
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
    skills: [...ALL_SKILL_IDS],
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
    skills: [...ALL_SKILL_IDS],
  },
];

export const DEFAULT_AGENT_IDS = AGENT_CATALOG.filter(
  (agent) => agent.installedByDefault,
).map((agent) => agent.id);

// OpenClaw's runtime filters the per-agent allowlist (config.agents.list[*].skills)
// against each skill's FRONTMATTER `name:` field — NOT its directory slug/skillKey
// (see openclaw dist workspace bundle: `filtered.filter(entry => allowed.has(entry.skill.name))`).
// For most skills the frontmatter `name:` equals the slug, so they bind either way. The
// entries below are the ONLY skills whose installed frontmatter `name:` differs from the
// slug; without remapping them, they are silently excluded from an agent even when eligible.
//
// SYNC: each value here MUST match the exact `name:` field in the corresponding installed
// skill's SKILL.md frontmatter. Keep this map limited to the differing cases.
//
// NOTE: `canvas` is present in ALL_SKILL_IDS (kept in sync with deployer/skill_catalog.py)
// but resolves to no installed skill on any known host — it is a phantom that matches
// nothing. It is intentionally left in ALL_SKILL_IDS; removing it is out of scope.
export const SKILL_MATCH_NAMES: Readonly<Record<string, string>> = {
  "desktop-organizer": "Desktop Organizer",
  "excel-xlsx": "Excel / XLSX",
  "powerpoint-pptx": "Powerpoint / PPTX",
  "security-practice": "Security Practice",
  "word-docx": "Word / DOCX",
};

/**
 * Resolves catalog slugs to the match-names OpenClaw's runtime expects in the
 * per-agent allowlist. Slugs without a mapping pass through unchanged. Call this
 * ONLY at the moment of writing openclaw.json — the renderer/UI and IPC input stay
 * slug-based.
 */
export function resolveSkillFilterNames(ids: readonly string[]): string[] {
  return ids.map((id) => SKILL_MATCH_NAMES[id] ?? id);
}

/**
 * Returns true when a value stored in config.agents.list[*].skills corresponds to
 * the given catalog slug. Matches EITHER the raw slug (older config written before
 * the name remap) OR the mapped match-name (current config), so round-trip reads
 * recognize both forms.
 */
export function matchesSkill(storedValue: string, slug: string): boolean {
  return storedValue === slug || storedValue === SKILL_MATCH_NAMES[slug];
}

/**
 * Returns the skill IDs bound to the given agent, or an empty array if the agent
 * id is not present in AGENT_CATALOG.
 */
export function getAgentSkills(agentId: string): readonly string[] {
  const agent = AGENT_CATALOG.find((entry) => entry.id === agentId);
  return agent ? agent.skills : [];
}

const ALL_SKILL_ID_SET: ReadonlySet<string> = new Set(ALL_SKILL_IDS);

/**
 * Returns true when the given id is one of the known catalog skill ids.
 */
export function isKnownSkillId(skillId: string): boolean {
  return ALL_SKILL_ID_SET.has(skillId);
}

/**
 * Validates and normalizes a requested list of skill ids into a sorted,
 * de-duplicated array of known catalog skill ids. Throws when the input is not
 * an array, contains non-string / empty entries, or references an unknown id.
 */
export function sanitizeAgentSkillIds(skillIds: readonly string[]): string[] {
  if (!Array.isArray(skillIds)) {
    throw new Error("skillIds must be an array");
  }
  const unique = new Set<string>();
  for (const skillId of skillIds) {
    if (typeof skillId !== "string" || skillId.length === 0) {
      throw new Error("skillIds must contain only non-empty strings");
    }
    if (!ALL_SKILL_ID_SET.has(skillId)) {
      throw new Error(`Unknown skill id: ${skillId}`);
    }
    unique.add(skillId);
  }
  return [...unique].sort();
}
