import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  createLightweightPlan,
  loadSnapshotAdapter,
  BACKUP_SCOPE,
} from "../deployer/assets/upgrade-backup.mjs";

let root, state, desktop, scratch, packageDir, workspace, adapter, environment;

async function write(filename, content = "fixture") {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, content);
}

beforeEach(async () => {
  const build = path.resolve("build");
  await fs.mkdir(build, { recursive: true });
  root = await fs.mkdtemp(path.join(build, "whitelist-test-"));
  state = path.join(root, "home", ".openclaw");
  desktop = path.join(root, "desktop");
  scratch = path.join(root, "scratch");
  packageDir = path.join(root, "package");
  workspace = path.join(root, "outside workspace");
  await fs.mkdir(scratch);
  await write(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.10.5" }),
  );
  await write(
    path.join(packageDir, "node_modules/json5/index.js"),
    "module.exports = {parse: JSON.parse};",
  );
  await write(
    path.join(state, "openclaw.json"),
    JSON.stringify({ agents: { defaults: { workspace } } }),
  );
  environment = { ...process.env };
  process.env.OPENCLAW_STATE_DIR = state;
  process.env.OPENCLAW_HOME = path.dirname(state);
  const resources = { pluginResourceRoots: [], regenerableRoots: [] };
  adapter = {
    microclawRun: (callback) => callback(),
    microclawPlan: async () => ({
      stateDir: state,
      oauthDir: path.join(state, "credentials"),
      workspaceDirs: [workspace],
      resources,
      included: [],
      configCapture: { revalidate: async () => {} },
    }),
    microclawConfig: async () => {
      const capture = path.join(scratch, "config-capture");
      await fs.copyFile(path.join(state, "openclaw.json"), capture);
      return new Map([[capture, path.join(state, "openclaw.json")]]);
    },
    microclawSnapshot: async () => {
      const snapshot = path.join(scratch, "database.sqlite");
      await write(snapshot, "verified snapshot fixture");
      return {
        legacyAuditSnapshots: [],
        stateSqliteBackup: {
          inventory: {
            coreDatabases: [
              {
                role: "agent",
                sourcePath: path.join(state, "agents/main/agent/openclaw-agent.sqlite"),
              },
            ],
          },
          snapshots: [
            {
              sourcePath: snapshot,
              archiveSourcePath: path.join(state, "state/openclaw.sqlite"),
              skippedSourcePaths: new Set(),
            },
          ],
        },
      };
    },
  };
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
  Object.assign(process.env, environment);
  assert.ok(path.relative(path.resolve("build"), root).startsWith("whitelist-test-"));
  await fs.rm(root, { recursive: true, force: true });
});

async function run() {
  const output = path.join(scratch, "plan.json");
  const outcome = await createLightweightPlan(
    { packageDir, output, desktopDir: desktop },
    async () => adapter,
  );
  assert.equal(outcome.scope, BACKUP_SCOPE);
  return JSON.parse(await fs.readFile(output, "utf8"));
}

test("whitelist protects user files, external workspaces, credentials, cold sessions and desktop identity", async () => {
  const included = [
    "credentials/channel.json",
    "openclaw-weixin/accounts/account.json",
    "agents/main/sessions/session.jsonl.zst",
    "agents/legacy/agent/auth-profiles.json",
    "agents/legacy/sessions/session.jsonl",
    "media/image.png",
    "skills/custom/SKILL.md",
    "hooks/custom.js",
    "workspace/MEMORY.md",
    "cron/jobs.json",
    "skills_signing_key.pem",
  ];
  const omitted = [
    "models/large.gguf",
    "browser/profile/cookies",
    "_internal/old-installer.zip",
    "compile-cache/entry",
    "cache/models",
    "logs/gateway.log",
    "tmp/session",
    "tools/runtime",
    "extensions/plugin/node_modules/library/index.js",
  ];
  for (const relative of [...included, ...omitted]) await write(path.join(state, relative));
  await write(path.join(workspace, "logs/important-user-document.txt"));
  await fs.mkdir(path.join(workspace, "empty-directory"));
  await write(path.join(desktop, "settings.json"));
  await write(path.join(desktop, "windows-node/identity/device-key-ed25519.json"));
  await write(path.join(desktop, "windows-node/durable-approvals.json"));
  await write(path.join(desktop, "windows-node/activation-lease.json"));
  const plan = await run();
  const sources = new Set(plan.entries.map((entry) => entry.sourcePath));
  for (const relative of included) assert.ok(sources.has(path.join(state, relative)), relative);
  for (const relative of omitted) {
    assert.ok(!sources.has(path.join(state, relative)), relative);
    assert.equal(await fs.readFile(path.join(state, relative), "utf8"), "fixture");
  }
  assert.ok(sources.has(path.join(workspace, "logs/important-user-document.txt")));
  assert.ok(plan.directories.includes(path.join(workspace, "empty-directory")));
  assert.ok(sources.has(path.join(desktop, "settings.json")));
  assert.ok(sources.has(path.join(desktop, "windows-node/identity/device-key-ed25519.json")));
  assert.ok(sources.has(path.join(desktop, "windows-node/durable-approvals.json")));
  assert.ok(!sources.has(path.join(desktop, "windows-node/activation-lease.json")));
  const database = plan.entries.find(
    (entry) => entry.sourcePath === path.join(state, "state/openclaw.sqlite"),
  );
  assert.equal(database.kind, "verified-sqlite-or-audit");
  assert.ok(database.stagedPath.startsWith(scratch));
});

