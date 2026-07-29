import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_PERSONAS,
  ensureAgentPersonasConfig,
  getAgentWorkspacePath,
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

describe("agent personas", () => {
  it("registers personas in the runtime list roster", () => {
    const stateDir = createStateDir();
    const config = {
      agents: {
        defaults: { model: "custom/model" },
        list: [{ id: "main", default: true, name: "Existing Assistant" }],
      },
    };

    expect(ensureAgentPersonasConfig(config, stateDir).changed).toBe(true);
    expect(config.agents.list).toContainEqual(
      expect.objectContaining({ id: "main", name: "Existing Assistant" }),
    );
    expect(config.agents.list).toContainEqual(
      expect.objectContaining({
        id: "master-archive",
        name: "Master Archive",
        workspace: path.join(stateDir, "workspace-master-archive"),
      }),
    );
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
    expect(agents.list).toEqual(
      expect.arrayContaining([
      expect.objectContaining({
        id: "master-archive",
        name: "Master Archive",
        workspace: path.join(stateDir, "workspace-master-archive"),
      }),
      ]),
    );
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
    expect(config.agents.list.find((entry) => entry.id === "main")).not.toHaveProperty(
      "default",
    );
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
    ensureAgentPersonasConfig(config, stateDir);
    const created = seedAgentPersonaWorkspaces(config, stateDir, "## Shared safety rule");
    const persona = AGENT_PERSONAS.find((entry) => entry.id === "master-archive");
    if (!persona) throw new Error("Master Archive persona is not registered");
    const workspace = getAgentWorkspacePath(stateDir, persona);
    if (!workspace) throw new Error("Master Archive workspace is not configured");

    expect(workspace).toBe(path.join(stateDir, "workspace-master-archive"));
    expect(created).toHaveLength(3);
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
    seedAgentPersonaWorkspaces(config, stateDir);
    const soulPath = path.join(customWorkspace, "SOUL.md");
    fs.writeFileSync(soulPath, "custom persona\n", "utf-8");

    const updated = seedAgentPersonaWorkspaces(config, stateDir, "## Required appendix");

    expect(updated).toEqual([soulPath]);
    expect(fs.readFileSync(soulPath, "utf-8")).toBe(
      "custom persona\n\n## Required appendix\n",
    );
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
});
