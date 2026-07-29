import { app, BrowserWindow, ipcMain, Menu, shell, dialog } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import { ChildProcess, execFileSync, spawn } from "child_process";
import { GatewayClient, type ChatEventPayload } from "./gateway-client";
import { hardRestartGateway, requiresExternalGatewayStop } from "./gateway-lifecycle";
import { createTray, destroyTray } from "./tray";
import Store from "electron-store";
import {
  verifySkillIntegrity,
  generateAndSignSnapshot,
  getSkillSourceDirs,
  type IntegrityResult,
} from "./skill-integrity";
import { ToolSandbox } from "./tool-sandbox";
import { shieldIfNeeded, unshieldIfNeeded } from "./sensitive-shield";
import { StudioBackendManager } from "./studio-backend-manager";
import { resolveSupportedLocale, t as mainT } from "./i18n";
import { checkForUpdates } from "./update-checker";
import { getUsdToCnyRate } from "./exchange-rate";
import {
  recoverInterruptedOpenClawUpgrade,
  UpgradeInProgressError,
} from "./openclaw-upgrade-recovery";
import {
  getOpenClawStateDir,
  loadGatewayEnvironment,
  loadStateDirEnv,
  resolveBuiltinSkillsDir,
  resolveNodePath,
  resolveOpenClawEntry,
  resolveOpenClawPackageDir,
} from "./path-resolver";
import {
  type GatewayStatus,
  CREATE_NO_WINDOW,
  COMPILE_CACHE_SUBDIR,
  DEFAULT_PORT,
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
  GATEWAY_READY_TIMEOUT_MS,
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_CHECK_HTTP_TIMEOUT_MS,
  HEALTH_CHECK_FAILURE_THRESHOLD,
  LOADING_WINDOW_WIDTH,
  LOADING_WINDOW_HEIGHT,
  MODEL_CONNECTION_TEST_TIMEOUT_MS,
  SETUP_WINDOW_WIDTH,
  SETUP_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  POST_SPAWN_RESTART_DELAY_MS,
  WEIXIN_LOGIN_TIMEOUT_MS,
  USAGE_QUERY_DAYS,
  UPDATE_MANIFEST_URL,
} from "./constants";
import {
  appendModelEndpoint,
  prepareModelBaseUrl,
  requestModelEndpoint,
  resolveModelApiKey,
} from "./model-connection";
import { hasConfiguredModel } from "./model-setup";
import {
  disconnectGitHubCopilot,
  getGitHubCopilotAuthStatus,
  GitHubCopilotAuthManager,
  type GitHubCopilotAuthRuntime,
  invalidateGitHubCopilotAuthStatusCache,
  listGitHubCopilotModels,
  parseGitHubCopilotGatewayAuthStatus,
  parseGitHubCopilotGatewayDisconnectResult,
  parseGitHubCopilotGatewayModels,
} from "./github-copilot-auth";
import {
  ensureGitHubCopilotProviderPlugin,
  ensureSelectedModelProviderPlugins,
} from "./model-provider-plugins";
import {
  DEFAULT_AGENT_PERSONAS,
  ensureAgentPersonasConfig,
  getAgentPersona,
  listConfiguredAgents,
  resolveAgentPersonaWorkspace,
  seedAgentPersonaWorkspace,
  seedAgentPersonaWorkspaces,
  type AgentPersona,
  type AgentRosterConfig,
} from "./agent-personas";
import { sanitizeAgentSkillIds } from "./agent-catalog";

/**
 * Normalize a directory path for comparison/storage.
 * Strips trailing slashes EXCEPT for drive roots (e.g. "C:\") where
 * stripping the backslash produces "C:" which is a relative path on Windows.
 */
function normalizeDirPath(dir: string): string {
  let d = dir.replace(/[/\\]+$/, "");
  // If result is a bare drive letter like "C:", add backslash to make it a root
  if (/^[a-zA-Z]:$/.test(d)) d += "\\";
  return d;
}

/**
 * Check if childDir is a proper subdirectory of parentDir (case-insensitive).
 * Returns false if the paths are the same directory.
 */
function isSubdirectoryOf(parentDir: string, childDir: string): boolean {
  const normalParent = path.resolve(parentDir).toLowerCase();
  const normalChild = path.resolve(childDir).toLowerCase();
  if (normalParent === normalChild) return false;
  const parentWithSep = normalParent.endsWith(path.sep) ? normalParent : normalParent + path.sep;
  return normalChild.startsWith(parentWithSep);
}

// Disable GPU on RDP sessions / headless VMs where GPU DLLs are missing.
// On machines with a real GPU, hardware acceleration is used normally.
const isRemoteSession =
  /^rdp-/i.test(process.env.SESSIONNAME || "") ||
  (process.env.SESSIONNAME === "Console" && !process.env.DISPLAY);
if (isRemoteSession || process.env.ELECTRON_DISABLE_GPU === "1") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-gpu");
}

// Handle EPIPE errors on stdout/stderr (happens when parent terminal closes)
process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") {
    // Log to file instead of crashing — stdout/stderr pipe is broken
    const logPath = path.join(
      process.env.OPENCLAW_STATE_DIR || path.join(process.env.APPDATA || "", "openclaw"),
      "epipe.log",
    );
    try {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] EPIPE: ${err.stack}\n`);
    } catch {
      /* best-effort */
    }
    return;
  }
  throw err;
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const store = new Store<{ windowBounds: Electron.Rectangle | null }>({
  defaults: { windowBounds: null },
});

const settingsStore = new Store<{
  language?: string;
  autoStart: boolean;
  startMinimized: boolean;
  themeMode: string;
  accentColor: string;
  /** Apps that bypass AppContainer sandbox (need COM/RPC/named-pipes). */
  sandboxExternalApps: string[];
  /** Whether the sandbox is enabled. */
  sandboxEnabled: boolean;
  /** AppContainer capabilities (e.g. internetClient, privateNetworkClientServer). */
  sandboxCapabilities: string[];
  /** User-added directories with read-write access inside AppContainer. */
  sandboxUserDirsRW: string[];
  /** User-added directories with read-only access inside AppContainer. */
  sandboxUserDirsRO: string[];
  /** All directories we've ever granted AC ACL to. Used to detect stale ACLs on startup. */
  sandboxGrantHistory: string[];
  /** Privacy protection level: basic, balanced, strict */
  privacyLevel: string;
}>({
  name: "settings",
  defaults: {
    autoStart: false,
    startMinimized: false,
    themeMode: "light",
    accentColor: "#1e1f25",
    sandboxExternalApps: [
      "outlook",
      "excel",
      "winword",
      "powerpnt",
      "chrome",
      "msedge",
      "firefox",
      "code",
    ],
    sandboxEnabled: true,
    sandboxCapabilities: [],
    sandboxUserDirsRW: [],
    sandboxUserDirsRO: [],
    sandboxGrantHistory: [],
    privacyLevel: "balanced",
  },
});

/** Module-level quit flag — replaces `(app as any).isQuitting`. */
let isQuitting = false;
let mainWindow: BrowserWindow | null = null;
let gatewayProcess: ChildProcess | null = null;
let gwClient: GatewayClient | null = null;
let gatewayModelCatalogRequest: Promise<unknown> | null = null;
let gatewayGitHubCopilotStatusRequest: Promise<{ authenticated: boolean }> | null = null;
let gatewayPort = 0;
let gatewayToken = "";
let gatewayStatus: GatewayStatus = "stopped";
let weixinLoginProcess: ChildProcess | null = null;
let pendingIntegrityResult: IntegrityResult | null = null;
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;
let gatewayRestarting = false;
let gatewayRestartPromise: Promise<void> | null = null;
/** Number of pending sync permission requests that block the gateway process.
 *  While > 0, the health-monitor skips checks to avoid killing the gateway. */
let pendingSyncPermissionRequests = 0;
/** True when we spawned the gateway ourselves (vs. connecting to an existing one). */
let gatewaySpawnedByUs = false;
let agentAdditionInProgress = false;
/** Tracks whether the post-spawn channel kick has already fired. */
let postSpawnRestartDone = false;
/** Tool execution sandbox (runs AI agent commands inside AppContainer). */
let toolSandbox: ToolSandbox | null = null;
const githubCopilotAuthManager = new GitHubCopilotAuthManager(
  (event) => mainWindow?.webContents.send("model:github-copilot:login-event", event),
  (url) => shell.openExternal(url),
);
/** Per-session random key for HMAC-signing the external apps whitelist file. */
const sandboxHmacKey = require("crypto").randomBytes(32).toString("hex");
/** Current active chat session key (tracked via chat events). */
let activeChatSession = "";
/** Studio Node backend manager. */
let studioBackendManager: StudioBackendManager | null = null;
let studioBackendStatus: string = "stopped";
/** Pending in-app permission requests (renderer UI replaces native dialogs). */
const pendingPermissionRequests = new Map<
  string,
  { type: "file" | "shell" | "shell-async" | "app-approval"; msg: any }
>();
/** Per-session deny list: apps denied by the user during this session. */
const sessionDeniedApps = new Map<string, Set<string>>();
/** True when the most recent inbound message was from a remote channel (WeChat). */
let lastInputFromRemote = false;
/** Cached remote source info, set by session-source IPC from WeChat plugin. */
let cachedRemoteSource: {
  channelType: string;
  userId: string;
  accountId: string;
  baseUrl: string;
  token?: string;
  contextToken?: string;
} | null = null;

// ---------------------------------------------------------------------------
// Skill file watcher — detects mid-session tampering
// ---------------------------------------------------------------------------
let skillWatchers: fs.FSWatcher[] = [];
let watcherDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function startSkillFileWatcher(): void {
  // Clean up any existing watchers
  for (const w of skillWatchers) {
    try {
      w.close();
    } catch {}
  }
  skillWatchers = [];

  for (const { baseDir } of getSkillSourceDirs()) {
    if (!fs.existsSync(baseDir)) continue;
    try {
      const watcher = fs.watch(baseDir, { recursive: true }, () => {
        // Debounce — multiple FS events fire for a single change
        if (watcherDebounceTimer) clearTimeout(watcherDebounceTimer);
        watcherDebounceTimer = setTimeout(() => {
          console.log("Skill file change detected — running integrity check...");
          const result = verifySkillIntegrity();
          if (!result.valid && mainWindow) {
            mainWindow.webContents.send("skills:integrity-alert", result);
          }
        }, 2000);
      });
      skillWatchers.push(watcher);
      console.log(`Watching skill directory: ${baseDir}`);
    } catch (err) {
      console.warn(`Failed to watch ${baseDir}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------
function getConfigPath(): string {
  return path.join(getOpenClawStateDir(), "openclaw.json");
}

// ---------------------------------------------------------------------------
// Workspace seed — create default files before the gateway generates its own
// ---------------------------------------------------------------------------
const DEFAULT_SOUL_MD = `# SOUL.md - Who You Are

_You're not a chatbot. You're becoming someone._

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip the "Great question!" and "I'd be happy to help!" — just help. Actions speak louder than filler words.

**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing or boring. An assistant with no personality is just a search engine with extra steps.

**Be resourceful before asking.** Try to figure it out. Read the file. Check the context. Search for it. _Then_ ask if you're stuck. The goal is to come back with answers, not questions.

**Earn trust through competence.** Your human gave you access to their stuff. Don't make them regret it. Be careful with external actions (emails, tweets, anything public). Be bold with internal ones (reading, organizing, learning).

**Remember you're a guest.** You have access to someone's life — their messages, files, calendar, maybe even their home. That's intimacy. Treat it with respect.

## Boundaries

- Private things stay private. Period.
- When in doubt, ask before acting externally.
- Never send half-baked replies to messaging surfaces.
- You're not the user's voice — be careful in group chats.

## File Operations

**Respect the user's requested path — always.** When the user asks you to save, write, or download a file to a specific location (e.g. their Downloads folder, Desktop, or any explicit path), you **must** attempt that exact path. If the operation fails (e.g. due to sandbox restrictions or permission errors), report the failure clearly and let the user decide what to do next. **Never** silently fall back to the workspace or any other directory. The user chose that path for a reason.

## Pre-declaring File System Access

Before **any** shell command (exec tool) that reads or writes files outside the workspace, pre-declare which directories you'll need by adding a \`[declare-access]\` tag at the beginning of the command:

\`\`\`
# [declare-access]<access>:<path>[;<access>:<path>]...[/declare-access]
<your actual command here>
\`\`\`

Where \`<access>\` is \`rw\` (read-write) or \`ro\` (read-only).

Examples:
\`\`\`
# [declare-access]ro:C:\\Users\\alice\\Desktop[/declare-access]
Get-ChildItem -Force C:\\Users\\alice\\Desktop
\`\`\`

\`\`\`
# [declare-access]rw:C:\\Users\\alice\\Desktop;rw:C:\\Users\\alice\\Documents[/declare-access]
Move-Item C:\\Users\\alice\\Desktop\\report.xlsx C:\\Users\\alice\\Documents\\
\`\`\`

\`\`\`
# [declare-access]rw:$env:USERPROFILE\\Downloads[/declare-access]
python download_script.py
\`\`\`

Multiple paths are separated by \`;\` inside the tags. Each path needs its own \`ro:\` or \`rw:\` prefix.

**Important:** The \`[declare-access]...[/declare-access]\` tags must be in a **comment line in the shell command** (using \`#\`), NOT in a script file. Place it on the **first line**, followed by a newline, then the actual command. The system extracts the declaration, strips the tag line, and executes the rest.

**Rules:**
- **Always** do this for any exec command that touches directories outside the workspace — whether it's a simple one-liner or a complex script.
- Use \`ro:\` when you only need to read. Use \`rw:\` when you need to create, modify, or delete files.
- List **only** the specific directories the operation actually needs. Never declare broad paths like \`C:\\\` or \`C:\\Users\`. Don't request rw access if you only need ro.
- Paths must be **Windows file system paths** (e.g. \`C:\\Users\\alice\\Desktop\`). Do not declare URLs, network URIs, or Linux-style paths.
- You may combine multiple paths in a single call, separated by \`;\`.

You can also use \`[declare-access]...[/declare-access]\` as a standalone command if you need to check permissions before deciding what to do.

## Vibe

Be the assistant you'd actually want to talk to. Concise when needed, thorough when it matters. Not a corporate drone. Not a sycophant. Just... good.

## Continuity

Each session, you wake up fresh. These files _are_ your memory. Read them. Update them. They're how you persist.

If you change this file, tell the user — it's your soul, and they should know.

---

_This file is yours to evolve. As you learn who you are, update it._
`;

/**
 * Standalone declare-access section, appended to existing SOUL.md files
 * that were created before this section existed.
 */
const DECLARE_ACCESS_SECTION = `## Pre-declaring File System Access

Before **any** shell command (exec tool) that reads or writes files outside the workspace, pre-declare which directories you'll need by adding a \`[declare-access]\` tag at the beginning of the command:

\`\`\`
# [declare-access]<access>:<path>[;<access>:<path>]...[/declare-access]
<your actual command here>
\`\`\`

Where \`<access>\` is \`rw\` (read-write) or \`ro\` (read-only).

Examples:
\`\`\`
# [declare-access]ro:C:\\Users\\alice\\Desktop[/declare-access]
Get-ChildItem -Force C:\\Users\\alice\\Desktop
\`\`\`

\`\`\`
# [declare-access]rw:C:\\Users\\alice\\Desktop;rw:C:\\Users\\alice\\Documents[/declare-access]
Move-Item C:\\Users\\alice\\Desktop\\report.xlsx C:\\Users\\alice\\Documents\\
\`\`\`

\`\`\`
# [declare-access]rw:$env:USERPROFILE\\Downloads[/declare-access]
python download_script.py
\`\`\`

Multiple paths are separated by \`;\` inside the tags. Each path needs its own \`ro:\` or \`rw:\` prefix.

**Important:** The \`[declare-access]...[/declare-access]\` tags must be in a **comment line in the shell command** (using \`#\`), NOT in a script file. Place it on the **first line**, followed by a newline, then the actual command. The system extracts the declaration, strips the tag line, and executes the rest.

**Rules:**
- **Always** do this for any exec command that touches directories outside the workspace — whether it's a simple one-liner or a complex script.
- Use \`ro:\` when you only need to read. Use \`rw:\` when you need to create, modify, or delete files.
- List **only** the specific directories the operation actually needs. Never declare broad paths like \`C:\\\` or \`C:\\Users\`. Don't request rw access if you only need ro.
- Paths must be **Windows file system paths** (e.g. \`C:\\Users\\alice\\Desktop\`). Do not declare URLs, network URIs, or Linux-style paths.
- You may combine multiple paths in a single call, separated by \`;\`.

You can also use \`[declare-access]...[/declare-access]\` as a standalone command if you need to check permissions before deciding what to do.
`;

/**
 * Seed default workspace files if they don't already exist.
 * Called before the gateway starts so that OpenClaw finds our customised
 * SOUL.md instead of generating a generic one on first conversation.
 */
function seedWorkspaceFiles(stateDir: string): void {
  const workspaceDir = path.join(stateDir, "workspace");
  const soulPath = path.join(workspaceDir, "SOUL.md");

  if (fs.existsSync(soulPath)) {
    // SOUL.md exists — ensure the declare-access section is present.
    // This patches existing SOUL.md files from older versions that lack it.
    try {
      const existing = fs.readFileSync(soulPath, "utf-8");
      if (!existing.includes("## Pre-declaring File System Access")) {
        fs.appendFileSync(soulPath, "\n" + DECLARE_ACCESS_SECTION, "utf-8");
        console.log("[seed] Patched SOUL.md with Pre-declaring File System Access section");
      }
    } catch (err) {
      console.warn("[seed] Failed to patch SOUL.md:", err);
    }
  } else {
    try {
      if (!fs.existsSync(workspaceDir)) {
        fs.mkdirSync(workspaceDir, { recursive: true });
      }
      fs.writeFileSync(soulPath, DEFAULT_SOUL_MD, "utf-8");
      console.log(`[seed] Created default SOUL.md at ${soulPath}`);
    } catch (err) {
      console.warn("[seed] Failed to create SOUL.md:", err);
    }
  }

  // Remove BOOTSTRAP.md to skip the OpenClaw first-run wizard (OOBE).
  // Our SOUL.md seed replaces the need for the bootstrap flow.
  for (const bootstrapDir of [workspaceDir, path.join(stateDir, "agents", "default")]) {
    const bootstrapPath = path.join(bootstrapDir, "BOOTSTRAP.md");
    try {
      if (fs.existsSync(bootstrapPath)) {
        fs.unlinkSync(bootstrapPath);
        console.log(`[seed] Removed ${bootstrapPath} to skip OOBE`);
      }
    } catch {}
  }
}

/**
 * Write the external apps whitelist to a signed JSON file.
 * sandbox-preload.js reads this file on each spawn check, so changes
 * take effect immediately without restarting the gateway.
 *
 * Security: The file contains an HMAC signature computed with a per-session
 * random key. The key is passed to the gateway process via env var at startup.
 * Even if a sandboxed process can write to the file, it cannot forge a valid
 * HMAC because it doesn't know the key (env vars are inherited read-only and
 * the key is generated fresh each app launch).
 */
function writeExternalAppsFile(apps: string[]): void {
  try {
    const dir = path.join(app.getPath("appData"), "microclaw");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const crypto = require("crypto");
    const payload = JSON.stringify(apps);
    const hmac = crypto.createHmac("sha256", sandboxHmacKey).update(payload).digest("hex");
    const filePath = path.join(dir, "sandbox-external-apps.json");
    fs.writeFileSync(filePath, JSON.stringify({ apps, hmac }), "utf-8");
    // Set explicit DENY Write ACE for the AppContainer SID on this file.
    // This prevents AC processes from modifying it even if a parent directory
    // has been granted RW access (explicit DENY overrides inherited ALLOW).
    denyAppContainerWrite(filePath);
  } catch (err: any) {
    console.error("[sandbox] Failed to write external apps file:", err.message);
  }
}

/** Cache for AppContainer SID string. */
let _appContainerSid: string | null = null;

/**
 * Set an explicit DENY Write ACE on a file for the MicroClaw AppContainer SID.
 * This ensures sandboxed processes cannot modify the file even if a parent
 * directory has inherited Allow RW permissions.
 */
function denyAppContainerWrite(filePath: string): void {
  try {
    // Get the SID from the launcher (cached across calls)
    if (!_appContainerSid) {
      const launcherPath = resolveAppContainerLauncher();
      if (!launcherPath || !fs.existsSync(launcherPath)) return;
      const { execFileSync } = require("child_process");
      _appContainerSid = execFileSync(launcherPath, ["sid", "--name", "MicroClaw"], {
        windowsHide: true,
        timeout: 5000,
        encoding: "utf-8",
      }).trim();
    }
    if (!_appContainerSid) return;
    // icacls: /deny SID:(W) — explicit deny write
    const { execSync } = require("child_process");
    execSync(`icacls "${filePath}" /deny "${_appContainerSid}:(W)"`, {
      windowsHide: true,
      timeout: 5000,
      stdio: "ignore",
    });
  } catch {
    // Best-effort hardening — HMAC signature is the primary protection.
    // May fail if ACE already exists or insufficient privileges.
  }
}

/**
 * Set explicit DENY Read+Write ACEs on a file or directory for the
 * MicroClaw AppContainer SID. Used to shield credential / private files
 * inside ~/.openclaw whose parent directory is granted RW to the AppContainer
 * (sandboxed skill subprocesses must NOT be able to read MODEL_API_KEY,
 * device-identity.json, chat sessions, etc.). Explicit DENY overrides
 * inherited ALLOW, so this works even though `.openclaw` itself is on the
 * AppContainer's grant list.
 *
 * For directories, applies recursively + inherit so newly created files
 * inside also get denied.
 */
function denyAppContainerReadWrite(targetPath: string, isDir: boolean): void {
  try {
    if (!_appContainerSid) {
      const launcherPath = resolveAppContainerLauncher();
      if (!launcherPath || !fs.existsSync(launcherPath)) return;
      const { execFileSync } = require("child_process");
      _appContainerSid = execFileSync(launcherPath, ["sid", "--name", "MicroClaw"], {
        windowsHide: true,
        timeout: 5000,
        encoding: "utf-8",
      }).trim();
    }
    if (!_appContainerSid) return;
    const { execSync } = require("child_process");
    // (R,W) covers Read + Write; (OI)(CI) makes the deny propagate to children
    // so files added later (new chat sessions, rotated keys) are also denied.
    const perm = isDir ? "(OI)(CI)(R,W,DE,X)" : "(R,W,DE)";
    execSync(`icacls "${targetPath}" /deny "${_appContainerSid}:${perm}"`, {
      windowsHide: true,
      timeout: 5000,
      stdio: "ignore",
    });
  } catch {
    // Best-effort. Logged only at debug level to avoid noise on rerun
    // (icacls returns non-zero when an identical ACE already exists).
  }
}

