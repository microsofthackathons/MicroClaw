// ---------------------------------------------------------------------------
// Shared path-resolution utilities for the MicroClaw Desktop main process.
//
// Consolidates path helpers that were previously duplicated across main.ts,
// gateway-manager.ts, skill-integrity.ts, and device-identity.ts.
// ---------------------------------------------------------------------------

import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { resolveBundledOpenClawDir } from "./bundled-runtime";

/**
 * Resolve the OpenClaw state directory.
 *
 * Priority:
 *  1. `OPENCLAW_STATE_DIR` environment variable
 *  2. `~/.openclaw` (if it contains `openclaw.json`)
 *  3. `%APPDATA%/openclaw` (deployer default)
 */
export function getOpenClawStateDir(): string {
  if (process.env.OPENCLAW_STATE_DIR) {
    return process.env.OPENCLAW_STATE_DIR;
  }
  const homeDir = path.join(app.getPath("home"), ".openclaw");
  if (fs.existsSync(path.join(homeDir, "openclaw.json"))) {
    return homeDir;
  }
  return path.join(app.getPath("appData"), "openclaw");
}

/**
 * Read the `.env` file from the state directory and return key-value pairs.
 * These are injected into the gateway process environment so that
 * `${VAR}` references in `openclaw.json` resolve correctly.
 */
export function loadStateDirEnv(stateDir?: string): Record<string, string> {
  const envPath = path.join(stateDir ?? getOpenClawStateDir(), ".env");
  const result: Record<string, string> = {};
  try {
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key) result[key] = value;
    }
  } catch {
    // .env may not exist — not fatal
  }
  return result;
}

export function loadGatewayEnvironment(
  stateDir: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...loadStateDirEnv(stateDir) };
}

/**
 * Stable Node releases supported by OpenClaw 2026.9.3.
 */
export function isSupportedNodeVersion(value: string): boolean {
  const match = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);
  if (!match || match[0] !== value) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  return (major === 24 && minor >= 16) || (major === 26 && minor >= 1) || major > 26;
}

/**
 * Resolve the path to `node.exe`.
 *
 * Priority (skipping unsupported or unreadable runtimes):
 *  1. Bundled in packaged app resources
 *  2. Explicit `OPENCLAW_NODE_DIR`
 *  3. Deployer-installed `~/.openclaw-node/node.exe`
 *  4. Per-machine and per-user MSI installations
 *  5. Bare `"node"` (rely on PATH)
 */
