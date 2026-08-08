import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentSkills, matchesSkill, resolveSkillFilterNames } from "./agent-catalog";
import {
  AGENT_PERSONAS,
  DEFAULT_AGENT_PERSONAS,
  ensureAgentPersonasConfig,
  getAgentPersona,
  getAgentWorkspacePath,
  listConfiguredAgents,
  removeConfiguredAgent,
  resolveAgentPersonaWorkspace,
  seedAgentPersonaWorkspaces,
} from "./agent-personas";

const tempDirs: string[] = [];

function createStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-agent-personas-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type AgentListEntry = { id: string; skills?: readonly string[] } & Record<string, unknown>;

function agentList(config: { agents?: unknown }): AgentListEntry[] {
  const agents = (config.agents ?? {}) as { list?: unknown };
  return (Array.isArray(agents.list) ? agents.list : []) as AgentListEntry[];
}

describe("agent personas", () => {
  it("registers only main for a new installation", () => {
    const stateDir = createStateDir();
    const config = { agents: { defaults: { model: "custom/model" } } };

    expect(ensureAgentPersonasConfig(config, stateDir).changed).toBe(true);
    expect(listConfiguredAgents(config)).toEqual([{ id: "main", name: "Assistant" }]);
    expect(ensureAgentPersonasConfig(config, stateDir).changed).toBe(false);
  });

  it("migrates unsupported entries data back to the runtime list", () => {
    const stateDir = createStateDir();
    const agents: Record<string, unknown> = {
      entries: {
        main: { name: "Existing Assistant", default: true },
      },
    };
    const config = {
      agents,
    };

    expect(ensureAgentPersonasConfig(config, stateDir).changed).toBe(true);
    expect(agents).not.toHaveProperty("entries");
    expect(listConfiguredAgents(config)).toEqual([{ id: "main", name: "Existing Assistant" }]);
  });

  it("preserves the effective legacy default and removes extra default markers", () => {
    const stateDir = createStateDir();
    const config = {
      agents: {
        list: [
          { id: "Coder", name: "Coder", default: true },
          { id: "MAIN", name: "Assistant", default: true },
        ],
      },
    };

    ensureAgentPersonasConfig(config, stateDir);

    expect(config.agents.list.find((entry) => entry.id === "coder")).toMatchObject({
      default: true,
    });
    expect(config.agents.list.find((entry) => entry.id === "main")).not.toHaveProperty("default");
  });

  it("rejects normalized id collisions without rewriting the legacy roster", () => {
    const stateDir = createStateDir();
    const list = [
      { id: "Code Geek", name: "First" },
      { id: "code-geek", name: "Second" },
    ];
    const config = { agents: { list } };

    expect(() => ensureAgentPersonasConfig(config, stateDir)).toThrow(
      'both normalize to "code-geek"',
    );
    expect(config.agents).toEqual({ list });
  });

  it("merges preview-only entries without overriding the runtime list", () => {
    const stateDir = createStateDir();
    const config = {
      agents: {
        list: [{ id: "main", name: "Runtime Assistant", default: true }],
        entries: {
          main: { name: "Preview Assistant", workspace: "preview-main" },
          analyst: { name: "Analyst", workspace: "preview-analyst" },
        },
      },
    };

    ensureAgentPersonasConfig(config, stateDir);

    expect(config.agents).not.toHaveProperty("entries");
    expect(config.agents.list.find((entry) => entry.id === "main")).toMatchObject({
      name: "Runtime Assistant",
      workspace: "preview-main",
      default: true,
    });
    expect(config.agents.list.find((entry) => entry.id === "analyst")).toMatchObject({
      name: "Analyst",
      workspace: "preview-analyst",
    });
  });

  it("seeds the Master Archive workspace with its operating context", () => {
    const stateDir = createStateDir();
    const config = { agents: {} };
    const persona = getAgentPersona("master-archive");
    if (!persona) throw new Error("Master Archive persona is not registered");
    ensureAgentPersonasConfig(config, stateDir, [...DEFAULT_AGENT_PERSONAS, persona]);
    expect(listConfiguredAgents(config).map((agent) => agent.id)).toEqual([
      "main",
      "master-archive",
    ]);
    const created = seedAgentPersonaWorkspaces(config, stateDir, "## Shared safety rule");
    const workspace = getAgentWorkspacePath(stateDir, persona);
    if (!workspace) throw new Error("Master Archive workspace is not configured");

    expect(workspace).toBe(path.join(stateDir, "workspace-master-archive"));
    expect(created).toHaveLength(5);
    expect(fs.readFileSync(path.join(workspace, "SOUL.md"), "utf-8")).toContain(
      "## Shared safety rule",
    );
    expect(fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf-8")).toContain(
      "Never move or rename files before the user approves",
    );
    expect(fs.readFileSync(path.join(workspace, "IDENTITY.md"), "utf-8")).toContain(
      "Name: Master Archive",
    );
  });

  it("does not seed a Popular Agent before it is installed", () => {
    const stateDir = createStateDir();
    const config = { agents: {} };
    ensureAgentPersonasConfig(config, stateDir);

    expect(seedAgentPersonaWorkspaces(config, stateDir)).toEqual([
      path.join(stateDir, "workspace", "IDENTITY.md"),
      path.join(stateDir, "workspace", "SOUL.md"),
    ]);
    expect(fs.existsSync(path.join(stateDir, "workspace-master-archive"))).toBe(false);
  });

  it("seeds a user-nameable MicroClaw identity for main", () => {
    const stateDir = createStateDir();
    const config = { agents: {} };
    ensureAgentPersonasConfig(config, stateDir);

    expect(seedAgentPersonaWorkspaces(config, stateDir)).toEqual([
      path.join(stateDir, "workspace", "IDENTITY.md"),
      path.join(stateDir, "workspace", "SOUL.md"),
    ]);
    const identity = fs.readFileSync(path.join(stateDir, "workspace", "IDENTITY.md"), "utf-8");
    expect(identity).toContain("the user may choose one");
    expect(identity).toContain("assistant in MicroClaw");
    expect(identity).toContain('Never identify yourself as "OpenClaw"');
    const soul = fs.readFileSync(path.join(stateDir, "workspace", "SOUL.md"), "utf-8");
    expect(soul).toContain("## Platform Identity");
    expect(soul).toContain("OpenClaw is only the underlying agent runtime");
    expect(soul).toContain('Never introduce yourself as OpenClaw or as an assistant "in OpenClaw"');
  });

  it("replaces the unconfigured identity template but preserves a chosen name", () => {
    const stateDir = createStateDir();
    const config = { agents: {} };
    ensureAgentPersonasConfig(config, stateDir);
    const workspace = path.join(stateDir, "workspace");
    const identityPath = path.join(workspace, "IDENTITY.md");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(
      identityPath,
      `# IDENTITY.md - Who Am I?

_Fill this in during your first conversation. Make it yours._

- **Name:**
  _(pick something you like)_
- **Creature:**
  _(AI? robot? familiar?)_
`,
      "utf-8",
    );

    expect(seedAgentPersonaWorkspaces(config, stateDir)).toEqual([
      identityPath,
      path.join(workspace, "SOUL.md"),
    ]);
    expect(fs.readFileSync(identityPath, "utf-8")).toContain("assistant in MicroClaw");

    fs.writeFileSync(
      identityPath,
      `# IDENTITY.md - Who Am I?

_Fill this in during your first conversation. Make it yours._

- **Name:** Nova
- **Creature:**
  _(AI? robot? familiar?)_
`,
      "utf-8",
    );

    expect(seedAgentPersonaWorkspaces(config, stateDir)).toEqual([]);
    expect(fs.readFileSync(identityPath, "utf-8")).toContain("**Name:** Nova");
  });

  it("adds the MicroClaw platform identity without replacing a customized main soul", () => {
    const stateDir = createStateDir();
    const config = { agents: {} };
    ensureAgentPersonasConfig(config, stateDir);
    const workspace = path.join(stateDir, "workspace");
    const identityPath = path.join(workspace, "IDENTITY.md");
    const soulPath = path.join(workspace, "SOUL.md");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(soulPath, "# Custom Soul\n\nKeep this personality.\n", "utf-8");

    expect(seedAgentPersonaWorkspaces(config, stateDir)).toEqual([identityPath, soulPath]);
    const migrated = fs.readFileSync(soulPath, "utf-8");
    expect(migrated).toContain("Keep this personality.");
    expect(migrated).toContain("## Platform Identity");
    expect(seedAgentPersonaWorkspaces(config, stateDir)).toEqual([]);
    expect(fs.readFileSync(soulPath, "utf-8").match(/## Platform Identity/g)).toHaveLength(1);
  });

  it("removes a configured optional agent without changing its workspace data", () => {
    const stateDir = createStateDir();
    const workspace = path.join(stateDir, "workspace-master-archive");
    fs.mkdirSync(workspace);
    const soulPath = path.join(workspace, "SOUL.md");
    fs.writeFileSync(soulPath, "custom persona\n", "utf-8");
    const config = {
      agents: {
        defaults: { model: "custom/model" },
        list: [
          { id: "main", name: "Assistant", default: true },
          { id: "master-archive", name: "Master Archive", workspace },
        ],
      },
    };

    expect(removeConfiguredAgent(config, "master-archive").changed).toBe(true);
    expect(config.agents.defaults).toEqual({ model: "custom/model" });
    expect(config.agents.list).toEqual([{ id: "main", name: "Assistant", default: true }]);
    expect(fs.readFileSync(soulPath, "utf-8")).toBe("custom persona\n");
    expect(removeConfiguredAgent(config, "master-archive").changed).toBe(false);
  });

  it("does not allow the built-in default agent to be removed", () => {
    const config = {
      agents: {
        list: [{ id: "main", name: "Assistant", default: true }],
      },
    };

    expect(() => removeConfiguredAgent(config, "MAIN")).toThrow(
      'Default agent "main" cannot be removed',
    );
    expect(config.agents.list).toHaveLength(1);
  });

  it("makes main the default when removing a legacy default agent", () => {
    const config = {
      agents: {
        list: [
          { id: "coder", name: "Coder", default: true },
          { id: "main", name: "Assistant" },
        ],
      },
    };

    removeConfiguredAgent(config, "coder");

    expect(config.agents.list).toEqual([{ id: "main", name: "Assistant", default: true }]);
  });

  it("does not overwrite user-customized workspace files", () => {
    const stateDir = createStateDir();
    const customWorkspace = path.join(stateDir, "custom-archive");
    const config = {
      agents: {
        list: [
          { id: "main", default: true },
          { id: "master-archive", workspace: customWorkspace },
        ],
      },
    };
    ensureAgentPersonasConfig(config, stateDir);
    seedAgentPersonaWorkspaces(config, stateDir, "## Required appendix");
    const soulPath = path.join(customWorkspace, "SOUL.md");
    fs.writeFileSync(soulPath, "custom persona\n", "utf-8");

    const updated = seedAgentPersonaWorkspaces(config, stateDir, "## Required appendix");

    expect(updated).toEqual([soulPath]);
    expect(fs.readFileSync(soulPath, "utf-8")).toBe("custom persona\n\n## Required appendix\n");
    expect(
      resolveAgentPersonaWorkspace(config, stateDir, AGENT_PERSONAS[1], {}, stateDir, stateDir),
    ).toBe(customWorkspace);
  });

  it("matches OpenClaw home and gateway cwd path resolution", () => {
    const stateDir = createStateDir();
    const gatewayCwd = path.join(stateDir, "gateway");
    const openClawHome = path.join(stateDir, "openclaw-home");
    const config = {
      agents: {
        list: [
          { id: "main", default: true },
          { id: "master-archive", workspace: "~/archive" },
        ],
      },
    };
    ensureAgentPersonasConfig(config, stateDir);

    expect(
      resolveAgentPersonaWorkspace(
        config,
        stateDir,
        AGENT_PERSONAS[1],
        { OPENCLAW_HOME: openClawHome },
        path.join(stateDir, "os-home"),
        gatewayCwd,
      ),
    ).toBe(path.join(openClawHome, "archive"));
  });

  it("writes each generated agent's catalog skills into agents.list", () => {
    const stateDir = createStateDir();
    const persona = getAgentPersona("master-archive");
    if (!persona) throw new Error("Master Archive persona is not registered");
    const config = { agents: {} };

    ensureAgentPersonasConfig(config, stateDir, [...DEFAULT_AGENT_PERSONAS, persona]);

    for (const entry of agentList(config)) {
      // Config stores OpenClaw match-names, not raw catalog slugs.
      expect(entry.skills).toEqual(resolveSkillFilterNames(getAgentSkills(entry.id)));
    }
  });

  it("writes OpenClaw match-names (not slugs) for remapped skills", () => {
    const stateDir = createStateDir();
    const config = { agents: {} };

    ensureAgentPersonasConfig(config, stateDir);

    const mainEntry = agentList(config).find((entry) => entry.id === "main");
    const skills = (mainEntry?.skills ?? []) as string[];
    // The five display-name exceptions must be stored by their frontmatter name.
    expect(skills).toContain("Excel / XLSX");
    expect(skills).toContain("Word / DOCX");
    expect(skills).toContain("Powerpoint / PPTX");
    expect(skills).toContain("Desktop Organizer");
    expect(skills).toContain("Security Practice");
    // Their raw slugs must NOT appear.
    expect(skills).not.toContain("excel-xlsx");
    expect(skills).not.toContain("word-docx");
    // Non-exception slugs pass through unchanged.
    expect(skills).toContain("1password");
    // Every stored value round-trips back to a catalog slug via matchesSkill.
    for (const slug of getAgentSkills("main")) {
      expect(skills.some((value) => matchesSkill(value, slug))).toBe(true);
    }
  });

  it("gives each agent a distinct skills array instance", () => {
    const stateDir = createStateDir();
    const persona = getAgentPersona("master-archive");
    if (!persona) throw new Error("Master Archive persona is not registered");
    const config = { agents: {} };

    ensureAgentPersonasConfig(config, stateDir, [...DEFAULT_AGENT_PERSONAS, persona]);

    const mainEntry = agentList(config).find((entry) => entry.id === "main");
    const archiveEntry = agentList(config).find((entry) => entry.id === "master-archive");
    if (!mainEntry || !archiveEntry) throw new Error("expected both agents");

    expect(mainEntry.skills).not.toBe(archiveEntry.skills);
    (mainEntry.skills as string[]).push("mutated");
    expect(archiveEntry.skills).not.toContain("mutated");
    expect(getAgentSkills("master-archive")).not.toContain("mutated");
    expect(getAgentSkills("main")).not.toContain("mutated");
  });

  it("preserves an existing skills value for a catalog-known agent", () => {
    const stateDir = createStateDir();
    const config = {
      agents: {
        list: [{ id: "main", name: "Assistant", default: true, skills: ["stale-skill"] }],
      },
    };

    const result = ensureAgentPersonasConfig(config, stateDir);

    const mainEntry = agentList(config).find((entry) => entry.id === "main");
    expect(mainEntry?.skills).toEqual(["stale-skill"]);
    expect(result.changed).toBe(false);
  });

  it("leaves a custom non-catalog agent without an injected skills field", () => {
    const stateDir = createStateDir();
    const config = {
      agents: {
        list: [
          { id: "main", name: "Assistant", default: true },
          { id: "custom-bot", name: "Custom Bot" },
        ],
      },
    };

    ensureAgentPersonasConfig(config, stateDir);

    const customEntry = agentList(config).find((entry) => entry.id === "custom-bot");
    expect(customEntry).not.toHaveProperty("skills");
    const mainEntry = agentList(config).find((entry) => entry.id === "main");
    expect(mainEntry?.skills).toEqual(resolveSkillFilterNames(getAgentSkills("main")));
  });

  it("reports changed when skills are added to a config that lacked them", () => {
    const stateDir = createStateDir();
    const config = {
      agents: {
        list: [{ id: "main", name: "Assistant", default: true }],
      },
    };

    expect(ensureAgentPersonasConfig(config, stateDir).changed).toBe(true);
    expect(ensureAgentPersonasConfig(config, stateDir).changed).toBe(false);
  });
});