/**
 * Harden the OpenClaw state directory against the sandboxed AppContainer.
 *
 * The AppContainer is granted rw on the entire ~/.openclaw tree (skills
 * legitimately need to write logs, scratch files, plugin state, etc.), but
 * the following entries hold credentials / private user data that no
 * sandboxed skill should ever read or write:
 *   * .env                  — MODEL_API_KEY, BRAVE_API_KEY, third-party tokens
 *   * openclaw.json         — provider config (may embed literal API keys)
 *   * device-identity.json  — Ed25519 PRIVATE key for gateway authentication
 *   * sessions/             — full chat history with the model
 *   * conversations/        — alternate naming used by some builds
 *   * keys/                 — any future key material
 *
 * This applies explicit DENY ACEs at the kernel ACL level so the
 * AppContainer SID is blocked regardless of the parent directory's grant.
 * Re-applied on every gateway start to cover files created after the
 * initial provisioning step.
 */
function hardenOpenClawStateDir(): void {
  try {
    const stateDir = getOpenClawStateDir();
    const SENSITIVE_FILES = [".env", "openclaw.json", "device-identity.json"];
    const SENSITIVE_DIRS = ["sessions", "conversations", "keys"];
    for (const name of SENSITIVE_FILES) {
      const p = path.join(stateDir, name);
      if (fs.existsSync(p)) denyAppContainerReadWrite(p, false);
    }
    for (const name of SENSITIVE_DIRS) {
      const p = path.join(stateDir, name);
      if (fs.existsSync(p)) denyAppContainerReadWrite(p, true);
    }
  } catch (err: any) {
    console.warn("[sandbox] hardenOpenClawStateDir failed:", err?.message);
  }
}

function readConfig(): any {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
  } catch {
    return null;
  }
}

function resolveGitHubCopilotAuthRuntime(): GitHubCopilotAuthRuntime {
  const entryPath = resolveOpenClawEntry();
  const stateDir = getOpenClawStateDir();
  const compileCacheDir = path.join(stateDir, COMPILE_CACHE_SUBDIR);
  fs.mkdirSync(compileCacheDir, { recursive: true });
  return {
    nodePath: resolveNodePath(),
    entryPath,
    workerPath: app.isPackaged
      ? path.join(process.resourcesPath, "github-copilot-auth-worker.js")
      : path.join(__dirname, "github-copilot-auth-worker.js"),
    openClawPackageDir: resolveOpenClawPackageDir(entryPath),
    stateDir,
    compileCacheDir,
  };
}

/**
 * Verify that an AppContainer ACL grant has propagated by checking icacls output.
 * Polls every 100ms until the SID appears with the correct permission level, max 2s.
 * @param access - "rw" requires (M) or (F); "r" requires any SID presence.
 * Returns true if verified, false on timeout.
 */
