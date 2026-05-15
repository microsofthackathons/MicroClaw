#!/usr/bin/env node
/**
 * Standalone script to generate a skill integrity snapshot.
 *
 * Called by the installer (deployer/windows_setup.py) after skills are
 * installed.  Produces four files in the OpenClaw state directory:
 *
 *   skills_snapshot.json   — SHA-256 hash manifest of all skill files
 *   skills_snapshot.sig    — Ed25519 signature of the manifest
 *   skills_signing_key.pub — Ed25519 public key  (DER / SPKI)
 *   skills_signing_key.pem — Ed25519 private key (DER / PKCS8)
 *
 * Usage:
 *   node generate-skill-snapshot.js
 *   node generate-skill-snapshot.js --state-dir <path>
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── Constants ──

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

// ── Path helpers ──

function getStateDir() {
  // Allow override via CLI arg
  const idx = process.argv.indexOf("--state-dir");
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  if (process.env.OPENCLAW_STATE_DIR) {
    return process.env.OPENCLAW_STATE_DIR;
  }
  const homeDir = path.join(os.homedir(), ".openclaw");
  if (fs.existsSync(path.join(homeDir, "openclaw.json"))) {
    return homeDir;
  }
  return path.join(process.env.APPDATA || path.join(os.homedir(), ".openclaw"), "openclaw");
}

function getSkillSourceDirs() {
  const home = os.homedir();
  return [
    {
      source: "builtin",
      baseDir: path.join(home, ".openclaw-node", "node_modules", "openclaw", "skills"),
    },
    {
      source: "managed",
      baseDir: path.join(home, ".openclaw", "skills"),
    },
  ];
}

// ── File hashing ──

function isExcluded(name) {
  return name.startsWith(".") || EXCLUDED_NAMES.has(name);
}

function hashFile(filePath) {
  const data = fs.readFileSync(filePath);
  const hex = crypto.createHash("sha256").update(data).digest("hex");
  return `sha256:${hex}`;
}

function collectFiles(dir, baseDir) {
  const result = new Map();
  if (!fs.existsSync(dir)) return result;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (isExcluded(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [rel, hash] of collectFiles(fullPath, baseDir)) {
        result.set(rel, hash);
      }
    } else if (entry.isFile()) {
      const rel = path.relative(baseDir, fullPath).replace(/\\/g, "/");
      result.set(rel, hashFile(fullPath));
    }
  }
  return result;
}

// ── Key management ──

function loadOrCreateKeyPair(stateDir) {
  const pubPath = path.join(stateDir, PUBLIC_KEY_FILE);
  const privPath = path.join(stateDir, PRIVATE_KEY_FILE);

  if (fs.existsSync(pubPath) && fs.existsSync(privPath)) {
    return {
      publicKeyDer: fs.readFileSync(pubPath),
      privateKeyDer: fs.readFileSync(privPath),
    };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(pubPath, publicKey);
  fs.writeFileSync(privPath, privateKey);

  return { publicKeyDer: publicKey, privateKeyDer: privateKey };
}

function signData(privateKeyDer, data) {
  const keyObj = crypto.createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });
  return crypto.sign(null, data, keyObj);
}

// ── Snapshot generation ──

function buildSnapshot(signingKeyId) {
  const sources = {};

  for (const { source, baseDir } of getSkillSourceDirs()) {
    const skills = {};
    if (fs.existsSync(baseDir)) {
      for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || isExcluded(entry.name)) continue;
        const skillDir = path.join(baseDir, entry.name);
        const fileHashes = collectFiles(skillDir, skillDir);
        const files = {};
        for (const [rel, hash] of fileHashes) {
          files[rel] = hash;
        }
        skills[entry.name] = { files };
      }
    }
    sources[source] = { base_dir: baseDir, skills };
  }

  return {
    version: 1,
    created_at: new Date().toISOString(),
    signing_key_id: signingKeyId,
    sources,
  };
}

// ── Main ──

function main() {
  const stateDir = getStateDir();
  console.log(`State directory: ${stateDir}`);

  const keyPair = loadOrCreateKeyPair(stateDir);
  const keyId = `sha256:${crypto.createHash("sha256").update(keyPair.publicKeyDer).digest("hex")}`;
  console.log(`Signing key: ${keyId}`);

  const snapshot = buildSnapshot(keyId);

  let totalFiles = 0;
  let totalSkills = 0;
  for (const [source, data] of Object.entries(snapshot.sources)) {
    const skillCount = Object.keys(data.skills).length;
    const fileCount = Object.values(data.skills).reduce(
      (sum, s) => sum + Object.keys(s.files).length,
      0,
    );
    totalSkills += skillCount;
    totalFiles += fileCount;
    console.log(`  ${source}: ${skillCount} skills, ${fileCount} files`);
  }

  const jsonBytes = Buffer.from(JSON.stringify(snapshot, null, 2), "utf-8");
  const sig = signData(keyPair.privateKeyDer, jsonBytes);

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, SNAPSHOT_FILE), jsonBytes);
  fs.writeFileSync(path.join(stateDir, SIGNATURE_FILE), sig);

  console.log(`Snapshot: ${totalSkills} skills, ${totalFiles} files`);
  console.log(`Written: ${SNAPSHOT_FILE}, ${SIGNATURE_FILE}`);
  console.log("Skill integrity snapshot generated successfully.");
}

main();
