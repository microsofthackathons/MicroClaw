import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  AGENT_CATALOG,
  getAgentOwnedSkillIds,
  matchesSkill,
  resolveSkillFilterNames,
} from "./agent-catalog";

export const AGENT_OWNED_SKILL_MARKER = ".microclaw-agent-skill.json";

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
  upgraded: boolean;
  backup?: string;
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

export interface AgentOwnedSkillReconciliationPlan {
  required: boolean;
  reasons: string[];
}

interface AgentOwnedSkillTrust {
  isTrustedInstalledSkill?: (skillId: string, destination: string) => boolean;
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
    if (entry.name === AGENT_OWNED_SKILL_MARKER) continue;
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
  const markerPath = path.join(destination, AGENT_OWNED_SKILL_MARKER);
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

function writeOwnershipMarker(
  destination: string,
  agentId: string,
  skillId: string,
  sourceDigest: string,
): void {
  const marker: SkillOwnershipMarker = {
    schemaVersion: 1,
    agentId,
    skillId,
    sourceDigest,
  };
  fs.writeFileSync(
    path.join(destination, AGENT_OWNED_SKILL_MARKER),
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf-8",
  );
}

function createQuarantinePath(
  stateDirectory: string,
  skillId: string,
  operation: "upgrade" | "remove",
): string {
  const quarantineRoot = path.join(stateDirectory, ".agent-skill-quarantine");
  fs.mkdirSync(quarantineRoot, { recursive: true });
  return path.join(quarantineRoot, `${skillId}-${operation}-${process.pid}-${Date.now()}`);
}

function installPackagedSkill(
  source: string,
  destination: string,
  agentId: string,
  skillId: string,
  sourceDigest: string,
): void {
  const staging = `${destination}.install-${process.pid}-${Date.now()}`;
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  try {
    copyDirectory(source, staging);
    writeOwnershipMarker(staging, agentId, skillId, sourceDigest);
    fs.renameSync(staging, destination);
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function hasAgentOwnedSkillMarker(stateDirectory: string, skillId: string): boolean {
  return fs.existsSync(path.join(stateDirectory, "skills", skillId, AGENT_OWNED_SKILL_MARKER));
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
  options: { preserveModified?: boolean } & AgentOwnedSkillTrust = {},
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
      const sourceDigest = manifestDigest(sourceHashes);

      const skillsDirectory = path.join(stateDirectory, "skills");
      fs.mkdirSync(skillsDirectory, { recursive: true });
      const destination = path.join(skillsDirectory, skillId);
      if (fs.existsSync(destination)) {
        const destinationHashes = collectFileHashes(destination);
        const destinationDigest = manifestDigest(destinationHashes);
        const existingMarker = readOwnershipMarker(destination);
        if (!manifestsEqual(sourceHashes, destinationHashes)) {
          const cleanOwnedVersion =
            existingMarker?.agentId === agentId &&
            existingMarker.skillId === skillId &&
            existingMarker.sourceDigest === destinationDigest &&
            options.isTrustedInstalledSkill?.(skillId, destination) === true;
          if (cleanOwnedVersion) {
            const backup = createQuarantinePath(stateDirectory, skillId, "upgrade");
            fs.renameSync(destination, backup);
            try {
              installPackagedSkill(source, destination, agentId, skillId, sourceDigest);
            } catch (error) {
              if (fs.existsSync(destination)) {
                fs.rmSync(destination, { recursive: true, force: true });
              }
              fs.renameSync(backup, destination);
              throw error;
            }
            installed.push({
              skillId,
              destination,
              created: false,
              markerCreated: false,
              upgraded: true,
              backup,
            });
            continue;
          }
          if (options.preserveModified) {
            installed.push({
              skillId,
              destination,
              created: false,
              markerCreated: false,
              upgraded: false,
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
          writeOwnershipMarker(destination, agentId, skillId, sourceDigest);
          markerCreated = true;
        }
        installed.push({
          skillId,
          destination,
          created: false,
          markerCreated,
          upgraded: false,
        });
        continue;
      }

      installPackagedSkill(source, destination, agentId, skillId, sourceDigest);
      installed.push({
        skillId,
        destination,
        created: true,
        markerCreated: false,
        upgraded: false,
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
    if (install.upgraded && install.backup) {
      if (fs.existsSync(install.destination)) {
        fs.rmSync(install.destination, { recursive: true, force: true });
      }
      if (fs.existsSync(install.backup)) {
        fs.renameSync(install.backup, install.destination);
      }
    } else if (install.created && fs.existsSync(install.destination)) {
      fs.rmSync(install.destination, { recursive: true, force: true });
    } else if (install.markerCreated) {
      const markerPath = path.join(install.destination, AGENT_OWNED_SKILL_MARKER);
      if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
    }
  }
}

export function commitAgentOwnedSkillInstalls(installs: AgentOwnedSkillInstall[]): string[] {
  const deferredCleanup: string[] = [];
  for (const install of installs) {
    if (!install.upgraded || !install.backup) continue;
    try {
      if (fs.existsSync(install.backup)) {
        fs.rmSync(install.backup, { recursive: true, force: true });
      }
      const quarantineRoot = path.dirname(install.backup);
      if (fs.existsSync(quarantineRoot) && fs.readdirSync(quarantineRoot).length === 0) {
        fs.rmdirSync(quarantineRoot);
      }
    } catch {
      deferredCleanup.push(install.backup);
    }
  }
  return deferredCleanup;
}

export function agentOwnedSkillInstallChanged(install: AgentOwnedSkillInstall): boolean {
  return install.created || install.upgraded;
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

function ensureAgentOwnedSkillsDefaultEnabled(config: AgentSkillsConfig, agentId: string): boolean {
  const ownedSkillIds = getAgentOwnedSkillIds(agentId);
  if (ownedSkillIds.length === 0) return false;
  let changed = false;
  for (const skillId of ownedSkillIds) {
    const existing = config.skills?.entries?.[skillId];
    if (existing?.enabled === false || existing?.enabled === true) continue;
    config.skills ??= {};
    config.skills.entries ??= {};
    config.skills.entries[skillId] = { ...(existing ?? {}), enabled: true };
    changed = true;
  }
  return changed;
}

export function prepareUnusedAgentOwnedSkillRemoval(
  config: AgentSkillsConfig,
  agentId: string,
  stateDirectory: string,
  bundleRoot?: string,
  trust: AgentOwnedSkillTrust = {},
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
      const cleanCurrentPackage =
        trustedSourceDigest !== null && currentDigest === trustedSourceDigest;
      const cleanPriorPackage =
        marker.sourceDigest === currentDigest &&
        trust.isTrustedInstalledSkill?.(skillId, destination) === true;
      if (!cleanCurrentPackage && !cleanPriorPackage) continue;

      const quarantine = createQuarantinePath(stateDirectory, skillId, "remove");
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
  trust: AgentOwnedSkillTrust = {},
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
            ...trust,
          }),
        );
        configChanged = ensureAgentOwnedSkillsDefaultEnabled(config, agent.id) || configChanged;
      } else {
        removals.push(
          ...prepareUnusedAgentOwnedSkillRemoval(
            config,
            agent.id,
            stateDirectory,
            bundleRoot,
            trust,
          ),
        );
        configChanged = disableUnreferencedAgentOwnedSkills(config, agent.id) || configChanged;
      }
    }
    return {
      installs,
      removals,
      configChanged,
      runtimeChanged:
        configChanged || installs.some(agentOwnedSkillInstallChanged) || removals.length > 0,
    };
  } catch (error) {
    rollbackAgentOwnedSkillInstalls(installs);
    rollbackAgentOwnedSkillRemovals(removals);
    throw error;
  }
}

export function inspectConfiguredAgentOwnedSkills(
  config: AgentSkillsConfig,
  stateDirectory: string,
  bundleRoot: string,
  trust: AgentOwnedSkillTrust = {},
): AgentOwnedSkillReconciliationPlan {
  const reasons: string[] = [];
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

  for (const agent of AGENT_CATALOG) {
    const ownedSkillIds = getAgentOwnedSkillIds(agent.id);
    if (ownedSkillIds.length === 0) continue;
    for (const skillId of ownedSkillIds) {
      const source = path.join(bundleRoot, skillId);
      if (!fs.existsSync(source)) {
        throw new Error(`Agent skill package is missing: ${source}`);
      }
      const destination = path.join(stateDirectory, "skills", skillId);
      if (configuredAgentIds.has(agent.id)) {
        const enabled = config.skills?.entries?.[skillId]?.enabled;
        if (enabled !== true && enabled !== false) {
          reasons.push(`configure ${skillId}`);
        }
        if (!fs.existsSync(destination)) {
          reasons.push(`install ${skillId}`);
          continue;
        }
        const sourceDigest = manifestDigest(collectFileHashes(source));
        const destinationDigest = manifestDigest(collectFileHashes(destination));
        const marker = readOwnershipMarker(destination);
        if (sourceDigest === destinationDigest) {
          if (!marker) {
            reasons.push(`adopt ${skillId}`);
          } else if (
            marker.agentId !== agent.id ||
            marker.skillId !== skillId ||
            marker.sourceDigest !== sourceDigest
          ) {
            throw new Error(`Existing skill "${skillId}" has conflicting ownership metadata`);
          }
          continue;
        }
        if (
          marker?.agentId === agent.id &&
          marker.skillId === skillId &&
          marker.sourceDigest === destinationDigest &&
          trust.isTrustedInstalledSkill?.(skillId, destination) === true
        ) {
          reasons.push(`upgrade ${skillId}`);
        }
        continue;
      }

      if (configReferencesSkill(config, skillId)) continue;
      const enabled = config.skills?.entries?.[skillId]?.enabled;
      if (enabled !== undefined && enabled !== false) {
        reasons.push(`disable ${skillId}`);
      }
      if (!fs.existsSync(destination)) continue;
      const marker = readOwnershipMarker(destination);
      if (!marker || marker.agentId !== agent.id || marker.skillId !== skillId) continue;
      const currentDigest = manifestDigest(collectFileHashes(destination));
      const sourceDigest = manifestDigest(collectFileHashes(source));
      if (
        currentDigest === sourceDigest ||
        (marker.sourceDigest === currentDigest &&
          trust.isTrustedInstalledSkill?.(skillId, destination) === true)
      ) {
        reasons.push(`remove ${skillId}`);
      }
    }
  }

  return { required: reasons.length > 0, reasons };
}
