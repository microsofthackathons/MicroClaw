import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureAgentPersonasConfig,
  getAgentPersona,
  removeConfiguredAgent,
  seedAgentPersonaWorkspaces,
  type AgentRosterConfig,
} from "./agent-personas";
import {
  getWorkspaceParent,
  materializeAgentWorkspaces,
  planAgentWorkspaces,
  planDefaultWorkspaceFolderGrant,
} from "./agent-workspaces";
import { readAgentRoster } from "./agent-roster";

const temporary: string[] = [];
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-workspaces-"));
  temporary.push(home);
  const state = path.join(home, ".openclaw");
  fs.mkdirSync(state);
  return { home, state, parent: getWorkspaceParent(home) };
}
function write(filePath: string, text: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}
afterEach(() => {
  for (const directory of temporary.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("managed agent workspaces", () => {
  it("uses separate directories outside state for main, catalog and custom agents", () => {
    const { home, state, parent } = fixture();
    const config: AgentRosterConfig = { agents: { entries: { main: {}, coder: {} } } };
    ensureAgentPersonasConfig(config, state, [
      getAgentPersona("main")!,
      getAgentPersona("master-archive")!,
    ]);
    const before = structuredClone(config);
    const plan = planAgentWorkspaces(config, state, home, {});
    materializeAgentWorkspaces(plan);
    expect(config).toEqual(before);
    expect(plan.config.agents?.defaults).toMatchObject({ workspace: parent });
    for (const { id, config: agent } of readAgentRoster(plan.config.agents)) {
      expect(agent.workspace).toBe(path.join(parent, id));
      expect(fs.statSync(String(agent.workspace)).isDirectory()).toBe(true);
    }
    seedAgentPersonaWorkspaces(plan.config, state, "", {}, home);
    expect(fs.existsSync(path.join(parent, "main", "SOUL.md"))).toBe(true);
    expect(fs.existsSync(path.join(state, "workspace"))).toBe(false);
    expect(planAgentWorkspaces(plan.config, state, home, {}).changed).toBe(false);
  });

  it("copies memory, hidden files, nested content and binary data without changing originals", () => {
    const { home, state, parent } = fixture();
    const old = path.join(state, "workspace");
    write(path.join(old, "MEMORY.md"), "existing memory");
    write(path.join(old, "memory", "2026-11-04.md"), "daily memory");
    write(path.join(old, ".hidden"), "keep hidden files");
    fs.writeFileSync(path.join(old, "binary"), Buffer.from([0, 255, 128]));
    const config: AgentRosterConfig = { agents: { entries: { main: { workspace: old } } } };
    const plan = planAgentWorkspaces(config, state, home, {});
    materializeAgentWorkspaces(plan);
    const target = path.join(parent, "main");
    expect(fs.readFileSync(path.join(target, "MEMORY.md"), "utf8")).toBe("existing memory");
    expect(fs.readFileSync(path.join(target, "memory", "2026-11-04.md"), "utf8")).toBe(
      "daily memory",
    );
    expect(fs.readFileSync(path.join(target, ".hidden"), "utf8")).toBe("keep hidden files");
    expect(fs.readFileSync(path.join(target, "binary"))).toEqual(Buffer.from([0, 255, 128]));
    expect(fs.readFileSync(path.join(old, "MEMORY.md"), "utf8")).toBe("existing memory");
    // A copy completed before a config-write failure can be safely reused.
    expect(() => materializeAgentWorkspaces(plan)).not.toThrow();
    write(path.join(target, "MEMORY.md"), "new memory");
    materializeAgentWorkspaces(planAgentWorkspaces(plan.config, state, home, {}));
    expect(fs.readFileSync(path.join(target, "MEMORY.md"), "utf8")).toBe("new memory");
    expect(fs.readFileSync(path.join(old, "MEMORY.md"), "utf8")).toBe("existing memory");
  });

  it.each(["list", "entries"])(
    "migrates inherited defaults in a %s roster before updating the parent",
    (format) => {
      const { home, state, parent } = fixture();
      const old = path.join(state, "workspace");
      const entries = { main: { workspace: old }, coder: {} };
      write(path.join(old, "main.txt"), "main");
      write(path.join(old, "coder", "notes.txt"), "coder");
      const config = {
        agents: {
          ownership: "explicit",
          defaults: { workspace: old, model: "model" },
          ...(format === "entries"
            ? { entries }
            : { list: Object.entries(entries).map(([id, entry]) => ({ id, ...entry })) }),
        },
      };
      const plan = planAgentWorkspaces(config, state, home, {});
      materializeAgentWorkspaces(plan);
      expect(
        readAgentRoster(plan.config.agents).map(({ config: entry }) => entry.workspace),
      ).toEqual([path.join(parent, "main"), path.join(parent, "coder")]);
      expect(fs.readFileSync(path.join(parent, "coder", "notes.txt"), "utf8")).toBe("coder");
      expect(plan.config.agents?.defaults).toMatchObject({ model: "model" });
    },
  );

  it("preserves explicit and inherited customized workspaces without granting them", () => {
    const { home, state, parent } = fixture();
    const custom = path.join(home, "Custom");
    const config = {
      agents: {
        ownership: "explicit",
        defaults: { workspace: custom },
        entries: {
          main: { workspace: "~\\Special" },
          coder: {},
          third: { workspace: path.join(state, "manual") },
        },
      },
    };
    const plan = planAgentWorkspaces(config, state, home, { USERPROFILE: home });
    expect(plan.config.agents?.defaults).toEqual({ workspace: custom });
    expect(readAgentRoster(plan.config.agents).map(({ config: entry }) => entry.workspace)).toEqual(
      ["~\\Special", path.join(custom, "coder"), path.join(state, "manual")],
    );
    expect(plan.workspaces).toEqual([]);
    expect(planDefaultWorkspaceFolderGrant({ rw: [], ro: [] }, parent)).toEqual({
      rw: [parent],
      ro: [],
    });
  });

  it("keeps historical aliases on their canonical agent's migrated workspace", () => {
    const { home, state, parent } = fixture();
    write(path.join(state, "workspace-leopard", "MEMORY.md"), "legacy");
    const config = { agents: { entries: { main: {}, leopard: {} } } };
    ensureAgentPersonasConfig(config, state);
    const plan = planAgentWorkspaces(config, state, home, {});
    materializeAgentWorkspaces(plan);
    const entries = new Map(
      readAgentRoster(plan.config.agents).map(({ id, config: entry }) => [id, entry]),
    );
    expect(entries.get("leopard")?.workspace).toBe(path.join(parent, "market-sentinel"));
    expect(entries.get("market-sentinel")?.workspace).toBe(entries.get("leopard")?.workspace);
    expect(fs.readFileSync(path.join(parent, "market-sentinel", "MEMORY.md"), "utf8")).toBe(
      "legacy",
    );
    ensureAgentPersonasConfig(plan.config, state);
    expect(planAgentWorkspaces(plan.config, state, home, {}).changed).toBe(false);
  });

  it("gives a subsequently added catalog agent its own directory without moving existing agents", () => {
    const { home, state, parent } = fixture();
    const config: AgentRosterConfig = {};
    ensureAgentPersonasConfig(config, state);
    const first = planAgentWorkspaces(config, state, home, {});
    materializeAgentWorkspaces(first);
    write(path.join(parent, "main", "MEMORY.md"), "keep me");
    ensureAgentPersonasConfig(
      first.config,
      state,
      [getAgentPersona("main")!, getAgentPersona("master-archive")!],
      parent,
    );
    const added = planAgentWorkspaces(first.config, state, home, {});
    materializeAgentWorkspaces(added);
    expect(fs.readFileSync(path.join(parent, "main", "MEMORY.md"), "utf8")).toBe("keep me");
    expect(fs.statSync(path.join(parent, "master-archive")).isDirectory()).toBe(true);
  });

  it("reuses a removed agent's current workspace rather than its retained legacy backup", () => {
    const { home, state, parent } = fixture();
    const old = path.join(state, "workspace-master-archive");
    write(path.join(old, "MEMORY.md"), "old memory");
    const config: AgentRosterConfig = {
      agents: { entries: { main: {}, "master-archive": { workspace: old } } },
    };
    ensureAgentPersonasConfig(config, state);
    const first = planAgentWorkspaces(config, state, home, {});
    materializeAgentWorkspaces(first);
    write(path.join(parent, "master-archive", "MEMORY.md"), "current memory");
    removeConfiguredAgent(first.config, "master-archive");
    ensureAgentPersonasConfig(
      first.config,
      state,
      [getAgentPersona("main")!, getAgentPersona("master-archive")!],
      parent,
    );
    const readded = planAgentWorkspaces(first.config, state, home, {});
    materializeAgentWorkspaces(readded);
    expect(fs.readFileSync(path.join(parent, "master-archive", "MEMORY.md"), "utf8")).toBe(
      "current memory",
    );
    expect(fs.readFileSync(path.join(old, "MEMORY.md"), "utf8")).toBe("old memory");
  });

  it("stops on conflicting destinations without overwriting either copy", () => {
    const { home, state, parent } = fixture();
    const old = path.join(state, "workspace");
    write(path.join(old, "MEMORY.md"), "original");
    write(path.join(parent, "main", "MEMORY.md"), "different");
    const config = { agents: { entries: { main: { workspace: old } } } };
    const plan = planAgentWorkspaces(config, state, home, {});
    expect(() => materializeAgentWorkspaces(plan)).toThrow("migration conflict");
    expect(config.agents.entries.main.workspace).toBe(old);
    expect(fs.readFileSync(path.join(old, "MEMORY.md"), "utf8")).toBe("original");
    expect(fs.readFileSync(path.join(parent, "main", "MEMORY.md"), "utf8")).toBe("different");
  });

  it.each(["source", "child", "parent", "destination"])(
    "rejects a junction at the %s",
    (location) => {
      const { home, state, parent } = fixture();
      const old = path.join(state, "workspace");
      const elsewhere = path.join(home, "elsewhere");
      write(path.join(elsewhere, "private.txt"), "do not copy");
      fs.mkdirSync(old);
      fs.mkdirSync(parent);
      const link =
        location === "source"
          ? old
          : location === "child"
            ? path.join(old, "link")
            : location === "parent"
              ? parent
              : path.join(parent, "main");
      if (fs.existsSync(link)) fs.rmdirSync(link);
      fs.symlinkSync(elsewhere, link, "junction");
      const plan = planAgentWorkspaces(
        { agents: { entries: { main: { workspace: old } } } },
        state,
        home,
        {},
      );
      expect(() => materializeAgentWorkspaces(plan)).toThrow();
      expect(fs.readFileSync(path.join(elsewhere, "private.txt"), "utf8")).toBe("do not copy");
    },
  );

  it("refuses hardlinked files and invalid agent IDs", () => {
    const { home, state } = fixture();
    const old = path.join(state, "workspace");
    write(path.join(home, "private.txt"), "private");
    fs.mkdirSync(old);
    fs.linkSync(path.join(home, "private.txt"), path.join(old, "linked.txt"));
    const plan = planAgentWorkspaces(
      { agents: { entries: { main: { workspace: old } } } },
      state,
      home,
      {},
    );
    expect(() => materializeAgentWorkspaces(plan)).toThrow("ordinary files");
    expect(() =>
      planAgentWorkspaces({ agents: { entries: { "../escape": {} } } }, state, home, {}),
    ).toThrow("Invalid workspace agent id");
  });
});

describe("default global workspace grant", () => {
  const parent = "C:\\Users\\alice\\OpenClawWorkspaces";
  it("adds the whole parent as RW, not individual agent folders", () => {
    expect(
      planDefaultWorkspaceFolderGrant({ rw: ["D:\\Work"], ro: ["D:\\Reference"] }, parent),
    ).toEqual({
      rw: ["D:\\Work", parent],
      ro: ["D:\\Reference"],
    });
  });
  it("does not duplicate case-insensitive existing or covering grants", () => {
    const folders = { rw: [parent.toLowerCase()], ro: [] };
    expect(planDefaultWorkspaceFolderGrant(folders, parent)).toEqual(folders);
  });
  it.each([parent, `${parent}\\main`, "C:\\Users\\alice"])(
    "preserves explicit RO restrictions at %s",
    (restricted) => {
      const folders = { rw: [], ro: [restricted] };
      expect(planDefaultWorkspaceFolderGrant(folders, parent)).toEqual(folders);
    },
  );
  it("does not confuse path-prefix siblings with containing roots", () => {
    expect(planDefaultWorkspaceFolderGrant({ rw: [`${parent}-other`], ro: [] }, parent).rw).toEqual(
      [`${parent}-other`, parent],
    );
  });
});