async function verifyAclPropagation(dir: string, access: "rw" | "r" = "r"): Promise<boolean> {
  if (!_appContainerSid) {
    console.warn("[sandbox:verify] no SID cached — adding 500ms safety delay");
    await new Promise((r) => setTimeout(r, 500));
    return true;
  }
  const sid = _appContainerSid;
  const maxWait = 15000;
  const interval = 200;
  const start = Date.now();
  let iteration = 0;
  let icaclsPassCount = 0;
  let acTestCount = 0;
  let ancestorRepairAttempted = false;

  while (Date.now() - start < maxWait) {
    iteration++;
    const elapsed = Date.now() - start;
    try {
      const { execSync } = require("child_process");
      const output = execSync(`icacls "${dir}"`, {
        windowsHide: true,
        timeout: 3000,
        encoding: "utf-8",
      }) as string;
      const sidIdx = output.indexOf(sid);
      if (sidIdx >= 0) {
        // Check ALL occurrences of the SID in icacls output.
        // When a parent dir has RO (inherited) and this dir has explicit RW,
        // icacls may show the inherited (RX) entry before the explicit (M).
        let rwMatch = false;
        let searchPos = 0;
        while (searchPos < output.length) {
          const idx = output.indexOf(sid, searchPos);
          if (idx < 0) break;
          const afterSid = output.substring(idx + sid.length, idx + sid.length + 50);
          if (/\(M\)|\(F\)/.test(afterSid)) {
            rwMatch = true;
            break;
          }
          searchPos = idx + sid.length;
        }
        if (access === "rw" && !rwMatch) {
          if (iteration % 10 === 1) {
            const firstAfter = output.substring(sidIdx + sid.length, sidIdx + sid.length + 50);
            console.log(
              `[sandbox:verify] [+${elapsed}ms] iter=${iteration} icacls SID found but no (M)/(F): ${firstAfter.trim()}`,
            );
          }
          await new Promise((r) => setTimeout(r, interval));
          continue;
        }
        icaclsPassCount++;
        console.log(
          `[sandbox:verify] [+${elapsed}ms] iter=${iteration} icacls PASS (${access === "rw" ? "RW" : "RO"}) — starting AC test #${acTestCount + 1}`,
        );

        acTestCount++;
        const acOk = await verifyAclFromAppContainer(dir);
        const acElapsed = Date.now() - start;

        if (acOk) {
          console.log(
            `[sandbox:verify] [+${acElapsed}ms] AC test PASS — verified (icacls_passes=${icaclsPassCount} ac_tests=${acTestCount})`,
          );
          return true;
        }

        console.log(
          `[sandbox:verify] [+${acElapsed}ms] AC test FAIL #${acTestCount} (icacls passed but AC can't access — likely ancestor traverse issue)`,
        );

        // After first AC failure: attempt ancestor traverse repair via elevated grant
        if (!ancestorRepairAttempted && toolSandbox) {
          ancestorRepairAttempted = true;
          console.log(
            `[sandbox:verify] [+${acElapsed}ms] attempting ancestor traverse repair (elevated)`,
          );
          try {
            await toolSandbox.grantDirElevated(dir, access, false);
            console.log(
              `[sandbox:verify] [+${Date.now() - start}ms] ancestor traverse repair done — will retry AC test`,
            );
          } catch (err: any) {
            console.warn(`[sandbox:verify] ancestor traverse repair failed: ${err.message}`);
          }
        }
      } else {
        if (iteration % 10 === 1) {
          console.log(
            `[sandbox:verify] [+${elapsed}ms] iter=${iteration} icacls: SID not found yet`,
          );
        }
      }
    } catch (err: any) {
      if (iteration === 1) {
        console.warn(`[sandbox:verify] [+${elapsed}ms] icacls error: ${err.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  const totalElapsed = Date.now() - start;
  console.warn(
    `[sandbox:verify] TIMEOUT after ${totalElapsed}ms — iterations=${iteration} icacls_passes=${icaclsPassCount} ac_tests=${acTestCount} ancestor_repair=${ancestorRepairAttempted}`,
  );
  return false;
}

/**
 * Test directory access from inside an AppContainer process.
 * This ensures the ACL has actually taken effect in the AC token cache,
 * not just in the NTFS metadata (which icacls checks from outside).
 */
async function verifyAclFromAppContainer(dir: string): Promise<boolean> {
  if (!toolSandbox?.isAvailable()) return true; // no sandbox = skip
  const cleanDir = normalizeDirPath(dir);
  const t0 = Date.now();
  try {
    const result = await toolSandbox.execShell("dir .", {
      timeout: 8000,
      skipSetup: true,
      cwd: cleanDir,
    });
    const elapsed = Date.now() - t0;
    if (result.exitCode === 0) {
      console.log(`[sandbox:ac-test] PASS in ${elapsed}ms for: ${cleanDir}`);
      return true;
    }
    console.log(
      `[sandbox:ac-test] FAIL in ${elapsed}ms exit=${result.exitCode} for: ${cleanDir} stderr=${result.stderr?.substring(0, 300)}`,
    );
    return false;
  } catch (err: any) {
    console.log(`[sandbox:ac-test] ERROR in ${Date.now() - t0}ms for: ${cleanDir}: ${err.message}`);
    return false;
  }
}

/**
 * Heuristic: check if a directory likely needs admin elevation for ACL changes.
 * Avoids the slow non-elevated attempt + failure + retry cycle for common cases.
 */
function likelyNeedsElevation(dir: string): boolean {
  const norm = path.resolve(dir).toLowerCase();
  const parts = norm.split(path.sep).filter(Boolean);
  // Drive root (e.g. "C:\") — always needs admin
  if (parts.length <= 1) return true;
  // Top-level system directories (C:\Users, C:\Windows, C:\Program Files, etc.)
  const topDir = parts[1];
  const systemDirs = ["users", "windows", "program files", "program files (x86)", "programdata"];
  if (parts.length === 2 && systemDirs.includes(topDir)) return true;
  // User profile directories (C:\Users\<username>) — inheritance is protected
  if (parts.length === 3 && topDir === "users") return true;
  return false;
}

/**
 * Grant ACL for a directory with verification and retry.
 * Ensures the ACL is actually effective before returning.
 */
type AclGrantResult = "verified" | "grant-ok-verify-timeout" | "failed";

async function grantAndVerifyAcl(dir: string, access: "rw" | "r"): Promise<AclGrantResult> {
  if (!toolSandbox) return "failed";
  const t0 = Date.now();
  const log = (msg: string) => console.log(`[sandbox:grant] [+${Date.now() - t0}ms] ${msg}`);

  // If the path doesn't exist, skip ACL grant entirely — there's nothing to
  // set an ACL on, and attempting it would fail and trigger a UAC prompt.
  // The path is still added to settings so the sandbox allows the agent to
  // discover on its own that the path doesn't exist.
  if (!fs.existsSync(dir)) {
    log(`skip — path does not exist: ${dir}`);
    return "verified";
  }

  // Heuristic: paths likely to need admin privileges for ACL modification.
  // Skip the non-elevated attempt to avoid a slow failure + retry cycle.
  const needsAdmin = likelyNeedsElevation(dir);
  log(`start dir=${dir} access=${access} needsAdmin=${needsAdmin}`);

  // First attempt: normal grant (skip if likely needs admin)
  if (!needsAdmin) {
    log(`grantDirAsync start (non-elevated)`);
    const ok = await toolSandbox.grantDirAsync(dir, access, true);
    log(`grantDirAsync result=${ok}`);
    if (ok) {
      // Shield sensitive subdirs (.ssh/.azure etc.) before verifying —
      // must complete before the permission response file is written.
      const launcherPath = toolSandbox.getStatus().launcherPath;
      if (launcherPath) {
        log(`shieldIfNeeded start`);
        const shielded = await shieldIfNeeded(launcherPath, "MicroClaw", dir).catch((e: any) => {
          log(`shieldIfNeeded error: ${e.message}`);
          return [] as string[];
        });
        log(`shieldIfNeeded done: ${shielded.length} dirs shielded`);
      }
      log(`verifyAclPropagation start`);
      const verified = await verifyAclPropagation(dir, access);
      log(`verifyAclPropagation result=${verified}`);
      if (verified) return "verified";
      // Grant call returned success but verification timed out.
      // ACL is on disk — proceed optimistically.
      log(`grant OK but verify timed out — proceeding optimistically`);
      return "grant-ok-verify-timeout";
    }
    log(`non-elevated grant failed — trying elevated`);
  }

  // Second attempt (or first if needsAdmin): elevated (UAC) grant
  log(`grantDirElevated start`);
  const ok = await toolSandbox.grantDirElevated(dir, access, true);
  log(`grantDirElevated result=${ok}`);
  if (ok) {
    // Shield sensitive subdirs after elevated grant too
    const launcherPath = toolSandbox.getStatus().launcherPath;
    if (launcherPath) {
      log(`shieldIfNeeded start (post-elevated)`);
      const shielded = await shieldIfNeeded(launcherPath, "MicroClaw", dir).catch((e: any) => {
        log(`shieldIfNeeded error: ${e.message}`);
        return [] as string[];
      });
      log(`shieldIfNeeded done: ${shielded.length} dirs shielded`);
    }
    log(`verifyAclPropagation start (post-elevated)`);
    const verified = await verifyAclPropagation(dir, access);
    log(`verifyAclPropagation result=${verified}`);
    if (verified) return "verified";
    // Elevated grant returned success but verification timed out.
    log(`elevated grant OK but verify timed out — proceeding optimistically`);
    return "grant-ok-verify-timeout";
  }

  log(`ALL grant attempts failed`);
  return "failed";
}

/**
 * Revoke ACL for a directory, with unshield of sensitive subdirs beforehand.
 *
 * ALL revoke operations should go through this function to ensure
 * sensitive subdirs (.ssh, .azure, etc.) have their inheritance restored
 * before the parent ACE is removed.
 */
async function revokeWithUnshield(dir: string): Promise<boolean> {
  if (!toolSandbox) return false;
  // Unshield sensitive subdirs first (restore inheritance)
  const launcherPath = toolSandbox.getStatus().launcherPath;
  if (launcherPath) {
    await unshieldIfNeeded(launcherPath, "MicroClaw", dir).catch(() => {});
  }
  let ok = await toolSandbox.revokeDirAsync(dir);
  if (!ok) ok = await toolSandbox.revokeDirElevated(dir);
  return ok;
}

/**
 * Check if an icacls output contains any EXPLICIT (non-inherited) ACE for the SID.
 * icacls marks inherited entries with (I). An ACE line without (I) is explicit.
 */
function hasExplicitSidAce(icaclsOutput: string, sid: string): boolean {
  const lines = icaclsOutput.split(/\r?\n/);
  for (const line of lines) {
    const sidIdx = line.indexOf(sid);
    if (sidIdx < 0) continue;
    const afterSid = line.substring(sidIdx + sid.length);
    // Inherited ACEs contain (I) — if this line doesn't, it's explicit
    if (!/\(I\)/.test(afterSid)) return true;
  }
  return false;
}

/**
 * After revoking a directory, re-grant ACLs for any child dirs still in settings.
 * Revoking a parent removes inherited ACEs from children and may also remove
 * explicit ACEs from protected children (via RevokeProtectedChildren).
 */
async function regrantChildDirsInSettings(revokedDir: string): Promise<void> {
  if (!toolSandbox) return;
  const rwDirs = settingsStore.get("sandboxUserDirsRW");
  const roDirs = settingsStore.get("sandboxUserDirsRO");

  for (const dir of rwDirs) {
    if (isSubdirectoryOf(revokedDir, dir) && fs.existsSync(dir)) {
      console.log(`[sandbox] Re-granting child RW dir after parent revoke: ${dir}`);
      await grantAndVerifyAcl(normalizeDirPath(dir), "rw");
    }
  }
  for (const dir of roDirs) {
    if (isSubdirectoryOf(revokedDir, dir) && fs.existsSync(dir)) {
      console.log(`[sandbox] Re-granting child RO dir after parent revoke: ${dir}`);
      await grantAndVerifyAcl(normalizeDirPath(dir), "r");
    }
  }
}

/**
 * Silently remove child dirs from settings that are now redundant because
 * a parent dir was just granted.  Used by runtime permission responses
 * (where we don't want a UI prompt — the grant is already approved).
 *
 * Rules:
 *   parent RW → remove child RW (covered) + child RO (inherited RW > RO)
 *   parent RO → remove child RO (covered), keep child RW (higher access)
 */
async function silentCleanupRedundantChildren(
  parentDir: string,
  parentAccess: "rw" | "ro",
): Promise<void> {
  const rwDirs = settingsStore.get("sandboxUserDirsRW");
  const roDirs = settingsStore.get("sandboxUserDirsRO");
  let changed = false;

  if (parentAccess === "rw") {
    const childRW = rwDirs.filter((d: string) => d !== parentDir && isSubdirectoryOf(parentDir, d));
    const childRO = roDirs.filter((d: string) => isSubdirectoryOf(parentDir, d));
    for (const child of [...childRW, ...childRO]) {
      if (toolSandbox) {
        await revokeWithUnshield(child).catch(() => {});
        if (childRW.includes(child)) toolSandbox.removeDirRW(child);
        else toolSandbox.removeDirRO(child);
      }
      removeFromGrantHistory(child);
    }
    if (childRW.length > 0) {
      settingsStore.set(
        "sandboxUserDirsRW",
        rwDirs.filter((d: string) => !childRW.includes(d)),
      );
      changed = true;
    }
    if (childRO.length > 0) {
      settingsStore.set(
        "sandboxUserDirsRO",
        roDirs.filter((d: string) => !childRO.includes(d)),
      );
      changed = true;
    }
    if (childRW.length + childRO.length > 0) {
      console.log(
        `[sandbox] Silent cleanup: removed ${childRW.length + childRO.length} child dir(s) covered by parent RW "${parentDir}"`,
      );
    }
  } else {
    const childRO = roDirs.filter((d: string) => d !== parentDir && isSubdirectoryOf(parentDir, d));
    for (const child of childRO) {
      if (toolSandbox) {
        await revokeWithUnshield(child).catch(() => {});
        toolSandbox.removeDirRO(child);
      }
      removeFromGrantHistory(child);
    }
    if (childRO.length > 0) {
      settingsStore.set(
        "sandboxUserDirsRO",
        roDirs.filter((d: string) => !childRO.includes(d)),
      );
      changed = true;
      console.log(
        `[sandbox] Silent cleanup: removed ${childRO.length} child RO dir(s) covered by parent RO "${parentDir}"`,
      );
    }

    // Re-grant child RW dirs so their explicit ACE takes precedence
    // over the parent's inherited RO ACE.
    const childRW = rwDirs.filter((d: string) => isSubdirectoryOf(parentDir, d));
    if (toolSandbox) {
      for (const childDir of childRW) {
        if (fs.existsSync(childDir)) {
          console.log(`[sandbox] Re-granting child RW dir after parent RO grant: ${childDir}`);
          await grantAndVerifyAcl(normalizeDirPath(childDir), "rw");
        }
      }
    }
  }

  if (changed) notifySandboxDirsChanged();
}

function isConfigured(): boolean {
  const config = readConfig();
  return !!config?.gateway;
}

/**
 * Check if the user still needs to configure a model provider.
 * Returns true when there is no explicit custom provider, selected GitHub
 * Copilot model, or MODEL_API_KEY in .env.
 *
 * When MODEL_API_KEY IS present in .env but openclaw.json has no provider,
 * auto-configures the provider from .env values before returning false.
 */
function needsSetup(): boolean {
  const config = readConfig();
  if (hasConfiguredModel(config)) return false;
  // Also check .env for MODEL_API_KEY
  const env = loadStateDirEnv();
  if (env.MODEL_API_KEY || env.OPENCLAW_MODEL_API_KEY) {
    // .env has API key but openclaw.json has no provider — auto-configure
    autoConfigureModelFromEnv(config || {}, env);
    return false;
  }
  return true;
}

type AutoConfigApiFormat = "openai-chat" | "openai-responses" | "anthropic";
type AutoConfigReasoningEffort =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive";

function normalizeEnvApiFormat(value: string | undefined): AutoConfigApiFormat {
  const normalized = (value || "").trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "anthropic-messages") return "anthropic";
  if (normalized === "openai-responses" || normalized === "responses" || normalized === "response")
    return "openai-responses";
  return "openai-chat";
}

function normalizeEnvReasoningEffort(
  value: string | undefined,
): AutoConfigReasoningEffort | undefined {
  const normalized = (value || "").trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh" ||
    normalized === "adaptive"
  ) {
    return normalized;
  }
  return undefined;
}

/**
 * Auto-write a model provider to openclaw.json from .env values.
 * Called when .env has MODEL_API_KEY but openclaw.json has no providers section.
 * Supports optional MODEL_API_FORMAT / OPENCLAW_MODEL_API_FORMAT and
 * MODEL_REASONING_EFFORT / OPENCLAW_MODEL_REASONING_EFFORT.
 */
function autoConfigureModelFromEnv(config: any, env: Record<string, string>): void {
  try {
    const baseUrl = env.MODEL_BASE_URL || "";
    const modelName = env.MODEL_NAME || "gpt-4o";
    const bareModel = modelName.includes("/") ? modelName.split("/").pop()! : modelName;
    const apiFormat = normalizeEnvApiFormat(env.OPENCLAW_MODEL_API_FORMAT || env.MODEL_API_FORMAT);
    const configuredReasoning = normalizeEnvReasoningEffort(
      env.OPENCLAW_MODEL_REASONING_EFFORT ||
        env.MODEL_REASONING_EFFORT ||
        env.OPENCLAW_MODEL_THINKING ||
        env.MODEL_THINKING,
    );
    const reasoningEffort =
      configuredReasoning ?? (apiFormat === "openai-responses" ? "low" : undefined);
    const providerId = apiFormat === "anthropic" ? "anthropic" : "custom";
    const modelRef = `${providerId}/${bareModel}`;

    // Determine API key env var name — prefer OPENCLAW_MODEL_API_KEY for consistency
    const apiKeyRef = env.OPENCLAW_MODEL_API_KEY ? "${OPENCLAW_MODEL_API_KEY}" : "${MODEL_API_KEY}";

    const reasoningEnabled =
      apiFormat === "openai-responses" ||
      (reasoningEffort !== undefined && reasoningEffort !== "off");
    const providerApi =
      apiFormat === "anthropic"
        ? "anthropic-messages"
        : apiFormat === "openai-responses"
          ? "openai-responses"
          : "openai-completions";

    const providerEntry: Record<string, any> = {
      apiKey: apiKeyRef,
      api: providerApi,
      models: [
        {
          id: bareModel,
          name: bareModel,
          ...(reasoningEnabled ? { reasoning: true } : {}),
          ...(apiFormat !== "anthropic" ? { input: ["text", "image"] } : {}),
        },
      ],
    };
    if (baseUrl) {
      let apiUrl = baseUrl.replace(/\/+$/, "");
      if (!apiUrl.endsWith("/v1")) apiUrl += "/v1";
      providerEntry.baseUrl = apiUrl;
    }

    if (!config.models) config.models = { mode: "merge", providers: {} };
    if (!config.models.providers) config.models.providers = {};
    config.models.providers[providerId] = providerEntry;

    if (!config.agents) config.agents = { defaults: {} };
    if (!config.agents.defaults) config.agents.defaults = {};
    if (!config.agents.defaults.model) config.agents.defaults.model = {};
    config.agents.defaults.model.primary = modelRef;
    if (apiFormat === "openai-responses" || reasoningEffort !== undefined) {
      if (!config.agents.defaults.models) config.agents.defaults.models = {};
      const existingModelConfig =
        typeof config.agents.defaults.models[modelRef] === "object" &&
        config.agents.defaults.models[modelRef]
          ? config.agents.defaults.models[modelRef]
          : {};
      config.agents.defaults.models[modelRef] = {
        ...existingModelConfig,
        params: {
          ...(existingModelConfig.params ?? {}),
          thinking: reasoningEffort ?? "off",
        },
      };
    }

    // Write OPENCLAW_MODEL_API_KEY to .env if only MODEL_API_KEY exists
    if (env.MODEL_API_KEY && !env.OPENCLAW_MODEL_API_KEY) {
      const envPath = path.join(getOpenClawStateDir(), ".env");
      try {
        let content = fs.readFileSync(envPath, "utf-8");
        if (!content.includes("OPENCLAW_MODEL_API_KEY")) {
          content += `\nOPENCLAW_MODEL_API_KEY=${env.MODEL_API_KEY}\n`;
          fs.writeFileSync(envPath, content, "utf-8");
        }
      } catch {}
    }

    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
    console.log(`[config] Auto-configured model from .env: ${modelRef} (${providerApi})`);
  } catch (err: any) {
    console.error(`[config] Failed to auto-configure model from .env: ${err.message}`);
  }
}

/**
 * Enable plugins required by the selected model and keep enabled plugin entries
 * in plugins.allow so the gateway loads them synchronously at startup.
 */
function ensurePluginsAllow(): void {
  try {
    const config = readConfig();
    if (!config) return;
    let changed = ensureSelectedModelProviderPlugins(config);
    if (!config?.plugins?.entries) {
      if (changed) fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
      return;
    }
    const entries = config.plugins.entries as Record<string, { enabled?: boolean }>;
    const enabledIds = Object.keys(entries).filter((id) => entries[id].enabled);
    if (enabledIds.length === 0) {
      if (changed) fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
      return;
    }

    if (!Array.isArray(config.plugins.allow)) {
      config.plugins.allow = [];
      changed = true;
    }
    for (const id of enabledIds) {
      if (!config.plugins.allow.includes(id)) {
        config.plugins.allow.push(id);
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
      console.log(`[config] Updated plugins.allow: ${config.plugins.allow.join(", ")}`);
    }
  } catch (err) {
    console.error("[config] Failed to update plugins.allow:", err);
  }
}

/**
 * Ensure the default MicroClaw persona exists in the OpenClaw roster.
 * OpenClaw 2026.7.1-1 uses `agents.list`; unsupported `agents.entries` data
 * written by preview builds is migrated back before personas are added. Existing
 * entries are preserved by id and the config is only rewritten when something
 * changes. Both processes consume the shared agent catalog.
 */
function prepareAgentPersonas(
  stateDir: string,
): { config: AgentRosterConfig; changed: boolean } | null {
  const config = readConfig();
  if (!config) return null;
  const result = ensureAgentPersonasConfig(config, stateDir);
  return { config, changed: result.changed };
}

function persistAgentPersonas(config: AgentRosterConfig): void {
  writeConfigTextAtomically(JSON.stringify(config, null, 2));
  console.log(
    `[config] Registered agent personas: ${listConfiguredAgents(config)
      .map((agent) => agent.id)
      .join(", ")}`,
  );
}

function writeConfigTextAtomically(contents: string): void {
  const configPath = getConfigPath();
  const temporaryPath = `${configPath}.microclaw-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, contents, "utf-8");
  try {
    fs.renameSync(temporaryPath, configPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function failForExternalGateway(port: number): never {
  const message =
    `Agent configuration changed, but Gateway port ${port} is owned by another process. ` +
    "Stop that Gateway and retry so MicroClaw can apply the new roster safely.";
  gatewayStatus = "failed";
  mainWindow?.webContents.send("gateway:status", "failed");
  mainWindow?.webContents.send("gateway:log", `[error] ${message}`);
  throw new Error(message);
}

function seedSpecialistAgentWorkspaces(
  config: AgentRosterConfig,
  stateDir: string,
  entryPath: string,
  gatewayEnvironment: Record<string, string>,
): void {
  try {
    const seededFiles = seedAgentPersonaWorkspaces(
      config,
      stateDir,
      DECLARE_ACCESS_SECTION,
      gatewayEnvironment,
      os.homedir(),
      path.dirname(entryPath),
    );
    if (seededFiles.length > 0) {
      console.log(`[seed] Created specialist agent workspace files: ${seededFiles.join(", ")}`);
    }
  } catch (err) {
    console.warn("[seed] Failed to create specialist agent workspace files:", err);
  }
}

interface WorkspaceSnapshot {
  directory: string;
  directoryExisted: boolean;
  files: Array<{ path: string; contents: string | null }>;
}

function captureAgentWorkspace(
  config: AgentRosterConfig,
  stateDir: string,
  persona: AgentPersona,
  gatewayEnvironment: Record<string, string>,
  entryPath: string,
): WorkspaceSnapshot | null {
  if (!persona.workspaceFiles) return null;
  const directory = resolveAgentPersonaWorkspace(
    config,
    stateDir,
    persona,
    gatewayEnvironment,
    os.homedir(),
    path.dirname(entryPath),
  );
  return {
    directory,
    directoryExisted: fs.existsSync(directory),
    files: Object.keys(persona.workspaceFiles).map((filename) => {
      const filePath = path.join(directory, filename);
      return {
        path: filePath,
        contents: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null,
      };
    }),
  };
}

function restoreAgentWorkspace(snapshot: WorkspaceSnapshot | null): void {
  if (!snapshot) return;
  for (const file of snapshot.files) {
    if (file.contents === null) {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } else {
      fs.writeFileSync(file.path, file.contents, "utf-8");
    }
  }
  if (
    !snapshot.directoryExisted &&
    fs.existsSync(snapshot.directory) &&
    fs.readdirSync(snapshot.directory).length === 0
  ) {
    fs.rmdirSync(snapshot.directory);
  }
}

async function addCatalogAgent(
  agentId: string,
): Promise<{ agents: Array<{ id: string; name: string }> }> {
  const persona = getAgentPersona(agentId);
  if (!persona || DEFAULT_AGENT_PERSONAS.some((candidate) => candidate.id === agentId)) {
    throw new Error(`Unknown installable agent template "${agentId}"`);
  }

  const stateDir = getOpenClawStateDir();
  const configPath = getConfigPath();
  const originalConfigText = fs.readFileSync(configPath, "utf-8");
  const config = readConfig();
  if (!config) throw new Error("OpenClaw configuration is unavailable");

  const result = ensureAgentPersonasConfig(config, stateDir, [
    ...DEFAULT_AGENT_PERSONAS,
    persona,
  ]);
  if (!result.changed) {
    return { agents: listConfiguredAgents(config) };
  }

  const alreadyRunning = await checkExistingGateway(gatewayPort);
  const managedGateway = gatewaySpawnedByUs && gatewayProcess !== null;
  if (
    requiresExternalGatewayStop(
      alreadyRunning,
      true,
      gatewaySpawnedByUs,
      gatewayProcess !== null,
    )
  ) {
    throw new Error(
      "Cannot add an agent while MicroClaw is connected to an externally managed Gateway",
    );
  }

  const entryPath = resolveOpenClawEntry();
  const gatewayEnvironment = loadGatewayEnvironment(stateDir);
  const workspaceSnapshot = captureAgentWorkspace(
    config,
    stateDir,
    persona,
    gatewayEnvironment,
    entryPath,
  );
  let restartAttempted = false;

  try {
    persistAgentPersonas(config);
    seedAgentPersonaWorkspace(
      config,
      stateDir,
      persona,
      DECLARE_ACCESS_SECTION,
      gatewayEnvironment,
      os.homedir(),
      path.dirname(entryPath),
    );
    restartAttempted = true;
    await restartManagedGateway(`Adding agent ${agentId}`);
    return { agents: listConfiguredAgents(config) };
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    try {
      writeConfigTextAtomically(originalConfigText);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      restoreAgentWorkspace(workspaceSnapshot);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (restartAttempted && managedGateway) {
      try {
        await restartManagedGateway(`Rolling back failed agent addition ${agentId}`);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Failed to add agent "${agentId}" and fully restore the previous state`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Renderer URL (Vite dev server vs built files)
// ---------------------------------------------------------------------------
// In local development, prefer the Vite dev server. Packaged builds always use renderer/dist.
const isDev = !app.isPackaged;
const VITE_DEV_URL = "http://localhost:5173";
const APP_ICON_PATH = path.join(
  __dirname,
  process.platform === "win32" ? "../assets/microclaw.ico" : "../assets/microclaw.png",
);

function _getRendererURL(): string {
  if (isDev) return VITE_DEV_URL;
  return `file://${path.join(__dirname, "../renderer/dist/index.html")}`;
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------
function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: LOADING_WINDOW_WIDTH,
    height: LOADING_WINDOW_HEIGHT,
    resizable: false,
    center: true,
    title: "MicroClaw",
    icon: APP_ICON_PATH,
    show: !settingsStore.get("startMinimized"),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Enforce minimum window size — Electron's minWidth/minHeight is broken
  // for frame:false + transparent:true on Windows. Use will-resize event instead.
  win.on("will-resize", (event, newBounds) => {
    const currentBounds = win.getBounds();
    if (
      (newBounds.width < MIN_WINDOW_WIDTH && newBounds.width < currentBounds.width) ||
      (newBounds.height < MIN_WINDOW_HEIGHT && newBounds.height < currentBounds.height)
    ) {
      event.preventDefault();
    }
  });

  // Save bounds only after the window has expanded to full size.
  let saveBoundsRegistered = false;
  const registerSaveBounds = () => {
    if (saveBoundsRegistered) return;
    saveBoundsRegistered = true;
    let saveBoundsTimer: ReturnType<typeof setTimeout> | null = null;
    const saveBounds = () => {
      if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
      saveBoundsTimer = setTimeout(() => {
        if (!win.isMinimized() && !win.isMaximized()) {
          store.set("windowBounds", win.getBounds());
        }
      }, 300);
    };
    win.on("resize", saveBounds);
    win.on("move", saveBounds);
  };
  (win as any).__registerSaveBounds = registerSaveBounds;

  // Forward maximize/unmaximize state to renderer
  win.on("maximize", () => win.webContents.send("window:maximize-change", true));
  win.on("unmaximize", () => win.webContents.send("window:maximize-change", false));

  // Minimize to tray instead of closing
  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  Menu.setApplicationMenu(null);
  if (isDev) win.webContents.openDevTools({ mode: "detach" });
  const showWindowOnStartup = () => {
    if (!settingsStore.get("startMinimized")) {
      win.show();
      win.focus();
    }
  };
  win.once("ready-to-show", showWindowOnStartup);
  win.webContents.once("did-finish-load", showWindowOnStartup);

  // Open external links in the default browser instead of navigating the app
  win.webContents.on("will-navigate", (event, url) => {
    // Allow navigation to our own renderer pages (dev server or file://)
    if (url.startsWith("file://") || url.startsWith("http://localhost")) return;
    event.preventDefault();
    // Only open http(s) URLs in the system browser; block javascript:, data:, etc.
    if (url.startsWith("https://") || url.startsWith("http://")) {
      shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  return win;
}

// ---------------------------------------------------------------------------
// Gateway management
// ---------------------------------------------------------------------------

/** Check if an existing gateway is running on the given port */
function checkExistingGateway(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${port}/health`,
      { timeout: HEALTH_CHECK_HTTP_TIMEOUT_MS },
      (res) => resolve(res.statusCode === 200),
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function isGatewayPortOccupied(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (occupied: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

/** Resolve AppContainerLauncher.exe path, or null if unavailable. */
function resolveAppContainerLauncher(): string | null {
  if (process.platform !== "win32") return null;
  const candidates = [
    app.isPackaged ? path.join(process.resourcesPath, "AppContainerLauncher.exe") : "",
    path.resolve(
      __dirname,
      "..",
      "..",
      "appcontainer",
      "bin",
      "Release",
      "net9.0-windows",
      "win-x64",
      "AppContainerLauncher.exe",
    ),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/** Wait for gateway health check to pass */
async function waitForGatewayReady(
  port: number,
  timeoutMs = GATEWAY_READY_TIMEOUT_MS,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await checkExistingGateway(port);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Kill the managed gateway and any listener still holding gatewayPort. */
function stopGatewayProcess(): void {
  const knownPid = gatewayProcess?.pid;
  gatewayProcess = null;
  const pids = new Set<number>();
  if (knownPid) pids.add(knownPid);
  if (gatewayPort && process.platform === "win32") {
    try {
      const result = execFileSync("netstat", ["-ano"], {
        windowsHide: true,
        encoding: "utf-8",
        timeout: 5_000,
      });
      for (const line of result.split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/);
        if (
          columns.length >= 5 &&
          columns[0].toUpperCase() === "TCP" &&
          columns[1].endsWith(`:${gatewayPort}`) &&
          columns[3].toUpperCase() === "LISTENING"
        ) {
          const pid = Number.parseInt(columns[4], 10);
          if (Number.isInteger(pid) && pid > 0) pids.add(pid);
        }
      }
    } catch {
      // No listener or netstat unavailable; the known child PID is still used.
    }
  }
  for (const pid of pids) {
    console.log(`[gateway] killing process ${pid} on port ${gatewayPort}`);
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          timeout: 10_000,
          stdio: "ignore",
        });
      } catch {}
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }
}

async function restartManagedGateway(reason: string): Promise<void> {
  if (gatewayRestartPromise) return gatewayRestartPromise;
  const restart = (async () => {
    gatewayRestarting = true;
    gatewayStatus = "restarting";
    mainWindow?.webContents.send("gateway:status", "restarting");
    mainWindow?.webContents.send("gateway:log", `[restart] ${reason}`);
    try {
      await hardRestartGateway({
        stopClient: () => gwClient?.stop(),
        stopProcess: stopGatewayProcess,
        isPortOccupied: () => isGatewayPortOccupied(gatewayPort),
        startGateway,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        timeoutMs: 8_000,
        pollMs: 500,
      });
    } catch (error) {
      gatewayStatus = "failed";
      mainWindow?.webContents.send("gateway:status", "failed");
      throw error;
    } finally {
      gatewayRestarting = false;
    }
  })();
  gatewayRestartPromise = restart;
  try {
    await restart;
  } finally {
    if (gatewayRestartPromise === restart) gatewayRestartPromise = null;
  }
}

// ---------------------------------------------------------------------------
// Health monitor — auto-restart gateway if it goes down
// ---------------------------------------------------------------------------
function startHealthMonitor(): void {
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  let consecutiveFailures = 0;
  healthCheckInterval = setInterval(async () => {
    // Skip during startup / intentional restart
    if (gatewayStatus === "stopped" || gatewayStatus === "starting" || gatewayRestarting) return;
    if (!gatewayPort) return;
    // Skip while gateway is blocked on a sync permission dialog (Atomics.wait)
    if (pendingSyncPermissionRequests > 0) {
      consecutiveFailures = 0;
      return;
    }

    const alive = await checkExistingGateway(gatewayPort);
    if (alive) {
      consecutiveFailures = 0;
      return;
    }
    if (gatewayStatus !== "running") return;

    consecutiveFailures += 1;
    const msg = `[health-monitor] /health failed (${consecutiveFailures}/${HEALTH_CHECK_FAILURE_THRESHOLD})`;
    console.log(msg);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("gateway:log", msg);
    }
    if (consecutiveFailures < HEALTH_CHECK_FAILURE_THRESHOLD) return;
    consecutiveFailures = 0;

    try {
      await restartManagedGateway("Gateway health check failed; replacing process");
    } catch (error) {
      console.error("[health-monitor] Gateway restart failed:", error);
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

/** Check gateway health & reconnect if needed (called on window-show / focus) */
async function ensureGatewayConnected(): Promise<void> {
  if (gatewayRestarting || gatewayStatus === "starting") return;
  if (!gatewayPort) return;

  const alive = await checkExistingGateway(gatewayPort);
  if (alive) {
    // Gateway is up — if WS is not connected, reconnect
    if (!gwClient?.connected) {
      if (gatewayStatus !== "running") {
        gatewayStatus = "running";
        mainWindow?.webContents.send("gateway:status", "running");
      }
      connectGatewayWs();
    }
  } else {
    console.log("[ensure-gateway] Gateway not reachable — restarting...");
    await restartManagedGateway("Gateway was unreachable when the window became active");
  }
}

let gatewayStartInProgress = false;

// ---------------------------------------------------------------------------
// Remote channel notification — sends a simple message to WeChat when a
// permission dialog is shown on the desktop and the session is remote.
// ---------------------------------------------------------------------------

/**
 * Send a WeChat text message directly from the Electron main process via HTTP.
 * Used to notify remote users that a permission dialog is waiting on the desktop.
 */
function sendWeixinNotification(
  source: { baseUrl: string; token?: string; userId: string; contextToken?: string },
  text: string,
): void {
  try {
    const clientId = `mc-notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const msgPayload: Record<string, unknown> = {
      from_user_id: "",
      to_user_id: source.userId,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
    };
    if (source.contextToken) msgPayload.context_token = source.contextToken;
    const bodyStr = JSON.stringify({ msg: msgPayload });
    const uint32 = require("crypto").randomBytes(4).readUInt32BE(0);
    const wechatUin = Buffer.from(String(uint32), "utf-8").toString("base64");
    const urlStr =
      (source.baseUrl.endsWith("/") ? source.baseUrl : source.baseUrl + "/") +
      "ilink/bot/sendmessage";

    const parsed = new URL(urlStr);
    const mod = parsed.protocol === "https:" ? require("https") : require("http");
    const req = mod.request(
      urlStr,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          AuthorizationType: "ilink_bot_token",
          "Content-Length": Buffer.byteLength(bodyStr, "utf-8"),
          "X-WECHAT-UIN": wechatUin,
          ...(source.token ? { Authorization: `Bearer ${source.token}` } : {}),
        },
        timeout: 15000,
      },
      (res: any) => {
        let data = "";
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => {
          console.log(
            `[remote-notify] WeChat API response: status=${res.statusCode} body=${data.slice(0, 200)}`,
          );
        });
      },
    );
    req.on("error", (err: Error) => {
      console.error(`[remote-notify] HTTP error: ${err.message}`);
    });
    req.write(bodyStr);
    req.end();
  } catch (err: any) {
    console.error(`[remote-notify] Failed to send WeChat notification: ${err.message}`);
  }
}

/** Notify the remote WeChat user that a permission dialog is waiting on the desktop. */
function notifyRemotePermissionNeeded(): void {
  if (!lastInputFromRemote || !cachedRemoteSource) return;
  const lang = settingsStore.get("language") ?? "en-US";
  sendWeixinNotification(cachedRemoteSource, mainT(lang, "perm.remoteNotify"));
}

async function startGateway(): Promise<void> {
  // Prevent concurrent calls — only one startGateway at a time
  if (gatewayStartInProgress) {
    console.log("[gateway] startGateway() already in progress, skipping");
    return;
  }
  gatewayStartInProgress = true;
  try {
    await startGatewayInner();
  } finally {
    gatewayStartInProgress = false;
  }
}

async function startGatewayInner(): Promise<void> {
  // Read config to get token and configured port
  const config = readConfig();
  gatewayToken = config?.gateway?.auth?.token || "";
  const configuredPort = config?.gateway?.port || DEFAULT_PORT;
  gatewayPort = configuredPort;
  const stateDir = getOpenClawStateDir();
  const nodePath = resolveNodePath();
  const entryPath = resolveOpenClawEntry();
  const gatewayEnvironment = loadGatewayEnvironment(stateDir);

  // Ensure plugins.allow includes enabled plugins so they load synchronously
  // (avoids the race where auto-discovered plugins miss the channel-start sweep)
  ensurePluginsAllow();

  const preparedPersonas = prepareAgentPersonas(stateDir);
  const agentRosterChanged = preparedPersonas?.changed ?? false;

  // If gateway is already healthy, just connect WS and return — no new process.
  // Callers that need replacement use restartManagedGateway(), which stops the
  // old process and waits for the port before invoking this function.
  const alreadyRunning = await checkExistingGateway(configuredPort);
  if (
    requiresExternalGatewayStop(
      alreadyRunning,
      agentRosterChanged,
      gatewaySpawnedByUs,
      gatewayProcess !== null,
    )
  ) {
    failForExternalGateway(configuredPort);
  }
  if (preparedPersonas?.changed) {
    persistAgentPersonas(preparedPersonas.config);
  }
  if (preparedPersonas) {
    seedSpecialistAgentWorkspaces(
      preparedPersonas.config,
      stateDir,
      entryPath,
      gatewayEnvironment,
    );
  }
  if (alreadyRunning && !agentRosterChanged) {
    console.log(`[gateway] Already healthy on port ${configuredPort} — skipping spawn`);
    gatewaySpawnedByUs = false;
    gatewayStatus = "running";
    mainWindow?.webContents.send("gateway:status", "running");
    connectGatewayWs();
    startHealthMonitor();
    return;
  }
  if (alreadyRunning) {
    console.log("[gateway] Agent roster changed — restarting to load canonical configuration");
    gwClient?.stop();
  }

  // Kill any old gateway on this port
  stopGatewayProcess();
  await new Promise((r) => setTimeout(r, 1000));

  // Clean stale gateway lock files (survive force-kill / uninstall-reinstall)
  try {
    const lockDir = path.join(process.env.LOCALAPPDATA || "", "Temp", "openclaw");
    if (fs.existsSync(lockDir)) {
      for (const f of fs.readdirSync(lockDir)) {
        if (f.startsWith("gateway.") && f.endsWith(".lock")) {
          fs.unlinkSync(path.join(lockDir, f));
          console.log(`Removed stale lock: ${f}`);
        }
      }
    }
  } catch {}

  if (!fs.existsSync(nodePath)) {
    const msg = `[error] node.exe not found at ${nodePath}`;
    console.error(msg);
    mainWindow?.webContents.send("gateway:log", msg);
    mainWindow?.webContents.send(
      "gateway:log",
      "[hint] 请确认安装程序已完成，或手动检查 .openclaw-node 目录",
    );
    gatewayStatus = "failed";
    mainWindow?.webContents.send("gateway:status", "failed");
    return;
  }
  if (!fs.existsSync(entryPath)) {
    const msg = `[error] openclaw entry not found at ${entryPath}`;
    console.error(msg);
    mainWindow?.webContents.send("gateway:log", msg);
    mainWindow?.webContents.send(
      "gateway:log",
      "[hint] 请确认 openclaw 已正确安装到 .openclaw-node",
    );
    gatewayStatus = "failed";
    mainWindow?.webContents.send("gateway:status", "failed");
    return;
  }

  console.log(
    `Launching gateway: stateDir=${stateDir} token=${gatewayToken ? gatewayToken.slice(0, 8) + "..." : "(empty)"}`,
  );
  console.log(`Launching gateway: node=${nodePath} entry=${entryPath} port=${configuredPort}`);

  // Ensure compile cache directory exists for Node 22+ V8 bytecode caching
  const compileCacheDir = path.join(stateDir, COMPILE_CACHE_SUBDIR);
  if (!fs.existsSync(compileCacheDir)) {
    fs.mkdirSync(compileCacheDir, { recursive: true });
  }

  // Seed default workspace files (e.g. SOUL.md) before gateway creates its own.
  // This ensures first-launch users get our customised SOUL.md with important
  // behavioural rules (e.g. respecting user-specified file paths).
  seedWorkspaceFiles(stateDir);

  // Spawn gateway as a hidden background process — logs are forwarded
  // to the renderer via the gateway:log IPC channel (visible in Settings).

  const gwEnv: Record<string, string> = {
    ...gatewayEnvironment,
    OPENCLAW_STATE_DIR: stateDir,
    NODE_OPTIONS: "--disable-warning=ExperimentalWarning --dns-result-order=ipv4first",
    NODE_ENV: "production",
    NODE_COMPILE_CACHE: compileCacheDir,
    // The Desktop process already supplies a stable cache directory. Prevent
    // the OpenClaw launcher from self-respawning through the tool sandbox.
    OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: "1",
    OPENCLAW_NO_RESPAWN: "1",
    // HMAC key for verifying the external apps whitelist file
    OPENCLAW_SANDBOX_HMAC_KEY: sandboxHmacKey,
  };

  // Determine spawn command
  const launcherPath = resolveAppContainerLauncher();

  // Initialize tool sandbox for AI agent command sandboxing.
  // Gateway runs outside AppContainer, but tool commands are routed
  // through AppContainer via preload interception.
  toolSandbox = new ToolSandbox(launcherPath, nodePath);

  // Restore sandbox enabled state from settings
  const sandboxEnabled = settingsStore.get("sandboxEnabled");
  if (!sandboxEnabled) {
    toolSandbox.setEnabled(false);
  }

  // Grant sandbox access to the state directory and the resolved runtimes.
  if (fs.existsSync(stateDir)) toolSandbox.addDirRW(stateDir);
  const openClawPackageDir = resolveOpenClawPackageDir(entryPath);
  if (fs.existsSync(openClawPackageDir)) toolSandbox.addDirRO(openClawPackageDir);
  const nodeRuntimeDir = path.dirname(nodePath);
  if (fs.existsSync(nodeRuntimeDir)) toolSandbox.addDirRO(nodeRuntimeDir);

  // Preserve support for the legacy per-user runtime layout.
  const ocNodeDir = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, ".openclaw-node")
    : "";
  if (ocNodeDir && fs.existsSync(ocNodeDir)) toolSandbox.addDirRO(ocNodeDir);

  // Grant read access to custom skills dir (~/.agents/skills/) so the
  // gateway can scan it without triggering a sandbox permission prompt.
  const customSkillsDir = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, ".agents", "skills")
    : "";
  if (customSkillsDir && fs.existsSync(customSkillsDir)) toolSandbox.addDirRO(customSkillsDir);

  // Load user-configured external apps whitelist from settings.
  // These apps bypass AppContainer when launched (need COM/RPC/named-pipes).
  // Stored in Electron settings (not accessible from sandbox).
  const externalApps = settingsStore.get("sandboxExternalApps");
  toolSandbox.setExternalApps(externalApps);
  // Write to %APPDATA%/microclaw/ so sandbox-preload.js can read it.
  // This file is NOT in the AppContainer's writable dirs, so it's safe.
  writeExternalAppsFile(externalApps);

  // Load AppContainer capabilities from settings (e.g. internetClient, privateNetworkClientServer).
  const savedCaps = settingsStore.get("sandboxCapabilities");
  if (savedCaps && savedCaps.length > 0) {
    toolSandbox.setCapabilities(savedCaps);
  }

  // Load user-configured sandbox directory permissions from settings.
  const userDirsRW = settingsStore.get("sandboxUserDirsRW");
  const userDirsRO = settingsStore.get("sandboxUserDirsRO");
  for (const dir of userDirsRW) {
    if (fs.existsSync(dir)) toolSandbox.addDirRW(dir);
  }
  for (const dir of userDirsRO) {
    if (fs.existsSync(dir)) toolSandbox.addDirRO(dir);
  }

  if (toolSandbox.isActive()) {
    // Provision AppContainer profile and ACLs (async to avoid blocking UI)
    toolSandbox.provisionAsync().then(async (provisioned) => {
      if (provisioned) {
        console.log("[sandbox] AppContainer tool sandbox provisioned");
        mainWindow?.webContents.send("gateway:log", "[sandbox] 工具沙箱已启用 (AppContainer)");
        // Clean up any stale ACLs from previous failed revokes
        await cleanupStaleAcls();
        // Apply explicit DENY ACEs on credential / private files inside the
        // OpenClaw state dir. The state dir as a whole is granted rw to the
        // AppContainer (skills need it for logs/scratch/plugin state), but
        // .env / openclaw.json / device-identity.json / sessions/ must be
        // shielded from sandboxed skill subprocesses.
        hardenOpenClawStateDir();
      } else {
        console.warn("[sandbox] AppContainer provisioning failed — sandbox disabled");
        toolSandbox!.setEnabled(false);
      }
    });
  }

  // Merge sandbox env (COMSPEC, sandbox config)
  const sandboxEnv = toolSandbox.getGatewayEnv();
  Object.assign(gwEnv, sandboxEnv);

  // Append sandbox preload to NODE_OPTIONS if available
  const preloadPath = toolSandbox.getPreloadPath();
  if (preloadPath) {
    // NODE_OPTIONS --require treats backslashes as escapes; use forward slashes
    const preloadForward = preloadPath.replace(/\\/g, "/");
    gwEnv.NODE_OPTIONS = `${gwEnv.NODE_OPTIONS} --require ${preloadForward}`;
    console.log(`[sandbox] Preload: ${preloadForward}`);
  }

  const gwArgs = [
    entryPath,
    "gateway",
    "run",
    "--port",
    String(configuredPort),
    "--bind",
    "loopback",
    // Note: --force is intentionally omitted. It calls exec("netstat") which
    // routes through COMSPEC=AppContainerLauncher, causing netstat to run inside
    // AppContainer where it may return wrong results, leading to the gateway
    // killing itself in a restart loop. Stale lock cleanup is handled by
    // ContainerManager.CleanStaleLockFiles() instead.
    "--allow-unconfigured",
  ];

  const child = spawn(nodePath, gwArgs, {
    cwd: path.dirname(entryPath),
    env: gwEnv,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    ...(process.platform === "win32" ? { creationFlags: CREATE_NO_WINDOW } : {}),
  });

  gatewayProcess = child;
  gatewaySpawnedByUs = true;
  // Only allow post-spawn restart on the very first gateway launch.
  // Do NOT reset on subsequent restarts — it causes an infinite restart loop.
  // postSpawnRestartDone keeps its value across gateway restarts.

  const safeSendLog = (channel: string, payload: unknown) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
      }
    } catch {
      // window tearing down — ignore
    }
  };

  // Forward stdout/stderr to the renderer's gateway log viewer
  child.stdout?.on("data", (data: Buffer) => {
    const msg = data.toString("utf-8").trim();
    if (msg) {
      console.log(`[gateway] ${msg}`);
      safeSendLog("gateway:log", msg);
    }
  });
  child.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString("utf-8").trim();
    if (msg) {
      console.log(`[gateway:err] ${msg}`);
      safeSendLog("gateway:log", msg);
    }
  });

  child.on("error", (err) => {
    console.error("Gateway spawn error:", err);
    safeSendLog("gateway:log", `[error] Gateway spawn failed: ${err.message}`);
    safeSendLog("gateway:log", `[info] node=${nodePath} entry=${entryPath}`);
    gatewayProcess = null;
    gatewayStatus = "failed";
    safeSendLog("gateway:status", "failed");
  });

  child.on("exit", (code, signal) => {
    console.log(`[gateway] exited: code=${code} signal=${signal}`);
    safeSendLog("gateway:log", `Gateway exited: code=${code} signal=${signal}`);
    gatewayProcess = null;
  });

  // Log ALL IPC messages from gateway for debugging remote permission routing
  child.on("message", (msg: any) => {
    if (msg?.type) {
      console.log(`[gateway-ipc] type=${msg.type} keys=${Object.keys(msg).join(",")}`);
    }
  });

  // Forward actual shell command notifications to renderer for exec panel display
  child.on("message", (msg: any) => {
    if (msg?.type !== "sandbox-exec-command") return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("sandbox:exec-command", {
        shell: msg.shell,
        command: msg.command,
      });
    }
  });

  // Handle sandbox approval requests from sandbox-preload.js via Node IPC.
  // The preload blocks (Atomics.wait) until we write the response file.
  // We pause the health-monitor while blocked to prevent it killing the gateway.
  child.on("message", (msg: any) => {
    if (msg?.type !== "sandbox-approval-request") return;
    const { id, app, command, responseFile } = msg;
    const appLower = (app || "").toLowerCase();
    console.log(
      `[sandbox] Approval request: app=${appLower} id=${id} session=${activeChatSession}`,
    );

    // Check per-session deny list — auto-deny without prompting
    const sessionDenied = sessionDeniedApps.get(activeChatSession);
    if (sessionDenied?.has(appLower)) {
      console.log(`[sandbox] Auto-denied (session): ${appLower}`);
      try {
        fs.writeFileSync(responseFile, JSON.stringify({ id, decision: "deny" }), "utf-8");
      } catch {}
      return;
    }

    pendingSyncPermissionRequests++;
    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    pendingPermissionRequests.set(requestId, { type: "app-approval", msg });

    if (mainWindow && !mainWindow.isDestroyed()) {
      notifyRemotePermissionNeeded();
      mainWindow.webContents.send("sandbox:permission-request", {
        requestId,
        type: "app-approval",
        app: appLower,
        command,
      });
    } else {
      pendingPermissionRequests.delete(requestId);
      pendingSyncPermissionRequests--;
      try {
        fs.writeFileSync(responseFile, JSON.stringify({ id, decision: "deny" }), "utf-8");
      } catch {}
    }
  });

  // Handle file permission requests from sandbox-preload.js via Node IPC.
  // The preload blocks (Atomics.wait) until we write the response file.
  // We pause the health-monitor and use a renderer dialog.
  // ACL is granted BEFORE writing the response file so the retried write succeeds.
  child.on("message", (msg: any) => {
    if (msg?.type !== "sandbox-file-permission-request") return;
    const {
      id,
      filePath: reqPath,
      roDir,
      accessNeeded,
      command: blockedCommand,
      callerStack,
      responseFile,
    } = msg;
    console.log(
      `[sandbox] File permission request: path=${reqPath} roDir=${roDir} access=${accessNeeded} command=${blockedCommand || "(none)"} stack=${callerStack || "(none)"} id=${id}`,
    );

    pendingSyncPermissionRequests++;
    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    pendingPermissionRequests.set(requestId, { type: "file", msg });

    if (mainWindow && !mainWindow.isDestroyed()) {
      notifyRemotePermissionNeeded();
      mainWindow.webContents.send("sandbox:permission-request", {
        requestId,
        type: "file",
        targetPath: reqPath,
        dirPath: roDir,
        accessNeeded: accessNeeded || "rw",
        command: blockedCommand || null,
        callerStack: callerStack || null,
      });
    } else {
      pendingPermissionRequests.delete(requestId);
      pendingSyncPermissionRequests = Math.max(0, pendingSyncPermissionRequests - 1);
      try {
        fs.writeFileSync(responseFile, JSON.stringify({ id, decision: "deny" }), "utf-8");
      } catch {}
    }
  });

  // Handle shell command permission requests (access-denied retry).
  // Triggered when a shell command inside AppContainer fails with "Access is denied".
  child.on("message", (msg: any) => {
    if (msg?.type !== "sandbox-shell-permission-request") return;
    const { id, deniedPath, dirPath, command, accessNeeded, responseFile } = msg;
    console.log(
      `[sandbox] Shell permission request: path=${deniedPath} dir=${dirPath} access=${accessNeeded} id=${id}`,
    );

    // If directory is already granted, re-grant ACL silently (may have been lost
    // e.g. startup provision failed due to admin requirement) and auto-approve.
    const normalCheck = normalizeDirPath(dirPath).toLowerCase();
    const existingRW = settingsStore.get("sandboxUserDirsRW");
    const existingRO = settingsStore.get("sandboxUserDirsRO");
    const alreadyRW = existingRW.some(
      (d: string) => normalizeDirPath(d).toLowerCase() === normalCheck,
    );
    const alreadyRO = existingRO.some(
      (d: string) => normalizeDirPath(d).toLowerCase() === normalCheck,
    );
    if (alreadyRW || alreadyRO) {
      console.log(
        `[sandbox] Dir "${dirPath}" already granted — re-granting ACL and auto-approving`,
      );
      const access = alreadyRW ? "rw" : "r";
      const dirToGrant = normalizeDirPath(dirPath);
      grantAndVerifyAcl(dirToGrant, access as "rw" | "r")
        .then(() => {
          const decision = alreadyRW ? "grant-rw" : "grant-ro";
          try {
            fs.writeFileSync(responseFile, JSON.stringify({ id, decision }), "utf-8");
          } catch {}
        })
        .catch(() => {
          const decision = alreadyRW ? "grant-rw" : "grant-ro";
          try {
            fs.writeFileSync(responseFile, JSON.stringify({ id, decision }), "utf-8");
          } catch {}
        });
    } else {
      // Use renderer dialog — safe because spawnSync no longer calls this
      // (it sends sandbox-shell-permission-request-async instead).
      const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      pendingPermissionRequests.set(requestId, { type: "shell", msg });

      if (mainWindow && !mainWindow.isDestroyed()) {
        notifyRemotePermissionNeeded();
        mainWindow.webContents.send("sandbox:permission-request", {
          requestId,
          type: "shell",
          targetPath: deniedPath,
          dirPath,
          command,
          accessNeeded: accessNeeded || "rw",
        });
      } else {
        pendingPermissionRequests.delete(requestId);
        try {
          fs.writeFileSync(responseFile, JSON.stringify({ id, decision: "deny" }), "utf-8");
        } catch {}
      }
    }
  });

  // Handle async shell permission requests from spawn (non-blocking).
  // The command has already failed — we show a dialog, grant ACL if approved,
  // and the AI will naturally retry the command.
  child.on("message", (msg: any) => {
    if (msg?.type !== "sandbox-shell-permission-request-async") return;
    const { deniedPath, dirPath, command, accessNeeded } = msg;
    console.log(
      `[sandbox] Async shell permission request: path=${deniedPath} dir=${dirPath} access=${accessNeeded}`,
    );

    // If directory is already in settings but command still failed with Access
    // Denied, silently re-grant ACL (may have been lost, e.g. startup provision
    // failed due to admin requirement).  No dialog needed.
    const normalCheck = normalizeDirPath(dirPath).toLowerCase();
    const rwDirs = settingsStore.get("sandboxUserDirsRW");
    const roDirs = settingsStore.get("sandboxUserDirsRO");
    const alreadyRW = rwDirs.some((d: string) => normalizeDirPath(d).toLowerCase() === normalCheck);
    const alreadyRO = roDirs.some((d: string) => normalizeDirPath(d).toLowerCase() === normalCheck);
    if (alreadyRW || alreadyRO) {
      const access = alreadyRW ? "rw" : "r";
      const dirToGrant = normalizeDirPath(dirPath);
      console.log(
        `[sandbox] Async: dir "${dirPath}" already in settings — silently re-granting ACL (${access})`,
      );
      grantAndVerifyAcl(dirToGrant, access as "rw" | "r")
        .then(() => {
          // Write response file to unblock any sync poll in preload
          if (msg.responseFile) {
            const decision = alreadyRW ? "grant-rw" : "grant-ro";
            try {
              fs.writeFileSync(msg.responseFile, JSON.stringify({ decision }), "utf-8");
            } catch {}
          }
        })
        .catch(() => {
          if (msg.responseFile) {
            try {
              fs.writeFileSync(msg.responseFile, JSON.stringify({ decision: "deny" }), "utf-8");
            } catch {}
          }
        });
      return;
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      // No window — write deny response to unblock
      if (msg.responseFile) {
        try {
          fs.writeFileSync(msg.responseFile, JSON.stringify({ decision: "deny" }), "utf-8");
        } catch {}
      }
      return;
    }

    notifyRemotePermissionNeeded();
    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    pendingPermissionRequests.set(requestId, { type: "shell-async", msg });
    mainWindow.webContents.send("sandbox:permission-request", {
      requestId,
      type: "shell-async",
      targetPath: deniedPath,
      dirPath,
      command,
      accessNeeded: accessNeeded || "rw",
    });
  });

  // Handle ACL-ineffective reports: directory is in settings but AppContainer
  // still got Access Denied. Attempt silent re-grant and notify the user.
  child.on("message", (msg: any) => {
    if (msg?.type !== "sandbox-acl-ineffective") return;
    const { deniedPath, dirPath, command } = msg;
    console.warn(
      `[sandbox] ACL ineffective: path=${deniedPath} dir=${dirPath} cmd=${command?.substring(0, 80)}`,
    );

    // Find the dir in settings to determine access level
    const normalCheck = path.resolve(dirPath).toLowerCase();
    const rwDirs = settingsStore.get("sandboxUserDirsRW");
    const roDirs = settingsStore.get("sandboxUserDirsRO");
    const isRW = rwDirs.some(
      (d: string) =>
        normalizeDirPath(d).toLowerCase() === normalCheck ||
        normalCheck.startsWith(normalizeDirPath(d).toLowerCase()),
    );
    const isRO =
      !isRW &&
      roDirs.some(
        (d: string) =>
          normalizeDirPath(d).toLowerCase() === normalCheck ||
          normalCheck.startsWith(normalizeDirPath(d).toLowerCase()),
      );

    if (isRW || isRO) {
      const access = isRW ? "rw" : "r";
      const matchedDir = isRW
        ? rwDirs.find((d: string) => normalCheck.startsWith(normalizeDirPath(d).toLowerCase()))
        : roDirs.find((d: string) => normalCheck.startsWith(normalizeDirPath(d).toLowerCase()));
      if (matchedDir) {
        console.log(`[sandbox] Attempting silent ACL re-grant for: ${matchedDir} (${access})`);
        grantAndVerifyAcl(normalizeDirPath(matchedDir), access as "rw" | "r").then((ok) => {
          if (!ok) {
            console.error(`[sandbox] ACL re-grant failed for: ${matchedDir}`);
            mainWindow?.webContents.send("sandbox:acl-ineffective", {
              dir: matchedDir,
              deniedPath,
              access,
              command,
            });
          } else {
            console.log(`[sandbox] ACL re-grant succeeded for: ${matchedDir}`);
          }
        });
      }
    }
  });

  // Track session source info from the WeChat plugin (or other remote channels).
  // Used to send a notification when a permission dialog appears on the desktop.
  child.on("message", (msg: any) => {
    if (msg?.type !== "session-source") return;
    const { source } = msg;
    if (source?.channelType) {
      lastInputFromRemote = true;
      cachedRemoteSource = source;
      console.log(`[session] Remote source: channel=${source.channelType} user=${source.userId}`);
    }
  });

  // Wait for gateway to become ready
  gatewayStatus = "starting";
  mainWindow?.webContents.send("gateway:status", "starting");

  const ready = await waitForGatewayReady(configuredPort);
  if (ready) {
    gatewayStatus = "running";
    mainWindow?.webContents.send("gateway:status", "running");
  } else {
    mainWindow?.webContents.send(
      "gateway:log",
      `[warn] Gateway health check timed out on port ${configuredPort}`,
    );
    mainWindow?.webContents.send(
      "gateway:log",
      `[info] node=${nodePath} entry=${entryPath} stateDir=${stateDir}`,
    );
    gatewayStatus = "timeout";
    mainWindow?.webContents.send("gateway:status", "timeout");
  }
  // Always connect WS — even on timeout the gateway may start shortly after,
  // and GatewayClient has built-in reconnect with exponential backoff.
  connectGatewayWs();

  // Start health monitoring to auto-restart if the gateway goes down
  startHealthMonitor();
}

// (end of startGatewayInner)

// ---------------------------------------------------------------------------
// WebSocket gateway client — mirrors the webchat protocol
// ---------------------------------------------------------------------------

function _extractText(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  if (typeof m.content === "string") return m.content;
  if (typeof m.text === "string") return m.text;
  if (Array.isArray(m.content)) {
    return (m.content as Array<Record<string, unknown>>)
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
  }
  return null;
}

let wsAuthRestartInProgress = false;

function connectGatewayWs(): void {
  gwClient?.stop();
  gatewayModelCatalogRequest = null;
  gatewayGitHubCopilotStatusRequest = null;

  gwClient = new GatewayClient({
    port: gatewayPort,
    token: gatewayToken,
    onConnected: () => {
      console.log("[gateway-ws] connected");
      wsAuthRestartInProgress = false;
      // Sync the status indicator — fixes "timeout" showing while WS is actually connected
      if (gatewayStatus !== "running") {
        gatewayStatus = "running";
        mainWindow?.webContents.send("gateway:status", "running");
      }
      const mainSessionKey = gwClient?.mainSessionKey;

      // After a fresh spawn, auto-discovered plugins (like weixin) may miss
      // the initial channel-start sweep. Replace the process once so every
      // channel initializes from the final plugin configuration.
      // IMPORTANT: Do NOT notify the renderer of ws-connected yet — if we
      // announce connectivity now, the user can send a message that will be
      // killed when the restart fires seconds later (causing a 30s timeout).
      // The renderer will be notified on the SECOND onConnected (after restart).
      if (gatewaySpawnedByUs && !postSpawnRestartDone) {
        postSpawnRestartDone = true;
        console.log("[gateway-ws] post-spawn: deferring ws-connected until after restart");
        mainWindow?.webContents.send("gateway:log", "[startup] 正在重启网关以激活插件通道…");
        setTimeout(async () => {
          console.log("[gateway-ws] post-spawn: restarting gateway to activate plugin channels");
          try {
            await restartManagedGateway("Activating installed plugin channels");
          } catch (err: any) {
            console.error("[gateway-ws] post-spawn restart failed:", err.message);
            // Restart failed — notify renderer anyway so it's not stuck
            mainWindow?.webContents.send("gateway:ws-connected", mainSessionKey || null);
          }
        }, POST_SPAWN_RESTART_DELAY_MS);
        return; // skip ws-connected notification — will fire on reconnect
      }

      mainWindow?.webContents.send("gateway:ws-connected", mainSessionKey || null);
    },
    onDisconnected: (reason) => {
      console.log(`[gateway-ws] disconnected: ${reason}`);
      mainWindow?.webContents.send("gateway:ws-disconnected", reason);
    },
    onAuthError: (message) => {
      // A stale gateway (from a previous install / scheduled task) is running
      // with a different token. Kill it and restart with our token.
      console.log(`[gateway-ws] auth error: ${message} — killing stale gateway`);
      mainWindow?.webContents.send("gateway:log", `[warn] 网关认证失败 (token 不匹配)，正在重启…`);
      if (!wsAuthRestartInProgress) {
        wsAuthRestartInProgress = true;
        setTimeout(async () => {
          try {
            await restartManagedGateway("Replacing Gateway after authentication failure");
          } catch (err: any) {
            console.error("[gateway-ws] restart after auth error failed:", err);
            mainWindow?.webContents.send(
              "gateway:log",
              `[error] 网关重启失败: ${err?.message || err}`,
            );
          } finally {
            wsAuthRestartInProgress = false;
          }
        }, 1500);
      }
    },
    onEvent: (evt) => {
      if (evt.event === "agent") {
        const p = evt.payload as Record<string, unknown> | undefined;
        if (p && p.stream === "tool") {
          const d = p.data as Record<string, unknown> | undefined;
          console.log(`[agent:tool] phase=${d?.phase} name=${d?.name} id=${d?.toolCallId}`);
          mainWindow?.webContents.send("agent:tool-event", p);
        }
      }
      if (evt.event === "chat") {
        const payload = evt.payload as ChatEventPayload | undefined;
        if (!payload) return;
        console.log(`[chat:event] state=${payload.state} sessionKey=${payload.sessionKey}`);

        // Track active session for per-session sandbox deny list
        if (payload.sessionKey && payload.sessionKey !== activeChatSession) {
          activeChatSession = payload.sessionKey;
          // Notify gateway process so sandbox-preload can reset per-session caches
          if (gatewayProcess && !gatewayProcess.killed) {
            try {
              gatewayProcess.send({
                type: "sandbox-session-changed",
                sessionKey: activeChatSession,
              });
            } catch {}
          }
        }
        mainWindow?.webContents.send("chat:event", payload);
      }
    },
  });
  gwClient.start();
}

function requestGatewayModelCatalog(): Promise<unknown> {
  if (gatewayModelCatalogRequest) return gatewayModelCatalogRequest;
  const client = gwClient;
  if (!client?.connected) return Promise.reject(new Error("Gateway is not connected"));

  const request = client.request("models.list", { view: "all" });
  gatewayModelCatalogRequest = request;
  void request.then(
    () => {
      if (gatewayModelCatalogRequest === request) gatewayModelCatalogRequest = null;
    },
    () => {
      if (gatewayModelCatalogRequest === request) gatewayModelCatalogRequest = null;
    },
  );
  return request;
}

function requestGitHubCopilotGatewayStatus(): Promise<{ authenticated: boolean }> {
  if (gatewayGitHubCopilotStatusRequest) return gatewayGitHubCopilotStatusRequest;
  const client = gwClient;
  if (!client?.connected) return Promise.reject(new Error("Gateway is not connected"));

  const request = client
    .request("models.authStatus", {})
    .then((status) => ({ authenticated: parseGitHubCopilotGatewayAuthStatus(status) }));
  gatewayGitHubCopilotStatusRequest = request;
  void request.then(
    () => {
      if (gatewayGitHubCopilotStatusRequest === request) {
        gatewayGitHubCopilotStatusRequest = null;
      }
    },
    () => {
      if (gatewayGitHubCopilotStatusRequest === request) {
        gatewayGitHubCopilotStatusRequest = null;
      }
    },
  );
  return request;
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

/** Notify gateway process about updated sandbox directory lists. */
function notifySandboxDirsChanged(): void {
  if (!gatewayProcess || gatewayProcess.killed) return;
  const status = toolSandbox?.getStatus();
  if (!status) return;
  try {
    gatewayProcess.send({
      type: "sandbox-dirs-updated",
      rw: status.sandboxDirsRW,
      ro: status.sandboxDirsRO,
    });
  } catch {}
}

/** Record a directory in grant history (idempotent). */
function addToGrantHistory(dir: string): void {
  const history = settingsStore.get("sandboxGrantHistory");
  const norm = dir.toLowerCase();
  if (!history.some((d) => d.toLowerCase() === norm)) {
    history.push(dir);
    settingsStore.set("sandboxGrantHistory", history);
  }
}

/** Remove a directory from grant history after successful revoke. */
function removeFromGrantHistory(dir: string): void {
  const norm = dir.toLowerCase();
  const history = settingsStore
    .get("sandboxGrantHistory")
    .filter((d: string) => d.toLowerCase() !== norm);
  settingsStore.set("sandboxGrantHistory", history);
}

/**
 * Clean up stale ACLs on startup: revoke any directories that are in
 * grant history but no longer in the current settings (RW or RO).
 * Handles: failed revokes from previous sessions, removed-then-not-cleaned dirs.
 * Does NOT touch dirs that were re-added (they're in settings → safe).
 */
async function cleanupStaleAcls(): Promise<void> {
  if (!toolSandbox) return;
  const history = settingsStore.get("sandboxGrantHistory");
  const rwSet = new Set(
    settingsStore.get("sandboxUserDirsRW").map((d: string) => normalizeDirPath(d).toLowerCase()),
  );
  const roSet = new Set(
    settingsStore.get("sandboxUserDirsRO").map((d: string) => normalizeDirPath(d).toLowerCase()),
  );

  for (const dir of history) {
    const norm = normalizeDirPath(dir).toLowerCase();
    if (!rwSet.has(norm) && !roSet.has(norm)) {
      console.log(`[sandbox] Cleaning up stale ACL: ${dir}`);
      const ok = await revokeWithUnshield(dir);
      if (ok) {
        removeFromGrantHistory(dir);
        console.log(`[sandbox] Stale ACL cleaned: ${dir}`);
      } else {
        console.warn(`[sandbox] Failed to clean stale ACL: ${dir} (will retry next startup)`);
      }
    }
  }
}

// --- Skill dependency (PATH) indexing ---
// Skills declare required CLIs in their SKILL.md metadata (requires.bins). To tell
// whether a skill is actually usable we must check if those binaries are on PATH.
// Doing a per-binary lookup (or spawning `where`/`which`) is extremely slow (~11s for
// ~40 bins). Instead we list each PATH directory ONCE and build an in-memory Set of
// executable basenames; membership checks are then O(1). The index is cached for the
// session and only rebuilt on an explicit refresh (e.g. after the user installs a CLI).
let pathExecutableIndexCache: Set<string> | null = null;

function buildPathExecutableIndex(): Set<string> {
  const exts = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((e) => e.toLowerCase())
    .filter(Boolean);
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const index = new Set<string>();
  for (const dir of dirs) {
    let items: string[];
    try {
      items = fs.readdirSync(dir);
    } catch {
      continue; // missing/inaccessible PATH entry — skip
    }
    for (const item of items) {
      const lower = item.toLowerCase();
      index.add(lower); // bare name (covers scripts without an extension)
      const ext = path.extname(lower);
      if (ext && exts.includes(ext)) {
        index.add(lower.slice(0, lower.length - ext.length));
      }
    }
  }
  return index;
}

function getPathExecutableIndex(forceRebuild = false): Set<string> {
  if (forceRebuild || !pathExecutableIndexCache) {
    pathExecutableIndexCache = buildPathExecutableIndex();
  }
  return pathExecutableIndexCache;
}

// A skill's usability requirements, mirroring openclaw's `metadata.openclaw.requires`
// plus the top-level `os` gate. The runtime (`evaluateRuntimeRequires`) rejects a skill
// unless ALL of these are satisfied, so the UI must evaluate every field — not just
// `bins` — or it will show skills as available that the gateway silently drops.
interface SkillRequirements {
  bins: string[]; // every one of these CLIs must be on PATH
  anyBins: string[]; // at least ONE of these CLIs must be on PATH
  env: string[]; // every one of these env vars must be set
  config: string[]; // every one of these dotted config paths must be truthy
  os: string[]; // if non-empty, current platform must be included
  primaryEnv?: string; // env var that a skill's `apiKey` config satisfies
}

// Extract the balanced `{ ... }` object following `metadata:` in a SKILL.md frontmatter.
// The block is multi-line and, importantly, uses RELAXED JSON with trailing commas,
// which `JSON.parse` rejects — callers must tolerate that (see parseSkillRequirements).
function extractMetadataBlock(frontmatter: string): string | null {
  const key = frontmatter.indexOf("metadata:");
  if (key < 0) return null;
  const start = frontmatter.indexOf("{", key);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < frontmatter.length; i++) {
    const c = frontmatter[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return frontmatter.slice(start, i + 1);
    }
  }
  return null;
}

// Parse a skill's requirements out of its SKILL.md frontmatter. Handles the multi-line,
// trailing-comma "relaxed JSON" that openclaw skills ship with. Falls back to a
// bins-only regex if the block can't be parsed, so we never regress the old behavior.
function parseSkillRequirements(frontmatter: string): SkillRequirements {
  const empty: SkillRequirements = { bins: [], anyBins: [], env: [], config: [], os: [] };
  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const block = extractMetadataBlock(frontmatter);
  if (block) {
    // Strip trailing commas (`,` before `}` or `]`) so JSON.parse accepts the block.
    const relaxed = block.replace(/,(\s*[}\]])/g, "$1");
    try {
      const meta = JSON.parse(relaxed);
      const oc = meta?.openclaw ?? meta?.clawdbot ?? {};
      const req = oc?.requires ?? {};
      return {
        bins: asStringArray(req.bins),
        anyBins: asStringArray(req.anyBins),
        env: asStringArray(req.env),
        config: asStringArray(req.config),
        os: asStringArray(oc.os),
        primaryEnv: typeof oc.primaryEnv === "string" ? oc.primaryEnv : undefined,
      };
    } catch {
      // fall through to regex fallback
    }
  }

  // Fallback: pull just the `bins` array (legacy behavior) when the block is missing
  // or unparseable.
  const match = frontmatter.match(/"requires"\s*:\s*\{[^}]*?"bins"\s*:\s*\[([^\]]*)\]/);
  if (!match) return empty;
  return {
    ...empty,
    bins: match[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean),
  };
}

