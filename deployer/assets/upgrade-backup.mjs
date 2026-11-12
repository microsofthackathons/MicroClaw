import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BACKUP_SCOPE = "microclaw-lightweight-v1";
const SNAPSHOT_CONTRACTS = {
  "2026.10.5": "10fafe010bd0f652d6724c42336019f4523dfee2c4c758592837f66e30a76318",
  "2026.10.10": "f34479b2349d5462d1d649593d3202db9f713b5bad739b88725a6f9bf449966d",
};
const STATE_PATHS = [
  "openclaw.json",
  "openclaw.json.last-good",
  ".env",
  "config-journal-fingerprint.key",
  "device-identity.json",
  "identity",
  "devices",
  "credentials",
  "openclaw-weixin",
  "media",
  "skills",
  "hooks",
  "workspace",
  "cron/jobs.json",
  "skill_catalog.json",
  "managed_skill_catalog.json",
  "microclaw-search-setup.json",
  "skills_snapshot.json",
  "skills_snapshot.sig",
  "skills_signing_key.pem",
  "skills_signing_key.pub",
];
const DESKTOP_PATHS = [
  "config.json",
  "settings.json",
  "windows-node/identity",
  "windows-node/policy.json",
  "windows-node/durable-approvals.json",
  "windows-node/command-consent/exec-approvals.json",
];
const AGENT_PATHS = ["auth-profiles.json", "auth.json", "models.json", "workshop-skills"];

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function exists(filename) {
  try {
    return await fs.lstat(filename);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadSnapshotAdapter(packageDir) {
  const metadata = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8"));
  const expected = SNAPSHOT_CONTRACTS[metadata.version];
  if (metadata.name !== "openclaw" || !expected)
    throw new Error(
      "Unreviewed OpenClaw snapshot version; use a reviewed installer or a manual full backup.",
    );
  const directory = path.join(packageDir, "dist");
  for (const name of (await fs.readdir(directory)).filter((name) =>
    /^backup-create-[\w-]+\.mjs$/.test(name),
  )) {
    const filename = path.join(directory, name);
    const source = await fs.readFile(filename, "utf8");
    if (createHash("sha256").update(source).digest("hex") !== expected) continue;
    const url = pathToFileURL(filename).href;
    const hook = registerHooks({
      load(candidate, context, nextLoad) {
        const loaded = nextLoad(candidate, context);
        if (candidate !== url) return loaded;
        return {
          ...loaded,
          source: `${source}\nexport { resolveBackupPlanFromDisk as microclawPlan, createConsistentStateSnapshotPlan as microclawSnapshot, stageBackupConfigCapture as microclawConfig };\nexport const microclawRun = typeof withCommandProcessScope === "function" ? withCommandProcessScope : callback => callback();`,
        };
      },
    });
    try {
      return await import(url);
    } finally {
      hook.deregister();
    }
  }
  throw new Error("OpenClaw snapshot source checksum changed; no runtime replacement is allowed.");
}

function referencedPaths(value, roots, trail = []) {
  if (!value || typeof value !== "object") return;
  const resolve = (filename) => {
    const expanded = filename.replace(/\$\{([^}]+)\}/g, (_match, variable) => {
      if (!process.env[variable]) throw new Error(`Unresolved backup path variable: ${variable}`);
      return process.env[variable];
    });
    if (expanded.startsWith("~/") || expanded.startsWith("~\\"))
      return path.resolve(process.env.OPENCLAW_HOME, expanded.slice(2));
    if (!path.isAbsolute(expanded))
      throw new Error(`Relative custom backup path requires manual review: ${expanded}`);
    return expanded;
  };
  if (value.source === "file" && typeof value.path === "string")
    roots.push({ sourcePath: resolve(value.path), kind: "secret" });
  if (
    Array.isArray(value.extraDirs) &&
    (trail.join(".") === "skills.load" || trail.join(".") === "hooks.internal.load")
  ) {
    for (const filename of value.extraDirs)
      roots.push({ sourcePath: resolve(filename), kind: "custom-user-content" });
  }
  for (const [key, child] of Object.entries(value)) referencedPaths(child, roots, [...trail, key]);
}

export async function createLightweightPlan(
  { packageDir, output, desktopDir },
  loadAdapter = loadSnapshotAdapter,
) {
  const adapter = await loadAdapter(packageDir);
  return adapter.microclawRun(async () => {
    const scratch = path.dirname(output);
    const plan = await adapter.microclawPlan({ includeWorkspace: true, onlyConfig: false });
    const stateDir = path.resolve(plan.stateDir);
    if (stateDir !== path.resolve(process.env.OPENCLAW_STATE_DIR))
      throw new Error("Unexpected state root in backup plan");
    const roots = STATE_PATHS.map((relative) => ({
      sourcePath: path.join(stateDir, relative),
      kind: "state",
    }));
    roots.push(
      ...DESKTOP_PATHS.map((relative) => ({
        sourcePath: path.join(desktopDir, relative),
        kind: "desktop",
      })),
    );
    roots.push(...plan.workspaceDirs.map((sourcePath) => ({ sourcePath, kind: "workspace" })));
    roots.push({ sourcePath: plan.oauthDir, kind: "credentials" });
    roots.push(
      ...plan.resources.pluginResourceRoots.map((sourcePath) => ({
        sourcePath,
        kind: "plugin-data",
      })),
    );
    roots.push(
      ...plan.included
        .filter((asset) => asset.kind === "managed skill")
        .map((asset) => ({ sourcePath: asset.sourcePath, kind: "managed-skill" })),
    );
    if (roots.some((root) => inside(root.sourcePath, scratch)))
      throw new Error("Backup output overlaps a protected user directory");
    const configRemaps = await adapter.microclawConfig(plan.configCapture, scratch);
    const require = createRequire(path.join(packageDir, "package.json"));
    const json5 = require("json5");
    const configValues = [];
    for (const [staged] of configRemaps) {
      const value = json5.parse(await fs.readFile(staged, "utf8"));
      configValues.push(value);
      referencedPaths(value, roots);
    }
    const knownPlugins = new Set(["openclaw-weixin", "llama-cpp"]);
    const declaredPlugins = new Set(
      plan.resources.regenerableRoots
        .filter((resource) => resource.kind === "plugin dependencies")
        .map((resource) => path.dirname(resource.sourcePath)),
    );
    const agentPluginResources = [];
    const declaredPluginIds = new Set();
    for (const directory of declaredPlugins) {
      const manifest = JSON.parse(
        await fs.readFile(path.join(directory, "openclaw.plugin.json"), "utf8"),
      );
      declaredPluginIds.add(manifest.id);
      if (!knownPlugins.has(manifest.id) && !Array.isArray(manifest.backupResources))
        throw new Error(
          `Plugin ${manifest.id} has no declared backup resources; classify its persistent data before upgrading.`,
        );
      for (const resource of manifest.backupResources ?? []) {
        const relative = resource.relativePath;
        if (
          typeof relative !== "string" ||
          relative.includes("\\") ||
          path.posix.isAbsolute(relative) ||
          path.posix.normalize(relative) !== relative ||
          relative === "." ||
          relative === ".." ||
          relative.startsWith("../") ||
          !["include", "exclude"].includes(resource.disposition) ||
          !["state", "agent"].includes(resource.scope)
        )
          throw new Error(`Plugin ${manifest.id} has an invalid backup resource declaration.`);
        if (resource.disposition !== "include") continue;
        if (resource.scope === "state")
          roots.push({
            sourcePath: path.join(stateDir, ...relative.split("/")),
            kind: "plugin-data",
          });
        else agentPluginResources.push(relative);
      }
    }
    for (const value of configValues) {
      for (const [id, entry] of Object.entries(value.plugins?.entries ?? {})) {
        if (entry?.enabled === true && !knownPlugins.has(id) && !declaredPluginIds.has(id))
          throw new Error(
            `Plugin ${id} needs a declared backup policy before lightweight upgrade.`,
          );
      }
    }
    process.stderr.write(
      "Creating verified OpenClaw SQLite snapshots (configuration, tasks, sessions and credentials).\n",
    );
    const pluginRoots = roots
      .filter((root) => root.kind === "plugin-data")
      .map((root) => root.sourcePath);
    for (const agent of plan.resources.agentRoots ?? []) {
      pluginRoots.push(
        ...agentPluginResources.map((relative) =>
          path.join(agent.sourcePath, ...relative.split("/")),
        ),
      );
    }
    const resources = {
      ...plan.resources,
      protectedPaths: [...new Set([...(plan.resources.protectedPaths ?? []), ...pluginRoots])],
      pluginResourceRoots: [...new Set([...plan.resources.pluginResourceRoots, ...pluginRoots])],
    };
    const captured = await adapter.microclawSnapshot({
      resources,
      stateDir,
      tempDir: scratch,
      onlyConfig: false,
    });
    const { inventory, snapshots } = captured.stateSqliteBackup;
    for (const owner of inventory.coreDatabases) {
      if (owner.role !== "agent") continue;
      const agentRoot = path.dirname(owner.sourcePath);
      if (path.basename(agentRoot) === "agent")
        roots.push({
          sourcePath: path.join(path.dirname(agentRoot), "sessions"),
          kind: "sessions",
        });
      roots.push(
        ...AGENT_PATHS.map((relative) => ({
          sourcePath: path.join(agentRoot, relative),
          kind: "agent",
        })),
      );
      roots.push(
        ...agentPluginResources.map((relative) => ({
          sourcePath: path.join(agentRoot, ...relative.split("/")),
          kind: "plugin-data",
        })),
      );
    }
    const agentsDir = path.join(stateDir, "agents");
    if (await exists(agentsDir)) {
      for (const entry of await fs.readdir(agentsDir, { withFileTypes: true })) {
        if (!entry.isDirectory())
          throw new Error(`Unexpected agent directory entry: ${entry.name}`);
        const directory = path.join(agentsDir, entry.name);
        roots.push({ sourcePath: path.join(directory, "sessions"), kind: "sessions" });
        roots.push(
          ...AGENT_PATHS.map((relative) => ({
            sourcePath: path.join(directory, "agent", relative),
            kind: "agent",
          })),
        );
      }
    }
    if (roots.some((root) => inside(root.sourcePath, scratch)))
      throw new Error("Backup output overlaps a protected user directory");
    const replacements = new Map(
      configRemaps
        .entries()
        .map(([staged, original]) => [path.resolve(original), { staged, kind: "config" }]),
    );
    const skipped = new Set();
    for (const snapshot of [...snapshots, ...captured.legacyAuditSnapshots]) {
      replacements.set(path.resolve(snapshot.archiveSourcePath), {
        staged: snapshot.sourcePath,
        kind: "verified-sqlite-or-audit",
      });
      for (const sourcePath of snapshot.skippedSourcePaths ?? [])
        skipped.add(path.resolve(sourcePath));
    }
    for (const sourcePath of replacements.keys()) roots.push({ sourcePath, kind: "snapshot" });
    const selected = new Map();
    const directories = new Set();
    async function visit(sourcePath, kind, ancestors = new Set()) {
      sourcePath = path.resolve(sourcePath);
      if (selected.has(sourcePath) || directories.has(sourcePath)) return;
      const replacement = replacements.get(sourcePath);
      if (replacement) {
        selected.set(sourcePath, {
          sourcePath,
          stagedPath: replacement.staged,
          kind: replacement.kind,
        });
        return;
      }
      if (skipped.has(sourcePath)) return;
      const stat = await exists(sourcePath);
      if (!stat) return;
      if (stat.isSymbolicLink() || (await fs.realpath(sourcePath)) !== sourcePath)
        throw new Error(`Linked backup path requires manual review: ${sourcePath}`);
      if (ancestors.has(sourcePath)) throw new Error(`Backup directory cycle: ${sourcePath}`);
      if (stat.isDirectory()) {
        directories.add(sourcePath);
        const next = new Set([...ancestors, sourcePath]);
        for (const name of (await fs.readdir(sourcePath)).sort())
          await visit(path.join(sourcePath, name), kind, next);
      } else if (stat.isFile()) {
        if (/\.sqlite(?:[.-].*)?$/.test(sourcePath) && inside(stateDir, sourcePath)) {
          if (
            /\.(?:bak|seal)$/.test(sourcePath) ||
            /\.pre-[^/\\]+\.bak$/.test(sourcePath) ||
            /(?:-wal|-shm|-journal|\.lock)$/.test(sourcePath)
          )
            return;
          throw new Error(`SQLite source was not captured by OpenClaw: ${sourcePath}`);
        }
        selected.set(sourcePath, { sourcePath, stagedPath: sourcePath, kind });
      } else throw new Error(`Unsupported backup entry: ${sourcePath}`);
    }
    for (const root of roots) await visit(root.sourcePath, root.kind);
    await plan.configCapture?.revalidate();
    const report = {
      scope: BACKUP_SCOPE,
      sourceVersion: JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8"))
        .version,
      stateDir,
      desktopDir: path.resolve(desktopDir),
      workspaceDirs: plan.workspaceDirs,
      sqliteSnapshots: snapshots.length,
      verifiedSqlite: true,
      entries: [...selected.values()],
      directories: [...directories].sort(),
      excluded: [
        "models",
        "browser",
        "_internal",
        "compile-cache",
        "cache",
        "logs",
        "tmp",
        "tools",
        "npm",
        "runtime and plugin dependencies",
      ],
      recoveryNotes: [
        "Lightweight upgrade recovery point, not an official full backup archive.",
        "Do not overwrite live databases or restore approvals/leases without owner validation.",
      ],
    };
    await fs.writeFile(output, JSON.stringify(report), { flag: "wx", mode: 0o600 });
    process.stderr.write(
      `Selected ${report.entries.length} files; ${snapshots.length} verified database snapshot artifacts. Models, browser profiles and installer/runtime caches are excluded.\n`,
    );
    return { scope: BACKUP_SCOPE, planPath: output, stateDir, verifiedSqlite: true };
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    const option = (name) => {
      const index = args.indexOf(name);
      if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`);
      return path.resolve(args[index + 1]);
    };
    const result = await createLightweightPlan({
      packageDir: option("--package"),
      output: option("--output"),
      desktopDir: option("--desktop"),
    });
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
