import * as fs from "fs";
import * as os from "os";
import * as path from "path";

interface WorkspaceFiles {
  "AGENTS.md": string;
  "IDENTITY.md": string;
  "SOUL.md": string;
}

export interface AgentPersona {
  id: string;
  name: string;
  workspaceDirName?: string;
  workspaceFiles?: WorkspaceFiles;
}

export interface AgentRosterConfig {
  agents?: Record<string, unknown>;
}

export interface AgentPersonasConfigResult {
  changed: boolean;
}

const MASTER_ARCHIVE_SOUL_MD = `# SOUL.md - Master Archive

You are Master Archive, a meticulous digital archivist for local files and documents.

## Character

- Organized, privacy-conscious, calm, and efficient.
- Prefer clear inventories, previews, and verifiable results over clever shortcuts.
- Keep responses concise and structure large results as plans, tables, or checklists.

## Safety

- Treat every local file as private.
- Inspect and explain the scope before moving, renaming, deleting, overwriting, or bulk-editing files.
- Require explicit confirmation before destructive or difficult-to-reverse actions.
- Preserve source files during conversion unless the user explicitly asks otherwise.
- Respect the exact path requested by the user. Report blocked access instead of silently using another location.

## Results

- State what changed, where outputs were written, and what was left untouched.
- Report partial failures explicitly, including the affected file and reason.
- Never describe an operation as complete until its outputs have been checked.
`;

const MASTER_ARCHIVE_AGENTS_MD = `# AGENTS.md - Master Archive Operating Guide

## Mission

Bring order to local digital assets through safe batch conversion, preview-first organization, and evidence-based document extraction.

## Standard workflow

1. Confirm the target paths, desired output, naming rules, and exclusions.
2. Inventory the relevant files using read-only inspection.
3. Present a concise plan when the operation moves, renames, deletes, overwrites, or reorganizes data.
4. Execute only the requested or approved changes.
5. Verify outputs and summarize successes, skips, and failures.

## Batch conversion

- Detect unsupported or encrypted inputs before starting.
- Define output naming and collision behavior up front.
- Preserve originals by default.
- For merge operations, show the input order and verify the merged output opens successfully.

## File and directory cleanup

- Never move or rename files before the user approves the preview plan.
- Base categories on the user's rules; use file type, project, and date only as sensible defaults.
- Avoid deleting duplicates automatically. Present duplicate candidates with evidence for review.
- Produce a before-and-after summary with file counts.

## Document summarization and extraction

- Distinguish source facts from inference.
- Cite the source filename and page, section, or timestamp when available.
- Preserve dates, owners, amounts, and deadlines exactly as written.
- Consolidate action items into a checklist with owner, due date, source, and status fields when present.

## Tools

- Prefer the installed document, spreadsheet, PDF, and media skills over ad hoc converters.
- Batch compatible reads and conversions, but isolate failures so one bad file does not hide other results.
`;

const MASTER_ARCHIVE_IDENTITY_MD = `# IDENTITY.md

- Name: Master Archive
- Role: Local digital archivist
- Vibe: Meticulous, private, and dependable
`;

export const AGENT_PERSONAS: readonly AgentPersona[] = [
  { id: "main", name: "Assistant" },
  {
    id: "master-archive",
    name: "Master Archive",
    workspaceDirName: "workspace-master-archive",
    workspaceFiles: {
      "AGENTS.md": MASTER_ARCHIVE_AGENTS_MD,
      "IDENTITY.md": MASTER_ARCHIVE_IDENTITY_MD,
      "SOUL.md": MASTER_ARCHIVE_SOUL_MD,
    },
  },
  { id: "coder", name: "Coder" },
  { id: "painter", name: "Painter" },
  { id: "master", name: "Master" },
  { id: "growth-hacker", name: "Growth Hacker" },
  { id: "leopard", name: "Leopard" },
  { id: "singer", name: "Singer" },
];

