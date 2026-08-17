/**
 * Skill integrity verification via SHA-256 hashing and Ed25519 signing.
 *
 * Generates a JSON snapshot of all skill file hashes, signs it with an
 * Ed25519 keypair, and can later verify that no files have been modified,
 * added, or removed.  Keys and snapshot are persisted in the OpenClaw
 * state directory.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "crypto";
import fs from "fs";
import path from "path";
import { app } from "electron";
import { getOpenClawStateDir, resolveBuiltinSkillsDir } from "./path-resolver";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IntegrityChange {
  skill: string;
  source: string;
  file: string;
  type: "modified" | "added" | "removed";
  expected?: string;
  actual?: string;
}

export interface IntegrityResult {
  valid: boolean;
  signatureValid: boolean;
  snapshotExists: boolean;
  changes: IntegrityChange[];
}

export interface SkillIntegritySnapshotState {
  snapshot: Buffer | null;
  signature: Buffer | null;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SkillFiles {
  [relativePath: string]: string; // path → "sha256:<hex>"
}

interface SkillEntry {
  files: SkillFiles;
}

interface SourceEntry {
  base_dir: string;
  skills: { [skillName: string]: SkillEntry };
}

interface Snapshot {
  version: number;
  created_at: string;
  signing_key_id: string;
  sources: { [sourceName: string]: SourceEntry };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SNAPSHOT_FILE = "skills_snapshot.json";
const SIGNATURE_FILE = "skills_snapshot.sig";
const PUBLIC_KEY_FILE = "skills_signing_key.pub";
const PRIVATE_KEY_FILE = "skills_signing_key.pem";

const EXCLUDED_NAMES = new Set([
  "node_modules",
  "__pycache__",
  ".mypy_cache",
  ".cache",
  "Thumbs.db",
]);

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getSkillSourceDirs(): Array<{ source: string; baseDir: string }> {
  const homeDir = app.getPath("home");
  return [
    {
      source: "builtin",
      baseDir: resolveBuiltinSkillsDir(),
    },
    {
      source: "managed",
      baseDir: path.join(getOpenClawStateDir(), "skills"),
    },
  ];
}

// ---------------------------------------------------------------------------
// File hashing
// ---------------------------------------------------------------------------

function isExcluded(name: string): boolean {
  if (name.startsWith(".")) return true;
  return EXCLUDED_NAMES.has(name);
}

function hashFile(filePath: string): string {
  const data = fs.readFileSync(filePath);
  const hex = createHash("sha256").update(data).digest("hex");
  return `sha256:${hex}`;
}

/**
 * Recursively collect all non-excluded files under `dir`, returning paths
 * relative to `baseDir`.
 */