// Resolve a dotted config path (e.g. "channels.discord.token") to its value, mirroring
// openclaw's `resolveConfigPath`.
function resolveConfigPath(config: any, dotted: string): unknown {
  const parts = dotted.split(".").filter(Boolean);
  let current: any = config;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = current[part];
  }
  return current;
}

// Truthiness check matching openclaw's `isTruthy`: empty/whitespace strings and 0 are
// falsy; any non-empty object/array is truthy.
function isConfigValueTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

// Skills that ship in the OpenClaw package but are intentionally not surfaced in
// MicroClaw because they cannot work on Windows (macOS-only tooling) or are otherwise
// unusable here. These directories may still exist on disk, so we filter them out of
// the Skills list by name. Keep in sync with deployer/skill_catalog.py removals.
const EXCLUDED_SKILL_IDS = new Set<string>([
  "apple-notes", // macOS Apple Notes
  "apple-reminders", // macOS Apple Reminders
  "imsg", // macOS Messages / iMessage
  "peekaboo", // macOS-only UI automation
  "model-usage", // restricted upstream to macOS / CodexBar
  "tmux", // upstream supports macOS and Linux only
  "desktop-beautify", // catalog-only, no skill dir; requires Notezilla
]);

function registerIpcHandlers(): void {
  // --- Gateway ---
  ipcMain.handle("gateway:get-port", () => gatewayPort);
  // gateway:get-token intentionally removed — the renderer does not need
  // direct access to the gateway auth token.  All gateway communication
  // flows through main-process IPC handlers (chat:send-message, etc.).
  ipcMain.handle("gateway:get-status", () => gatewayStatus);
  ipcMain.handle("gateway:restart", async (_event, _options?: { hard?: boolean }) => {
    try {
      await restartManagedGateway("Restart requested by user");
      mainWindow?.webContents.send("gateway:log", "[restart] 网关重启完成");
    } catch (err: any) {
      const msg = `[error] Gateway restart failed: ${err?.message || err}`;
      console.error(msg);
      mainWindow?.webContents.send("gateway:log", msg);
      throw err;
    }
  });

  // --- Config ---
  ipcMain.handle("config:get-state-dir", () => getOpenClawStateDir());
  ipcMain.handle("config:is-configured", () => isConfigured());
  ipcMain.handle("config:needs-setup", () => needsSetup());
  ipcMain.handle("config:read", () => readConfig());
  ipcMain.handle("config:read-env", () => loadStateDirEnv());
  ipcMain.handle("config:write", async (_event, config: any) => {
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      throw new Error("config:write — invalid config: must be a plain object");
    }
    // Known top-level keys supported by OpenClaw's openclaw.json.
    // Keep this as a permissive allow-list: any key OpenClaw may legitimately
    // read/write should be passed through unchanged so Save doesn't drop or
    // reject pre-existing config sections.
    const ALLOWED_TOP_LEVEL_KEYS = new Set([
      "$schema",
      "meta",
      "models",
      "agents",
      "tools",
      "gateway",
      "skills",
      "plugins",
      "browser",
      "commands",
      "permissions",
      "hooks",
      "mcp",
      "channels",
      "telemetry",
      "memory",
      "logging",
      "sandbox",
    ]);
    const unknownKeys = Object.keys(config).filter((k) => !ALLOWED_TOP_LEVEL_KEYS.has(k));
    if (unknownKeys.length > 0) {
      throw new Error(`config:write — disallowed top-level keys: ${unknownKeys.join(", ")}`);
    }
    const stateDir = getOpenClawStateDir();
    await fs.promises.mkdir(stateDir, { recursive: true });
    await fs.promises.writeFile(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
  });

  // --- Skills ---
  const buildSkillsPayload = (forceRebuildPathIndex: boolean) => {
    const homeDir = app.getPath("home");
    const builtinDir = resolveBuiltinSkillsDir();
    const customDir = path.join(homeDir, ".agents", "skills");
    const managedDir = path.join(homeDir, ".openclaw", "skills");

    // Build (or reuse) the PATH executable index used to resolve skill dependencies.
    const pathIndex = getPathExecutableIndex(forceRebuildPathIndex);

    // Load certification catalog (builtin)
    let catalog: Record<string, { description: string; platform: string[] }> = {};
    try {
      const catalogPath = path.join(getOpenClawStateDir(), "skill_catalog.json");
      if (fs.existsSync(catalogPath)) {
        catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
      }
    } catch {
      /* catalog unavailable — all skills show as non-windows */
    }

    // Load managed skill catalog
    let managedCatalog: Record<string, { description: string; platform: string[] }> = {};
    try {
      const managedCatalogPath = path.join(getOpenClawStateDir(), "managed_skill_catalog.json");
      if (fs.existsSync(managedCatalogPath)) {
        managedCatalog = JSON.parse(fs.readFileSync(managedCatalogPath, "utf-8"));
      }
    } catch {}

    // Load allowBundled and entries from config
    const config = readConfig();
    const allowBundled: string[] | undefined = config?.skills?.allowBundled;
    const entries: Record<string, { enabled: boolean }> = config?.skills?.entries ?? {};

    function scanSkills(dir: string, source: "builtin" | "custom" | "managed"): any[] {
      const results: any[] = [];
      if (!fs.existsSync(dir)) return results;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (EXCLUDED_SKILL_IDS.has(entry.name)) continue;
        const skillMd = path.join(dir, entry.name, "SKILL.md");
        let name = entry.name;
        let description = "";
        let requirements: SkillRequirements = {
          bins: [],
          anyBins: [],
          env: [],
          config: [],
          os: [],
        };
        if (fs.existsSync(skillMd)) {
          const content = fs.readFileSync(skillMd, "utf-8");
          // Extract the YAML frontmatter block (between the first two `---` fences) so
          // the full multi-line `metadata` object is available to the parser. Fall back
          // to the whole file if the closing fence isn't found.
          let frontmatter = content;
          const fenceStart = content.indexOf("---");
          if (fenceStart >= 0) {
            const fenceEnd = content.indexOf("\n---", fenceStart + 3);
            if (fenceEnd >= 0) frontmatter = content.slice(fenceStart, fenceEnd);
          }
          const nameMatch = frontmatter.match(/^name:\s*(.+)/m);
          const descMatch = frontmatter.match(/^description:\s*(.+)/m);
          if (nameMatch) name = nameMatch[1].trim();
          if (descMatch) description = descMatch[1].replace(/^["']|["']$/g, "").trim();
          requirements = parseSkillRequirements(frontmatter);
        }

        // Evaluate every requirement type the runtime checks (see openclaw's
        // `evaluateRuntimeRequires`). A skill is only usable when ALL are satisfied;
        // checking `bins` alone (the old behavior) marked skills gated by env vars,
        // channel config, or alternative CLIs as available even though the gateway
        // silently drops them. See #83.
        const skillCfg: any = (entries as Record<string, any>)[entry.name] ?? {};
        const hasBin = (b: string): boolean => pathIndex.has(b.toLowerCase());
        const hasEnv = (envName: string): boolean =>
          Boolean(
            process.env[envName] ||
            skillCfg?.env?.[envName] ||
            (skillCfg?.apiKey && requirements.primaryEnv === envName),
          );

        const missingBins = requirements.bins.filter((b) => !hasBin(b));
        // `anyBins` is unmet only when NONE of the alternatives are present.
        const missingAnyBins =
          requirements.anyBins.length > 0 && !requirements.anyBins.some((b) => hasBin(b))
            ? requirements.anyBins
            : [];
        const missingEnv = requirements.env.filter((e) => !hasEnv(e));
        const missingConfig = requirements.config.filter(
          (c) => !isConfigValueTruthy(resolveConfigPath(config, c)),
        );
        const osMismatch =
          requirements.os.length > 0 && !requirements.os.includes(process.platform);

        const eligible =
          missingBins.length === 0 &&
          missingAnyBins.length === 0 &&
          missingEnv.length === 0 &&
          missingConfig.length === 0 &&
          !osMismatch;

        let enabled = true;

        if (source === "managed") {
          const windowsAdapted = managedCatalog[entry.name]?.platform?.includes("windows") ?? false;
          enabled = entries[entry.name]?.enabled ?? windowsAdapted;
          if (!description && managedCatalog[entry.name]?.description) {
            description = managedCatalog[entry.name].description;
          }
        } else if (source === "custom") {
          // Custom (user-authored) skills default to enabled; persisted per-skill via
          // skills.entries so the user can toggle them on/off from the UI.
          enabled = entries[entry.name]?.enabled ?? true;
        } else {
          if (source === "builtin" && allowBundled && allowBundled.length > 0) {
            enabled = allowBundled.includes(entry.name);
          }
        }

        results.push({
          id: entry.name,
          name,
          description,
          source,
          platform: catalog[entry.name]?.platform ?? managedCatalog[entry.name]?.platform ?? [],
          enabled,
          installed: true,
          requiredBins: requirements.bins,
          missingBins,
          missingAnyBins,
          missingEnv,
          missingConfig,
          osRequired: requirements.os,
          osMismatch,
          eligible,
        });
      }
      return results;
    }

    const builtin = scanSkills(builtinDir, "builtin");
    const custom = scanSkills(customDir, "custom");
    const managedOnDisk = scanSkills(managedDir, "managed");

    // Only expose managed skills that are actually installed on disk. Catalog-only
    // entries (defined in managed_skill_catalog.json but not present on disk) are
    // intentionally omitted because there is no in-app install action for them. See #58.

    // Skills the user authors (e.g. via skill-creator) land in the managed skills
    // directory but are NOT part of the shipped managed catalog. Reclassify those as
    // custom so they appear under "Custom Skills" instead of the built-in workspace
    // skills. Catalog workspace skills (officecli, excel-xlsx, …) stay managed.
    const managedWorkspace = managedOnDisk.filter((s) => managedCatalog[s.id] !== undefined);
    const userAuthored = managedOnDisk
      .filter((s) => managedCatalog[s.id] === undefined)
      // Reclassified from managed → custom: recompute `enabled` with custom
      // semantics (default on) rather than the managed default (off when not
      // windows-adapted in the catalog).
      .map((s) => ({ ...s, source: "custom" as const, enabled: entries[s.id]?.enabled ?? true }));

    return { builtin, custom: [...custom, ...userAuthored], managed: managedWorkspace };
  };

  ipcMain.handle("skills:list", () => buildSkillsPayload(false));

  // Rebuild the PATH executable index (picks up CLIs the user installed/removed while
  // the app was running) and recompute skill eligibility. Cheap — only re-indexes PATH.
  ipcMain.handle("skills:refresh", () => buildSkillsPayload(true));

  ipcMain.handle("skills:update-allowlist", (_event, allowBundled: string[]) => {
    const config = readConfig() || {};
    if (!config.skills) config.skills = {};
    config.skills.allowBundled = allowBundled;
    const stateDir = getOpenClawStateDir();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
  });

  ipcMain.handle(
    "skills:update-managed-entries",
    (_event, updatedEntries: Record<string, { enabled: boolean }>) => {
      const config = readConfig() || {};
      if (!config.skills) config.skills = {};
      if (!config.skills.entries) config.skills.entries = {};
      Object.assign(config.skills.entries, updatedEntries);
      const stateDir = getOpenClawStateDir();
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
    },
  );

  ipcMain.handle("skills:integrity-check", (): IntegrityResult => {
    return verifySkillIntegrity();
  });

  ipcMain.handle("skills:generate-snapshot", () => {
    generateAndSignSnapshot();
  });

  ipcMain.handle("skills:pending-integrity-result", (): IntegrityResult | null => {
    return pendingIntegrityResult;
  });

  ipcMain.handle("skills:accept-integrity-changes", () => {
    generateAndSignSnapshot();
    pendingIntegrityResult = null;
  });

  ipcMain.handle(
    "skills:set-agent-skills",
    async (
      _event,
      agentId: string,
      skillIds: string[],
    ): Promise<{ agentId: string; skills: string[] }> => {
      if (typeof agentId !== "string" || agentId.length === 0) {
        throw new Error("A non-empty agentId is required");
      }
      const skills = sanitizeAgentSkillIds(skillIds ?? []);

      const configPath = getConfigPath();
      const originalConfigText = fs.readFileSync(configPath, "utf-8");
      const config = readConfig();
      if (!config) throw new Error("OpenClaw configuration is unavailable");

      const agents = config.agents;
      if (!agents || !Array.isArray(agents.list)) {
        throw new Error("No configured agents to update");
      }
      const entry = agents.list.find(
        (candidate: unknown): candidate is Record<string, unknown> =>
          typeof candidate === "object" &&
          candidate !== null &&
          (candidate as { id?: unknown }).id === agentId,
      );
      if (!entry) {
        throw new Error(`Unknown agent "${agentId}"`);
      }
      entry.skills = skills;

      const alreadyRunning = await checkExistingGateway(gatewayPort);
      const managedGateway = gatewaySpawnedByUs && gatewayProcess !== null;
      if (
        requiresExternalGatewayStop(
          alreadyRunning,
          true,
          gatewaySpawnedByUs,
          gatewayProcess !== null,
        )
      ) {
        throw new Error(
          "Cannot update agent skills while MicroClaw is connected to an externally managed Gateway",
        );
      }

      let restartAttempted = false;
      try {
        writeConfigTextAtomically(JSON.stringify(config, null, 2));
        restartAttempted = true;
        await restartManagedGateway(`Updating skills for agent ${agentId}`);
        return { agentId, skills };
      } catch (error) {
        try {
          writeConfigTextAtomically(originalConfigText);
          if (restartAttempted && managedGateway) {
            await restartManagedGateway(
              `Rolling back failed skills update for ${agentId}`,
            );
          }
        } catch {
          // Preserve the original failure; rollback is best-effort.
        }
        throw error;
      }
    },
  );

  // --- Chat (WebSocket gateway protocol) ---
  ipcMain.handle(
    "chat:send-message",
    async (_event, params: { sessionKey: string; message: string }) => {
      if (!gwClient?.connected) throw new Error("Gateway not connected");
      // Mark that the latest input is from the local desktop UI.
      lastInputFromRemote = false;
      await gwClient.sendChat(params.sessionKey, params.message);
    },
  );

  ipcMain.handle("chat:load-history", async (_event, params: { sessionKey: string }) => {
    if (!gwClient?.connected) throw new Error("Gateway not connected");
    return await gwClient.loadHistory(params.sessionKey);
  });

  ipcMain.handle("chat:abort", async (_event, params: { sessionKey: string }) => {
    if (!gwClient?.connected) throw new Error("Gateway not connected");
    await gwClient.abortChat(params.sessionKey);
  });

  ipcMain.handle("chat:delete-session", async (_event, params: { sessionKey: string }) => {
    if (!gwClient?.connected) throw new Error("Gateway not connected");
    await gwClient.deleteSession(params.sessionKey);
  });

  ipcMain.handle("chat:clear-history", async () => {
    if (!gwClient?.connected) throw new Error("Gateway not connected");
    return await gwClient.clearAllHistory();
  });

  // Report as "not connected" while the post-spawn restart is pending.
  // Without this, the renderer's isConnected() poll on mount bypasses the
  // ws-connected gate and lets the user send messages before the gateway's
  // post-spawn process replacement completes (sandbox runtime not yet initialized).
  ipcMain.handle("chat:is-connected", () => (gwClient?.connected ?? false) && postSpawnRestartDone);

  // --- Cron / Scheduled Tasks ---
  ipcMain.handle("cron:list", async () => {
    if (!gwClient?.connected) throw new Error("Gateway not connected");
    return await gwClient.listCronJobs();
  });

  // --- Agents ---
  ipcMain.handle("agents:list", async () => {
    if (!gwClient?.connected) throw new Error("Gateway not connected");
    return await gwClient.listAgents();
  });
  ipcMain.handle("agents:add", async (_event, agentId: string) => {
    if (typeof agentId !== "string" || !agentId.trim()) {
      throw new Error("Agent id is required");
    }
    if (!gwClient?.connected) throw new Error("Gateway not connected");
    if (agentAdditionInProgress) {
      throw new Error("Another agent is already being added");
    }
    agentAdditionInProgress = true;
    try {
      return await addCatalogAgent(agentId);
    } finally {
      agentAdditionInProgress = false;
    }
  });

  // --- Channels ---
  ipcMain.handle("channels:list", async () => {
    if (!gwClient?.connected) return { channels: [] };
    try {
      return await gwClient.listChannels();
    } catch (err) {
      console.warn("[channels:list] failed:", err);
      return { channels: [] };
    }
  });

  // --- WeChat Plugin ---
  ipcMain.handle("plugin:weixin:get-status", () => {
    const config = readConfig();
    const enabled = !!config?.plugins?.entries?.["openclaw-weixin"]?.enabled;
    const installed = !!config?.plugins?.installs?.["openclaw-weixin"];
    // Check if plugin is installed, enabled, AND has saved login accounts
    let loggedIn = false;
    if (installed && enabled) {
      try {
        const accountsPath = path.join(getOpenClawStateDir(), "openclaw-weixin", "accounts.json");
        if (fs.existsSync(accountsPath)) {
          const accounts = JSON.parse(fs.readFileSync(accountsPath, "utf-8"));
          if (Array.isArray(accounts) && accounts.length > 0) {
            // Verify at least one account has a token file
            const accountsDir = path.join(getOpenClawStateDir(), "openclaw-weixin", "accounts");
            loggedIn = accounts.some((id: string) => {
              const tokenFile = path.join(accountsDir, `${id}.json`);
              return fs.existsSync(tokenFile);
            });
          }
        }
      } catch {}
    }
    return { enabled, installed, loggedIn, loginInProgress: !!weixinLoginProcess };
  });

  ipcMain.handle("plugin:weixin:set-enabled", async (_event, enabled: boolean) => {
    const config = readConfig() || {};
    if (!config.plugins) config.plugins = {};
    if (!config.plugins.entries) config.plugins.entries = {};
    if (!config.plugins.entries["openclaw-weixin"]) config.plugins.entries["openclaw-weixin"] = {};
    config.plugins.entries["openclaw-weixin"].enabled = enabled;
    // Ensure plugins.allow includes openclaw-weixin so the gateway loads it synchronously
    if (!config.plugins.allow) config.plugins.allow = [];
    if (enabled && !config.plugins.allow.includes("openclaw-weixin")) {
      config.plugins.allow.push("openclaw-weixin");
    }
    const stateDir = getOpenClawStateDir();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
    return { ok: true };
  });

  ipcMain.handle("plugin:weixin:login", async () => {
    if (weixinLoginProcess) {
      weixinLoginProcess.kill();
      weixinLoginProcess = null;
    }
    const nodePath = resolveNodePath();
    const entryPath = resolveOpenClawEntry();
    if (!fs.existsSync(nodePath) || !fs.existsSync(entryPath)) {
      return { ok: false, error: "OpenClaw CLI not found" };
    }
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const args = [entryPath, "channels", "login", "--channel", "openclaw-weixin"];
      const stateDir = getOpenClawStateDir();
      const compileCacheDir = path.join(stateDir, COMPILE_CACHE_SUBDIR);
      const spawnOpts: any = {
        cwd: path.dirname(entryPath),
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          NODE_COMPILE_CACHE: compileCacheDir,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      };
      if (process.platform === "win32") {
        spawnOpts.creationFlags = CREATE_NO_WINDOW;
      }
      const child = spawn(nodePath, args, spawnOpts);
      weixinLoginProcess = child;
      let settled = false;

      child.stdout?.on("data", (chunk: Buffer) => {
        mainWindow?.webContents.send("plugin:weixin:login-output", chunk.toString("utf-8"));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        mainWindow?.webContents.send("plugin:weixin:login-output", chunk.toString("utf-8"));
      });
      child.on("error", (err) => {
        weixinLoginProcess = null;
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: err.message });
        }
      });
      child.on("close", (code) => {
        weixinLoginProcess = null;
        mainWindow?.webContents.send("plugin:weixin:login-done", { code });
        if (!settled) {
          settled = true;
          resolve({ ok: code === 0, error: code !== 0 ? `Exit code ${code}` : undefined });
        }
        // After successful login, restart gateway so weixin channel starts
        if (code === 0) {
          console.log("[weixin-login] Login succeeded — will restart gateway in 2s");
          mainWindow?.webContents.send(
            "gateway:log",
            "[weixin] 登录成功，正在重启网关以激活微信通道…",
          );
          setTimeout(async () => {
            try {
              await restartManagedGateway("Activating Weixin after login");
            } catch (err: any) {
              console.error("[weixin-login] restart failed:", err.message);
            }
          }, 2000);
        }
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill();
          weixinLoginProcess = null;
          resolve({ ok: false, error: "Login timed out" });
        }
      }, WEIXIN_LOGIN_TIMEOUT_MS);
    });
  });

  ipcMain.handle("plugin:weixin:cancel-login", () => {
    if (weixinLoginProcess) {
      weixinLoginProcess.kill();
      weixinLoginProcess = null;
    }
  });

  // --- WeChat QR Login via Gateway RPC (fast path, no CLI spawn) ---
  ipcMain.handle(
    "plugin:weixin:login-qr-start",
    async (
      _event,
      params?: {
        accountId?: string;
        force?: boolean;
      },
    ) => {
      if (!gwClient?.connected) {
        return { ok: false, error: "Gateway not connected" };
      }
      try {
        const result = await gwClient.weixinLoginQrStart(params);
        return { ok: true, ...result };
      } catch (err: any) {
        console.error("[weixin:login-qr-start] failed:", err.message);
        return { ok: false, error: err.message };
      }
    },
  );

  ipcMain.handle(
    "plugin:weixin:login-qr-wait",
    async (
      _event,
      params: {
        sessionKey: string;
        accountId?: string;
        timeoutMs?: number;
      },
    ) => {
      if (!gwClient?.connected) {
        return { connected: false, message: "Gateway not connected" };
      }
      try {
        const result = await gwClient.weixinLoginQrWait(params);
        return result;
      } catch (err: any) {
        console.error("[weixin:login-qr-wait] failed:", err.message);
        return { connected: false, message: err.message };
      }
    },
  );

  ipcMain.handle("plugin:weixin:disconnect", async (_event, params?: { accountId?: string }) => {
    // Remove all account files and restart gateway
    try {
      const stateDir = getOpenClawStateDir();
      const accountsIndexPath = path.join(stateDir, "openclaw-weixin", "accounts.json");
      const accountsDir = path.join(stateDir, "openclaw-weixin", "accounts");

      let accountIds: string[] = [];
      if (params?.accountId) {
        accountIds = [params.accountId];
      } else {
        // Remove all accounts
        try {
          if (fs.existsSync(accountsIndexPath)) {
            const parsed = JSON.parse(fs.readFileSync(accountsIndexPath, "utf-8"));
            if (Array.isArray(parsed)) accountIds = parsed;
          }
        } catch {}
      }

      // Delete account data files
      for (const id of accountIds) {
        const tokenFile = path.join(accountsDir, `${id}.json`);
        try {
          fs.unlinkSync(tokenFile);
        } catch {}
      }

      // Update or clear the index
      if (params?.accountId) {
        // Remove just this account from index
        try {
          const remaining =
            accountIds.length > 0
              ? JSON.parse(fs.readFileSync(accountsIndexPath, "utf-8")).filter(
                  (id: string) => id !== params.accountId,
                )
              : [];
          fs.writeFileSync(accountsIndexPath, JSON.stringify(remaining, null, 2), "utf-8");
        } catch {}
      } else {
        // Clear entire index
        try {
          fs.writeFileSync(accountsIndexPath, "[]", "utf-8");
        } catch {}
      }

      // Restart gateway so the channel stops
      console.log("[weixin:disconnect] Credentials removed, restarting gateway...");
      mainWindow?.webContents.send("gateway:log", "[weixin] 微信账号已断开，正在重启网关…");
      await restartManagedGateway("Applying Weixin account disconnection");

      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  // --- Model connection test (runs in main process to avoid CORS) ---
  ipcMain.handle(
    "model:test-connection",
    async (
      _event,
      params: {
        baseUrl: string;
        apiKey: string;
        apiFormat: string;
        modelName: string;
        reasoningEffort?: string;
      },
    ) => {
      const { baseUrl, apiKey: configuredApiKey, apiFormat, modelName, reasoningEffort } = params;
      const apiKeyResult = resolveModelApiKey(configuredApiKey, {
        ...process.env,
        ...loadStateDirEnv(),
      });
      if (!apiKeyResult.ok) return apiKeyResult;
      const apiKey = apiKeyResult.value;

      const baseUrlResult = prepareModelBaseUrl(baseUrl);
      if (!baseUrlResult.ok) return baseUrlResult;
      const versionedBase = baseUrlResult.value;
      const normalizedReasoning =
        reasoningEffort === "minimal" ||
        reasoningEffort === "low" ||
        reasoningEffort === "medium" ||
        reasoningEffort === "high" ||
        reasoningEffort === "xhigh"
          ? reasoningEffort
          : undefined;
      try {
        if (apiFormat === "anthropic") {
          const res = await requestModelEndpoint(appendModelEndpoint(versionedBase, "messages"), {
            method: "POST",
            signal: AbortSignal.timeout(MODEL_CONNECTION_TEST_TIMEOUT_MS),
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: modelName || "claude-3-haiku-20240307",
              max_tokens: 1,
              messages: [{ role: "user", content: "hi" }],
            }),
          });
          if (res.ok) {
            return {
              ok: true,
              message: "Connection successful (Anthropic)",
              baseUrl: versionedBase,
            };
          }
          return { ok: false, message: `Failed: HTTP ${res.status} ${res.statusText}` };
        } else if (apiFormat === "openai-responses") {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

          const body: Record<string, unknown> = {
            model: modelName || "gpt-4o",
            input: "hi",
            max_output_tokens: 1,
          };
          if (normalizedReasoning) {
            body.reasoning = { effort: normalizedReasoning };
          }

          const res = await requestModelEndpoint(appendModelEndpoint(versionedBase, "responses"), {
            method: "POST",
            signal: AbortSignal.timeout(MODEL_CONNECTION_TEST_TIMEOUT_MS),
            headers,
            body: JSON.stringify(body),
          });
          if (res.ok) {
            return {
              ok: true,
              message: "Connection successful (OpenAI Responses)",
              baseUrl: versionedBase,
            };
          }
          return { ok: false, message: `Failed: HTTP ${res.status} ${res.statusText}` };
        } else {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
          const res = await requestModelEndpoint(
            appendModelEndpoint(versionedBase, "chat/completions"),
            {
              method: "POST",
              signal: AbortSignal.timeout(MODEL_CONNECTION_TEST_TIMEOUT_MS),
              headers,
              body: JSON.stringify({
                model: modelName || "gpt-4o",
                max_tokens: 1,
                messages: [{ role: "user", content: "hi" }],
              }),
            },
          );
          if (res.ok) {
            return {
              ok: true,
              message: "Connection successful (OpenAI)",
              baseUrl: versionedBase,
            };
          }
          return { ok: false, message: `Failed: HTTP ${res.status} ${res.statusText}` };
        }
      } catch (err: any) {
        return { ok: false, message: "Connection failed: " + (err.message || "Network error") };
      }
    },
  );

  ipcMain.handle("model:github-copilot:prepare", async () => {
    const config = readConfig();
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("OpenClaw configuration is unavailable");
    }
    const restartRequired = ensureGitHubCopilotProviderPlugin(config);
    if (restartRequired) {
      await fs.promises.writeFile(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
      invalidateGitHubCopilotAuthStatusCache();
    }
    return { restartRequired };
  });

  ipcMain.handle("model:github-copilot:start-login", () => ({
    sessionId: githubCopilotAuthManager.start(resolveGitHubCopilotAuthRuntime()),
  }));

  ipcMain.handle("model:github-copilot:cancel-login", (_event, sessionId?: string) => ({
    cancelled: githubCopilotAuthManager.cancel(sessionId),
  }));

  ipcMain.handle("model:github-copilot:disconnect", async () => {
    githubCopilotAuthManager.stop();
    if (gwClient?.connected) {
      try {
        const payload = await gwClient.request("models.authLogout", {
          provider: "github-copilot",
        });
        const result = parseGitHubCopilotGatewayDisconnectResult(payload);
        invalidateGitHubCopilotAuthStatusCache();
        gatewayGitHubCopilotStatusRequest = null;
        return result;
      } catch (error) {
        console.warn("[github-copilot-auth] Gateway logout unavailable:", error);
      }
    }

    const result = await disconnectGitHubCopilot(resolveGitHubCopilotAuthRuntime());
    if (gwClient?.connected) {
      try {
        await gwClient.request("models.authStatus", { refresh: true });
      } catch (error) {
        console.warn("[github-copilot-auth] Gateway auth refresh unavailable:", error);
      }
    }
    return result;
  });

  ipcMain.handle("model:github-copilot:status", async () => {
    if (gwClient?.connected) {
      try {
        return await requestGitHubCopilotGatewayStatus();
      } catch (error) {
        console.warn("[github-copilot-auth] Gateway auth status unavailable:", error);
      }
    }
    return getGitHubCopilotAuthStatus(resolveGitHubCopilotAuthRuntime());
  });

  ipcMain.handle("model:github-copilot:list-models", async () => {
    if (gwClient?.connected) {
      try {
        const result = await requestGatewayModelCatalog();
        const models = parseGitHubCopilotGatewayModels(result);
        if (models.length > 0) return models;
      } catch (error) {
        console.warn("[github-copilot-auth] Gateway model catalog unavailable:", error);
      }
    }
    return listGitHubCopilotModels(resolveGitHubCopilotAuthRuntime());
  });

  // --- Usage (via gateway WebSocket sessions.usage) ---
  ipcMain.handle("usage:get-stats", async () => {
    if (!gwClient?.connected) throw new Error("Gateway 未连接");
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - USAGE_QUERY_DAYS * 86_400_000)
      .toISOString()
      .split("T")[0];

    // Query the gateway's sessions.usage method (same as OpenClaw web dashboard)
    const result = await gwClient.request<any>("sessions.usage", {
      startDate,
      endDate,
      limit: 1000,
      includeContextWeight: true,
    });

    const totals = result?.totals || {};
    const aggregates = result?.aggregates || {};
    const daily = aggregates.daily || [];
    const byModel = aggregates.byModel || [];
    const messages = aggregates.messages || {};

    // Build model breakdown
    const modelBreakdown: Record<
      string,
      {
        requests: number;
        promptTokens: number;
        completionTokens: number;
        spend: number;
      }
    > = {};
    const modelSpend: Record<string, number> = {};
    for (const m of byModel) {
      const name = m.model || m.provider || "unknown";
      const mt = m.totals || {};
      modelBreakdown[name] = {
        requests: m.count || 0,
        promptTokens: mt.input || 0,
        completionTokens: mt.output || 0,
        spend: mt.totalCost || 0,
      };
      modelSpend[name] = mt.totalCost || 0;
    }

    // Build daily spend
    const dailySpend: Record<string, number> = {};
    for (const d of daily) {
      if (d.date) dailySpend[d.date] = d.cost || 0;
    }

    // The gateway reports cost in USD; fetch the live USD→CNY rate so the
    // renderer can convert + relabel spend to ¥ (falls back gracefully offline).
    const fx = await getUsdToCnyRate();

    return {
      totalSpend: totals.totalCost || 0,
      maxBudget: null,
      modelSpend,
      keyName: "",
      budgetDuration: null,
      budgetResetAt: null,
      totalPromptTokens: totals.input || 0,
      totalCompletionTokens: totals.output || 0,
      totalTokens: totals.totalTokens || 0,
      totalRequests: messages.total || result?.sessions?.length || 0,
      modelBreakdown,
      dailySpend,
      hasDetailedLogs: (result?.sessions?.length || 0) > 0,
      // Extra fields from gateway
      cacheReadTokens: totals.cacheRead || 0,
      cacheWriteTokens: totals.cacheWrite || 0,
      sessionCount: result?.sessions?.length || 0,
      toolCalls: aggregates.tools?.totalCalls || 0,
      // USD→CNY conversion metadata (spend values above remain raw USD)
      exchangeRate: fx.rate,
      currency: fx.currency,
    };
  });

  // Live USD→CNY exchange rate used to render spend figures in CNY.
  ipcMain.handle("usage:get-exchange-rate", async () => {
    return getUsdToCnyRate();
  });

  // Detailed usage stats for the full Usage dashboard page
  ipcMain.handle(
    "usage:get-detailed-stats",
    async (_event, params: { startDate?: string; endDate?: string; filter?: string }) => {
      if (!gwClient?.connected) throw new Error("Gateway 未连接");

      const endDate = params.endDate || new Date().toISOString().split("T")[0];
      const startDate =
        params.startDate ||
        new Date(Date.now() - USAGE_QUERY_DAYS * 86_400_000).toISOString().split("T")[0];

      const result = await gwClient.request<any>("sessions.usage", {
        startDate,
        endDate,
        limit: 5000,
        includeContextWeight: true,
      });

      const totals = result?.totals || {};
      const aggregates = result?.aggregates || {};
      const sessions: any[] = result?.sessions || [];

      // Compute aggregate messages from sessions if aggregates.messages is incomplete
      const aggMessages = aggregates.messages || {};
      if (!aggMessages.total && sessions.length) {
        let total = 0,
          user = 0,
          assistant = 0,
          toolCalls = 0,
          errors = 0;
        for (const s of sessions) {
          const mc = s.usage?.messageCounts || {};
          total += mc.total || 0;
          user += mc.user || 0;
          assistant += mc.assistant || 0;
          toolCalls += mc.toolCalls || 0;
          errors += mc.errors || 0;
        }
        aggMessages.total = total;
        aggMessages.user = user;
        aggMessages.assistant = assistant;
        aggMessages.toolCalls = toolCalls;
        aggMessages.errors = errors;
      }

      // Compute aggregate tools from sessions if aggregates.tools is incomplete
      const aggTools = aggregates.tools || {};
      if (!aggTools.totalCalls && sessions.length) {
        let totalCalls = 0;
        const toolSet = new Set<string>();
        for (const s of sessions) {
          const mc = s.usage?.messageCounts || {};
          totalCalls += mc.toolCalls || 0;
        }
        aggTools.totalCalls = totalCalls;
        aggTools.uniqueTools = toolSet.size;
      }

      // Build error aggregation by day/hour from daily data
      const errTotal = (aggregates.daily || []).reduce(
        (sum: number, d: any) => sum + (d.errors || 0),
        0,
      );
      const errorsByDay = (aggregates.daily || [])
        .filter((d: any) => d.errors > 0)
        .map((d: any) => ({ date: d.date, count: d.errors, messages: d.messages || 0 }));

      // Build byTool from aggregates.tools or sessions
      const byTool: Array<{ tool: string; calls: number }> = [];
      if (aggregates.tools?.byTool) {
        for (const [name, calls] of Object.entries(aggregates.tools.byTool)) {
          byTool.push({ tool: name, calls: calls as number });
        }
      }

      return {
        totals: {
          totalCost: totals.totalCost || 0,
          input: totals.input || 0,
          output: totals.output || 0,
          totalTokens: totals.totalTokens || 0,
          cacheRead: totals.cacheRead || 0,
          cacheWrite: totals.cacheWrite || 0,
        },
        aggregates: {
          daily: (aggregates.daily || []).map((d: any) => ({
            date: d.date,
            tokens: d.tokens || 0,
            cost: d.cost || 0,
            input: d.input || 0,
            output: d.output || 0,
            cacheRead: d.cacheRead || 0,
            messages: d.messages || 0,
            toolCalls: d.toolCalls || 0,
            errors: d.errors || 0,
          })),
          byModel: (aggregates.byModel || []).map((m: any) => ({
            model: m.model || "unknown",
            provider: m.provider || "",
            count: m.count || 0,
            totals: m.totals || {},
          })),
          byProvider: (aggregates.byProvider || []).map((p: any) => ({
            provider: p.provider || p.name || "unknown",
            count: p.count || 0,
            totals: p.totals || {},
          })),
          byAgent: (aggregates.byAgent || []).map((a: any) => ({
            agent: a.agentId || a.agent || a.name || "unknown",
            count: a.count || 0,
            totals: a.totals || {},
          })),
          byChannel: (aggregates.byChannel || []).map((c: any) => ({
            channel: c.channel || c.name || "unknown",
            count: c.count || 0,
            totals: c.totals || {},
          })),
          byTool,
          messages: aggMessages,
          tools: aggTools,
          errors: {
            total: errTotal,
            byDay: errorsByDay,
          },
        },
        sessions: sessions.map((s: any) => {
          const usage = s.usage || {};
          const mc = usage.messageCounts || {};
          return {
            key: s.key || s.sessionKey || "",
            agent: s.agentId || s.agent || "",
            channel: s.channel || "",
            provider: s.modelProvider || s.provider || "",
            model: s.model || "",
            messages: mc.total || 0,
            tools: mc.toolCalls || 0,
            errors: mc.errors || 0,
            tokens: usage.totalTokens || 0,
            cost: usage.totalCost || 0,
            duration: (usage.durationMs || 0) / 1000,
            createdAt: usage.firstActivity
              ? new Date(usage.firstActivity).toISOString()
              : s.updatedAt
                ? new Date(s.updatedAt).toISOString()
                : "",
          };
        }),
        startDate,
        endDate,
      };
    },
  );

  // --- Settings ---
  ipcMain.handle("settings:get", () => settingsStore.store);
  ipcMain.handle("settings:set", (_event, key: string, value: any) => {
    settingsStore.set(key as any, value);
    if (key === "autoStart") {
      app.setLoginItemSettings({ openAtLogin: !!value });
    }
    if (key === "themeMode" && mainWindow) {
      mainWindow.setTitleBarOverlay(
        value === "dark"
          ? { color: "#27272a", symbolColor: "#fafafa", height: 36 }
          : { color: "#ffffff", symbolColor: "#1e1f25", height: 36 },
      );
    }
  });

  // --- Updates ---
  ipcMain.handle("updates:check", () => {
    return checkForUpdates({
      currentVersion: app.getVersion(),
      manifestUrl: UPDATE_MANIFEST_URL,
    });
  });

  // --- Studio Backend ---
  ipcMain.handle("studio:start", async () => {
    if (!studioBackendManager) {
      const stateDir = getOpenClawStateDir();
      studioBackendManager = new StudioBackendManager(stateDir);
      studioBackendManager.on("status", (status: string) => {
        studioBackendStatus = status;
        mainWindow?.webContents.send("studio:status", status);
      });
    }
    if (studioBackendManager.isRunning()) return studioBackendManager.getPort();
    return studioBackendManager.start();
  });
  ipcMain.handle("studio:stop", () => {
    if (studioBackendManager) {
      studioBackendManager.stop();
      studioBackendManager.removeAllListeners("status");
      studioBackendManager = null;
    }
    studioBackendStatus = "stopped";
    mainWindow?.webContents.send("studio:status", "stopped");
  });
  ipcMain.handle("studio:get-status", () => studioBackendStatus);
  ipcMain.handle("studio:get-port", () => studioBackendManager?.getPort() ?? 0);

  // --- Window ---
  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:maximize", () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  ipcMain.handle("window:is-maximized", () => mainWindow?.isMaximized() ?? false);
  ipcMain.handle("window:close", () => mainWindow?.close());
  ipcMain.handle("window:resize-to-setup", () => {
    if (!mainWindow) return;
    mainWindow.setSize(SETUP_WINDOW_WIDTH, SETUP_WINDOW_HEIGHT);
    mainWindow.center();
  });
  ipcMain.handle("window:expand-to-full", () => {
    if (!mainWindow) return;
    mainWindow.setResizable(true);
    const savedBounds = store.get("windowBounds") as
      | { width?: number; height?: number; x?: number; y?: number }
      | undefined;
    const width = savedBounds?.width || DEFAULT_WINDOW_WIDTH;
    const height = savedBounds?.height || DEFAULT_WINDOW_HEIGHT;
    mainWindow.setSize(width, height);
    mainWindow.center();
    (mainWindow as any).__registerSaveBounds?.();
  });

  // --- Shell ---
  ipcMain.handle("shell:open-external", (_event, url: string) => {
    if (typeof url === "string" && (url.startsWith("https://") || url.startsWith("http://"))) {
      shell.openExternal(url);
    }
  });

  // --- Tool Sandbox ---
  ipcMain.handle("sandbox:get-status", () => {
    return (
      toolSandbox?.getStatus() ?? {
        available: false,
        enabled: false,
        launcherPath: null,
        containerName: "MicroClaw",
        capabilities: [],
        sandboxDirsRW: [],
        sandboxDirsRO: [],
        externalApps: [],
      }
    );
  });

  ipcMain.handle("sandbox:set-enabled", async (_event, enabled: boolean) => {
    toolSandbox?.setEnabled(enabled);
    settingsStore.set("sandboxEnabled", enabled);
    // Sandbox enabled/disabled requires hard gateway restart — COMSPEC and
    // NODE_OPTIONS are baked at process start, can't change for running gateway.
    mainWindow?.webContents.send(
      "gateway:log",
      `[sandbox] Sandbox ${enabled ? "enabled" : "disabled"} — restarting gateway…`,
    );
    try {
      await restartManagedGateway(`Applying sandbox ${enabled ? "enablement" : "disablement"}`);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle(
    "sandbox:exec-shell",
    async (
      _event,
      params: {
        command: string;
        cwd?: string;
        timeout?: number;
      },
    ) => {
      if (!toolSandbox?.isActive()) {
        return { exitCode: 1, stdout: "", stderr: "Sandbox not available", timedOut: false };
      }
      return await toolSandbox.execShell(params.command, {
        cwd: params.cwd,
        timeout: params.timeout || 30000,
      });
    },
  );

  ipcMain.handle(
    "sandbox:exec-node",
    async (
      _event,
      params: {
        code: string;
        cwd?: string;
        timeout?: number;
      },
    ) => {
      if (!toolSandbox?.isActive()) {
        return { exitCode: 1, stdout: "", stderr: "Sandbox not available", timedOut: false };
      }
      return await toolSandbox.execNode(params.code, {
        cwd: params.cwd,
        timeout: params.timeout || 30000,
      });
    },
  );

  ipcMain.handle("sandbox:provision", async () => {
    return (await toolSandbox?.provisionAsync()) ?? false;
  });

  ipcMain.handle("sandbox:get-external-apps", () => {
    return settingsStore.get("sandboxExternalApps");
  });

  ipcMain.handle("sandbox:set-external-apps", async (_event, apps: string[]) => {
    if (!Array.isArray(apps)) return { ok: false, apps: [] };
    // Shell executables must never bypass the sandbox — block them even if
    // a compromised renderer tries to add them.
    const BLOCKED_NAMES = new Set([
      "cmd",
      "powershell",
      "pwsh",
      "bash",
      "sh",
      "wsl",
      "python",
      "python3",
      "node",
      "cscript",
      "wscript",
      "mshta",
    ]);
    const MAX_EXTERNAL_APPS = 20;
    // Validate: only accept simple alphanumeric names (no paths, no special chars)
    const clean = apps
      .map((a) =>
        String(a)
          .trim()
          .toLowerCase()
          .replace(/\.exe$/i, ""),
      )
      .filter((a) => /^[a-z0-9_-]+$/.test(a) && !BLOCKED_NAMES.has(a))
      .slice(0, MAX_EXTERNAL_APPS);
    settingsStore.set("sandboxExternalApps", clean);
    toolSandbox?.setExternalApps(clean);
    // Write to file so sandbox-preload.js picks up changes immediately
    // (no gateway restart needed — preload re-reads on each spawn check)
    writeExternalAppsFile(clean);
    return { ok: true, apps: clean };
  });

  ipcMain.handle("sandbox:apply-external-apps", async () => {
    // No-op now — changes take effect immediately via file.
    // Kept for API compatibility.
    return { ok: true, restarted: false };
  });

  // --- Sandbox directory permissions ---

  // --- Sandbox capabilities ---
  ipcMain.handle("sandbox:get-capabilities", () => {
    return settingsStore.get("sandboxCapabilities");
  });

  ipcMain.handle("sandbox:set-capabilities", async (_event, caps: string[]) => {
    // Validate: only accept known capability names
    const KNOWN_CAPS = new Set([
      "internetClient",
      "internetClientServer",
      "privateNetworkClientServer",
      "picturesLibrary",
      "videosLibrary",
      "musicLibrary",
      "documentsLibrary",
      "enterpriseAuthentication",
      "sharedUserCertificates",
      "removableStorage",
      "appointments",
      "contacts",
    ]);
    const clean = caps.filter((c) => KNOWN_CAPS.has(c));
    settingsStore.set("sandboxCapabilities", clean);
    toolSandbox?.setCapabilities(clean);
    // Capabilities are baked into the Gateway environment, so the renderer
    // asks the user to apply them through the hard restart IPC.
    return { ok: true, caps: clean, needsRestart: true };
  });

  ipcMain.handle("sandbox:get-user-dirs", () => {
    return {
      rw: settingsStore.get("sandboxUserDirsRW"),
      ro: settingsStore.get("sandboxUserDirsRO"),
    };
  });

  ipcMain.handle("sandbox:add-user-dir", async (_event, params: { access: "rw" | "ro" }) => {
    if (!mainWindow) return { ok: false, dirs: { rw: [], ro: [] } };
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: false,
        dirs: {
          rw: settingsStore.get("sandboxUserDirsRW"),
          ro: settingsStore.get("sandboxUserDirsRO"),
        },
      };
    }
    const dir = result.filePaths[0];
    const key = params.access === "rw" ? "sandboxUserDirsRW" : "sandboxUserDirsRO";
    const otherKey = params.access === "rw" ? "sandboxUserDirsRO" : "sandboxUserDirsRW";
    const current = settingsStore.get(key);
    const other = settingsStore.get(otherKey);
    // Already in the same list — no-op
    if (current.includes(dir)) {
      return {
        ok: false,
        dirs: {
          rw: settingsStore.get("sandboxUserDirsRW"),
          ro: settingsStore.get("sandboxUserDirsRO"),
        },
      };
    }

    // ── Parent/child hierarchy checks ──

    // Check if a parent directory already has the SAME access level.
    // If so, the child is already covered by inheritance — no need to add.
    for (const existingDir of current) {
      if (isSubdirectoryOf(existingDir, dir)) {
        console.log(
          `[sandbox] Skipping "${dir}" — parent "${existingDir}" already has ${params.access} access`,
        );
        return {
          ok: false,
          reason: "parent-covers" as const,
          parentDir: existingDir,
          parentAccess: params.access,
          dirs: {
            rw: settingsStore.get("sandboxUserDirsRW"),
            ro: settingsStore.get("sandboxUserDirsRO"),
          },
        };
      }
    }

    // Check if a parent directory already has RW access and we're adding RO.
    // Parent RW → child inherits Modify ACE → explicit RO on child is ineffective
    // for shell commands running inside AppContainer.
    if (params.access === "ro") {
      const rwDirs = settingsStore.get("sandboxUserDirsRW");
      for (const rwDir of rwDirs) {
        if (isSubdirectoryOf(rwDir, dir)) {
          console.log(
            `[sandbox] Skipping RO for "${dir}" — parent "${rwDir}" already has RW (inherited ACL makes RO ineffective)`,
          );
          return {
            ok: false,
            reason: "parent-rw-covers" as const,
            parentDir: rwDir,
            dirs: {
              rw: settingsStore.get("sandboxUserDirsRW"),
              ro: settingsStore.get("sandboxUserDirsRO"),
            },
          };
        }
      }
    }

    // Try to grant ACL first — only update settings if successful
    let grantOk = true;
    if (toolSandbox) {
      const access = params.access === "rw" ? "rw" : ("r" as const);
      const result = await grantAndVerifyAcl(dir, access);
      if (result === "failed") {
        grantOk = false;
      } else {
        addToGrantHistory(dir);
      }
    }
    const removedChildren: string[] = [];
    if (grantOk) {
      // ACL granted — update settings
      if (other.includes(dir)) {
        settingsStore.set(
          otherKey,
          other.filter((d: string) => d !== dir),
        );
        if (toolSandbox) {
          if (params.access === "rw") toolSandbox.removeDirRO(dir);
          else toolSandbox.removeDirRW(dir);
        }
      }
      current.push(dir);
      settingsStore.set(key, current);
      if (toolSandbox) {
        if (params.access === "rw") toolSandbox.addDirRW(dir);
        else toolSandbox.addDirRO(dir);
      }

      // When adding a parent dir, auto-remove child dirs that are redundant:
      //   - Adding parent RW → remove child RW entries (covered) AND child RO
      //     entries (parent RW makes child RO ineffective via inherited ACL).
      //   - Adding parent RO → remove child RO entries (covered by inheritance).
      //     Keep child RW entries (they provide higher access than parent).
      const rwDirs = settingsStore.get("sandboxUserDirsRW");
      const roDirs = settingsStore.get("sandboxUserDirsRO");

      if (params.access === "rw") {
        // Parent RW → remove all children (both RW and RO are redundant)
        const childRW = rwDirs.filter((d: string) => d !== dir && isSubdirectoryOf(dir, d));
        const childRO = roDirs.filter((d: string) => isSubdirectoryOf(dir, d));
        for (const child of [...childRW, ...childRO]) {
          removedChildren.push(child);
          // Revoke the child's explicit ACE (parent's inherited ACE will cover it)
          if (toolSandbox) {
            await revokeWithUnshield(child).catch(() => {});
            if (childRW.includes(child)) toolSandbox.removeDirRW(child);
            else toolSandbox.removeDirRO(child);
          }
          removeFromGrantHistory(child);
        }
        if (childRW.length > 0) {
          settingsStore.set(
            "sandboxUserDirsRW",
            rwDirs.filter((d: string) => !childRW.includes(d)),
          );
        }
        if (childRO.length > 0) {
          settingsStore.set(
            "sandboxUserDirsRO",
            roDirs.filter((d: string) => !childRO.includes(d)),
          );
        }
      } else {
        // Parent RO → remove child RO entries (covered), keep child RW
        const childRO = roDirs.filter((d: string) => d !== dir && isSubdirectoryOf(dir, d));
        for (const child of childRO) {
          removedChildren.push(child);
          if (toolSandbox) {
            await revokeWithUnshield(child).catch(() => {});
            toolSandbox.removeDirRO(child);
          }
          removeFromGrantHistory(child);
        }
        if (childRO.length > 0) {
          settingsStore.set(
            "sandboxUserDirsRO",
            roDirs.filter((d: string) => !childRO.includes(d)),
          );
        }

        // Re-grant any child RW dirs so their explicit ACE takes precedence
        // over the parent's inherited RO ACE.
        const childRW = rwDirs.filter((d: string) => isSubdirectoryOf(dir, d));
        if (toolSandbox) {
          for (const childDir of childRW) {
            if (fs.existsSync(childDir)) {
              console.log(`[sandbox] Re-granting child RW dir after parent RO grant: ${childDir}`);
              await grantAndVerifyAcl(normalizeDirPath(childDir), "rw");
            }
          }
        }
      }

      if (removedChildren.length > 0) {
        console.log(
          `[sandbox] Auto-removed ${removedChildren.length} child dir(s) covered by parent "${dir}": ${removedChildren.join(", ")}`,
        );
      }

      notifySandboxDirsChanged();
    } else {
      console.warn(`[sandbox] Grant failed for "${dir}" — not adding to settings`);
    }
    return {
      ok: grantOk,
      removedChildren: grantOk ? removedChildren : undefined,
      dirs: {
        rw: settingsStore.get("sandboxUserDirsRW"),
        ro: settingsStore.get("sandboxUserDirsRO"),
      },
    };
  });

  ipcMain.handle(
    "sandbox:remove-user-dir",
    async (_event, params: { dir: string; access: "rw" | "ro" }) => {
      const key = params.access === "rw" ? "sandboxUserDirsRW" : "sandboxUserDirsRO";
      const normalTarget = normalizeDirPath(params.dir).toLowerCase();

      // Try to revoke ACL first — only remove from settings if successful
      let revokeOk = true;
      if (toolSandbox) {
        console.log(`[sandbox] Revoking ACL for: ${params.dir}`);
        let ok = await revokeWithUnshield(params.dir);

        // Verify ACL was actually removed (revoke can succeed but ACE persist)
        if (ok && _appContainerSid) {
          try {
            const { execSync } = require("child_process");
            const output = execSync(`icacls "${normalizeDirPath(params.dir)}"`, {
              windowsHide: true,
              timeout: 3000,
              encoding: "utf-8",
            }) as string;
            if (output.includes(_appContainerSid)) {
              // Check if all remaining ACEs for the SID are inherited (marked
              // with (I) by icacls). If only inherited ACEs remain, the revoke
              // of the explicit ACE succeeded — the inherited ones come from a
              // parent directory's grant and are expected.
              const hasExplicitAce = hasExplicitSidAce(output, _appContainerSid);
              if (!hasExplicitAce) {
                console.log(`[sandbox] Remaining ACL for ${params.dir} is inherited — revoke OK`);
              } else {
                console.warn(
                  `[sandbox] Revoke returned success but explicit SID still in ACL for: ${params.dir} — retrying elevated`,
                );
                ok = await toolSandbox.revokeDirElevated(params.dir);
                // Check again
                const output2 = execSync(`icacls "${normalizeDirPath(params.dir)}"`, {
                  windowsHide: true,
                  timeout: 3000,
                  encoding: "utf-8",
                }) as string;
                if (output2.includes(_appContainerSid)) {
                  const hasExplicit2 = hasExplicitSidAce(output2, _appContainerSid);
                  if (!hasExplicit2) {
                    console.log(
                      `[sandbox] Remaining ACL for ${params.dir} is inherited — revoke OK (post-elevated)`,
                    );
                  } else {
                    console.error(
                      `[sandbox] Explicit ACL still present after elevated revoke for: ${params.dir}`,
                    );
                    ok = false;
                  }
                }
              }
            }
          } catch {}
        }

        console.log(`[sandbox] Revoke result: ${ok}`);
        if (ok) {
          removeFromGrantHistory(params.dir);
        } else {
          revokeOk = false;
        }
      }

      if (revokeOk) {
        // ACL revoked — remove from settings
        const current = settingsStore
          .get(key)
          .filter((d: string) => normalizeDirPath(d).toLowerCase() !== normalTarget);
        settingsStore.set(key, current);
        if (toolSandbox) {
          if (params.access === "rw") toolSandbox.removeDirRW(params.dir);
          else toolSandbox.removeDirRO(params.dir);
        }

        // Re-grant ACLs for any child dirs that are still in settings.
        // When a parent dir is revoked, children lose inherited ACEs (and
        // RevokeProtectedChildren may remove explicit ACEs from protected children).
        await regrantChildDirsInSettings(params.dir);

        notifySandboxDirsChanged();
      } else {
        console.warn(`[sandbox] Revoke failed for "${params.dir}" — keeping in settings`);
      }

      return {
        ok: revokeOk,
        dirs: {
          rw: settingsStore.get("sandboxUserDirsRW"),
          ro: settingsStore.get("sandboxUserDirsRO"),
        },
      };
    },
  );

  // Verify actual NTFS ACL matches settings for each user directory.
  // Returns per-directory status so the UI can show mismatches.
  ipcMain.handle("sandbox:verify-acl", async () => {
    if (!toolSandbox || !toolSandbox.isAvailable())
      return { missing: [], stale: [], ok: [], errors: [] };

    const rwDirs = settingsStore.get("sandboxUserDirsRW");
    const roDirs = settingsStore.get("sandboxUserDirsRO");
    const history = settingsStore.get("sandboxGrantHistory");

    // System dirs come from toolSandbox (single source of truth)
    const status = toolSandbox.getStatus();
    const userRwSet = new Set(rwDirs.map((d: string) => normalizeDirPath(d).toLowerCase()));
    const userRoSet = new Set(roDirs.map((d: string) => normalizeDirPath(d).toLowerCase()));
    const systemDirsRW = status.sandboxDirsRW.filter(
      (d) => !userRwSet.has(normalizeDirPath(d).toLowerCase()),
    );
    const systemDirsRO = status.sandboxDirsRO.filter(
      (d) => !userRoSet.has(normalizeDirPath(d).toLowerCase()),
    );

    const missing: Array<{ dir: string; access: string; reason: string }> = [];
    const ok: Array<{ dir: string; access: string }> = [];
    const errors: Array<{ dir: string; error: string }> = [];

    // Check all dirs: system + user
    const allExpected = [
      ...systemDirsRW.map((d) => ({ dir: d, access: "rw" as const })),
      ...systemDirsRO.map((d) => ({ dir: d, access: "r" as const })),
      ...rwDirs.map((d: string) => ({ dir: d, access: "rw" as const })),
      ...roDirs.map((d: string) => ({ dir: d, access: "r" as const })),
    ];

    for (const { dir, access } of allExpected) {
      const result = await toolSandbox.checkAcl(dir, access === "rw" ? "rw" : "r");
      if (!result) {
        errors.push({ dir, error: "check-acl command failed" });
      } else if (result.exists === false) {
        errors.push({ dir, error: "directory does not exist" });
      } else if (result.error) {
        errors.push({ dir, error: String(result.error) });
      } else if (result.sufficient) {
        ok.push({ dir, access });
      } else {
        missing.push({
          dir,
          access,
          reason: result.hasAllAppPackages ? "ALL_APP_PACKAGES has access" : "no ACL entry",
        });
      }
    }

    // Scan for stale ACLs (dirs with our SID but not in settings)
    const knownDirSet = new Set([
      ...status.sandboxDirsRW.map((d) => normalizeDirPath(d)),
      ...status.sandboxDirsRO.map((d) => normalizeDirPath(d)),
      ...rwDirs.map((d: string) => normalizeDirPath(d)),
      ...roDirs.map((d: string) => normalizeDirPath(d)),
      ...history.map((d: string) => normalizeDirPath(d)),
    ]);
    // Drive roots are expected to have traverse (setup grants it)
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      knownDirSet.add(`${letter}:`);
      knownDirSet.add(`${letter}:\\`);
    }

    const staleResults = await toolSandbox.scanStaleAcls([...knownDirSet], 4);
    // Only flag as stale if the ACL has real data access (Read/Write/Modify),
    // not just traverse (ReadAttributes + Traverse + ReadExtendedAttributes).
    // Traverse-only ACLs are normal — GrantAncestorTraverse adds them to
    // ancestor dirs so AppContainer can reach target paths.
    const TRAVERSE_ONLY_FLAGS = [
      "ReadAttributes",
      "ReadExtendedAttributes",
      "Traverse",
      "Synchronize",
    ];
    function isTraverseOnly(rights: string): boolean {
      const parts = rights.split(",").map((s) => s.trim());
      return parts.every((p) => TRAVERSE_ONLY_FLAGS.includes(p));
    }
    const stale = staleResults
      .filter((s) => !s.inherited && !isTraverseOnly(s.rights))
      .map((s) => ({ dir: s.path, rights: s.rights }));

    return { missing, stale, ok, errors };
  });

  // Repair ACL for a specific directory — re-grant the expected permission.
  ipcMain.handle(
    "sandbox:repair-acl",
    async (_event, params: { dir: string; access: "rw" | "ro" }) => {
      if (!toolSandbox) return { ok: false };
      const access = params.access === "rw" ? "rw" : ("r" as const);
      const result = await grantAndVerifyAcl(params.dir, access);
      const ok = result !== "failed";
      if (ok) addToGrantHistory(params.dir);
      return { ok };
    },
  );

  // Revoke a stale ACL entry found by scan-acl.
  // Also removes from settings lists + grant history to prevent re-grant.
  ipcMain.handle("sandbox:revoke-stale-acl", async (_event, dir: string) => {
    if (!toolSandbox) return { ok: false };
    const ok = await revokeWithUnshield(dir);
    if (ok) {
      removeFromGrantHistory(dir);
      // Also remove from settings dirs to prevent re-grant
      const normalDir = normalizeDirPath(dir).toLowerCase();
      for (const key of ["sandboxUserDirsRW", "sandboxUserDirsRO"] as const) {
        const dirs = settingsStore.get(key);
        const filtered = dirs.filter(
          (d: string) => normalizeDirPath(d).toLowerCase() !== normalDir,
        );
        if (filtered.length !== dirs.length) {
          settingsStore.set(key, filtered);
          if (toolSandbox) {
            if (key === "sandboxUserDirsRW") toolSandbox.removeDirRW(dir);
            else toolSandbox.removeDirRO(dir);
          }
        }
      }
      notifySandboxDirsChanged();
    }
    return { ok };
  });

  // Handle renderer responses to in-app permission dialogs.
  ipcMain.handle(
    "sandbox:permission-respond",
    async (_event, requestId: string, decision: string) => {
      const pending = pendingPermissionRequests.get(requestId);
      if (!pending) return;
      pendingPermissionRequests.delete(requestId);
      const { type, msg } = pending;

      if (type === "file") {
        const { id, roDir, responseFile } = msg;
        const reqPath = msg.filePath;
        console.log(`[sandbox] File permission decision: ${decision} for ${reqPath}`);

        const finishFilePermission = async () => {
          if (decision === "grant-ro" || decision === "grant-rw") {
            const isRW = decision === "grant-rw";
            const normalDir = normalizeDirPath(roDir).toLowerCase();
            const targetKey = isRW ? "sandboxUserDirsRW" : "sandboxUserDirsRO";
            const otherKey = isRW ? "sandboxUserDirsRO" : "sandboxUserDirsRW";
            const otherDirs = settingsStore.get(otherKey);
            const otherIdx = otherDirs.findIndex(
              (d: string) => normalizeDirPath(d).toLowerCase() === normalDir,
            );
            let dirToAdd = normalizeDirPath(roDir);
            if (otherIdx >= 0) {
              dirToAdd = otherDirs[otherIdx];
              otherDirs.splice(otherIdx, 1);
              settingsStore.set(otherKey, otherDirs);
              if (toolSandbox) {
                if (isRW) toolSandbox.removeDirRO(dirToAdd);
                else toolSandbox.removeDirRW(dirToAdd);
              }
            }
            const targetDirs = settingsStore.get(targetKey);
            if (!targetDirs.some((d: string) => normalizeDirPath(d).toLowerCase() === normalDir)) {
              targetDirs.push(dirToAdd);
              settingsStore.set(targetKey, targetDirs);
            }
            if (toolSandbox) {
              if (isRW) toolSandbox.addDirRW(dirToAdd);
              else toolSandbox.addDirRO(dirToAdd);
              // Grant ACL BEFORE writing response file — gateway retries the write
              // immediately after picking up the response, so ACL must be in place.
              const access = isRW ? "rw" : "r";
              const t0 = Date.now();
              console.log(
                `[sandbox:respond] file: starting grant for ${dirToAdd} access=${access}`,
              );
              const granted = await grantAndVerifyAcl(dirToAdd, access);
              console.log(
                `[sandbox:respond] file: grant result=${granted} elapsed=${Date.now() - t0}ms`,
              );
              if (granted === "failed") {
                // ACL grant itself failed — rollback settings, write "timeout"
                console.warn(
                  `[sandbox:respond] file: FAILED — rolling back settings for ${dirToAdd}`,
                );
                mainWindow?.webContents.send("sandbox:permission-completed", {
                  requestId,
                  result: "failed",
                  dir: dirToAdd,
                  access,
                });
                const rollbackDirs = settingsStore
                  .get(targetKey)
                  .filter((d: string) => normalizeDirPath(d).toLowerCase() !== normalDir);
                settingsStore.set(targetKey, rollbackDirs);
                if (isRW) toolSandbox.removeDirRW(dirToAdd);
                else toolSandbox.removeDirRO(dirToAdd);
                if (otherIdx >= 0) {
                  const restoredOther = settingsStore.get(otherKey);
                  restoredOther.push(dirToAdd);
                  settingsStore.set(otherKey, restoredOther);
                  if (isRW) toolSandbox.addDirRO(dirToAdd);
                  else toolSandbox.addDirRW(dirToAdd);
                }
                notifySandboxDirsChanged();
                mainWindow?.webContents.send("sandbox:acl-timeout", {
                  dir: dirToAdd,
                  access,
                });
                try {
                  fs.writeFileSync(
                    responseFile,
                    JSON.stringify({ id, decision: "timeout" }),
                    "utf-8",
                  );
                } catch (err: any) {
                  console.error(`[sandbox] Failed to write timeout response: ${err.message}`);
                }
                pendingSyncPermissionRequests = Math.max(0, pendingSyncPermissionRequests - 1);
                return;
              }
              if (granted === "grant-ok-verify-timeout") {
                // ACL set on disk but verification timed out — keep settings, proceed optimistically
                console.log(
                  `[sandbox:respond] file: OPTIMISTIC — grant OK but verify timed out, keeping settings for ${dirToAdd}`,
                );
                mainWindow?.webContents.send("sandbox:acl-propagation-pending", {
                  dir: dirToAdd,
                  access,
                });
                mainWindow?.webContents.send("sandbox:permission-completed", {
                  requestId,
                  result: "verify-timeout",
                  dir: dirToAdd,
                  access,
                });
              } else {
                // Fully verified
                mainWindow?.webContents.send("sandbox:permission-completed", {
                  requestId,
                  result: "verified",
                  dir: dirToAdd,
                  access,
                });
              }
              addToGrantHistory(dirToAdd);
            }
            console.log(`[sandbox] Added "${dirToAdd}" to ${isRW ? "RW" : "RO"} permissions`);
            // Silently clean up child dirs now covered by this parent grant
            await silentCleanupRedundantChildren(dirToAdd, isRW ? "rw" : "ro");
            notifySandboxDirsChanged();
          }
          // Write response file AFTER ACL is granted — unblocks gateway's Atomics.wait
          try {
            fs.writeFileSync(responseFile, JSON.stringify({ id, decision }), "utf-8");
          } catch (err: any) {
            console.error(`[sandbox] Failed to write file permission response: ${err.message}`);
          }
          pendingSyncPermissionRequests = Math.max(0, pendingSyncPermissionRequests - 1);
        };
        finishFilePermission().catch(() => {
          pendingSyncPermissionRequests = Math.max(0, pendingSyncPermissionRequests - 1);
        });
      } else if (type === "shell") {
        const { id, deniedPath, dirPath, responseFile } = msg;
        console.log(`[sandbox] Shell permission decision: ${decision} for ${deniedPath}`);

        if (decision === "grant-ro" || decision === "grant-rw") {
          const isRW = decision === "grant-rw";
          const normalDir = normalizeDirPath(dirPath).toLowerCase();
          const targetKey = isRW ? "sandboxUserDirsRW" : "sandboxUserDirsRO";
          const otherKey = isRW ? "sandboxUserDirsRO" : "sandboxUserDirsRW";
          const otherDirs = settingsStore.get(otherKey);
          const otherIdx = otherDirs.findIndex(
            (d: string) => normalizeDirPath(d).toLowerCase() === normalDir,
          );
          let dirToAdd = normalizeDirPath(dirPath);
          if (otherIdx >= 0) {
            dirToAdd = otherDirs[otherIdx];
            otherDirs.splice(otherIdx, 1);
            settingsStore.set(otherKey, otherDirs);
            if (toolSandbox) {
              if (isRW) toolSandbox.removeDirRO(dirToAdd);
              else toolSandbox.removeDirRW(dirToAdd);
            }
          }
          const targetDirs = settingsStore.get(targetKey);
          if (!targetDirs.some((d: string) => normalizeDirPath(d).toLowerCase() === normalDir)) {
            targetDirs.push(dirToAdd);
            settingsStore.set(targetKey, targetDirs);
          }
          if (toolSandbox) {
            if (isRW) toolSandbox.addDirRW(dirToAdd);
            else toolSandbox.addDirRO(dirToAdd);
            const access = isRW ? "rw" : "r";
            const t0 = Date.now();
            console.log(`[sandbox:respond] shell: starting grant for ${dirToAdd} access=${access}`);
            const granted = await grantAndVerifyAcl(dirToAdd, access as "rw" | "r");
            console.log(
              `[sandbox:respond] shell: grant result=${granted} elapsed=${Date.now() - t0}ms`,
            );
            if (granted === "failed") {
              // ACL grant itself failed — rollback settings, write "timeout"
              console.warn(
                `[sandbox:respond] shell: FAILED — rolling back settings for ${dirToAdd}`,
              );
              const rollbackDirs = settingsStore
                .get(targetKey)
                .filter((d: string) => normalizeDirPath(d).toLowerCase() !== normalDir);
              settingsStore.set(targetKey, rollbackDirs);
              if (isRW) toolSandbox.removeDirRW(dirToAdd);
              else toolSandbox.removeDirRO(dirToAdd);
              if (otherIdx >= 0) {
                const restoredOther = settingsStore.get(otherKey);
                restoredOther.push(dirToAdd);
                settingsStore.set(otherKey, restoredOther);
                if (isRW) toolSandbox.addDirRO(dirToAdd);
                else toolSandbox.addDirRW(dirToAdd);
              }
              notifySandboxDirsChanged();
              mainWindow?.webContents.send("sandbox:acl-timeout", {
                dir: dirToAdd,
                access,
              });
              try {
                fs.writeFileSync(
                  responseFile,
                  JSON.stringify({ id, decision: "timeout" }),
                  "utf-8",
                );
              } catch {}
              return;
            }
            if (granted === "grant-ok-verify-timeout") {
              console.log(
                `[sandbox:respond] shell: OPTIMISTIC — grant OK but verify timed out, keeping settings for ${dirToAdd}`,
              );
              mainWindow?.webContents.send("sandbox:acl-propagation-pending", {
                dir: dirToAdd,
                access,
              });
            }
          }
          console.log(`[sandbox] Granted ${isRW ? "RW" : "RO"} to "${dirToAdd}" for shell retry`);
          addToGrantHistory(dirToAdd);
          // Silently clean up child dirs now covered by this parent grant
          await silentCleanupRedundantChildren(dirToAdd, isRW ? "rw" : "ro");
          notifySandboxDirsChanged();
        }
        try {
          fs.writeFileSync(responseFile, JSON.stringify({ id, decision }), "utf-8");
        } catch (err: any) {
          console.error(`[sandbox] Failed to write shell permission response: ${err.message}`);
        }
      } else if (type === "shell-async") {
        const { deniedPath, dirPath, responseFile: asyncResponseFile } = msg;
        console.log(`[sandbox] Async shell permission decision: ${decision} for ${deniedPath}`);

        if (decision === "grant-ro" || decision === "grant-rw") {
          const isRW = decision === "grant-rw";
          const normalDir = normalizeDirPath(dirPath).toLowerCase();
          const targetKey = isRW ? "sandboxUserDirsRW" : "sandboxUserDirsRO";
          const otherKey = isRW ? "sandboxUserDirsRO" : "sandboxUserDirsRW";
          const otherDirs = settingsStore.get(otherKey);
          const otherIdx = otherDirs.findIndex(
            (d: string) => normalizeDirPath(d).toLowerCase() === normalDir,
          );
          let dirToAdd = normalizeDirPath(dirPath);
          if (otherIdx >= 0) {
            dirToAdd = otherDirs[otherIdx];
            otherDirs.splice(otherIdx, 1);
            settingsStore.set(otherKey, otherDirs);
            if (toolSandbox) {
              if (isRW) toolSandbox.removeDirRO(dirToAdd);
              else toolSandbox.removeDirRW(dirToAdd);
            }
          }
          const targetDirs = settingsStore.get(targetKey);
          if (!targetDirs.some((d: string) => normalizeDirPath(d).toLowerCase() === normalDir)) {
            targetDirs.push(dirToAdd);
            settingsStore.set(targetKey, targetDirs);
          }
          if (toolSandbox) {
            if (isRW) toolSandbox.addDirRW(dirToAdd);
            else toolSandbox.addDirRO(dirToAdd);
            const access = isRW ? "rw" : "r";
            toolSandbox
              .grantDirAsync(dirToAdd, access)
              .then((ok) => {
                if (!ok) return toolSandbox!.grantDirElevated(dirToAdd, access);
                return true;
              })
              .then(() => {
                addToGrantHistory(dirToAdd);
                // Shield sensitive subdirs after grant
                const lp = toolSandbox!.getStatus().launcherPath;
                if (lp) return shieldIfNeeded(lp, "MicroClaw", dirToAdd).catch(() => {});
              })
              .then(() => {
                console.log(`[sandbox] Async: granted ${isRW ? "RW" : "RO"} to "${dirToAdd}"`);
                // Silently clean up child dirs now covered by this parent grant
                silentCleanupRedundantChildren(dirToAdd, isRW ? "rw" : "ro").catch(() => {});
                notifySandboxDirsChanged();
                // Write response file AFTER ACL is granted — unblocks any sync poll
                if (asyncResponseFile) {
                  try {
                    fs.writeFileSync(asyncResponseFile, JSON.stringify({ decision }), "utf-8");
                  } catch {}
                }
                // Nudge the model to retry — user granted permission but the original
                // command already failed, so the model doesn't know to try again.
                if (activeChatSession && gwClient?.connected) {
                  const lang = settingsStore.get("language") ?? "en-US";
                  const accessLabel = mainT(lang, isRW ? "perm.accessRW" : "perm.accessRO");
                  const retryMsg = mainT(lang, "perm.retryNudge")
                    .replace("{dir}", dirToAdd)
                    .replace("{access}", accessLabel);
                  gwClient.sendChat(activeChatSession, retryMsg).catch(() => {});
                }
              })
              .catch(() => {
                // ACL grant failed — rollback settings and write deny response
                console.error(`[sandbox] Async ACL grant failed for ${dirToAdd} — rolling back`);
                const rollbackDirs = settingsStore
                  .get(targetKey)
                  .filter((d: string) => normalizeDirPath(d).toLowerCase() !== normalDir);
                settingsStore.set(targetKey, rollbackDirs);
                if (toolSandbox) {
                  if (isRW) toolSandbox.removeDirRW(dirToAdd);
                  else toolSandbox.removeDirRO(dirToAdd);
                  // Restore the 'other' list if we removed it during RO↔RW upgrade
                  if (otherIdx >= 0) {
                    const restoredOther = settingsStore.get(otherKey);
                    restoredOther.push(dirToAdd);
                    settingsStore.set(otherKey, restoredOther);
                    if (isRW) toolSandbox.addDirRO(dirToAdd);
                    else toolSandbox.addDirRW(dirToAdd);
                  }
                }
                notifySandboxDirsChanged();
                if (asyncResponseFile) {
                  try {
                    fs.writeFileSync(
                      asyncResponseFile,
                      JSON.stringify({ decision: "deny" }),
                      "utf-8",
                    );
                  } catch {}
                }
              });
          } else {
            // No sandbox — write response immediately
            if (asyncResponseFile) {
              try {
                fs.writeFileSync(asyncResponseFile, JSON.stringify({ decision }), "utf-8");
              } catch {}
            }
          }
        } else {
          // Denied — write response to unblock any sync poll
          if (asyncResponseFile) {
            try {
              fs.writeFileSync(asyncResponseFile, JSON.stringify({ decision: "deny" }), "utf-8");
            } catch {}
          }
        }
      } else if (type === "app-approval") {
        const { id, app, responseFile } = msg;
        const appLower = (app || "").toLowerCase();
        console.log(`[sandbox] App approval decision: ${decision} for ${appLower}`);

        if (decision === "deny") {
          // Add to session deny list
          if (!sessionDeniedApps.has(activeChatSession)) {
            sessionDeniedApps.set(activeChatSession, new Set());
          }
          sessionDeniedApps.get(activeChatSession)!.add(appLower);
          if (sessionDeniedApps.size > 20) {
            const oldest = sessionDeniedApps.keys().next().value!;
            sessionDeniedApps.delete(oldest);
          }
        } else if (decision === "allow-always") {
          const current = settingsStore.get("sandboxExternalApps");
          if (!current.includes(appLower)) {
            current.push(appLower);
            settingsStore.set("sandboxExternalApps", current);
            toolSandbox?.setExternalApps(current);
            writeExternalAppsFile(current);
            console.log(`[sandbox] Added "${appLower}" to permanent whitelist`);
          }
        }
        // Write response file to unblock the gateway's Atomics.wait loop
        try {
          fs.writeFileSync(responseFile, JSON.stringify({ id, decision }), "utf-8");
        } catch (err: any) {
          console.error(`[sandbox] Failed to write approval response: ${err.message}`);
        }
        pendingSyncPermissionRequests = Math.max(0, pendingSyncPermissionRequests - 1);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    // Ensure gateway is alive when user re-opens the app
    ensureGatewayConnected().catch((err) =>
      console.error("[second-instance] gateway reconnect failed:", err),
    );
  });
}

