import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { applyWindowsNodeMxcGatewayPolicy } from "./windows-node-mxc";

const publishedPackage = process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR;

describe.skipIf(!publishedPackage)("installed OpenClaw scoped memory recall", () => {
  it.each(["protected", "relocated"])(
    "reads %s workspace memory without folder grants, but not unrelated files",
    (layout) => {
      const root = mkdtempSync(join(tmpdir(), "microclaw-memory-"));
      try {
        const state = join(root, ".openclaw");
        const workspace =
          layout === "protected"
            ? join(state, "workspace")
            : join(root, "OpenClawWorkspaces", "main");
        const otherWorkspace =
          layout === "protected"
            ? join(state, "other-workspace")
            : join(root, "OpenClawWorkspaces", "other");
        mkdirSync(state, { recursive: true });
        mkdirSync(join(workspace, "memory"), { recursive: true });
        mkdirSync(otherWorkspace, { recursive: true });
        writeFileSync(join(workspace, "MEMORY.md"), "Header\nquartz-lantern-fixture\nLast line\n");
        writeFileSync(join(workspace, "memory", "note.md"), "Synthetic daily memory\n");
        writeFileSync(join(workspace, "private.md"), "Not a memory source\n");
        writeFileSync(join(state, "private.md"), "Private state\n");
        writeFileSync(join(otherWorkspace, "MEMORY.md"), "Other agent's memory\n");
        const { config } = applyWindowsNodeMxcGatewayPolicy(
          {
            agents: {
              ownership: "explicit",
              entries: { main: { workspace }, other: { workspace: otherWorkspace } },
            },
            memory: {
              search: {
                provider: "none",
                sources: ["memory"],
                rememberAcrossConversations: false,
              },
            },
          },
          "test-node",
        );
        const configPath = join(state, "openclaw.json");
        writeFileSync(configPath, JSON.stringify(config));
        const dist = join(publishedPackage!, "dist");
        const toolModules = readdirSync(dist).filter(
          (name) =>
            /^tools-.*\.mjs$/.test(name) &&
            readFileSync(join(dist, name), "utf8").includes("function createMemoryGetTool("),
        );
        expect(toolModules).toHaveLength(1);
        const stateModules = readdirSync(dist).filter(
          (name) =>
            /^plugin-state-store-.*\.mjs$/.test(name) &&
            readFileSync(join(dist, name), "utf8").includes(
              "export { createPluginStateKeyedStore,",
            ),
        );
        expect(stateModules).toHaveLength(1);
        const result = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            `
import assert from "node:assert/strict";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
const { createMemoryGetTool, createMemorySearchTool } = await import(${JSON.stringify(pathToFileURL(join(dist, toolModules[0])).href)});
const { configureMemoryCoreDreamingState } = await import(${JSON.stringify(pathToFileURL(join(dist, "extensions", "memory-core", "api.js")).href)});
const { createPluginStateKeyedStore } = await import(${JSON.stringify(pathToFileURL(join(dist, stateModules[0])).href)});
// Supply the same SQLite host service as plugin registration, using only the isolated state directory.
configureMemoryCoreDreamingState((options) => createPluginStateKeyedStore("memory-core", options));
const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
const options = { config, agentId: "main", agentSessionKey: "agent:main:main", oneShotCliRun: true };
const get = createMemoryGetTool(options);
const search = createMemorySearchTool(options);
assert.equal(get?.name, "memory_get");
assert.equal(search?.name, "memory_search");
const read = async (path, range = {}) => (await get.execute("test", { path, corpus: "memory", ...range })).details;
const excerpt = await read("MEMORY.md", { from: 2, lines: 1 });
assert.equal(excerpt.status, "ok", JSON.stringify(excerpt));
assert.ok(excerpt.text.startsWith("quartz-lantern-fixture"));
assert.ok(!excerpt.text.includes("Header") && !excerpt.text.includes("Last line"));
assert.equal(excerpt.nextFrom, 3);
assert.equal((await read("memory/note.md")).status, "ok");
assert.equal((await read("memory/missing.md")).status, "not_found");
const recalled = (await search.execute("test", {
  query: "quartz-lantern-fixture", corpus: "memory", minScore: 0,
})).details;
assert.ok(!recalled.disabled && !recalled.unavailable, JSON.stringify(recalled));
assert.ok(recalled.results.some((hit) => hit.path === "MEMORY.md"), JSON.stringify(recalled));
const workspace = config.agents.entries.main.workspace;
const otherWorkspace = config.agents.entries.other.workspace;
symlinkSync(otherWorkspace, join(workspace, "memory", "outside"), "junction");
for (const path of ["private.md", "../private.md", "../other-workspace/MEMORY.md",
  join(otherWorkspace, "MEMORY.md"), "memory/outside/MEMORY.md", "../agents/main/agent/openclaw-agent.sqlite"]) {
  const result = await read(path);
  assert.notEqual(result.status, "ok", path);
  assert.equal(result.text, "", JSON.stringify(result));
}
assert.equal(createMemoryGetTool({
  ...options,
  config: { ...config, memory: { search: { enabled: false } } },
}), null);
console.log("SCOPED_MEMORY_OK");
`,
          ],
          {
            encoding: "utf8",
            timeout: 60_000,
            env: {
              ...process.env,
              HOME: root,
              USERPROFILE: root,
              APPDATA: join(root, "roaming"),
              LOCALAPPDATA: join(root, "local"),
              OPENCLAW_HOME: root,
              OPENCLAW_STATE_DIR: state,
              OPENCLAW_CONFIG_PATH: configPath,
              OPENCLAW_DISABLE_COMPILE_CACHE: "1",
            },
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr + result.stdout).toBe(0);
        expect(result.stdout).toContain("SCOPED_MEMORY_OK");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    70_000,
  );
});