function collectFiles(dir: string, baseDir: string): Map<string, string> {
  const result = new Map<string, string>();

  if (!fs.existsSync(dir)) {
    return result;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (isExcluded(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = collectFiles(fullPath, baseDir);
      for (const [rel, hash] of sub) {
        result.set(rel, hash);
      }
    } else if (entry.isFile()) {
      const rel = path.relative(baseDir, fullPath).replace(/\\/g, "/");
      result.set(rel, hashFile(fullPath));
    }
  }

  return result;
}

function collectControlledSkillFiles(dir: string, baseDir = dir): Map<string, string> {
  const result = new Map<string, string>();
  if (!fs.existsSync(dir)) return result;
  const rootInfo = fs.lstatSync(dir);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Controlled skill path must be a regular directory: ${dir}`);
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".microclaw-agent-skill.json") continue;
    const fullPath = path.join(dir, entry.name);
    const info = fs.lstatSync(fullPath);
    if (info.isSymbolicLink()) {
      throw new Error(`Controlled skill cannot contain links: ${fullPath}`);
    }
    if (info.isDirectory()) {
      for (const [relativePath, digest] of collectControlledSkillFiles(fullPath, baseDir)) {
        result.set(relativePath, digest);
      }
    } else if (info.isFile()) {
      const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
      result.set(relativePath, hashFile(fullPath));
    } else {
      throw new Error(`Controlled skill contains an unsupported entry: ${fullPath}`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

function fingerprintDerPublicKey(derPub: Buffer): string {
  return `sha256:${createHash("sha256").update(derPub).digest("hex")}`;
}

interface KeyPair {
  publicKeyDer: Buffer;
  privateKeyDer: Buffer;
}

function loadOrCreateKeyPair(): KeyPair {
  const stateDir = getOpenClawStateDir();
  const pubPath = path.join(stateDir, PUBLIC_KEY_FILE);
  const privPath = path.join(stateDir, PRIVATE_KEY_FILE);

  // Reuse existing keypair if both files are present
  if (fs.existsSync(pubPath) && fs.existsSync(privPath)) {
    return {
      publicKeyDer: fs.readFileSync(pubPath),
      privateKeyDer: fs.readFileSync(privPath),
    };
  }

  // Generate new Ed25519 keypair
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(pubPath, publicKey);
  fs.writeFileSync(privPath, privateKey);

  return {
    publicKeyDer: publicKey as Buffer,
    privateKeyDer: privateKey as Buffer,
  };
}

function signData(privateKeyDer: Buffer, data: Buffer): Buffer {
  const keyObj = createPrivateKey({
    key: privateKeyDer,
    format: "der",
    type: "pkcs8",
  });
  return sign(null, data, keyObj);
}

function verifySignature(publicKeyDer: Buffer, data: Buffer, signature: Buffer): boolean {
  const keyObj = createPublicKey({
    key: publicKeyDer,
    format: "der",
    type: "spki",
  });
  return verify(null, data, keyObj, signature);
}

// ---------------------------------------------------------------------------
// Snapshot building
// ---------------------------------------------------------------------------

function buildSnapshot(signingKeyId: string): Snapshot {
  const sources: Snapshot["sources"] = {};

  for (const { source, baseDir } of getSkillSourceDirs()) {
    const sourceEntry: SourceEntry = { base_dir: baseDir, skills: {} };

    if (fs.existsSync(baseDir)) {
      const skillDirs = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const entry of skillDirs) {
        if (!entry.isDirectory() || isExcluded(entry.name)) continue;

        const skillDir = path.join(baseDir, entry.name);
        const fileHashes = collectFiles(skillDir, skillDir);
        const files: SkillFiles = {};
        for (const [rel, hash] of fileHashes) {
          files[rel] = hash;
        }
        sourceEntry.skills[entry.name] = { files };
      }
    }

    sources[source] = sourceEntry;
  }

  return {
    version: 1,
    created_at: new Date().toISOString(),
    signing_key_id: signingKeyId,
    sources,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a snapshot of all skill file hashes, sign it, and persist everything
 * to the state directory.  Reuses an existing keypair if one is found on disk.
 */
export function generateAndSignSnapshot(): void {
  const keyPair = loadOrCreateKeyPair();
  const keyId = fingerprintDerPublicKey(keyPair.publicKeyDer);
  const snapshot = buildSnapshot(keyId);

  const jsonBytes = Buffer.from(JSON.stringify(snapshot, null, 2), "utf-8");
  const sig = signData(keyPair.privateKeyDer, jsonBytes);

  const stateDir = getOpenClawStateDir();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, SNAPSHOT_FILE), jsonBytes);
  fs.writeFileSync(path.join(stateDir, SIGNATURE_FILE), sig);
}

export interface ControlledManagedSkillChange {
  skillName: string;
  expectedDirectory: string | null;
}

export function acceptManagedSkillIntegrityChanges(
  controlledChanges: readonly ControlledManagedSkillChange[],
): void {
  const controlled = new Map(
    controlledChanges.map((change) => [change.skillName, change.expectedDirectory]),
  );
  const result = verifySkillIntegrity();
  if (!result.snapshotExists || !result.signatureValid) {
    throw new Error("Cannot update skill integrity without a valid signed baseline");
  }
  const unexpected = result.changes.filter(
    (change) => change.source !== "managed" || !controlled.has(change.skill),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Unrelated skill integrity changes must be reviewed first: ${unexpected
        .map((change) => `${change.source}/${change.skill}/${change.file}`)
        .join(", ")}`,
    );
  }
  const managedRoot = getSkillSourceDirs().find((entry) => entry.source === "managed")!.baseDir;
  for (const [skillName, expectedDirectory] of controlled) {
    const actualDirectory = path.join(managedRoot, skillName);
    const actual = collectControlledSkillFiles(actualDirectory);
    const expected = expectedDirectory
      ? collectControlledSkillFiles(expectedDirectory)
      : new Map<string, string>();
    if (
      actual.size !== expected.size ||
      [...expected].some(([relativePath, digest]) => actual.get(relativePath) !== digest)
    ) {
      throw new Error(`Managed skill "${skillName}" does not match the controlled lifecycle state`);
    }
  }
  if (result.changes.length > 0) generateAndSignSnapshot();
}

export function captureSkillIntegritySnapshotState(
  stateDir = getOpenClawStateDir(),
): SkillIntegritySnapshotState {
  const snapshotPath = path.join(stateDir, SNAPSHOT_FILE);
  const signaturePath = path.join(stateDir, SIGNATURE_FILE);
  return {
    snapshot: fs.existsSync(snapshotPath) ? fs.readFileSync(snapshotPath) : null,
    signature: fs.existsSync(signaturePath) ? fs.readFileSync(signaturePath) : null,
  };
}

