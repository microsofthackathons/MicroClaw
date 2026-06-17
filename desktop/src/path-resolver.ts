// ---------------------------------------------------------------------------
// Shared path-resolution utilities for the MicroClaw Desktop main process.
//
// Consolidates path helpers that were previously duplicated across main.ts,
// gateway-manager.ts, skill-integrity.ts, and device-identity.ts.
// ---------------------------------------------------------------------------

import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

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

/**
 * Resolve the path to `node.exe`.
 *
 * Priority:
 *  1. Bundled in packaged app resources
 *  2. Deployer-installed `~/.openclaw-node/node.exe`
 *  3. `C:\Program Files\nodejs\node.exe`
 *  4. Bare `"node"` (rely on PATH)
 */
export function resolveNodePath(): string {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "node.exe");
    if (fs.existsSync(bundled)) return bundled;
  }
  const ocNode = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, ".openclaw-node", "node.exe")
    : "";
  if (ocNode && fs.existsSync(ocNode)) return ocNode;

  const programFiles = "C:\\Program Files\\nodejs\\node.exe";
  if (fs.existsSync(programFiles)) return programFiles;

  return "node";
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
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "openclaw", "openclaw.mjs");
    if (fs.existsSync(bundled)) return bundled;
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
      ? path.join(
          localAppData,
          "Programs",
          "nodejs",
          "node_modules",
          "openclaw",
          "openclaw.mjs",
        )
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
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "openclaw", "skills");
    if (fs.existsSync(bundled)) return bundled;
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
