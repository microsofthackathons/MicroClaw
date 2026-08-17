import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentSkills, matchesSkill, resolveSkillFilterNames } from "./agent-catalog";
import {
  AGENT_PERSONAS,
  DEFAULT_AGENT_PERSONAS,
  CREATIVE_MUSE_LEGACY_PIPELINE_MARKER,
  CREATIVE_MUSE_PIPELINE_SECTION,
  ensureAgentPersonasConfig,
  getAgentPersona,
  getAgentWorkspacePath,
  listConfiguredAgents,
  MARKET_SENTINEL_FINANCIAL_BOUNDARY_SECTION,
  MARKET_SENTINEL_OPERATING_BOUNDARY_SECTION,
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
    ensureAgentPersonasConfig(config, stateDir);
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

  it("seeds the Code Geek workspace with its engineering context", () => {
    const stateDir = createStateDir();
    const config = { agents: {} };
    const persona = getAgentPersona("code-geek");
    if (!persona) throw new Error("Code Geek persona is not registered");
    ensureAgentPersonasConfig(config, stateDir, [...DEFAULT_AGENT_PERSONAS, persona]);
    expect(listConfiguredAgents(config)).toContainEqual({
      id: "code-geek",
      name: "Code Geek",
    });
    const created = seedAgentPersonaWorkspaces(config, stateDir, "## Shared safety rule");
    const workspace = getAgentWorkspacePath(stateDir, persona);
    if (!workspace) throw new Error("Code Geek workspace is not configured");

    expect(workspace).toBe(path.join(stateDir, "workspace-code-geek"));
    expect(created).toHaveLength(5);
    expect(fs.readFileSync(path.join(workspace, "SOUL.md"), "utf-8")).toContain(
      "sharp, pragmatic software engineer",
    );
    expect(fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf-8")).toContain(
      "Separate root causes from cascading errors",
    );
    expect(fs.readFileSync(path.join(workspace, "IDENTITY.md"), "utf-8")).toContain(
      "Name: Code Geek",
    );
  });

  it("seeds the Intel Analyst workspace with its research context", () => {
    const stateDir = createStateDir();
    const config = { agents: {} };
    const persona = getAgentPersona("intel-analyst");
    if (!persona) throw new Error("Intel Analyst persona is not registered");
    ensureAgentPersonasConfig(config, stateDir, [...DEFAULT_AGENT_PERSONAS, persona]);
    expect(listConfiguredAgents(config)).toContainEqual({
      id: "intel-analyst",
      name: "Intel Analyst",
    });
    const created = seedAgentPersonaWorkspaces(config, stateDir, "## Shared safety rule");
    const workspace = getAgentWorkspacePath(stateDir, persona);
    if (!workspace) throw new Error("Intel Analyst workspace is not configured");

    expect(workspace).toBe(path.join(stateDir, "workspace-intel-analyst"));
    expect(created).toHaveLength(5);
    expect(fs.readFileSync(path.join(workspace, "SOUL.md"), "utf-8")).toContain(
      "vigilant, objective intelligence analyst",
    );
    expect(fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf-8")).toContain(
      "not executable instructions",
    );
    expect(fs.readFileSync(path.join(workspace, "IDENTITY.md"), "utf-8")).toContain(
      "Name: Intel Analyst",
    );
  });

  it("seeds the Dr. Pulse workspace with its safety-first Windows context", () => {
    const stateDir = createStateDir();
    const config = { agents: {} };
    const persona = getAgentPersona("dr-pulse");
    if (!persona) throw new Error("Dr. Pulse persona is not registered");
    ensureAgentPersonasConfig(config, stateDir, [...DEFAULT_AGENT_PERSONAS, persona]);
    expect(listConfiguredAgents(config)).toContainEqual({
      id: "dr-pulse",
      name: "Dr. Pulse",
    });
    const created = seedAgentPersonaWorkspaces(config, stateDir, "## Shared safety rule");
    const workspace = getAgentWorkspacePath(stateDir, persona);
    if (!workspace) throw new Error("Dr. Pulse workspace is not configured");

    expect(workspace).toBe(path.join(stateDir, "workspace-dr-pulse"));
    expect(created).toHaveLength(5);
    expect(fs.readFileSync(path.join(workspace, "SOUL.md"), "utf-8")).toContain(
      "Never run autonomous broad repair",
    );
    expect(fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf-8")).toContain(
      "explicit confirmation before any system or application change",
    );
    expect(fs.readFileSync(path.join(workspace, "IDENTITY.md"), "utf-8")).toContain(
      "Name: Dr. Pulse",
    );
  });

  it("seeds the Market Sentinel workspace with its non-advisory market context", () => {
    const stateDir = createStateDir();
    const config = { agents: {} };
    const persona = getAgentPersona("market-sentinel");
    if (!persona) throw new Error("Market Sentinel persona is not registered");
    ensureAgentPersonasConfig(config, stateDir, [...DEFAULT_AGENT_PERSONAS, persona]);
    expect(listConfiguredAgents(config)).toContainEqual({
      id: "market-sentinel",
      name: "Market Sentinel",
    });
    const created = seedAgentPersonaWorkspaces(config, stateDir, "## Shared safety rule");
    const workspace = getAgentWorkspacePath(stateDir, persona);
    if (!workspace) throw new Error("Market Sentinel workspace is not configured");

    expect(workspace).toBe(path.join(stateDir, "workspace-market-sentinel"));
    expect(created).toHaveLength(5);
    expect(fs.readFileSync(path.join(workspace, "SOUL.md"), "utf-8")).toContain(
      "Do not issue buy, sell, hold",
    );
    expect(fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf-8")).toContain(
      "Never execute or simulate a trade",
    );
    expect(fs.readFileSync(path.join(workspace, "IDENTITY.md"), "utf-8")).toContain(
      "Name: Market Sentinel",
    );
  });

  it("seeds the Creative Muse workspace with its platform content context", () => {
    const stateDir = createStateDir();
    const config = { agents: {} };
    const persona = getAgentPersona("creative-muse");
    if (!persona) throw new Error("Creative Muse persona is not registered");
    ensureAgentPersonasConfig(config, stateDir, [...DEFAULT_AGENT_PERSONAS, persona]);
    expect(listConfiguredAgents(config)).toContainEqual({
      id: "creative-muse",
      name: "Creative Muse",
    });
    const created = seedAgentPersonaWorkspaces(config, stateDir, "## Shared safety rule");
    const workspace = getAgentWorkspacePath(stateDir, persona);
    if (!workspace) throw new Error("Creative Muse workspace is not configured");

    expect(workspace).toBe(path.join(stateDir, "workspace-creative-muse"));
    expect(created).toHaveLength(5);
    expect(fs.readFileSync(path.join(workspace, "SOUL.md"), "utf-8")).toContain(
      "trend-aware Rednote content producer",
    );
    expect(fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf-8")).toContain(
      "three distinct durable stages",
    );
    expect(fs.readFileSync(path.join(workspace, "IDENTITY.md"), "utf-8")).toContain(
      "Name: Creative Muse",
    );
  });

  it("adds the Rednote pipeline to an existing Creative Muse guide without replacing it", () => {
    const stateDir = createStateDir();
    const config = { agents: {} };
    const persona = getAgentPersona("creative-muse");
    if (!persona) throw new Error("Creative Muse persona is not registered");
    ensureAgentPersonasConfig(config, stateDir, [...DEFAULT_AGENT_PERSONAS, persona]);
    const workspace = getAgentWorkspacePath(stateDir, persona);
    if (!workspace) throw new Error("Creative Muse workspace is not configured");
    fs.mkdirSync(workspace, { recursive: true });
    const agentsPath = path.join(workspace, "AGENTS.md");
    fs.writeFileSync(agentsPath, "# Custom guide\n\nKeep my editorial rules.\n", "utf-8");

    expect(seedAgentPersonaWorkspaces(config, stateDir)).toContain(agentsPath);
    const migrated = fs.readFileSync(agentsPath, "utf-8");
    expect(migrated).toContain("Keep my editorial rules.");
    expect(migrated).toContain("## Rednote publishing pipeline v2");
    expect(seedAgentPersonaWorkspaces(config, stateDir)).toEqual([]);
    expect(
      fs
        .readFileSync(agentsPath, "utf-8")
        .match(new RegExp(CREATIVE_MUSE_PIPELINE_SECTION.split("\n")[0], "g")),
    ).toHaveLength(1);
  });

  it("replaces the legacy monolithic Creative Muse pipeline with v2", () => {
    const stateDir = createStateDir();
    const config = { agents: {} };
    const persona = getAgentPersona("creative-muse");
    if (!persona) throw new Error("Creative Muse persona is not registered");
    ensureAgentPersonasConfig(config, stateDir, [...DEFAULT_AGENT_PERSONAS, persona]);
    const workspace = getAgentWorkspacePath(stateDir, persona);
    if (!workspace) throw new Error("Creative Muse workspace is not configured");
    fs.mkdirSync(workspace, { recursive: true });
    const agentsPath = path.join(workspace, "AGENTS.md");
    fs.writeFileSync(
      agentsPath,
      `# Custom guide

## Rednote publishing pipeline

- ${CREATIVE_MUSE_LEGACY_PIPELINE_MARKER}; material skips discovery.

## Custom rules

Keep this section.
`,
      "utf-8",
    );

    expect(seedAgentPersonaWorkspaces(config, stateDir)).toContain(agentsPath);
    const migrated = fs.readFileSync(agentsPath, "utf-8");
    expect(migrated).toContain("## Rednote publishing pipeline v2");
    expect(migrated).not.toContain(CREATIVE_MUSE_LEGACY_PIPELINE_MARKER);
    expect(migrated).toContain("## Custom rules");
    expect(migrated).toContain("Keep this section.");
  });

  it("migrates an installed Growth Hacker to Intel Analyst without losing custom settings", () => {
    const stateDir = createStateDir();
    const customWorkspace = path.join(stateDir, "custom-research");
    const config = {
      agents: {
        list: [
          { id: "main", name: "Assistant", default: true },
          {
            id: "growth-hacker",
            name: "Growth Hacker",
            workspace: customWorkspace,
            skills: ["custom-skill"],
            model: "custom/research-model",
          },
        ],
      },
    };

    expect(ensureAgentPersonasConfig(config, stateDir).changed).toBe(true);
    expect(listConfiguredAgents(config)).toEqual([
      { id: "main", name: "Assistant" },
      { id: "intel-analyst", name: "Intel Analyst" },
    ]);
    expect(agentList(config).find((entry) => entry.id === "intel-analyst")).toMatchObject({
      workspace: customWorkspace,
      skills: ["custom-skill"],
      model: "custom/research-model",
    });
    expect(agentList(config).some((entry) => entry.id === "growth-hacker")).toBe(false);

    seedAgentPersonaWorkspaces(config, stateDir);
    expect(fs.readFileSync(path.join(customWorkspace, "IDENTITY.md"), "utf-8")).toContain(
      "Name: Intel Analyst",
    );
  });

  it("migrates an installed Singer to Creative Muse without losing custom settings", () => {
    const stateDir = createStateDir();
    const customWorkspace = path.join(stateDir, "custom-content");
    const config = {
      agents: {
        list: [
          { id: "main", name: "Assistant", default: true },
          {
            id: "singer",
            name: "Singer",
            workspace: customWorkspace,
            skills: ["custom-skill"],
            model: "custom/content-model",
          },
        ],
      },
    };

    expect(ensureAgentPersonasConfig(config, stateDir).changed).toBe(true);
    expect(listConfiguredAgents(config)).toEqual([
      { id: "main", name: "Assistant" },
      { id: "creative-muse", name: "Creative Muse" },
    ]);
    expect(agentList(config).find((entry) => entry.id === "creative-muse")).toMatchObject({
      workspace: customWorkspace,
      skills: ["custom-skill"],
      model: "custom/content-model",
    });
    expect(agentList(config).find((entry) => entry.id === "singer")).toMatchObject({
      name: "Creative Muse",
      workspace: customWorkspace,
      skills: ["custom-skill"],
    });
    expect(ensureAgentPersonasConfig(config, stateDir).changed).toBe(false);

    seedAgentPersonaWorkspaces(config, stateDir);
    expect(fs.readFileSync(path.join(customWorkspace, "IDENTITY.md"), "utf-8")).toContain(
      "Name: Creative Muse",
    );
  });

  it("migrates an installed Master to Dr. Pulse without losing custom settings or default", () => {
    const stateDir = createStateDir();
    const customWorkspace = path.join(stateDir, "custom-system-doctor");
    const config = {
      agents: {
        list: [
          { id: "main", name: "Assistant" },
          {
            id: "master",
            name: "My PC Doctor",
            workspace: customWorkspace,
            skills: ["custom-skill"],
            model: "custom/diagnostic-model",
            default: true,
            confirmationMode: "always",
          },
        ],
      },
    };

    expect(ensureAgentPersonasConfig(config, stateDir).changed).toBe(true);
    expect(listConfiguredAgents(config)).toEqual([
      { id: "main", name: "Assistant" },
      { id: "dr-pulse", name: "My PC Doctor" },
    ]);
    expect(agentList(config).find((entry) => entry.id === "dr-pulse")).toMatchObject({
      name: "My PC Doctor",
      workspace: customWorkspace,
      skills: ["custom-skill"],
      model: "custom/diagnostic-model",
      default: true,
      confirmationMode: "always",
    });
    expect(agentList(config).find((entry) => entry.id === "master")).toMatchObject({
      name: "My PC Doctor",
      workspace: customWorkspace,
      skills: ["custom-skill"],
      model: "custom/diagnostic-model",
      confirmationMode: "always",
    });
    expect(agentList(config).find((entry) => entry.id === "master")).not.toHaveProperty("default");
    expect(ensureAgentPersonasConfig(config, stateDir).changed).toBe(false);

    seedAgentPersonaWorkspaces(config, stateDir);
    expect(fs.readFileSync(path.join(customWorkspace, "IDENTITY.md"), "utf-8")).toContain(
      "Name: Dr. Pulse",
    );
    expect(fs.existsSync(path.join(stateDir, "workspace-dr-pulse"))).toBe(false);
  });

  it("moves an uncustomized Master to the fixed Dr. Pulse workspace", () => {
    const stateDir = createStateDir();
    const config = {
      agents: {
        list: [
          { id: "main", name: "Assistant", default: true },
          { id: "master", name: "Master" },
        ],
      },
    };

    ensureAgentPersonasConfig(config, stateDir);

    expect(agentList(config).find((entry) => entry.id === "dr-pulse")).toMatchObject({
      name: "Dr. Pulse",
      workspace: path.join(stateDir, "workspace-dr-pulse"),
    });
    expect(agentList(config).find((entry) => entry.id === "master")).toMatchObject({
      name: "Dr. Pulse",
      workspace: path.join(stateDir, "workspace-dr-pulse"),
    });
  });

  it("restores the hidden Master alias whenever Dr. Pulse is configured", () => {
    const stateDir = createStateDir();
    const workspace = path.join(stateDir, "workspace-dr-pulse");
    const config = {
      agents: {
        list: [
          { id: "main", name: "Assistant", default: true },
          { id: "dr-pulse", name: "Dr. Pulse", workspace },
        ],
      },
    };

    expect(ensureAgentPersonasConfig(config, stateDir).changed).toBe(true);
    expect(listConfiguredAgents(config)).toEqual([
      { id: "main", name: "Assistant" },
      { id: "dr-pulse", name: "Dr. Pulse" },
    ]);
    expect(agentList(config).find((entry) => entry.id === "master")).toMatchObject({
      name: "Dr. Pulse",
      workspace,
    });
    expect(ensureAgentPersonasConfig(config, stateDir).changed).toBe(false);
  });

  it("keeps canonical Dr. Pulse settings while filling missing legacy fields", () => {
    const stateDir = createStateDir();
    const legacyWorkspace = path.join(stateDir, "custom-master");
    const drPulsePersona = getAgentPersona("dr-pulse");
    if (!drPulsePersona) throw new Error("Dr. Pulse persona is not registered");
    const config = {
      agents: {
        list: [
          { id: "main", name: "Assistant" },
          {
            id: "dr-pulse",
            name: "Dr. Pulse",
            workspace: path.join(stateDir, "workspace-dr-pulse"),
            skills: resolveSkillFilterNames(getAgentSkills("dr-pulse")),
          },
          {
            id: "master",
            name: "My System Specialist",
            workspace: legacyWorkspace,
            skills: ["custom-skill"],
            model: "custom/system-model",
            default: true,
          },
        ],
      },
    };

    ensureAgentPersonasConfig(config, stateDir);

    expect(agentList(config).filter((entry) => entry.id === "dr-pulse")).toHaveLength(1);
    expect(agentList(config).find((entry) => entry.id === "dr-pulse")).toMatchObject({
      name: "Dr. Pulse",
      workspace: path.join(stateDir, "workspace-dr-pulse"),
      skills: resolveSkillFilterNames(getAgentSkills("dr-pulse")),
      model: "custom/system-model",
      default: true,
    });
    expect(agentList(config).find((entry) => entry.id === "master")).toMatchObject({
      name: "Dr. Pulse",
      workspace: path.join(stateDir, "workspace-dr-pulse"),
      skills: resolveSkillFilterNames(getAgentSkills("dr-pulse")),
      model: "custom/system-model",
    });
  });

  it("keeps an existing customized Dr. Pulse identity when Master coexists", () => {
    const stateDir = createStateDir();
    const drPulseWorkspace = path.join(stateDir, "custom-dr-pulse");
    const config = {
      agents: {
        list: [
          { id: "main", name: "Assistant" },
          {
            id: "dr-pulse",
            name: "Trusted System Doctor",
            workspace: drPulseWorkspace,
            skills: ["preferred-skill"],
          },
          {
            id: "master",
            name: "Legacy Master",
            workspace: path.join(stateDir, "legacy-master"),
            skills: ["legacy-skill"],
            model: "custom/legacy-model",
            default: true,
          },
        ],
      },
    };

    ensureAgentPersonasConfig(config, stateDir);

    expect(agentList(config).find((entry) => entry.id === "dr-pulse")).toMatchObject({
      name: "Trusted System Doctor",
      workspace: drPulseWorkspace,
      skills: ["preferred-skill"],
      model: "custom/legacy-model",
      default: true,
    });
    expect(agentList(config).find((entry) => entry.id === "master")).toMatchObject({
      name: "Trusted System Doctor",
      workspace: drPulseWorkspace,
      skills: ["preferred-skill"],
    });
  });

  it("migrates an installed Leopard to Market Sentinel without losing custom settings", () => {
    const stateDir = createStateDir();
    const customWorkspace = path.join(stateDir, "custom-market-monitor");
    const config = {
      agents: {
        list: [
          { id: "main", name: "Assistant" },
          {
            id: "leopard",
            name: "My Market Monitor",
            workspace: customWorkspace,
            skills: ["custom-skill"],
            model: "custom/market-model",
            default: true,
            dataProvider: "licensed-feed",
          },
        ],
      },
    };

    expect(ensureAgentPersonasConfig(config, stateDir).changed).toBe(true);
    expect(listConfiguredAgents(config)).toEqual([
      { id: "main", name: "Assistant" },
      { id: "market-sentinel", name: "My Market Monitor" },
    ]);
    expect(agentList(config).find((entry) => entry.id === "market-sentinel")).toMatchObject({
      name: "My Market Monitor",
      workspace: customWorkspace,
      skills: ["custom-skill"],
      model: "custom/market-model",
      default: true,
      dataProvider: "licensed-feed",
    });
    expect(agentList(config).find((entry) => entry.id === "leopard")).toMatchObject({
      name: "My Market Monitor",
      workspace: customWorkspace,
      skills: ["custom-skill"],
      model: "custom/market-model",
      dataProvider: "licensed-feed",
    });
    expect(agentList(config).find((entry) => entry.id === "leopard")).not.toHaveProperty("default");
    expect(ensureAgentPersonasConfig(config, stateDir).changed).toBe(false);

    seedAgentPersonaWorkspaces(config, stateDir);
    expect(fs.readFileSync(path.join(customWorkspace, "IDENTITY.md"), "utf-8")).toContain(
      "Name: Market Sentinel",
    );
  });

  it("keeps Leopard's implicit workspace when migrating to Market Sentinel", () => {
    const stateDir = createStateDir();
    const config = {
      agents: {
        list: [
          { id: "main", name: "Assistant", default: true },
          { id: "leopard", name: "Leopard" },
        ],
      },
    };

    ensureAgentPersonasConfig(config, stateDir);

    expect(agentList(config).find((entry) => entry.id === "market-sentinel")).toMatchObject({
      name: "Market Sentinel",
      workspace: path.join(stateDir, "workspace-leopard"),
    });
    expect(agentList(config).find((entry) => entry.id === "leopard")).toMatchObject({
      name: "Market Sentinel",
      workspace: path.join(stateDir, "workspace-leopard"),
    });
    seedAgentPersonaWorkspaces(config, stateDir);
    expect(
      fs.readFileSync(path.join(stateDir, "workspace-leopard", "IDENTITY.md"), "utf-8"),
    ).toContain("Name: Market Sentinel");
    expect(fs.existsSync(path.join(stateDir, "workspace-market-sentinel"))).toBe(false);
  });

  it("adds mandatory Market Sentinel boundaries to a populated legacy workspace", () => {
    const stateDir = createStateDir();
    const customWorkspace = path.join(stateDir, "legacy-market-workspace");
    fs.mkdirSync(customWorkspace);
    const agentsPath = path.join(customWorkspace, "AGENTS.md");
    const soulPath = path.join(customWorkspace, "SOUL.md");
    fs.writeFileSync(
      agentsPath,
      "# Custom market guide\n\nKeep my data-provider rules.\n",
      "utf-8",
    );
    fs.writeFileSync(soulPath, "# Custom market persona\n\nKeep my reporting voice.\n", "utf-8");
    const config = {
      agents: {
        list: [
          { id: "main", name: "Assistant", default: true },
          { id: "leopard", name: "Leopard", workspace: customWorkspace },
        ],
      },
    };

    ensureAgentPersonasConfig(config, stateDir);
    expect(seedAgentPersonaWorkspaces(config, stateDir, "## Shared safety rule")).toEqual([
      path.join(stateDir, "workspace", "IDENTITY.md"),
      path.join(stateDir, "workspace", "SOUL.md"),
      agentsPath,
      path.join(customWorkspace, "IDENTITY.md"),
      soulPath,
    ]);

    const agents = fs.readFileSync(agentsPath, "utf-8");
    const soul = fs.readFileSync(soulPath, "utf-8");
    expect(agents).toContain("Keep my data-provider rules.");
    expect(agents).toContain(MARKET_SENTINEL_OPERATING_BOUNDARY_SECTION.split("\n")[0]);
    expect(agents).toContain("Ask before creating an external alert");
    expect(agents).toContain("Never send a report or change a subscription");
    expect(soul).toContain("Keep my reporting voice.");
    expect(soul).toContain(MARKET_SENTINEL_FINANCIAL_BOUNDARY_SECTION.split("\n")[0]);
    expect(soul).toContain("## Shared safety rule");
    expect(seedAgentPersonaWorkspaces(config, stateDir, "## Shared safety rule")).toEqual([]);
  });

  it("keeps Singer's implicit workspace when migrating to Creative Muse", () => {
    const stateDir = createStateDir();
    const config = {
      agents: {
        list: [
          { id: "main", name: "Assistant", default: true },
          { id: "singer", name: "Singer" },
        ],
      },
    };

    ensureAgentPersonasConfig(config, stateDir);

    expect(agentList(config).find((entry) => entry.id === "creative-muse")).toMatchObject({
      name: "Creative Muse",
      workspace: path.join(stateDir, "workspace-singer"),
    });
    expect(agentList(config).find((entry) => entry.id === "singer")).toMatchObject({
      workspace: path.join(stateDir, "workspace-singer"),
    });
    seedAgentPersonaWorkspaces(config, stateDir);
    expect(
      fs.readFileSync(path.join(stateDir, "workspace-singer", "IDENTITY.md"), "utf-8"),
    ).toContain("Name: Creative Muse");
    expect(fs.existsSync(path.join(stateDir, "workspace-creative-muse"))).toBe(false);
  });

  it("prefers customized Singer settings over default Creative Muse settings", () => {
    const stateDir = createStateDir();
    const legacyWorkspace = path.join(stateDir, "custom-singer");
    const creativePersona = getAgentPersona("creative-muse");
    if (!creativePersona) throw new Error("Creative Muse persona is not registered");
    const config = {
      agents: {
        list: [
          { id: "main", name: "Assistant", default: true },
          {
            id: "creative-muse",
            name: "Creative Muse",
            workspace: path.join(stateDir, "workspace-creative-muse"),
            skills: resolveSkillFilterNames(getAgentSkills("creative-muse")),
          },
          {
            id: "singer",
            name: "My Content Partner",
            workspace: legacyWorkspace,
            skills: ["custom-skill"],
            model: "custom/content-model",
          },
        ],
      },
    };

    ensureAgentPersonasConfig(config, stateDir);

    expect(agentList(config).filter((entry) => entry.id === "creative-muse")).toHaveLength(1);
    expect(agentList(config).find((entry) => entry.id === "creative-muse")).toMatchObject({
      name: "My Content Partner",
      workspace: legacyWorkspace,
      skills: ["custom-skill"],
      model: "custom/content-model",
    });
    expect(agentList(config).find((entry) => entry.id === "singer")).toMatchObject({
      name: "My Content Partner",
      workspace: legacyWorkspace,
      skills: ["custom-skill"],
    });
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
    expect(fs.existsSync(path.join(stateDir, "workspace-code-geek"))).toBe(false);
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

  it("removes Dr. Pulse and its Master compatibility alias together", () => {
    const config = {
      agents: {
        list: [
          { id: "main", name: "Assistant", default: true },
          { id: "dr-pulse", name: "Dr. Pulse", workspace: "workspace-dr-pulse" },
          { id: "master", name: "Dr. Pulse", workspace: "workspace-dr-pulse" },
        ],
      },
    };

    expect(removeConfiguredAgent(config, "dr-pulse").changed).toBe(true);
    expect(config.agents.list).toEqual([{ id: "main", name: "Assistant", default: true }]);
  });

  it("removes Market Sentinel and its Leopard compatibility alias together", () => {
    const config = {
      agents: {
        list: [
          { id: "main", name: "Assistant", default: true },
          {
            id: "market-sentinel",
            name: "Market Sentinel",
            workspace: "workspace-market-sentinel",
          },
          { id: "leopard", name: "Market Sentinel", workspace: "workspace-market-sentinel" },
        ],
      },
    };

    expect(removeConfiguredAgent(config, "market-sentinel").changed).toBe(true);
    expect(config.agents.list).toEqual([{ id: "main", name: "Assistant", default: true }]);
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

  it("adds Rednote Publisher to an untouched previous catalog skill set", () => {
    const stateDir = createStateDir();
    const currentSkills = resolveSkillFilterNames(getAgentSkills("creative-muse"));
    const previousSkills = currentSkills.filter((skill) => skill !== "Rednote Publisher");
    const config = {
      agents: {
        list: [
          { id: "main", name: "Assistant", default: true },
          { id: "creative-muse", name: "Creative Muse", skills: previousSkills },
        ],
      },
    };

    expect(ensureAgentPersonasConfig(config, stateDir).changed).toBe(true);
    expect(agentList(config).find((entry) => entry.id === "creative-muse")?.skills).toEqual(
      currentSkills,
    );
  });

  it("preserves an explicit Rednote Publisher assignment on non-owner agents", () => {
    const stateDir = createStateDir();
    const legacyAllSkills = resolveSkillFilterNames(getAgentSkills("creative-muse"));
    const config = {
      agents: {
        list: [
          {
            id: "main",
            name: "Assistant",
            default: true,
            skills: legacyAllSkills,
          },
          {
            id: "code-geek",
            name: "Code Geek",
            skills: legacyAllSkills,
          },
        ],
      },
    };

    expect(ensureAgentPersonasConfig(config, stateDir).changed).toBe(false);
    expect(agentList(config).find((entry) => entry.id === "main")?.skills).toEqual(legacyAllSkills);
    expect(agentList(config).find((entry) => entry.id === "code-geek")?.skills).toEqual(
      legacyAllSkills,
    );
  });

  it("does not restore Rednote Publisher after the user removes it", () => {
    const stateDir = createStateDir();
    const currentSkills = resolveSkillFilterNames(getAgentSkills("creative-muse"));
    const withoutRednote = currentSkills.filter((skill) => skill !== "Rednote Publisher");
    const markerPath = path.join(
      stateDir,
      "skills",
      "rednote-publisher",
      ".microclaw-agent-skill.json",
    );
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "{}");
    const config = {
      agents: {
        list: [
          { id: "main", name: "Assistant", default: true },
          { id: "creative-muse", name: "Creative Muse", skills: withoutRednote },
        ],
      },
    };

    ensureAgentPersonasConfig(config, stateDir);
    expect(agentList(config).find((entry) => entry.id === "creative-muse")?.skills).toEqual(
      withoutRednote,
    );
  });

  it("does not add Rednote Publisher to a customized skill set", () => {
    const stateDir = createStateDir();
    const config = {
      agents: {
        list: [
          { id: "main", name: "Assistant", default: true },
          { id: "creative-muse", name: "Creative Muse", skills: ["custom-skill"] },
        ],
      },
    };

    ensureAgentPersonasConfig(config, stateDir);
    expect(agentList(config).find((entry) => entry.id === "creative-muse")?.skills).toEqual([
      "custom-skill",
    ]);
    seedAgentPersonaWorkspaces(config, stateDir);
    expect(
      fs.readFileSync(path.join(stateDir, "workspace-creative-muse", "AGENTS.md"), "utf-8"),
    ).not.toContain("## Rednote publishing pipeline");
  });

  it("removes the managed pipeline when Rednote Publisher is globally disabled", () => {
    const stateDir = createStateDir();
    const config = {
      agents: {
        list: [
          { id: "main", name: "Assistant", default: true },
          {
            id: "creative-muse",
            name: "Creative Muse",
            skills: resolveSkillFilterNames(getAgentSkills("creative-muse")),
          },
        ],
      },
      skills: {
        entries: {
          "rednote-publisher": { enabled: true },
        },
      },
    };

    seedAgentPersonaWorkspaces(config, stateDir);
    const agentsPath = path.join(stateDir, "workspace-creative-muse", "AGENTS.md");
    fs.appendFileSync(agentsPath, "\nCustom editorial note.\n", "utf-8");
    expect(fs.readFileSync(agentsPath, "utf-8")).toContain("## Rednote publishing pipeline");

    config.skills.entries["rednote-publisher"].enabled = false;
    expect(seedAgentPersonaWorkspaces(config, stateDir)).toContain(agentsPath);
    const disabled = fs.readFileSync(agentsPath, "utf-8");
    expect(disabled).not.toContain("## Rednote publishing pipeline");
    expect(disabled).toContain("Custom editorial note.");
    expect(seedAgentPersonaWorkspaces(config, stateDir)).toEqual([]);
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
