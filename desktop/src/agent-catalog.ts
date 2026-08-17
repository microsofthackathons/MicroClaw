// Skills available to every catalog agent. This is the union of the bundled and
// installer-managed catalogs and MUST stay in sync with deployer/skill_catalog.py.
export const SHARED_SKILL_IDS: readonly string[] = [
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

// Agent-owned skills ship as dormant desktop resources. They are installed into
// the OpenClaw state directory only when their owning agent is added.
export const AGENT_OWNED_SKILL_IDS: readonly string[] = ["rednote-publisher"];

export const ALL_SKILL_IDS: readonly string[] = [
  ...SHARED_SKILL_IDS.slice(0, 15),
  ...AGENT_OWNED_SKILL_IDS,
  ...SHARED_SKILL_IDS.slice(15),
];

function catalogSkills(...agentOwnedSkillIds: string[]): string[] {
  const owned = new Set(agentOwnedSkillIds);
  return ALL_SKILL_IDS.filter(
    (skillId) => SHARED_SKILL_IDS.includes(skillId) || owned.has(skillId),
  );
}

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
  ownedSkills?: readonly string[];
  workspaceDirName?: string;
  personaProfile?:
    | "master-archive"
    | "code-geek"
    | "dr-pulse"
    | "intel-analyst"
    | "market-sentinel"
    | "creative-muse";
}