export function restoreSkillIntegritySnapshotState(
  state: SkillIntegritySnapshotState,
  stateDir = getOpenClawStateDir(),
): void {
  fs.mkdirSync(stateDir, { recursive: true });
  for (const [filename, contents] of [
    [SNAPSHOT_FILE, state.snapshot],
    [SIGNATURE_FILE, state.signature],
  ] as const) {
    const target = path.join(stateDir, filename);
    if (contents === null) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      continue;
    }
    fs.writeFileSync(target, contents);
  }
}

/**
 * Verify the current on-disk skill files against a previously stored snapshot.
 *
 * - If no snapshot exists, returns valid with `snapshotExists: false` (first
 *   launch — caller should generate the baseline).
 * - If the snapshot signature is invalid, returns `signatureValid: false`.
 * - Otherwise, computes file-level diffs (modified / added / removed).
 */
export function verifySkillIntegrity(): IntegrityResult {
  const stateDir = getOpenClawStateDir();
  const snapshotPath = path.join(stateDir, SNAPSHOT_FILE);
  const sigPath = path.join(stateDir, SIGNATURE_FILE);
  const pubPath = path.join(stateDir, PUBLIC_KEY_FILE);

  // No snapshot yet — first launch
  if (!fs.existsSync(snapshotPath)) {
    return { valid: true, signatureValid: true, snapshotExists: false, changes: [] };
  }

  // Read snapshot and verify signature
  const snapshotBytes = fs.readFileSync(snapshotPath);
  const sigBytes = fs.existsSync(sigPath) ? fs.readFileSync(sigPath) : null;
  const pubKeyDer = fs.existsSync(pubPath) ? fs.readFileSync(pubPath) : null;

  if (!sigBytes || !pubKeyDer) {
    return { valid: false, signatureValid: false, snapshotExists: true, changes: [] };
  }

  const sigOk = verifySignature(pubKeyDer, snapshotBytes, sigBytes);
  if (!sigOk) {
    return { valid: false, signatureValid: false, snapshotExists: true, changes: [] };
  }

  const snapshot: Snapshot = JSON.parse(snapshotBytes.toString("utf-8"));
  const changes: IntegrityChange[] = [];
  const currentSourceDirectories = new Map(
    getSkillSourceDirs().map((entry) => [entry.source, entry.baseDir]),
  );

  // Compare snapshot against current disk state
  for (const [sourceName, sourceEntry] of Object.entries(snapshot.sources)) {
    // Source locations can move across runtime layouts or OPENCLAW_STATE_DIR
    // changes. Keep the signed file hashes authoritative, but always scan the
    // currently resolved source directory rather than a stale stored path.
    const baseDir = currentSourceDirectories.get(sourceName) ?? sourceEntry.base_dir;

    // Check every skill recorded in the snapshot
    for (const [skillName, skillEntry] of Object.entries(sourceEntry.skills)) {
      const skillDir = path.join(baseDir, skillName);

      // Check files listed in snapshot
      for (const [relPath, expectedHash] of Object.entries(skillEntry.files)) {
        const fullPath = path.join(skillDir, relPath.replace(/\//g, path.sep));
        if (!fs.existsSync(fullPath)) {
          changes.push({
            skill: skillName,
            source: sourceName,
            file: relPath,
            type: "removed",
            expected: expectedHash,
          });
        } else {
          const actualHash = hashFile(fullPath);
          if (actualHash !== expectedHash) {
            changes.push({
              skill: skillName,
              source: sourceName,
              file: relPath,
              type: "modified",
              expected: expectedHash,
              actual: actualHash,
            });
          }
        }
      }

      // Check for files on disk that are NOT in the snapshot (added)
      if (fs.existsSync(skillDir)) {
        const diskFiles = collectFiles(skillDir, skillDir);
        for (const [relPath, actualHash] of diskFiles) {
          if (!(relPath in skillEntry.files)) {
            changes.push({
              skill: skillName,
              source: sourceName,
              file: relPath,
              type: "added",
              actual: actualHash,
            });
          }
        }
      }
    }

    // Check for skill directories on disk that are NOT in the snapshot (added)
    if (fs.existsSync(baseDir)) {
      const diskSkillDirs = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const entry of diskSkillDirs) {
        if (!entry.isDirectory() || isExcluded(entry.name)) continue;
        if (!(entry.name in sourceEntry.skills)) {
          const skillDir = path.join(baseDir, entry.name);
          const diskFiles = collectFiles(skillDir, skillDir);
          for (const [relPath, actualHash] of diskFiles) {
            changes.push({
              skill: entry.name,
              source: sourceName,
              file: relPath,
              type: "added",
              actual: actualHash,
            });
          }
        }
      }
    }
  }

  return {
    valid: changes.length === 0,
    signatureValid: true,
    snapshotExists: true,
    changes,
  };
}
