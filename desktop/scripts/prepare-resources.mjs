import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createPackage } from "@electron/asar";
import {
  readOpenClawTarget,
  verifyOpenClawArchive,
  verifyOpenClawResources,
  verifyNodeVersion,
} from "./openclaw-resource.mjs";
import { validatePinnedOpenClawApprovalPackage } from "../src/openclaw-approval-replay-compat.mjs";

const desktopDir = path.resolve(import.meta.dirname, "..");
const repositoryDir = path.resolve(desktopDir, "..");
const resourcesDir = path.join(desktopDir, "resources");
const openClawArchive = path.join(resourcesDir, "openclaw.asar");
const registry =
  process.env.MICROCLAW_NPM_REGISTRY ||
  process.env.MSIX_NPM_REGISTRY ||
  process.env.npm_config_registry ||
  "https://registry.npmjs.org";
const version = readOpenClawTarget(repositoryDir);
if (process.platform !== "win32" || path.basename(process.execPath).toLowerCase() !== "node.exe") {
  throw new Error("Packaged resources must be prepared on Windows with node.exe");
}
verifyNodeVersion(process.version);
mkdirSync(resourcesDir, { recursive: true });

let coreReady = false;
try {
  verifyOpenClawResources(resourcesDir, version);
  coreReady = true;
} catch (error) {
  console.log(`[resources] Preparing OpenClaw ${version}: ${error.message}`);
}

if (!coreReady) {
  const staging = path.resolve(resourcesDir, `.openclaw-staging-${randomUUID()}`);
  const relative = path.relative(resourcesDir, staging);
  if (relative.startsWith("..") || path.isAbsolute(relative) || path.dirname(relative) !== ".") {
    throw new Error("OpenClaw staging escaped the resource directory");
  }
  const prefix = path.join(staging, "prefix");
  const archive = path.join(staging, "openclaw.asar");
  mkdirSync(prefix, { recursive: true });
  try {
    writeFileSync(
      path.join(prefix, "package.json"),
      JSON.stringify({
        private: true,
        allowScripts: {
          [`openclaw@${version}`]: true,
          "esbuild@0.28.2": true,
          "protobufjs@7.6.6": true,
        },
      }),
    );
    const npmCli =
      process.env.npm_execpath ||
      path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
    const result = spawnSync(
      process.execPath,
      [
        npmCli,
        "install",
        "--prefix",
        prefix,
        "--omit=dev",
        "--ignore-scripts=false",
        "--no-package-lock",
        "--no-save",
        "--registry",
        registry,
        "--replace-registry-host=always",
        `openclaw@${version}`,
      ],
      {
        stdio: "inherit",
        windowsHide: true,
        env: { ...process.env, NODE_LLAMA_CPP_SKIP_DOWNLOAD: "true" },
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`OpenClaw resource installation exited ${result.status}`);
    const packageDir = path.join(prefix, "node_modules/openclaw");
    const metadata = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
    if (metadata.name !== "openclaw" || metadata.version !== version)
      throw new Error("Staged OpenClaw version mismatch");
    const targets = validatePinnedOpenClawApprovalPackage(packageDir, {
      approval: true,
      cronResume: true,
    });
    for (const target of targets) {
      const checked = spawnSync(process.execPath, ["--check", "--input-type=module"], {
        input: target.patch(target.original.toString("utf8")),
        encoding: "utf8",
        windowsHide: true,
      });
      if (checked.error) throw checked.error;
      if (checked.status !== 0)
        throw new Error(
          `Invalid OpenClaw compatibility transform ${target.module}: ${checked.stderr}`,
        );
    }
    await createPackage(prefix, archive);
    verifyOpenClawArchive(archive, version);
    copyFileSync(process.execPath, path.join(resourcesDir, "node.exe"));
    const previous = path.join(resourcesDir, `openclaw.asar.previous-${randomUUID()}`);
    const present = existsSync(openClawArchive);
    if (present) renameSync(openClawArchive, previous);
    try {
      renameSync(archive, openClawArchive);
    } catch (error) {
      if (present) renameSync(previous, openClawArchive);
      throw error;
    }
    if (present) console.log(`[resources] Previous core retained at ${previous}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const windowsNodeResult = spawnSync(
  process.execPath,
  [path.join(desktopDir, "scripts", "prepare-windows-node-resources.mjs"), "--arch=x64"],
  { stdio: "inherit" },
);
if (windowsNodeResult.error) throw windowsNodeResult.error;
if (windowsNodeResult.status !== 0) process.exit(windowsNodeResult.status ?? 1);

const weixinPluginResult = spawnSync(
  process.execPath,
  [path.join(desktopDir, "scripts", "prepare-weixin-plugin-resource.mjs")],
  { stdio: "inherit" },
);
if (weixinPluginResult.error) throw weixinPluginResult.error;
if (weixinPluginResult.status !== 0) process.exit(weixinPluginResult.status ?? 1);

console.log(
  `[resources] Verified ${JSON.stringify(verifyOpenClawResources(resourcesDir, version))}`,
);