export function resolveNodePath(): string {
  const override = process.env.OPENCLAW_NODE_DIR || "";
  const candidates = [
    app.isPackaged ? path.join(process.resourcesPath, "node.exe") : "",
    path.isAbsolute(override) ? path.join(override, "node.exe") : "",
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".openclaw-node", "node.exe") : "",
    path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "nodejs", "node.exe")
      : "",
    "node",
  ];
  for (const candidate of new Set(candidates.filter(Boolean))) {
    if (candidate !== "node" && !fs.existsSync(candidate)) continue;
    let version: string;
    try {
      version = execFileSync(candidate, ["--version"], {
        encoding: "utf-8",
        windowsHide: true,
        timeout: 5_000,
      }).trim();
    } catch (error) {
      console.warn(
        `[path-resolver] Cannot read Node.js version at ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (isSupportedNodeVersion(version)) return candidate;
    console.warn(`[path-resolver] Skipping unsupported Node.js ${version} at ${candidate}`);
  }
  throw new Error(
    "OpenClaw 2026.9.3 requires Node.js >=24.16.0 <25 || >=26.1.0. " +
      "Run the MicroClaw installer or install Node.js 26.",
  );
}

/**
 * Resolve the path to the OpenClaw entry script (`openclaw.mjs` or `dist/index.js`).
 *
 * Priority:
 *  1. Bundled in packaged app resources
 *  2. Deployer-installed under `~/.openclaw-node` (classic & `lib/` npm layouts)
 *  3. Global npm install under `%APPDATA%/npm`
 *  4. Per-machine Node at `%ProgramFiles%/nodejs`
 *  5. Per-user Node at `%LocalAppData%/Programs/nodejs`
 */
export function resolveOpenClawEntry(): string {
  const bundledRoot = resolveBundledOpenClawDir();
  if (bundledRoot) {
    return path.join(bundledRoot, "node_modules", "openclaw", "openclaw.mjs");
  }
  const home = process.env.USERPROFILE || "";
  const appData = process.env.APPDATA || "";
  const programFiles = process.env.ProgramFiles || "";
  const localAppData = process.env.LOCALAPPDATA || "";
  const candidates = [
    home ? path.join(home, ".openclaw-node", "node_modules", "openclaw", "openclaw.mjs") : "",
    home
      ? path.join(home, ".openclaw-node", "lib", "node_modules", "openclaw", "openclaw.mjs")
      : "",
    home ? path.join(home, ".openclaw-node", "node_modules", "openclaw", "dist", "index.js") : "",
    home
      ? path.join(home, ".openclaw-node", "lib", "node_modules", "openclaw", "dist", "index.js")
      : "",
    appData ? path.join(appData, "npm", "node_modules", "openclaw", "openclaw.mjs") : "",
    appData ? path.join(appData, "npm", "node_modules", "openclaw", "dist", "index.js") : "",
    programFiles
      ? path.join(programFiles, "nodejs", "node_modules", "openclaw", "openclaw.mjs")
      : "",
    programFiles
      ? path.join(programFiles, "nodejs", "node_modules", "openclaw", "dist", "index.js")
      : "",
    localAppData
      ? path.join(localAppData, "Programs", "nodejs", "node_modules", "openclaw", "openclaw.mjs")
      : "",
    localAppData
      ? path.join(
          localAppData,
          "Programs",
          "nodejs",
          "node_modules",
          "openclaw",
          "dist",
          "index.js",
        )
      : "",
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return candidates[0];
}

/** Resolve the package root that must remain readable by the sandbox preload. */
export function resolveOpenClawPackageDir(entryPath: string): string {
  const entryDir = path.dirname(entryPath);
  return path.basename(entryDir).toLowerCase() === "dist" ? path.dirname(entryDir) : entryDir;
}

/**
 * Resolve the directory containing the built-in (bundled with the `openclaw`
 * npm package) skills.
 *
 * Mirrors the layouts probed by {@link resolveOpenClawEntry}:
 *  1. Bundled in packaged app resources (`resources/openclaw/skills`)
 *  2. Deployer-installed under `~/.openclaw-node` (classic & `lib/` npm layouts)
 *  3. Global npm install under `%APPDATA%/npm` (per-user, default `npm i -g`)
 *  4. Per-machine Node at `%ProgramFiles%/nodejs`
 *  5. Per-user Node at `%LocalAppData%/Programs/nodejs`
 *
 * Returns the first existing path. If none exist, returns the first candidate
 * (legacy deployer layout) so callers can still surface a useful path.
 */
export function resolveBuiltinSkillsDir(): string {
  const bundledRoot = resolveBundledOpenClawDir();
  if (bundledRoot) {
    return path.join(bundledRoot, "node_modules", "openclaw", "skills");
  }
  const home = process.env.USERPROFILE || "";
  const appData = process.env.APPDATA || "";
  const programFiles = process.env.ProgramFiles || "";
  const localAppData = process.env.LOCALAPPDATA || "";
  const candidates = [
    home ? path.join(home, ".openclaw-node", "node_modules", "openclaw", "skills") : "",
    home ? path.join(home, ".openclaw-node", "lib", "node_modules", "openclaw", "skills") : "",
    appData ? path.join(appData, "npm", "node_modules", "openclaw", "skills") : "",
    programFiles ? path.join(programFiles, "nodejs", "node_modules", "openclaw", "skills") : "",
    localAppData
      ? path.join(localAppData, "Programs", "nodejs", "node_modules", "openclaw", "skills")
      : "",
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return candidates[0];
}
