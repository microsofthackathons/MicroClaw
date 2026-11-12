import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractFile, listPackage } from "@electron/asar";

const repositoryDir = path.resolve(import.meta.dirname, "../..");

export function readOpenClawTarget(root = repositoryDir) {
  const source = readFileSync(path.join(root, "deployer/openclaw_version.py"), "utf8");
  const version = source.match(/^OPENCLAW_TARGET_VERSION = "([0-9]{4}\.[0-9]+\.[0-9]+)"$/m)?.[1];
  if (!version) throw new Error("Could not resolve the pinned OpenClaw target");
  return version;
}

export function verifyNodeVersion(value) {
  const match = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);
  if (!match || match[0] !== value) throw new Error(`Invalid bundled Node version: ${value}`);
  const [major, minor] = match.slice(1).map(Number);
  if (!(major > 26 || (major === 26 && minor >= 1) || (major === 24 && minor >= 16))) {
    throw new Error(`Unsupported bundled Node ${value}; require >=24.16.0 <25 || >=26.1.0`);
  }
  return value;
}

export function verifyOpenClawArchive(archive, expectedVersion) {
  const packagePath = path.join("node_modules", "openclaw");
  const metadata = JSON.parse(extractFile(archive, path.join(packagePath, "package.json")));
  if (metadata.name !== "openclaw" || metadata.version !== expectedVersion) {
    throw new Error(
      `Bundled OpenClaw mismatch: expected ${expectedVersion}, found ${metadata.version ?? "unknown"}`,
    );
  }
  if (metadata.engines?.node !== ">=24.16.0 <25 || >=26.1.0") {
    throw new Error(`Unaudited OpenClaw Node engine policy: ${metadata.engines?.node}`);
  }
  const entries = listPackage(archive).map((entry) => entry.replaceAll("\\", "/"));
  if (!entries.includes("/node_modules/openclaw/openclaw.mjs")) {
    throw new Error("Bundled OpenClaw is missing openclaw.mjs");
  }
  return metadata.version;
}

export function verifyOpenClawResources(resources, expectedVersion) {
  const openClawVersion = verifyOpenClawArchive(
    path.join(resources, "openclaw.asar"),
    expectedVersion,
  );
  const nodeVersion = verifyNodeVersion(
    execFileSync(path.join(resources, "node.exe"), ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    }).trim(),
  );
  return { openClawVersion, nodeVersion };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const target = readOpenClawTarget();
  const requested = process.argv[2] || target;
  if (requested !== target) {
    throw new Error(`Installer target ${requested} differs from source target ${target}`);
  }
  const resources = process.argv[3] || path.join(repositoryDir, "desktop/resources");
  console.log(JSON.stringify(verifyOpenClawResources(resources, target)));
}
