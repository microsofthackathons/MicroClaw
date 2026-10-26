import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createPackage, listPackage } from "@electron/asar";

const desktopDir = path.resolve(import.meta.dirname, "..");
const repositoryDir = path.resolve(desktopDir, "..");
const resourcesDir = path.join(desktopDir, "resources");
const openClawDir = path.join(resourcesDir, "openclaw");
const openClawArchive = path.join(resourcesDir, "openclaw.asar");
const registry = process.env.MSIX_NPM_REGISTRY || "https://registry.npmjs.org";
const versionSource = readFileSync(
  path.join(repositoryDir, "deployer", "openclaw_version.py"),
  "utf8",
);
const version = versionSource.match(/^OPENCLAW_TARGET_VERSION = "([^"]+)"$/m)?.[1];

if (!version) {
  throw new Error("Could not resolve OPENCLAW_TARGET_VERSION from deployer/openclaw_version.py");
}
if (process.platform !== "win32" || path.basename(process.execPath).toLowerCase() !== "node.exe") {
  throw new Error("MSIX resources must be prepared on Windows with node.exe");
}

rmSync(resourcesDir, { recursive: true, force: true });
mkdirSync(openClawDir, { recursive: true });
copyFileSync(process.execPath, path.join(resourcesDir, "node.exe"));

const npmCli = process.env.npm_execpath;
const npm = npmCli?.endsWith(".js")
  ? process.execPath
  : path.join(path.dirname(process.execPath), "npm.cmd");
const npmArguments = npmCli?.endsWith(".js") ? [npmCli] : [];
const result = spawnSync(
  npm,
  [
    ...npmArguments,
    "install",
    "--prefix",
    openClawDir,
    "--omit=dev",
    "--ignore-scripts=false",
    "--no-package-lock",
    "--no-save",
    "--registry",
    registry,
    `openclaw@${version}`,
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const entry = path.join(openClawDir, "node_modules", "openclaw", "openclaw.mjs");
try {
  readFileSync(entry);
} catch {
  throw new Error(`OpenClaw ${version} staging did not produce ${entry}`);
}

await createPackage(openClawDir, openClawArchive);
const archiveFiles = listPackage(openClawArchive).map((file) => file.replaceAll("\\", "/"));
if (!archiveFiles.includes("/node_modules/openclaw/openclaw.mjs")) {
  throw new Error(`OpenClaw ${version} archive is missing openclaw.mjs`);
}
rmSync(openClawDir, { recursive: true, force: true });
console.log(`[msix] Staged Node ${process.version} and OpenClaw ${version} as openclaw.asar`);