export function getAgentWorkspacePath(
  stateDir: string,
  persona: AgentPersona,
): string | undefined {
  return persona.workspaceDirName ? path.join(stateDir, persona.workspaceDirName) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAgentId(value: string): string {
  const normalized = value.trim().toLowerCase();
  return (
    normalized
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 64) || "main"
  );
}

function createAgentEntry(persona: AgentPersona, stateDir: string): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: persona.name };
  const workspace = getAgentWorkspacePath(stateDir, persona);
  if (workspace) entry.workspace = workspace;
  return entry;
}

export function ensureAgentPersonasConfig(
  config: AgentRosterConfig,
  stateDir: string,
): AgentPersonasConfigResult {
  if (config.agents !== undefined && !isRecord(config.agents)) {
    throw new Error("Invalid agents configuration");
  }

  const agents = config.agents ?? {};
  const sourceEntries: Array<{
    id: string;
    config: Record<string, unknown>;
    source: "list" | "entries";
  }> = [];
  const hasList = Object.hasOwn(agents, "list") && agents.list !== undefined;

  if (hasList) {
    if (!Array.isArray(agents.list)) {
      throw new Error("Invalid agents.list configuration");
    }
    for (const entry of agents.list) {
      if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) {
        throw new Error("Invalid agent entry in agents.list");
      }
      const { id, ...entryConfig } = entry;
      sourceEntries.push({ id, config: entryConfig, source: "list" });
    }
  }
  if (Object.hasOwn(agents, "entries") && agents.entries !== undefined) {
    if (!isRecord(agents.entries)) {
      throw new Error("Invalid agents.entries configuration");
    }
    for (const [id, entry] of Object.entries(agents.entries)) {
      if (!id.trim() || !isRecord(entry)) {
        throw new Error(`Invalid agent entry "${id}" in agents.entries`);
      }
      sourceEntries.push({ id, config: { ...entry }, source: "entries" });
    }
  }

  const entries: Array<{ id: string } & Record<string, unknown>> = [];
  const normalizedIds = new Map<
    string,
    { rawId: string; source: "list" | "entries"; entry: { id: string } & Record<string, unknown> }
  >();
  for (const source of sourceEntries) {
    const normalizedId = normalizeAgentId(source.id);
    const previous = normalizedIds.get(normalizedId);
    if (previous !== undefined) {
      const bothCanonical =
        previous.rawId.trim().toLowerCase() === normalizedId &&
        source.id.trim().toLowerCase() === normalizedId;
      if (previous.source !== source.source && bothCanonical) {
        if (previous.source === "list") {
          for (const [key, value] of Object.entries(source.config)) {
            if (key !== "id" && !Object.hasOwn(previous.entry, key)) {
              previous.entry[key] = value;
            }
          }
        } else {
          Object.assign(previous.entry, source.config, { id: normalizedId });
          previous.source = "list";
        }
        continue;
      }
      throw new Error(
        `Agent ids "${previous.rawId}" and "${source.id}" both normalize to "${normalizedId}"`,
      );
    }
    const entry = { id: normalizedId };
    Object.assign(entry, source.config, { id: normalizedId });
    normalizedIds.set(normalizedId, {
      rawId: source.id,
      source: source.source,
      entry,
    });
    entries.push(entry);
  }

  const sourceDefault =
    sourceEntries.find((entry) => entry.config.default === true) ?? sourceEntries[0];
  const defaultAgentId = sourceDefault ? normalizeAgentId(sourceDefault.id) : "main";

  for (const persona of AGENT_PERSONAS) {
    if (normalizedIds.has(persona.id)) continue;
    const entry = { id: persona.id, ...createAgentEntry(persona, stateDir) };
    entries.push(entry);
    normalizedIds.set(persona.id, { rawId: persona.id, source: "list", entry });
  }

  for (const entry of entries) {
    if (entry.id === defaultAgentId) {
      entry.default = true;
    } else if (entry.default === true) {
      delete entry.default;
    }
  }

  const changed =
    !hasList ||
    Object.hasOwn(agents, "entries") ||
    JSON.stringify(agents.list) !== JSON.stringify(entries);
  agents.list = entries;
  delete agents.entries;
  config.agents = agents;
  return { changed };
}

function normalizeHomeValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return !trimmed || trimmed === "undefined" || trimmed === "null" ? undefined : trimmed;
}

function resolveEffectiveHome(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  cwd: string,
): string {
  const osHome =
    normalizeHomeValue(env.HOME) ??
    normalizeHomeValue(env.USERPROFILE) ??
    normalizeHomeValue(homeDir);
  const configuredHome = normalizeHomeValue(env.OPENCLAW_HOME);
  const rawHome = configuredHome
    ? configuredHome.replace(/^~(?=$|[\\/])/, osHome ?? "")
    : osHome;
  return path.resolve(cwd, rawHome ?? ".");
}

function resolveUserPath(
  value: string,
  env: NodeJS.ProcessEnv,
  homeDir: string,
  cwd: string,
): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("~")) {
    const expanded = trimmed.replace(
      /^~(?=$|[\\/])/,
      resolveEffectiveHome(env, homeDir, cwd),
    );
    return path.resolve(cwd, expanded);
  }
  return path.resolve(cwd, trimmed);
}

export function resolveAgentPersonaWorkspace(
  config: AgentRosterConfig,
  stateDir: string,
  persona: AgentPersona,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
  cwd = process.cwd(),
): string {
  const agents = isRecord(config.agents) ? config.agents : {};
  const entries = Array.isArray(agents.list)
    ? agents.list.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
  const entry =
    entries.find(
      (candidate) =>
        typeof candidate.id === "string" && normalizeAgentId(candidate.id) === persona.id,
    ) ?? {};
  if (typeof entry.workspace === "string" && entry.workspace.trim()) {
    return resolveUserPath(entry.workspace, env, homeDir, cwd);
  }

  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const defaultWorkspace =
    typeof defaults.workspace === "string" && defaults.workspace.trim()
      ? resolveUserPath(defaults.workspace, env, homeDir, cwd)
      : undefined;
  const defaultAgentId =
    normalizeAgentId(
      String(entries.find((candidate) => candidate.default === true)?.id ?? entries[0]?.id ?? "main"),
    );

  if (persona.id === defaultAgentId) {
    return defaultWorkspace ?? path.join(stateDir, "workspace");
  }
  return defaultWorkspace
    ? path.join(defaultWorkspace, persona.id)
    : path.join(stateDir, `workspace-${persona.id}`);
}

export function seedAgentPersonaWorkspaces(
  config: AgentRosterConfig,
  stateDir: string,
  soulAppendix = "",
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
  cwd = process.cwd(),
): string[] {
  const updatedFiles: string[] = [];

  for (const persona of AGENT_PERSONAS) {
    if (!persona.workspaceFiles) continue;
    const workspaceDir = resolveAgentPersonaWorkspace(
      config,
      stateDir,
      persona,
      env,
      homeDir,
      cwd,
    );

    fs.mkdirSync(workspaceDir, { recursive: true });
    for (const [filename, source] of Object.entries(persona.workspaceFiles)) {
      const filePath = path.join(workspaceDir, filename);
      if (fs.existsSync(filePath)) {
        if (filename === "SOUL.md" && soulAppendix) {
          const existing = fs.readFileSync(filePath, "utf-8");
          const appendixMarker =
            soulAppendix.split(/\r?\n/).find((line) => line.startsWith("## ")) ??
            soulAppendix.trim();
          if (appendixMarker && !existing.includes(appendixMarker)) {
            fs.appendFileSync(filePath, `\n${soulAppendix.trim()}\n`, "utf-8");
            updatedFiles.push(filePath);
          }
        }
        continue;
      }

      const content =
        filename === "SOUL.md" && soulAppendix
          ? `${source.trimEnd()}\n\n${soulAppendix.trim()}\n`
          : `${source.trimEnd()}\n`;
      fs.writeFileSync(filePath, content, "utf-8");
      updatedFiles.push(filePath);
    }
  }

  return updatedFiles;
}