export const AGENT_CATALOG: readonly AgentCatalogEntry[] = [
  {
    id: "main",
    name: "Assistant",
    nameKey: "store.defaultAgent",
    descKey: "store.defaultAgentDesc",
    avatar: "main-avatar.png",
    image: "main-avatar.png",
    tagKeys: [],
    taskKeys: [
      { titleKey: "agent.main.task.1.title", descKey: "agent.main.task.1.desc" },
      { titleKey: "agent.main.task.2.title", descKey: "agent.main.task.2.desc" },
      { titleKey: "agent.main.task.3.title", descKey: "agent.main.task.3.desc" },
    ],
    installedByDefault: true,
    skills: catalogSkills(),
  },
  {
    id: "master-archive",
    name: "Master Archive",
    nameKey: "agent.masterArchive.name",
    descKey: "agent.masterArchive.desc",
    avatar: "master-archive-avatar.png",
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
    skills: catalogSkills(),
    workspaceDirName: "workspace-master-archive",
    personaProfile: "master-archive",
  },
  {
    id: "code-geek",
    name: "Code Geek",
    nameKey: "agent.codeGeek.name",
    descKey: "agent.codeGeek.desc",
    avatar: "code-geek-avatar.png",
    image: "Coder.png",
    tagKeys: ["agent.codeGeek.tag.1", "agent.codeGeek.tag.2", "agent.codeGeek.tag.3"],
    taskKeys: [
      { titleKey: "agent.codeGeek.task.1.title", descKey: "agent.codeGeek.task.1.desc" },
      { titleKey: "agent.codeGeek.task.2.title", descKey: "agent.codeGeek.task.2.desc" },
      { titleKey: "agent.codeGeek.task.3.title", descKey: "agent.codeGeek.task.3.desc" },
    ],
    installedByDefault: false,
    skills: catalogSkills(),
    workspaceDirName: "workspace-code-geek",
    personaProfile: "code-geek",
  },
  {
    id: "painter",
    name: "Painter",
    nameKey: "agent.painter.name",
    descKey: "agent.painter.desc",
    avatar: "painter-avatar.png",
    image: "Painter.png",
    tagKeys: ["agent.painter.tag.1", "agent.painter.tag.2", "agent.painter.tag.3"],
    taskKeys: [
      { titleKey: "agent.painter.task.1.title", descKey: "agent.painter.task.1.desc" },
      { titleKey: "agent.painter.task.2.title", descKey: "agent.painter.task.2.desc" },
      { titleKey: "agent.painter.task.3.title", descKey: "agent.painter.task.3.desc" },
    ],
    installedByDefault: false,
    skills: catalogSkills(),
  },
  {
    id: "dr-pulse",
    name: "Dr. Pulse",
    nameKey: "agent.drPulse.name",
    descKey: "agent.drPulse.desc",
    avatar: "dr-pulse-avatar.png",
    image: "Diviner.png",
    tagKeys: ["agent.drPulse.tag.1", "agent.drPulse.tag.2", "agent.drPulse.tag.3"],
    taskKeys: [
      { titleKey: "agent.drPulse.task.1.title", descKey: "agent.drPulse.task.1.desc" },
      { titleKey: "agent.drPulse.task.2.title", descKey: "agent.drPulse.task.2.desc" },
      { titleKey: "agent.drPulse.task.3.title", descKey: "agent.drPulse.task.3.desc" },
    ],
    installedByDefault: false,
    skills: catalogSkills(),
    workspaceDirName: "workspace-dr-pulse",
    personaProfile: "dr-pulse",
  },
  {
    id: "intel-analyst",
    name: "Intel Analyst",
    nameKey: "agent.intelAnalyst.name",
    descKey: "agent.intelAnalyst.desc",
    avatar: "intel-analyst-avatar.png",
    image: "Scientist.png",
    tagKeys: ["agent.intelAnalyst.tag.1", "agent.intelAnalyst.tag.2", "agent.intelAnalyst.tag.3"],
    taskKeys: [
      {
        titleKey: "agent.intelAnalyst.task.1.title",
        descKey: "agent.intelAnalyst.task.1.desc",
      },
      {
        titleKey: "agent.intelAnalyst.task.2.title",
        descKey: "agent.intelAnalyst.task.2.desc",
      },
      {
        titleKey: "agent.intelAnalyst.task.3.title",
        descKey: "agent.intelAnalyst.task.3.desc",
      },
    ],
    installedByDefault: false,
    skills: catalogSkills(),
    workspaceDirName: "workspace-intel-analyst",
    personaProfile: "intel-analyst",
  },
  {
    id: "market-sentinel",
    name: "Market Sentinel",
    nameKey: "agent.marketSentinel.name",
    descKey: "agent.marketSentinel.desc",
    avatar: "market-sentinel-avatar.png",
    image: "stock.png",
    tagKeys: [
      "agent.marketSentinel.tag.1",
      "agent.marketSentinel.tag.2",
      "agent.marketSentinel.tag.3",
    ],
    taskKeys: [
      {
        titleKey: "agent.marketSentinel.task.1.title",
        descKey: "agent.marketSentinel.task.1.desc",
      },
      {
        titleKey: "agent.marketSentinel.task.2.title",
        descKey: "agent.marketSentinel.task.2.desc",
      },
      {
        titleKey: "agent.marketSentinel.task.3.title",
        descKey: "agent.marketSentinel.task.3.desc",
      },
    ],
    installedByDefault: false,
    skills: catalogSkills(),
    workspaceDirName: "workspace-market-sentinel",
    personaProfile: "market-sentinel",
  },
  {
    id: "creative-muse",
    name: "Creative Muse",
    nameKey: "agent.creativeMuse.name",
    descKey: "agent.creativeMuse.desc",
    avatar: "creative-muse-avatar.png",
    image: "CreativeMuse.png",
    tagKeys: ["agent.creativeMuse.tag.1", "agent.creativeMuse.tag.2", "agent.creativeMuse.tag.3"],
    taskKeys: [
      {
        titleKey: "agent.creativeMuse.task.1.title",
        descKey: "agent.creativeMuse.task.1.desc",
      },
      {
        titleKey: "agent.creativeMuse.task.2.title",
        descKey: "agent.creativeMuse.task.2.desc",
      },
      {
        titleKey: "agent.creativeMuse.task.3.title",
        descKey: "agent.creativeMuse.task.3.desc",
      },
    ],
    installedByDefault: false,
    skills: catalogSkills(...AGENT_OWNED_SKILL_IDS),
    ownedSkills: AGENT_OWNED_SKILL_IDS,
    workspaceDirName: "workspace-creative-muse",
    personaProfile: "creative-muse",
  },
];

export const DEFAULT_AGENT_IDS = AGENT_CATALOG.filter((agent) => agent.installedByDefault).map(
  (agent) => agent.id,
);

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
  "rednote-publisher": "Rednote Publisher",
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

export function getAgentOwnedSkillIds(agentId: string): readonly string[] {
  return AGENT_CATALOG.find((entry) => entry.id === agentId)?.ownedSkills ?? [];
}

export const LEGACY_AGENT_ID_ALIASES: Readonly<Record<string, string>> = {
  leopard: "market-sentinel",
  master: "dr-pulse",
  singer: "creative-muse",
};

export function canonicalAgentId(agentId: string): string {
  return LEGACY_AGENT_ID_ALIASES[agentId] ?? agentId;
}

const ALL_SKILL_ID_SET: ReadonlySet<string> = new Set(ALL_SKILL_IDS);
const AGENT_OWNED_SKILL_ID_SET: ReadonlySet<string> = new Set(AGENT_OWNED_SKILL_IDS);

/**
 * Returns true when the given id is one of the known catalog skill ids.
 */
export function isKnownSkillId(skillId: string): boolean {
  return ALL_SKILL_ID_SET.has(skillId);
}

export function isAgentOwnedSkillId(skillId: string): boolean {
  return AGENT_OWNED_SKILL_ID_SET.has(skillId);
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