test("declared plugin data, external secrets, skill and hook directories are protected", async () => {
  const extraSkills = path.join(root, "extra-skills");
  const extraHooks = path.join(root, "extra-hooks");
  const secret = path.join(root, "private/secrets.json");
  const pluginData = path.join(state, "plugin-custom/data");
  await write(path.join(extraSkills, "SKILL.md"));
  await write(path.join(extraHooks, "hook.js"));
  await write(secret);
  await write(path.join(pluginData, "user-state.json"));
  const plan = await adapter.microclawPlan();
  plan.resources.pluginResourceRoots.push(pluginData);
  await write(
    path.join(state, "openclaw.json"),
    JSON.stringify({
      secrets: { providers: { custom: { source: "file", path: secret } } },
      skills: { load: { extraDirs: [extraSkills] } },
      hooks: { internal: { load: { extraDirs: [extraHooks] } } },
    }),
  );
  const result = await run();
  const sources = new Set(result.entries.map((entry) => entry.sourcePath));
  for (const filename of [
    secret,
    path.join(extraSkills, "SKILL.md"),
    path.join(extraHooks, "hook.js"),
    path.join(pluginData, "user-state.json"),
  ])
    assert.ok(sources.has(filename), filename);
});

test("unknown enabled plugins block replacement instead of silently omitting data", async () => {
  await write(
    path.join(state, "openclaw.json"),
    JSON.stringify({ plugins: { entries: { unclassified: { enabled: true } } } }),
  );
  await assert.rejects(run, /declared backup policy/);
});

test("declared disabled plugin state and agent data remain protected without dependencies", async () => {
  const directory = path.join(state, "extensions/custom-plugin");
  const plan = await adapter.microclawPlan();
  plan.resources.regenerableRoots.push({
    kind: "plugin dependencies",
    sourcePath: path.join(directory, "node_modules"),
  });
  await write(
    path.join(directory, "openclaw.plugin.json"),
    JSON.stringify({
      id: "custom-plugin",
      backupResources: [
        { disposition: "include", scope: "state", relativePath: "custom-data" },
        { disposition: "include", scope: "agent", relativePath: "plugin-data" },
      ],
    }),
  );
  await write(path.join(state, "custom-data/account.json"));
  await write(path.join(state, "agents/main/agent/plugin-data/state.json"));
  await write(path.join(directory, "node_modules/library/index.js"));
  const result = await run();
  const sources = new Set(result.entries.map((entry) => entry.sourcePath));
  assert.ok(sources.has(path.join(state, "custom-data/account.json")));
  assert.ok(sources.has(path.join(state, "agents/main/agent/plugin-data/state.json")));
  assert.ok(!sources.has(path.join(directory, "node_modules/library/index.js")));
});

test("plugin resource declarations cannot escape their ownership root", async () => {
  const directory = path.join(state, "extensions/custom-plugin");
  const plan = await adapter.microclawPlan();
  plan.resources.regenerableRoots.push({
    kind: "plugin dependencies",
    sourcePath: path.join(directory, "node_modules"),
  });
  await write(
    path.join(directory, "openclaw.plugin.json"),
    JSON.stringify({
      id: "custom-plugin",
      backupResources: [{ disposition: "include", scope: "state", relativePath: "../private" }],
    }),
  );
  await assert.rejects(run, /invalid backup resource declaration/);
});

test("configuration include files are preserved from the official captured include graph", async () => {
  const originalConfig = adapter.microclawConfig;
  const include = path.join(root, "outside-config/settings.json");
  await write(include, JSON.stringify({ models: { providers: {} } }));
  adapter.microclawConfig = async () => {
    const remaps = await originalConfig();
    const staged = path.join(scratch, "include-capture");
    await fs.copyFile(include, staged);
    remaps.set(staged, include);
    return remaps;
  };
  const result = await run();
  assert.ok(
    result.entries.some((entry) => entry.sourcePath === include && entry.kind === "config"),
  );
});

test("uncaptured SQLite appearing in a protected directory is refused", async () => {
  await write(path.join(state, "credentials/uncaptured.sqlite"));
  await assert.rejects(run, /not captured by OpenClaw/);
});

test("relative secret paths cannot silently select the wrong file", async () => {
  await write(
    path.join(state, "openclaw.json"),
    JSON.stringify({
      secrets: { providers: { custom: { source: "file", path: "ambiguous/secrets.json" } } },
    }),
  );
  await assert.rejects(run, /manual review/);
});

test("links out of a workspace are rejected rather than traversed", async () => {
  await fs.mkdir(workspace);
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(workspace, "linked"), "junction");
  await assert.rejects(run, /Linked backup path/);
});

test("backup destinations nested inside the actual user workspace are refused", async () => {
  adapter.microclawPlan = async () => ({
    stateDir: state,
    workspaceDirs: [root],
    resources: { pluginResourceRoots: [], regenerableRoots: [] },
    included: [],
  });
  await assert.rejects(run, /overlaps/);
});

test("unknown versions and altered snapshot source hashes are refused", async () => {
  await write(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.3" }),
  );
  await assert.rejects(() => loadSnapshotAdapter(packageDir), /Unreviewed/);
  await write(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.10.5" }),
  );
  await write(
    path.join(packageDir, "dist/backup-create-altered.mjs"),
    "export const modified = true;",
  );
  await assert.rejects(() => loadSnapshotAdapter(packageDir), /checksum changed/);
});
