import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  AGENT_CATALOG,
  getAgentOwnedSkillIds,
  matchesSkill,
  resolveSkillFilterNames,
} from "./agent-catalog";

const OWNERSHIP_MARKER = ".microclaw-agent-skill.json";

interface SkillOwnershipMarker {
  schemaVersion: 1;
  agentId: string;
  skillId: string;
  sourceDigest: string;
}

export interface AgentOwnedSkillInstall {
  skillId: string;
  destination: string;
  created: boolean;
  markerCreated: boolean;
}

export interface AgentOwnedSkillRemoval {
  skillId: string;
  destination: string;
  quarantine: string;
}

export interface AgentOwnedSkillReconciliation {
  installs: AgentOwnedSkillInstall[];
  removals: AgentOwnedSkillRemoval[];
  configChanged: boolean;
  runtimeChanged: boolean;
}

type AgentSkillsConfig = {
  agents?: { list?: unknown };
  skills?: { entries?: Record<string, { enabled?: boolean } & Record<string, unknown>> };
};

function assertPlainDirectoryTree(directory: string): void {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Agent skill path must be a regular directory: ${directory}`);
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const entryInfo = fs.lstatSync(entryPath);
    if (entryInfo.isSymbolicLink()) {
      throw new Error(`Agent skill packages cannot contain links: ${entryPath}`);
    }
    if (entryInfo.isDirectory()) {
      assertPlainDirectoryTree(entryPath);
    } else if (!entryInfo.isFile()) {
      throw new Error(`Unsupported agent skill package entry: ${entryPath}`);
    }
  }
}

function collectFileHashes(directory: string, root = directory): Map<string, string> {
  const hashes = new Map<string, string>();
  assertPlainDirectoryTree(directory);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === OWNERSHIP_MARKER) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [relativePath, digest] of collectFileHashes(entryPath, root)) {
        hashes.set(relativePath, digest);
      }
      continue;
    }
    const relativePath = path.relative(root, entryPath).replace(/\\/g, "/");
    const digest = createHash("sha256").update(fs.readFileSync(entryPath)).digest("hex");
    hashes.set(relativePath, digest);
  }
  return hashes;
}

function manifestDigest(hashes: Map<string, string>): string {
  const serialized = [...hashes.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([relativePath, digest]) => `${relativePath}\0${digest}`)
    .join("\n");
  return createHash("sha256").update(serialized).digest("hex");
}

function manifestsEqual(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [relativePath, digest] of left) {
    if (right.get(relativePath) !== digest) return false;
  }
  return true;
}

function copyDirectory(source: string, destination: string): void {
  fs.mkdirSync(destination);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else {
      fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    }
  }
}

function readOwnershipMarker(destination: string): SkillOwnershipMarker | null {
  const markerPath = path.join(destination, OWNERSHIP_MARKER);
  if (!fs.existsSync(markerPath)) return null;
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as SkillOwnershipMarker;
    return marker.schemaVersion === 1 &&
      typeof marker.agentId === "string" &&
      typeof marker.skillId === "string" &&
      typeof marker.sourceDigest === "string"
      ? marker
      : null;
  } catch {
    return null;
  }
}

function configReferencesSkill(config: AgentSkillsConfig, skillId: string): boolean {
  const list = config.agents?.list;
  if (!Array.isArray(list)) return false;
  return list.some((candidate) => {
    if (typeof candidate !== "object" || candidate === null) {
      return false;
    }
    if (!Object.hasOwn(candidate, "skills")) return true;
    if (!Array.isArray((candidate as { skills?: unknown }).skills)) return true;
    return (candidate as { skills: unknown[] }).skills.some(
      (value) => typeof value === "string" && matchesSkill(value, skillId),
    );
  });
}

export function resolveAgentOwnedSkillBundleRoot(
  packaged: boolean,
  resourcesPath: string,
  moduleDirectory = __dirname,
): string {
  return packaged
    ? path.join(resourcesPath, "agent-skills")
    : path.resolve(moduleDirectory, "../../skills");
}

export function installAgentOwnedSkills(
  agentId: string,
  stateDirectory: string,
  bundleRoot: string,
  options: { preserveModified?: boolean } = {},
): AgentOwnedSkillInstall[] {
  const installed: AgentOwnedSkillInstall[] = [];
  try {
    for (const skillId of getAgentOwnedSkillIds(agentId)) {
      const source = path.join(bundleRoot, skillId);
      if (!fs.existsSync(source)) {
        throw new Error(`Agent skill package is missing: ${source}`);
      }
      const sourceHashes = collectFileHashes(source);
      if (sourceHashes.size === 0) {
        throw new Error(`Agent skill package is empty: ${source}`);
      }

      const skillsDirectory = path.join(stateDirectory, "skills");
      fs.mkdirSync(skillsDirectory, { recursive: true });
      const destination = path.join(skillsDirectory, skillId);
      if (fs.existsSync(destination)) {
        const destinationHashes = collectFileHashes(destination);
        const sourceDigest = manifestDigest(sourceHashes);
        const existingMarker = readOwnershipMarker(destination);
        if (!manifestsEqual(sourceHashes, destinationHashes)) {
          if (options.preserveModified) {
            installed.push({
              skillId,
              destination,
              created: false,
              markerCreated: false,
            });
            continue;
          }
          throw new Error(
            `Existing skill "${skillId}" differs from the packaged Creative Muse skill`,
          );
        }
        let markerCreated = false;
        if (existingMarker) {
          if (
            existingMarker.agentId !== agentId ||
            existingMarker.skillId !== skillId ||
            existingMarker.sourceDigest !== sourceDigest
          ) {
            throw new Error(`Existing skill "${skillId}" has conflicting ownership metadata`);
          }
        } else {
          const marker: SkillOwnershipMarker = {
            schemaVersion: 1,
            agentId,
            skillId,
            sourceDigest,
          };
          fs.writeFileSync(
            path.join(destination, OWNERSHIP_MARKER),
            `${JSON.stringify(marker, null, 2)}\n`,
            "utf-8",
          );
          markerCreated = true;
        }
        installed.push({
          skillId,
          destination,
          created: false,
          markerCreated,
        });
        continue;
      }

      const staging = `${destination}.install-${process.pid}-${Date.now()}`;
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
      try {
        copyDirectory(source, staging);
        const marker: SkillOwnershipMarker = {
          schemaVersion: 1,
          agentId,
          skillId,
          sourceDigest: manifestDigest(sourceHashes),
        };
        fs.writeFileSync(
          path.join(staging, OWNERSHIP_MARKER),
          `${JSON.stringify(marker, null, 2)}\n`,
          "utf-8",
        );
        fs.renameSync(staging, destination);
      } finally {
        if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
      }
      installed.push({
        skillId,
        destination,
        created: true,
        markerCreated: false,
      });
    }
    return installed;
  } catch (error) {
    rollbackAgentOwnedSkillInstalls(installed);
    throw error;
  }
}

export function rollbackAgentOwnedSkillInstalls(installs: AgentOwnedSkillInstall[]): void {
  for (const install of [...installs].reverse()) {
    if (install.created && fs.existsSync(install.destination)) {
      fs.rmSync(install.destination, { recursive: true, force: true });
    } else if (install.markerCreated) {
      const markerPath = path.join(install.destination, OWNERSHIP_MARKER);
      if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
    }
  }
}

export function setAgentOwnedSkillsEnabled(
  config: AgentSkillsConfig,
  agentId: string,
  enabled: boolean,
): boolean {
  const ownedSkillIds = getAgentOwnedSkillIds(agentId);
  if (ownedSkillIds.length === 0) return false;
  config.skills ??= {};
  config.skills.entries ??= {};
  let changed = false;
  for (const skillId of ownedSkillIds) {
    const entry = config.skills.entries[skillId] ?? {};
    if (entry.enabled !== enabled) {
      entry.enabled = enabled;
      changed = true;
    }
    config.skills.entries[skillId] = entry;
  }
  return changed;
}

export function prepareUnusedAgentOwnedSkillRemoval(
  config: AgentSkillsConfig,
  agentId: string,
  stateDirectory: string,
  bundleRoot?: string,
): AgentOwnedSkillRemoval[] {
  const removals: AgentOwnedSkillRemoval[] = [];
  try {
    for (const skillId of getAgentOwnedSkillIds(agentId)) {
      if (configReferencesSkill(config, skillId)) continue;
      const destination = path.join(stateDirectory, "skills", skillId);
      if (!fs.existsSync(destination)) continue;
      const marker = readOwnershipMarker(destination);
      if (!marker || marker.agentId !== agentId || marker.skillId !== skillId) continue;
      let trustedSourceDigest: string | null = null;
      if (bundleRoot) {
        const source = path.join(bundleRoot, skillId);
        if (fs.existsSync(source)) {
          trustedSourceDigest = manifestDigest(collectFileHashes(source));
        }
      }
      const currentDigest = manifestDigest(collectFileHashes(destination));
      if (!trustedSourceDigest || currentDigest !== trustedSourceDigest) continue;

      const quarantineRoot = path.join(stateDirectory, ".agent-skill-quarantine");
      fs.mkdirSync(quarantineRoot, { recursive: true });
      const quarantine = path.join(quarantineRoot, `${skillId}-${process.pid}-${Date.now()}`);
      fs.renameSync(destination, quarantine);
      removals.push({ skillId, destination, quarantine });
    }
    return removals;
  } catch (error) {
    rollbackAgentOwnedSkillRemovals(removals);
    throw error;
  }
}

export function commitAgentOwnedSkillRemovals(removals: AgentOwnedSkillRemoval[]): string[] {
  const deferredCleanup: string[] = [];
  for (const removal of removals) {
    try {
      if (fs.existsSync(removal.quarantine)) {
        fs.rmSync(removal.quarantine, { recursive: true, force: true });
      }
      const quarantineRoot = path.dirname(removal.quarantine);
      if (fs.existsSync(quarantineRoot) && fs.readdirSync(quarantineRoot).length === 0) {
        fs.rmdirSync(quarantineRoot);
      }
    } catch {
      deferredCleanup.push(removal.quarantine);
    }
  }
  return deferredCleanup;
}

export function rollbackAgentOwnedSkillRemovals(removals: AgentOwnedSkillRemoval[]): void {
  for (const removal of [...removals].reverse()) {
    if (fs.existsSync(removal.quarantine) && !fs.existsSync(removal.destination)) {
      fs.renameSync(removal.quarantine, removal.destination);
    }
    const quarantineRoot = path.dirname(removal.quarantine);
    if (fs.existsSync(quarantineRoot) && fs.readdirSync(quarantineRoot).length === 0) {
      fs.rmdirSync(quarantineRoot);
    }
  }
}

export function disableUnreferencedAgentOwnedSkills(
  config: AgentSkillsConfig,
  agentId: string,
): boolean {
  let changed = false;
  for (const skillId of getAgentOwnedSkillIds(agentId)) {
    if (configReferencesSkill(config, skillId)) continue;
    const entry = config.skills?.entries?.[skillId];
    if (!entry) continue;
    if (entry.enabled !== false) {
      entry.enabled = false;
      changed = true;
    }
  }
  return changed;
}

export function agentOwnedSkillMatchNames(agentId: string): string[] {
  return resolveSkillFilterNames([...getAgentOwnedSkillIds(agentId)]);
}

export function reconcileConfiguredAgentOwnedSkills(
  config: AgentSkillsConfig,
  stateDirectory: string,
  bundleRoot: string,
): AgentOwnedSkillReconciliation {
  const installs: AgentOwnedSkillInstall[] = [];
  const removals: AgentOwnedSkillRemoval[] = [];
  let configChanged = false;
  const configuredAgentIds = new Set(
    Array.isArray(config.agents?.list)
      ? config.agents.list.flatMap((candidate) =>
          typeof candidate === "object" &&
          candidate !== null &&
          typeof (candidate as { id?: unknown }).id === "string"
            ? [(candidate as { id: string }).id]
            : [],
        )
      : [],
  );
  try {
    for (const agent of AGENT_CATALOG) {
      if (getAgentOwnedSkillIds(agent.id).length === 0) continue;
      if (configuredAgentIds.has(agent.id)) {
        installs.push(
          ...installAgentOwnedSkills(agent.id, stateDirectory, bundleRoot, {
            preserveModified: true,
          }),
        );
        configChanged = setAgentOwnedSkillsEnabled(config, agent.id, true) || configChanged;
      } else {
        removals.push(
          ...prepareUnusedAgentOwnedSkillRemoval(config, agent.id, stateDirectory, bundleRoot),
        );
        configChanged = disableUnreferencedAgentOwnedSkills(config, agent.id) || configChanged;
      }
    }
    return {
      installs,
      removals,
      configChanged,
      runtimeChanged:
        configChanged || installs.some((install) => install.created) || removals.length > 0,
    };
  } catch (error) {
    rollbackAgentOwnedSkillInstalls(installs);
    rollbackAgentOwnedSkillRemovals(removals);
    throw error;
  }
}
