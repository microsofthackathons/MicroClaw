import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalAgentId, LEGACY_AGENT_ID_ALIASES } from "./agent-catalog";
import {
  resolveAgentPersonaWorkspace,
  resolveUserPath,
  type AgentRosterConfig,
} from "./agent-personas";
import { readAgentRoster } from "./agent-roster";
import type { WindowsNodeMxcFolderPolicy } from "./windows-node-mxc-folder-transaction";

export function getWorkspaceParent(homeDir = os.homedir()): string {
  return path.join(homeDir, "OpenClawWorkspaces");
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export interface AgentWorkspacePlan {
  config: AgentRosterConfig;
  changed: boolean;
  parent: string;
  workspaces: Array<{ source: string | null; destination: string }>;
}

/** Resolve the old layout before changing defaults, including doctor's explicit ownership. */
export function planAgentWorkspaces(
  original: AgentRosterConfig,
  stateDir: string,
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): AgentWorkspacePlan {
  const config = structuredClone(original);
  const agents = config.agents;
  if (!agents) throw new Error("Agent workspace preparation requires an agent roster");
  const parent = getWorkspaceParent(homeDir);
  const workspaces = new Map<string, { source: string | null; destination: string }>();
  const roster = readAgentRoster(agents);
  for (const { id, config: entry } of roster) {
    if (entry.workspace !== undefined && typeof entry.workspace !== "string") {
      throw new Error(`Invalid workspace configuration for agent "${id}"`);
    }
    const hasWorkspace = typeof entry.workspace === "string" && !!entry.workspace.trim();
    const canonicalId = canonicalAgentId(id);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(canonicalId)) {
      throw new Error(`Invalid workspace agent id "${id}"`);
    }
    const current = resolveAgentPersonaWorkspace(
      original,
      stateDir,
      { id, name: id, skills: [] },
      env,
      homeDir,
      cwd,
    );
    const destination = path.join(parent, canonicalId);
    const ids = [
      canonicalId,
      ...Object.entries(LEGACY_AGENT_ID_ALIASES)
        .filter(([, target]) => target === canonicalId)
        .map(([alias]) => alias),
    ];
    const legacy = [
      path.join(stateDir, "workspace"),
      ...ids.flatMap((agentId) => [
        path.join(stateDir, `workspace-${agentId}`),
        path.join(stateDir, "workspace", agentId),
      ]),
    ].some((candidate) => pathKey(candidate) === pathKey(current));
    const managed =
      legacy ||
      pathKey(current) === pathKey(destination) ||
      (pathKey(current) === pathKey(parent) && !hasWorkspace);
    if (!managed) {
      // Materialize inherited custom paths before changing the roster/defaults again.
      if (!hasWorkspace) entry.workspace = current;
      continue;
    }
    const source = legacy ? current : null;
    const previous = workspaces.get(pathKey(destination));
    if (previous?.source && source && pathKey(previous.source) !== pathKey(source)) {
      throw new Error(`Agent aliases have conflicting legacy workspaces for "${canonicalId}"`);
    }
    workspaces.set(pathKey(destination), {
      source: previous?.source ?? source,
      destination,
    });
    entry.workspace = destination;
  }
  const defaults = agents.defaults;
  if (
    defaults !== undefined &&
    (!defaults || typeof defaults !== "object" || Array.isArray(defaults))
  ) {
    throw new Error("Invalid agents.defaults configuration");
  }
  const nextDefaults = (defaults ?? {}) as Record<string, unknown>;
  const previousDefault = nextDefaults.workspace;
  if (previousDefault !== undefined && typeof previousDefault !== "string") {
    throw new Error("Invalid agents.defaults.workspace configuration");
  }
  if (
    previousDefault === undefined ||
    (typeof previousDefault === "string" &&
      (!previousDefault.trim() ||
        pathKey(resolveUserPath(previousDefault, env, homeDir, cwd)) ===
          pathKey(path.join(stateDir, "workspace"))))
  ) {
    agents.defaults = { ...nextDefaults, workspace: parent };
  }
  return {
    config,
    parent,
    changed: JSON.stringify(config) !== JSON.stringify(original),
    workspaces: [...workspaces.values()],
  };
}