app.whenReady().then(async () => {
  if (!settingsStore.has("language")) {
    settingsStore.set("language", resolveSupportedLocale(app.getLocale()));
  }

  try {
    const home = app.getPath("home");
    const recovery = recoverInterruptedOpenClawUpgrade(path.join(home, ".microclaw"), {
      expectedStateDir: path.join(home, ".openclaw"),
    });
    if (recovery.status === "rolled-back") {
      console.log("[upgrade] Restored the previous OpenClaw package and state");
    }
  } catch (error) {
    const inProgress = error instanceof UpgradeInProgressError;
    dialog.showErrorBox(
      inProgress ? "MicroClaw upgrade in progress" : "OpenClaw recovery failed",
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
    return;
  }

  registerIpcHandlers();

  // Sync auto-start with OS
  app.setLoginItemSettings({ openAtLogin: settingsStore.get("autoStart") });

  mainWindow = createMainWindow();

  const trayCallbacks = {
    onShowWindow: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
      // Ensure gateway is alive when user shows window from tray
      ensureGatewayConnected().catch((err) =>
        console.error("[tray-show] gateway reconnect failed:", err),
      );
    },
    onRestartGateway: () => {
      restartManagedGateway("Restart requested from system tray").catch((error) =>
        console.error("[tray] Gateway restart failed:", error),
      );
    },
    onQuit: () => {
      isQuitting = true;
    },
  };
  createTray(trayCallbacks);

  // Skill integrity check — must run BEFORE loading renderer so
  // pendingIntegrityResult is ready when App.vue calls the IPC.
  const integrityResult = verifySkillIntegrity();
  if (!integrityResult.snapshotExists) {
    console.log(
      "No skill integrity snapshot found — generating baseline (installer may not have run)...",
    );
    generateAndSignSnapshot();
  } else if (!integrityResult.valid) {
    console.log("Skill integrity check failed — changes detected");
    pendingIntegrityResult = integrityResult;
  }

  // Load the Vue renderer UI.
  if (isDev) {
    // Poll until Vite dev server is ready (up to 60s).
    const waitForVite = async () => {
      for (let i = 0; i < 120; i++) {
        try {
          await mainWindow!.loadURL(VITE_DEV_URL);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      await mainWindow!.loadURL(VITE_DEV_URL);
    };
    await waitForVite();
  } else {
    const indexPath = path.join(__dirname, "../renderer/dist/index.html");
    try {
      await mainWindow.loadFile(indexPath);
    } catch (err) {
      console.error("Failed to load renderer, retrying:", err);
      await new Promise((r) => setTimeout(r, 1000));
      await mainWindow.loadFile(indexPath);
    }
  }

  // Watch skill directories for mid-session changes
  startSkillFileWatcher();

  startGateway().catch((err) => {
    console.error("Failed to start gateway:", err);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  // Clean up skill file watchers
  for (const w of skillWatchers) {
    try {
      w.close();
    } catch {}
  }
  skillWatchers = [];
  if (watcherDebounceTimer) {
    clearTimeout(watcherDebounceTimer);
    watcherDebounceTimer = null;
  }
  destroyTray();
  githubCopilotAuthManager.stop();
  gwClient?.stop();
  studioBackendManager?.stop();
  stopGatewayProcess();
});

app.on("activate", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
  }
  ensureGatewayConnected().catch((err) =>
    console.error("[activate] gateway reconnect failed:", err),
  );
});