function metadataOrMissing(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

export function ensureWorkspaceParent(parent: string): void {
  fs.mkdirSync(parent, { recursive: true });
  if (
    !fs.lstatSync(parent).isDirectory() ||
    fs.lstatSync(parent).isSymbolicLink() ||
    pathKey(fs.realpathSync.native(parent)) !== pathKey(parent)
  ) {
    throw new Error(`Workspace parent must be a plain, canonical directory: ${parent}`);
  }
}

function workspaceDigest(directory: string): string {
  if (
    !fs.lstatSync(directory).isDirectory() ||
    pathKey(fs.realpathSync.native(directory)) !== pathKey(directory)
  ) {
    throw new Error(`Workspace migration refuses a redirected directory: ${directory}`);
  }
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(256 * 1024);
  const visit = (relative: string) => {
    const filePath = path.join(directory, relative);
    const stat = fs.lstatSync(filePath);
    if (
      stat.isSymbolicLink() ||
      (!stat.isDirectory() && !stat.isFile()) ||
      (stat.nlink > 1 && stat.isFile())
    ) {
      throw new Error(`Workspace migration requires ordinary files and directories: ${filePath}`);
    }
    hash.update(
      JSON.stringify([
        relative,
        stat.isDirectory() ? "directory" : "file",
        stat.isFile() ? stat.size : 0,
      ]),
    );
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(filePath).sort()) visit(path.join(relative, name));
    } else {
      const fd = fs.openSync(filePath, "r");
      try {
        let count: number;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
          hash.update(buffer.subarray(0, count));
        }
      } finally {
        fs.closeSync(fd);
      }
    }
  };
  visit("");
  return hash.digest("hex");
}

/** Copy, verify, then publish. Never delete sources or merge into existing destinations. */
export function materializeAgentWorkspaces(plan: AgentWorkspacePlan): void {
  ensureWorkspaceParent(plan.parent);
  for (const { source, destination } of plan.workspaces) {
    if (pathKey(path.dirname(destination)) !== pathKey(plan.parent)) {
      throw new Error("Managed workspaces must be direct children of the workspace parent");
    }
    const existing = metadataOrMissing(destination);
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
      throw new Error(`Workspace destination must be a plain directory: ${destination}`);
    }
    if (!source || !metadataOrMissing(source)) {
      fs.mkdirSync(destination, { recursive: true });
      continue;
    }
    const expected = workspaceDigest(source);
    if (existing) {
      if (workspaceDigest(destination) !== expected) {
        throw new Error(
          `Workspace migration conflict: ${destination} differs from ${source}. Originals were preserved; resolve the destination before retrying.`,
        );
      }
      continue;
    }
    const staging = path.join(plan.parent, `.microclaw-workspace-${randomUUID()}`);
    try {
      fs.cpSync(source, staging, { recursive: true, force: false, errorOnExist: true });
      if (workspaceDigest(staging) !== expected || workspaceDigest(source) !== expected) {
        throw new Error(`Workspace changed during migration: ${source}. Retry while it is idle.`);
      }
      if (metadataOrMissing(destination)) {
        throw new Error(`Workspace destination appeared during migration: ${destination}`);
      }
      fs.renameSync(staging, destination);
    } finally {
      if (metadataOrMissing(staging)) fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}

export function planDefaultWorkspaceFolderGrant(
  folders: WindowsNodeMxcFolderPolicy,
  parent: string,
): WindowsNodeMxcFolderPolicy {
  const contains = (root: string, candidate: string) => {
    const relative = path.win32.relative(root, candidate);
    return (
      relative === "" ||
      (!relative.startsWith("..\\") && relative !== ".." && !path.win32.isAbsolute(relative))
    );
  };
  // Do not widen an explicitly saved RO boundary, including children of the new parent.
  if (
    folders.ro.some((root) => contains(root, parent) || contains(parent, root)) ||
    folders.rw.some((root) => contains(root, parent))
  ) {
    return { rw: [...folders.rw], ro: [...folders.ro] };
  }
  return { rw: [...folders.rw, parent], ro: [...folders.ro] };
}
