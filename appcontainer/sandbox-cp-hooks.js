/**
 * sandbox-cp-hooks.js — Monkey-patches for child_process (spawn, exec, execFile, etc.).
 *
 * Intercepts shell command execution, routes through AppContainer, performs
 * pre-blocking path checks, and sends async permission requests on access denied.
 * Also handles external app detection and approval flow.
 *
 * SECURITY MODEL (defense in depth):
 *
 *   Layer 1 — Pre-blocking (UX, best-effort):
 *     Regex-based path extraction guesses which paths a command will access.
 *     If a path is outside the sandbox dirs, a permission dialog is shown
 *     BEFORE execution.  This is a UX convenience — it is NOT a security
 *     boundary because regex cannot fully parse shell syntax.
 *
 *   Layer 2 — AppContainer (security boundary, OS-enforced):
 *     All shell commands (except safe diagnostics and user-approved external
 *     apps) are executed inside a Windows AppContainer via
 *     AppContainerLauncher.exe.  The kernel enforces ACLs regardless of
 *     what the regex extracted.  Commands that trick the path extractor
 *     into reporting safe paths will still be blocked by AppContainer ACLs
 *     if they access non-granted directories.
 *
 *   Layer 3 — Post-failure detection (UX, async):
 *     After a command finishes, stderr/stdout is scanned for "access denied"
 *     patterns.  If found, an async permission dialog is shown so the user
 *     can grant access for the next attempt.
 */
"use strict";

var pathMod = require("path");
var fsMod = require("fs");

var S = require(pathMod.join(__dirname, "sandbox-state.js"));
var perm = require(pathMod.join(__dirname, "sandbox-permission.js"));
var sensitive = require(pathMod.join(__dirname, "sandbox-sensitive.js"));
var _pathExtraction = require(pathMod.join(__dirname, "path-extraction.js"));
var extractShellPayload = _pathExtraction.extractShellPayload;
var extractWritePaths = _pathExtraction.extractWritePaths;
var extractReadPaths = _pathExtraction.extractReadPaths;
var extractShellPayloadFromString = _pathExtraction.extractShellPayloadFromString;
var filterSystemPaths = _pathExtraction.filterSystemPaths;

// ── Utility functions ───────────────────────────────────────────────────

function isShellExe(exe) {
  if (!exe) return false;
  var base = pathMod
    .basename(String(exe))
    .toLowerCase()
    .replace(/\.exe$/i, "");
  return S.SHELL_NAMES_SET.has(base);
}

function isLauncherExe(exe) {
  if (!exe) return false;
  return /appcontainerlauncher/i.test(pathMod.basename(String(exe)));
}

function buildLA(exe, childArgs) {
  var a = ["run", "--name", S.CNAME, "--exe", String(exe), "--no-window", "--quiet"];
  for (var i = 0; i < S.CAPS.length; i++) a.push("--cap", S.CAPS[i].trim());
  a.push("--");
  if (childArgs && childArgs.length > 0)
    for (var j = 0; j < childArgs.length; j++) a.push(childArgs[j]);
  return a;
}

// Inject UTF-8 encoding directives into shell args so the child process
// running inside AppContainer outputs UTF-8 instead of the system OEM code page.
function ensureUtf8Args(exe, args) {
  var bn = pathMod
    .basename(String(exe))
    .toLowerCase()
    .replace(/\.exe$/i, "");
  var a = args.slice();
  if (bn === "cmd") {
    for (var i = 0; i < a.length; i++) {
      if (/^\/[ck]$/i.test(a[i]) && i + 1 < a.length) {
        a.splice(i + 1, 0, "chcp 65001 >nul &");
        break;
      }
    }
  } else if (bn === "powershell" || bn === "pwsh") {
    for (var i = 0; i < a.length; i++) {
      if (/^-(?:Command|c)$/i.test(a[i]) && i + 1 < a.length) {
        a.splice(i + 1, 0, "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;");
        break;
      }
    }
  }
  return a;
}

// ── Safe read-only diagnostic tool bypass ───────────────────────────────
// These system tools require kernel device access (e.g. \\.\Nsi) that
// AppContainer blocks even with network capabilities. They are safe to
// run outside the sandbox because dangerous flags require admin elevation.

var SAFE_DIAG_TOOLS = new Set([
  "ping",
  "tracert",
  "traceroute",
  "pathping",
  "nslookup",
  "hostname",
  "arp",
]);

// Shell metacharacters that should never appear in a safe diagnostic command.
// Catches: redirection (>, <), subexpression $(), backtick escapes, for/if blocks.
var UNSAFE_SHELL_CHARS_RE = /[><]|\$\(|`[^`]/;

/**
 * Check if a shell payload consists entirely of safe diagnostic commands.
 * Piped commands do not bypass AppContainer because filter tools can accept
 * file operands in addition to stdin.
 *
 * Security: rejects any payload containing redirection, subexpressions,
 * or backtick escapes. Splits on ALL cmd/PS separators including single &.
 */
function isSafeDiagnosticCommand(cmd, args) {
  var payload = extractShellPayload(cmd, Array.isArray(args) ? args : []);
  if (!payload) return false;

  // Reject shell metacharacters that could enable write or code injection
  if (UNSAFE_SHELL_CHARS_RE.test(payload)) return false;

  // Split on ALL statement separators: &&, ||, single &, ;, newlines
  // Order matters: && before & so && is matched as one separator, not two &'s
  var statements = payload.split(/\s*(?:&&|\|\||&|;|\n)\s*/);

  for (var s = 0; s < statements.length; s++) {
    var stmt = statements[s].trim();
    if (!stmt) continue;

    // Filters such as find/more/sort can also open named files.
    var segments = stmt.split(/\s*\|\s*/);
    if (segments.length !== 1) return false;
    for (var p = 0; p < segments.length; p++) {
      var seg = segments[p].trim();
      if (!seg) continue;

      // Extract the executable name (first token), strip quotes and path
      var firstToken = seg.split(/\s+/)[0].replace(/^["']|["']$/g, "");
      var exeName = pathMod
        .basename(firstToken)
        .toLowerCase()
        .replace(/\.exe$/i, "");

      if (!SAFE_DIAG_TOOLS.has(exeName)) return false;
    }
  }

  return true;
}

/**
 * String variant: check if a raw command string is a safe diagnostic command.
 * Used by exec() / execSync() which receive the full command as a string.
 */
function isSafeDiagnosticCommandStr(cmdStr) {
  if (!cmdStr) return false;

  // Reject shell metacharacters that could enable write or code injection
  if (UNSAFE_SHELL_CHARS_RE.test(cmdStr)) return false;

  var statements = cmdStr.split(/\s*(?:&&|\|\||&|;|\n)\s*/);
  for (var s = 0; s < statements.length; s++) {
    var stmt = statements[s].trim();
    if (!stmt) continue;
    var segments = stmt.split(/\s*\|\s*/);
    if (segments.length !== 1) return false;
    for (var p = 0; p < segments.length; p++) {
      var seg = segments[p].trim();
      if (!seg) continue;
      var firstToken = seg.split(/\s+/)[0].replace(/^["']|["']$/g, "");
      var exeName = pathMod
        .basename(firstToken)
        .toLowerCase()
        .replace(/\.exe$/i, "");
      if (!SAFE_DIAG_TOOLS.has(exeName)) return false;
    }
  }
  return true;
}

function stripShell(opts) {
  if (!opts || !opts.shell) return opts;
  var o = {};
  var keys = Object.keys(opts);
  for (var i = 0; i < keys.length; i++) if (keys[i] !== "shell") o[keys[i]] = opts[keys[i]];
  return o;
}

function buildCmdPreview(cmd, args) {
  var argArr = Array.isArray(args) ? args : [];
  return String(cmd) + " " + argArr.join(" ");
}

function getChildOptions(args, opts) {
  if (Array.isArray(args)) return opts;
  if (args === null || args === undefined) {
    return opts && typeof opts === "object" ? opts : undefined;
  }
  return typeof args === "object" ? args : undefined;
}

var TRUSTED_CHILD_ENV_KEYS = [
  "COMSPEC",
  "OPENCLAW_ORIGINAL_COMSPEC",
  "OPENCLAW_SANDBOX_NAME",
  "OPENCLAW_SANDBOX_CAPS",
  "OPENCLAW_SANDBOX_DIRS_RW",
  "OPENCLAW_SANDBOX_DIRS_RO",
  "OPENCLAW_SANDBOX_PERMISSION_TIMEOUT",
  "OPENCLAW_SANDBOX_HMAC_KEY",
  "OPENCLAW_AC_EXTERNAL_APPS",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_NODE_DIR",
  "USERPROFILE",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "ProgramFiles",
  "SystemDrive",
  "SystemRoot",
  "windir",
];

function withCurrentPrivacyEnv(options) {
  if (!options || typeof options !== "object") return options;
  var updated = Object.assign({}, options);
  if (options.env && typeof options.env === "object") {
    updated.env = Object.assign({}, options.env);
    for (var i = 0; i < TRUSTED_CHILD_ENV_KEYS.length; i++) {
      var key = TRUSTED_CHILD_ENV_KEYS[i];
      if (process.env[key] !== undefined) updated.env[key] = process.env[key];
    }
    var pathValue = process.env.PATH || process.env.Path;
    if (pathValue !== undefined) updated.env.PATH = pathValue;
    updated.env.OPENCLAW_PRIVACY_LEVEL = S.state.privacyLevel;
    if (process.env.NODE_OPTIONS) {
      updated.env.NODE_OPTIONS = process.env.NODE_OPTIONS;
    }
  }
  if (options.shell && S.LAUNCHER) updated.shell = S.LAUNCHER;
  return updated;
}

function notifyExecCommand(cmd, args) {
  if (typeof process.send !== "function") return;
  var payload = extractShellPayload(cmd, Array.isArray(args) ? args : []);
  if (!payload) return;
  process.send({
    type: "sandbox-exec-command",
    shell: pathMod
      .basename(String(cmd))
      .toLowerCase()
      .replace(/\.exe$/i, ""),
    command: payload.substring(0, 500),
  });
}

// ── External app detection ──────────────────────────────────────────────

function hasExternalApp(cmd, args, getExternalApps) {
  var EXTERNAL_APPS = getExternalApps();
  if (EXTERNAL_APPS.length === 0) return false;
  var payload = "";
  var argArr = Array.isArray(args) ? args : [];
  for (var i = 0; i < argArr.length; i++) {
    var a = String(argArr[i]);
    if (/^[-\/][a-z]/i.test(a)) continue;
    payload = argArr.slice(i).join(" ");
    break;
  }
  if (!payload) return false;
  payload = payload.toLowerCase();
  var statements = payload.split(/\s*[;\n|]+\s*|\s*&&\s*|\s*\|\|\s*/);
  var foundApp = false;
  for (var s = 0; s < statements.length; s++) {
    var stmt = statements[s].trim();
    if (!stmt) continue;
    var isAppLaunch = false;
    for (var j = 0; j < EXTERNAL_APPS.length; j++) {
      var app = EXTERNAL_APPS[j];
      if (
        new RegExp("^start-process\\s+[\"']?([^\"']*\\\\)?" + app + "(\\.exe)?[\"']?", "i").test(
          stmt,
        )
      ) {
        isAppLaunch = true;
        break;
      }
      if (new RegExp("^&\\s+[\"']([^\"']*\\\\)?" + app + "(\\.exe)?[\"']", "i").test(stmt)) {
        isAppLaunch = true;
        break;
      }
      if (
        new RegExp(
          '^start\\s+(""|["\'][^"\']*["\']\\s+)?["\']?([^"\']*\\\\)?' + app + "(\\.exe)?[\"']?",
          "i",
        ).test(stmt)
      ) {
        isAppLaunch = true;
        break;
      }
      if (new RegExp("^[\"']?[a-z]:\\\\[^\"']*\\\\" + app + "\\.exe[\"']?", "i").test(stmt)) {
        isAppLaunch = true;
        break;
      }
      if (
        new RegExp("^(invoke-item|ii)\\s+[\"']?([^\"']*\\\\)?" + app + "(\\.exe)?[\"']?", "i").test(
          stmt,
        )
      ) {
        isAppLaunch = true;
        break;
      }
    }
    // NOTE: shell:appsfolder URIs are intentionally NOT auto-approved here.
    // Even if a statement is `explorer shell:appsfolder\X!A`, the launched
    // process runs OUTSIDE the AppContainer (Shell activation does not
    // inherit the AC token). Treat it like any other non-whitelisted app:
    // fall through to checkApproval() / requestApproval() so the user sees
    // the full command (including any chained `; notepad.exe` payload) and
    // must explicitly approve.
    if (isAppLaunch) {
      foundApp = true;
    } else {
      process.stderr.write(
        "[sandbox] external app check: rejected non-whitelisted statement: " +
          stmt.substring(0, 80) +
          "\n",
      );
      return false;
    }
  }
  return foundApp;
}

// File manipulation cmdlets/commands whose path arguments are files being
// operated on, NOT executables being launched.
var FILE_MGMT_CMDS_RE =
  /\b(?:Move-Item|Copy-Item|Rename-Item|Remove-Item|New-Item|Get-Item|Get-ChildItem|Get-Content|Set-Content|Add-Content|Out-File|Test-Path|Resolve-Path|Get-FileHash|Compress-Archive|Expand-Archive|del|erase|move|copy|xcopy|robocopy|ren|rename)\b/i;

function extractLaunchedApp(cmd, args) {
  var payload = "";
  var argArr = Array.isArray(args) ? args : [];
  for (var i = 0; i < argArr.length; i++) {
    var a = String(argArr[i]);
    if (/^[-\/][a-z]/i.test(a)) continue;
    payload = argArr.slice(i).join(" ");
    break;
  }
  if (!payload) return null;
  var m, name;
  m = payload.match(/(?:explorer|start)\s+.*shell:appsfolder\\([^!\\]+)![^\s"']*/i);
  if (m) return "store:" + m[1].toLowerCase();
  m = payload.match(
    /\b(?:start-process|invoke-item|ii)\s+["']?(?:[^"']*\\)?([a-z0-9_-]+)(?:\.exe)?["']?/i,
  );
  if (m) {
    name = m[1].toLowerCase();
    if (!S.SHELL_NAMES_SET.has(name)) return name;
  }
  m = payload.match(/&\s+["'](?:[^"']*\\)?([a-z0-9_-]+)(?:\.exe)?["']/i);
  if (m) {
    name = m[1].toLowerCase();
    if (!S.SHELL_NAMES_SET.has(name)) return name;
  }
  // Only match "start" as cmd.exe command when it appears at command position
  // (start of payload or after a command separator), NOT inside quoted strings
  // or JSON bodies where natural language like "start your reply" can appear.
  m = payload.match(
    /(?:^|[;|&\n])\s*start\s+(?:""\s+)?["']?(?:[^"']*\\)?([a-z0-9_-]+)(?:\.exe)?["']?/i,
  );
  if (m) {
    name = m[1].toLowerCase();
    if (!S.SHELL_NAMES_SET.has(name)) return name;
  }
  m = payload.match(/[a-z]:\\[^"']*\\([a-z0-9_-]+)\.exe/i);
  if (m) {
    name = m[1].toLowerCase();
    if (!S.SHELL_NAMES_SET.has(name)) {
      // Don't treat .exe paths as app launches when they appear as arguments
      // to file manipulation cmdlets (Move-Item, Copy-Item, del, etc.).
      var textBeforeExe = payload.substring(0, m.index);
      if (!FILE_MGMT_CMDS_RE.test(textBeforeExe)) {
        return name;
      }
    }
  }
  return null;
}

function checkApproval(cmd, args, getExternalApps) {
  var argArr = Array.isArray(args) ? args : [];
  // Auto-bypass for apps already in the user-configured whitelist.
  // The whitelist is curated by the user in Settings and protected by
  // a shell-name blocklist + HMAC-signed file, so silent bypass is acceptable.
  if (hasExternalApp(cmd, argArr, getExternalApps)) return "bypass";
  // Non-whitelisted apps still require explicit user approval.
  var appName = extractLaunchedApp(cmd, argArr);
  if (!appName) return "none";
  var cmdPreview = String(cmd) + " " + argArr.join(" ");
  var isStoreApp = appName.indexOf("store:") === 0;
  var decision = perm.requestApproval(appName, cmdPreview);
  // Store apps run OUTSIDE the AppContainer (Shell activation bypasses the
  // AC token), so a remembered "allow-always" decision could be replayed by
  // a prompt-injected command that appends extra statements after the
  // shell:appsfolder URI (e.g. `explorer shell:appsfolder\X!A; notepad.exe`).
  // Demote allow-always to allow-once so each Store-app launch shows the
  // full cmdPreview and the user can spot chained payloads.
  if (isStoreApp && decision === "allow-always") {
    decision = "allow-once";
  }
  if (decision === "allow-always" || decision === "allow-once") {
    process.stderr.write("[sandbox] User approved: " + appName + " (" + decision + ")\n");
    return "bypass";
  }
  process.stderr.write("[sandbox] User denied: " + appName + "\n");
  return "sandbox";
}

// ── Access-denied detection ─────────────────────────────────────────────

var ACCESS_DENIED_PATTERNS = [
  /access.*is denied/i,
  /access to the path.*is denied/i,
  /unauthorizedaccessexception/i,
  /permission denied/i,
  /EACCES/,
];
var PATH_EXTRACT_PATTERNS = [
  /access to the path\s+['"](.*?)['"]\s+is denied/i,
  /access is denied:\s+['\u2018\u2019]([a-zA-Z]:\\[^'\u2018\u2019]*)['\u2018\u2019]/i,
  /cannot access the file ['"](.*?)['"]/i,
  /EACCES.*?['"](.*?)['"]/,
  /(?:PermissionDenied|ObjectNotFound|ItemExistsUnauthorizedAccessError)[^(]*\(([a-zA-Z]:\\[^:)]*?):[A-Z][a-zA-Z]*\)/i,
  /(?:Out-File|Set-Content|New-Item|Remove-Item).*?['"](.*?)['"]/i,
  /(?:Get-ChildItem|dir|ls|gci)\s+['"](.*?)['"]/i,
  /(?:Get-ChildItem|dir|ls|gci)\s+([a-zA-Z]:\\[^\s'"*?<>|]*?)(?:\s+-|$)/i,
];

var SHELL_PATH_RE = _pathExtraction.SHELL_PATH_RE;
var SYSTEM_DIR_RE = _pathExtraction.SYSTEM_DIR_RE;
var GENERIC_PATH_RE = /([a-zA-Z]:\\[^\s'"*?<>|:()]+)/g;

function detectAccessDenied(stderr, stdout) {
  var output = (stderr || "") + "\n" + (stdout || "");
  var cleanOutput = output.replace(/\[(?:AppContainerLauncher|loopback)\][^\n]*/g, "");
  if (
    /(?:Retrieving the COM class factory|DCOM|ComObject|0x80070005.*COM|COM\s+object)/i.test(output)
  )
    return null;
  var hasAccessError = false;
  for (var i = 0; i < ACCESS_DENIED_PATTERNS.length; i++) {
    if (ACCESS_DENIED_PATTERNS[i].test(output)) {
      hasAccessError = true;
      break;
    }
  }
  if (!hasAccessError) return null;
  for (var i = 0; i < ACCESS_DENIED_PATTERNS.length; i++) {
    if (ACCESS_DENIED_PATTERNS[i].test(output)) {
      for (var j = 0; j < PATH_EXTRACT_PATTERNS.length; j++) {
        var m = cleanOutput.match(PATH_EXTRACT_PATTERNS[j]);
        if (m && m[1]) {
          var p = m[1].trim();
          if (/^[a-zA-Z]:\\/.test(p) && !SYSTEM_DIR_RE.test(p)) return p;
        }
      }
      var gm;
      while ((gm = GENERIC_PATH_RE.exec(cleanOutput)) !== null) {
        var gp = gm[1].trim();
        if (/^[a-zA-Z]:\\/.test(gp) && !SHELL_PATH_RE.test(gp) && !SYSTEM_DIR_RE.test(gp)) {
          GENERIC_PATH_RE.lastIndex = 0;
          return gp;
        }
      }
      GENERIC_PATH_RE.lastIndex = 0;
      return "unknown";
    }
  }
  return null;
}

// ── Pre-blocking ────────────────────────────────────────────────────────

/**
 * Check if any path in the write/read arrays is sensitive.
 * Used by preBlockShellCommand and inline path checks in execFile/exec/execSync.
 */
function hasSensitivePaths(writePaths, readPaths) {
  for (var i = 0; i < writePaths.length; i++) {
    if (sensitive.isSensitivePath(writePaths[i])) return writePaths[i];
  }
  for (var j = 0; j < readPaths.length; j++) {
    if (sensitive.isSensitivePath(readPaths[j])) return readPaths[j];
  }
  return null;
}

var SENSITIVE_READ_OPERATION_RE =
  /\b(?:Get-Content|gc|Select-String|sls|Import-Csv|Get-FileHash|type|more|find|findstr|sort|cat|head|tail|Copy-Item|Move-Item|Rename-Item|New-Item|copy|move|rename|ren|mklink|cp|mv)\b|(?:(?:fs|require\s*\(\s*["']fs["']\s*\))(?:\.promises)?\.(?:readFile|readFileSync|createReadStream|open)|\.(?:readFile|readFileSync|createReadStream|open|read_text|read_bytes)\s*\(|\bopen\s*\(|System\.IO\.(?:File|Directory).*::(?:Read|Get|Exists|Open))/i;

function extractSensitiveRelativeReadPaths(command, cwd, scanAllCandidates) {
  var results = [];
  var seen = {};
  var baseDir = cwd ? sensitive.normalizeFilePath(cwd) : process.cwd();
  var statements = String(command || "").split(/\s*(?:&&|\|\||[;&\r\n])\s*/);

  function addCandidate(token) {
    token = String(token || "").replace(/[)\]}]+$/g, "");
    if (!token) return;
    var normalized = /^file:/i.test(token) ? sensitive.normalizeFilePath(token) : token;
    if (!normalized) return;
    var resolved = pathMod.isAbsolute(normalized)
      ? pathMod.resolve(normalized)
      : pathMod.resolve(baseDir, normalized);
    if (!sensitive.isSensitiveFile(normalized) && !sensitive.isSensitivePath(resolved)) return;
    var key = resolved.toLowerCase();
    if (!seen[key]) {
      seen[key] = true;
      results.push(resolved);
    }
  }

  for (var i = 0; i < statements.length; i++) {
    var statement = statements[i];
    if (!scanAllCandidates && !SENSITIVE_READ_OPERATION_RE.test(statement)) continue;
    var quotedPatterns = [/"([^"]+)"/g, /'([^']+)'/g];
    for (var q = 0; q < quotedPatterns.length; q++) {
      var quotedMatch;
      while ((quotedMatch = quotedPatterns[q].exec(statement)) !== null) {
        addCandidate(quotedMatch[1]);
      }
    }
    var tokenPattern = /"([^"]+)"|'([^']+)'|([^\s|(),]+)/g;
    var match;
    while ((match = tokenPattern.exec(statement)) !== null) {
      addCandidate(match[1] || match[2] || match[3] || "");
    }
  }
  return results;
}

function addSensitiveRelativeReadPaths(command, readPaths, cwd, scanAllCandidates) {
  if (S.state.privacyLevel === "basic") return readPaths;
  var combined = readPaths.slice();
  var seen = {};
  for (var i = 0; i < combined.length; i++) seen[combined[i].toLowerCase()] = true;
  var relative = extractSensitiveRelativeReadPaths(command, cwd, scanAllCandidates);
  for (var j = 0; j < relative.length; j++) {
    var key = relative[j].toLowerCase();
    if (!seen[key]) {
      seen[key] = true;
      combined.push(relative[j]);
    }
  }
  return combined;
}

function isScriptInterpreterCommand(cmd, payload) {
  var candidates = [String(cmd || "")];
  var match = String(payload || "").match(/^\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  if (match) candidates.push(match[1] || match[2] || match[3] || "");
  for (var i = 0; i < candidates.length; i++) {
    var name = pathMod
      .basename(candidates[i])
      .toLowerCase()
      .replace(/\.exe$/i, "");
    if (name === "node" || name === "python" || name === "python3" || name === "py") return true;
  }
  return false;
}

function preBlockSensitiveCommand(cmd, args, cwd, commandIsPayload) {
  var cmdPreview = buildCmdPreview(cmd, args).trim();
  var payload = commandIsPayload ? cmdPreview : extractShellPayload(cmd, args);
  var writePaths = extractWritePaths(payload);
  var readPaths = addSensitiveRelativeReadPaths(
    payload,
    extractReadPaths(payload),
    cwd,
    isScriptInterpreterCommand(cmd, payload),
  );
  var sensitiveHit = hasSensitivePaths(writePaths, readPaths);
  if (sensitiveHit) return { reason: "sensitive", path: sensitiveHit };

  S.state._currentCmdPreview = cmdPreview;
  for (var i = 0; i < readPaths.length; i++) {
    if (perm.shouldBlockSensitiveRead(readPaths[i])) {
      return { reason: "permission", path: readPaths[i] };
    }
  }
  return false;
}

function blockedError(denied) {
  return denied.reason === "sensitive"
    ? sensitive.throwSensitiveDenied(denied.path)
    : S.throwReadBlocked("sandbox permission denied");
}

function blockedMessage(denied) {
  return denied.reason === "sensitive"
    ? blockedError(denied).message
    : "EACCES: sandbox permission denied";
}

function createBlockedChild(denied, callback) {
  var EventEmitter = require("events");
  var streams = require("stream");
  var child = new EventEmitter();
  var message = blockedMessage(denied);
  child.stdin = new streams.Writable({
    write: function (chunk, encoding, callback) {
      callback();
    },
  });
  child.stdout = new streams.Readable({
    read: function () {
      this.push(null);
    },
  });
  child.stderr = new streams.Readable({
    read: function () {
      this.push(message + "\n");
      this.push(null);
      message = null;
    },
  });
  child.pid = 0;
  child.killed = true;
  child.connected = false;
  child.kill = function () {
    return true;
  };
  child.ref = function () {
    return child;
  };
  child.unref = function () {
    return child;
  };
  process.nextTick(function () {
    if (typeof callback === "function") callback(blockedError(denied), "", "");
    child.emit("exit", 1, null);
    child.emit("close", 1, null);
  });
  return child;
}

function createBlockedSyncResult(denied) {
  var message = Buffer.from(blockedMessage(denied));
  return {
    pid: 0,
    status: 1,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: message,
    output: [null, Buffer.alloc(0), message],
    error: null,
  };
}

// NOTE: Pre-blocking is a UX convenience layer, not a security boundary.
// Commands that pass pre-blocking still run inside AppContainer (OS ACLs).
// A crafted command may evade regex extraction — that's acceptable because
// AppContainer will still enforce access control at the kernel level.
function preBlockShellCommand(cmd, args, cwd) {
  var cmdPreview = buildCmdPreview(cmd, args);
  S.state._currentCmdPreview = cmdPreview;
  var payload = extractShellPayload(cmd, args);
  var writePaths = extractWritePaths(payload);
  var readPaths = addSensitiveRelativeReadPaths(payload, extractReadPaths(payload), cwd);
  process.stderr.write(
    "[sandbox] Pre-block: cmd=" +
      cmdPreview.substring(0, 120) +
      " writePaths=[" +
      writePaths.join(",") +
      "] readPaths=[" +
      readPaths.join(",") +
      "]\n",
  );
  var anyDenied = false;
  // Hard-deny sensitive paths before normal permission checks
  var sensitiveHit = hasSensitivePaths(writePaths, readPaths);
  if (sensitiveHit) {
    process.stderr.write("[sandbox] Pre-block: SENSITIVE path denied: " + sensitiveHit + "\n");
    return { reason: "sensitive", path: sensitiveHit };
  }
  for (var i = 0; i < writePaths.length; i++) {
    if (perm.shouldBlockWrite(writePaths[i])) {
      process.stderr.write("[sandbox] Pre-block: write denied for " + writePaths[i] + "\n");
      anyDenied = true;
    } else {
      process.stderr.write("[sandbox] Pre-block: write approved for " + writePaths[i] + "\n");
    }
  }
  var writePathsLower = {};
  for (var j = 0; j < writePaths.length; j++) writePathsLower[writePaths[j].toLowerCase()] = true;
  for (var k = 0; k < readPaths.length; k++) {
    var rp = readPaths[k];
    if (writePathsLower[rp.toLowerCase()]) continue;
    if (perm.shouldBlockRead(rp, true)) {
      process.stderr.write("[sandbox] Pre-block: read denied for " + rp + "\n");
      anyDenied = true;
    } else {
      process.stderr.write("[sandbox] Pre-block: read approved for " + rp + "\n");
    }
  }
  if (writePaths.length > 0 || readPaths.length > 0) {
    process.stderr.write(
      "[sandbox] Pre-block: checked " +
        writePaths.length +
        " write + " +
        readPaths.length +
        " read paths\n",
    );
  }
  return anyDenied;
}

// ── Async fallback: infer denied path, check safety, send permission ────

/**
 * Common logic for handling access-denied after a command runs.
 * Used by spawn, spawnSync, execFile, exec, and execSync callbacks.
 * @param {string} deniedPath - path from detectAccessDenied
 * @param {string} innerCmd - the inner command text
 * @param {string} label - log label (e.g. 'spawn', 'exec')
 * @returns {boolean} true if async request was sent
 */
function handleAsyncAccessDenied(deniedPath, innerCmd, label) {
  if (!deniedPath || typeof process.send !== "function") return false;

  // Never send permission requests for sensitive paths — access is permanently denied.
  if (deniedPath !== "unknown" && sensitive.isSensitivePath(deniedPath)) {
    process.stderr.write(
      "[sandbox] Access denied for SENSITIVE path (" +
        label +
        "): " +
        deniedPath +
        " — this is a protected directory and cannot be accessed.\n",
    );
    return false;
  }

  // Strip shell executable prefix (e.g. "C:\Windows\System32\cmd.exe /c ...")
  // before extracting paths, so shell/system paths don't get mistaken for
  // user-requested paths.
  var strippedCmd = extractShellPayloadFromString(innerCmd);

  // Prefer command-text parsing over stderr extraction, BUT only if
  // the inferred path is not in a safe/authorized area.
  var rawInferred = extractWritePaths(strippedCmd).concat(extractReadPaths(strippedCmd));
  // Filter out system/shell executable paths that may leak through generic fallback patterns
  var inferred = filterSystemPaths(rawInferred);
  if (inferred.length > 0) {
    var inferredResolved = pathMod.resolve(inferred[0]).toLowerCase();
    var inferredIsSafe = S.isSafePrefixPath(inferredResolved);
    if (!inferredIsSafe) {
      for (var ri = 0; ri < S.state._rwDirs.length; ri++) {
        if (
          inferredResolved === S.state._rwDirs[ri].slice(0, -1) ||
          inferredResolved.indexOf(S.state._rwDirs[ri]) === 0
        ) {
          inferredIsSafe = true;
          break;
        }
      }
    }
    if (!inferredIsSafe) {
      for (var oi = 0; oi < S.state._roDirs.length; oi++) {
        if (
          inferredResolved === S.state._roDirs[oi].slice(0, -1) ||
          inferredResolved.indexOf(S.state._roDirs[oi]) === 0
        ) {
          inferredIsSafe = true;
          break;
        }
      }
    }
    if (!inferredIsSafe) {
      deniedPath = inferred[0];
      // Re-check after path resolution — inferred path may be sensitive
      if (sensitive.isSensitivePath(deniedPath)) {
        process.stderr.write(
          "[sandbox] Access denied for SENSITIVE path (" +
            label +
            "): " +
            deniedPath +
            " — this is a protected directory and cannot be accessed.\n",
        );
        return false;
      }
    } else {
      process.stderr.write(
        "[sandbox] Keeping stderr path (inferred path is safe): " + inferred[0] + "\n",
      );
      if (deniedPath === "unknown") {
        process.stderr.write(
          "[sandbox] Skipping async fallback (" +
            label +
            ") — denied path unknown and inferred path already authorized\n",
        );
        return false;
      }
    }
  }

  if (deniedPath === "unknown") {
    // Can't determine path — skip rather than prompting with an unhelpful "." directory
    process.stderr.write(
      "[sandbox] Skipping async fallback (" +
        label +
        ") — denied path unknown, no actionable directory\n",
    );
    return false;
  }

  var resolvedCheck = pathMod.resolve(deniedPath).toLowerCase();

  // Skip if inside a prefix-safe dir
  if (S.isSafePrefixPath(resolvedCheck)) {
    process.stderr.write(
      "[sandbox] Async fallback skipped (" + label + ") — safe prefix path: " + deniedPath + "\n",
    );
    return false;
  }

  // Check authorization level: RW vs RO
  var authLevel = classifyAuthLevel(resolvedCheck, S.state._rwDirs, S.state._roDirs);
  var inRW = authLevel === "rw";
  var inRO = authLevel === "ro";
  if (inRW) {
    process.stderr.write(
      "[sandbox] RW-authorized path got Access Denied (" + label + "): " + deniedPath + "\n",
    );
    // Directory has RW authorization but AppContainer still got Access Denied.
    // ACL propagation may still be in progress — wait and notify Electron for repair.
    var MAX_ACL_RETRIES = 3;
    var ACL_RETRY_DELAY_MS = 1000;

    for (var retryIdx = 0; retryIdx < MAX_ACL_RETRIES; retryIdx++) {
      process.stderr.write(
        "[sandbox] ACL propagation retry " +
          (retryIdx + 1) +
          "/" +
          MAX_ACL_RETRIES +
          " (waiting " +
          ACL_RETRY_DELAY_MS +
          "ms) for: " +
          deniedPath +
          "\n",
      );

      if (retryIdx === 0 && typeof process.send === "function") {
        process.send({
          type: "sandbox-acl-ineffective",
          deniedPath: deniedPath,
          dirPath: resolvedCheck,
          command: innerCmd ? innerCmd.substring(0, 500) : null,
        });
      }

      var buf = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(buf), 0, 0, ACL_RETRY_DELAY_MS);
    }

    process.stderr.write(
      "[sandbox] ACL propagation retries exhausted (" +
        MAX_ACL_RETRIES +
        "x " +
        ACL_RETRY_DELAY_MS +
        "ms) for: " +
        deniedPath +
        "\n",
    );
    return false;
  }
  if (S.state.privacyLevel === "strict") {
    process.stderr.write(
      "[sandbox] Async permission fallback disabled by Strict privacy mode (" +
        label +
        "): " +
        deniedPath +
        "\n",
    );
    return false;
  }
  if (inRO) {
    // Directory has RO authorization but command needs write access.
    // This is NOT an ACL propagation issue — the user needs to upgrade RO → RW.
    // Send an async permission request for RW access.
    process.stderr.write(
      "[sandbox] RO-authorized path needs RW upgrade (" + label + "): " + deniedPath + "\n",
    );
    var roDirPath;
    try {
      roDirPath = S.findRestrictedDir(resolvedCheck);
      if (roDirPath.length > 3 && roDirPath[roDirPath.length - 1] === pathMod.sep)
        roDirPath = roDirPath.slice(0, -1);
    } catch (e) {
      roDirPath = pathMod.dirname(deniedPath);
    }
    perm.sendAsyncPermissionRequest(
      "sandbox-shell-permission-request-async",
      deniedPath,
      roDirPath,
      innerCmd,
      "rw",
    );
    return true;
  }

  // Skip if already granted by pre-block cache
  var dirCheck = S.findRestrictedDir(resolvedCheck);
  var now = Date.now();
  var permW = perm._filePermWriteAllowed();
  var permR = perm._filePermReadAllowed();
  if ((permW[dirCheck] && permW[dirCheck] > now) || (permR[dirCheck] && permR[dirCheck] > now)) {
    process.stderr.write(
      "[sandbox] Async fallback skipped (" +
        label +
        ") — already granted by pre-block: " +
        deniedPath +
        "\n",
    );
    return false;
  }

  // Resolve directory path for the permission request
  var dirPath;
  try {
    dirPath = S.findRestrictedDir(resolvedCheck);
    if (dirPath.length > 3 && dirPath[dirPath.length - 1] === pathMod.sep)
      dirPath = dirPath.slice(0, -1);
  } catch (e) {
    dirPath = pathMod.dirname(deniedPath);
  }
  // Never grant a drive root
  if (/^[a-zA-Z]:\\?$/.test(dirPath)) dirPath = pathMod.resolve(deniedPath);

  // Final safety check on dirPath
  var dirPathResolved = pathMod.resolve(dirPath).toLowerCase();
  if (S.isSafePrefixPath(dirPathResolved)) {
    process.stderr.write(
      "[sandbox] Async fallback skipped (" +
        label +
        ") — dirPath in safe prefix: " +
        dirPath +
        "\n",
    );
    return false;
  }

  perm.sendAsyncPermissionRequest(
    "sandbox-shell-permission-request-async",
    deniedPath,
    dirPath,
    innerCmd,
    perm.inferAccessNeeded(innerCmd),
  );
  return true;
}

// ── Declare-access command ──────────────────────────────────────────────
//
// Two modes:
//
// 1. Standalone: the entire command IS a declare-access invocation.
//      openclaw-declare-access rw:C:\a;ro:C:\b
//    → permissions requested, synthetic result returned, nothing executed.
//
// 2. Inline tag: declare-access embedded anywhere in a command using bracket tags.
//      [declare-access]rw:C:\a;ro:C:\b[/declare-access]
//      Move-Item C:\a\file.txt C:\b\
//    → permissions requested, tags stripped, remaining command executed.
//    The tags can appear on a comment line or anywhere in the command string.
//
// This allows the model to pre-declare permissions without an extra
// round-trip when used inline.

var DECLARE_ACCESS_PREFIX = "openclaw-declare-access ";

// Bracket-tag regex: [declare-access]...[/declare-access]
// Captures the payload between the tags.  Case-insensitive, non-greedy.
var DECLARE_TAG_RE = /\[declare-access\](.*?)\[\/declare-access\]/i;

/**
 * Parse and execute a declare-access payload string.
 * Returns { grantedDirs: string[], deniedDirs: string[] }.
 */
function executeDeclarePayload(payload) {
  var entries = payload
    .split(";")
    .map(function (d) {
      return d.trim();
    })
    .filter(Boolean);
  var granted = [];
  var denied = [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var access = "rw";
    var dirRaw = entry;
    if (/^rw:/i.test(entry)) {
      access = "rw";
      dirRaw = entry.slice(3);
    } else if (/^ro:/i.test(entry)) {
      access = "ro";
      dirRaw = entry.slice(3);
    }
    dirRaw = _pathExtraction.expandEnvVarsInCmd(dirRaw.trim());
    if (!dirRaw) continue;

    var probe = pathMod.resolve(dirRaw);
    var probeLower = probe.toLowerCase();
    // Always deny access to sensitive paths (e.g. .ssh, .gnupg)
    if (sensitive.isSensitivePath(probe)) {
      denied.push(access + ":" + dirRaw);
      continue;
    }
    // Auto-grant safe paths, but NOT if they could contain sensitive dirs
    // (e.g. home directory contains .ssh — must go through permission dialog
    // so that grantDirAsync triggers ACL shield)
    if (S.isSafePath(probeLower) && !sensitive.parentOfSensitive(probe)) {
      granted.push(access + ":" + dirRaw);
      continue;
    }
    var dirPath = probe;
    if (dirPath[dirPath.length - 1] !== pathMod.sep) dirPath += pathMod.sep;
    S.state._currentCmdPreview = "declare-access " + access + ":" + dirRaw;
    var blocked =
      access === "ro" ? perm.shouldBlockRead(dirPath, true) : perm.shouldBlockWrite(dirPath);
    S.state._currentCmdPreview = null;
    if (blocked) {
      denied.push(access + ":" + dirRaw);
    } else {
      granted.push(access + ":" + dirRaw);
    }
  }
  process.stderr.write(
    "[sandbox] declare-access: granted=[" +
      granted.join(", ") +
      "] denied=[" +
      denied.join(", ") +
      "]\n",
  );
  return { grantedDirs: granted, deniedDirs: denied };
}

/**
 * Try to handle a standalone declare-access command.
 * Matches: [declare-access]rw:C:\a;ro:C:\b[/declare-access]
 * (optionally with a # or other comment prefix before the opening tag)
 * Returns { handled: true, grantedDirs, deniedDirs } or null.
 */
function tryDeclareAccess(cmdStr) {
  if (!S.state.sandboxActive) return null;
  var trimmed = cmdStr.replace(/^\s+/, "");
  // Legacy prefix: openclaw-declare-access rw:...
  if (trimmed.indexOf(DECLARE_ACCESS_PREFIX) === 0) {
    var payload = trimmed.slice(DECLARE_ACCESS_PREFIX.length).trim();
    if (!payload) return null;
    var result = executeDeclarePayload(payload);
    result.handled = true;
    return result;
  }
  // Bracket tag: [declare-access]...[/declare-access]
  // Strip optional comment prefix (# // :: REM) before checking
  var stripped = trimmed.replace(/^(?:#|\/\/|::|REM)\s*/i, "");
  var m = DECLARE_TAG_RE.exec(stripped);
  if (!m) return null;
  // Only treat as standalone if the tag covers the entire command (no trailing command)
  var afterTag = stripped.substring(m.index + m[0].length).trim();
  if (afterTag) return null; // has trailing content → inline, not standalone
  var tagPayload = m[1].trim();
  if (!tagPayload) return null;
  var tagResult = executeDeclarePayload(tagPayload);
  tagResult.handled = true;
  return tagResult;
}

/**
 * Try to extract and process inline [declare-access]...[/declare-access]
 * tags from a command string.  Handles ALL tags (LLMs sometimes emit
 * duplicates), deduplicates entries, and strips every tag from the command.
 * Returns the command with all tags stripped, or null if none found.
 * Also strips empty comment lines left behind (e.g. "# \n" → "").
 */
function tryInlineDeclareAccess(cmdStr) {
  if (!S.state.sandboxActive) return null;
  var m = DECLARE_TAG_RE.exec(cmdStr);
  if (!m) return null;
  // Collect payloads from ALL tags using a global regex
  var globalRe = /\[declare-access\](.*?)\[\/declare-access\]/gi;
  var gm;
  var pathAccess = {}; // resolved-lower → { access, expanded }
  while ((gm = globalRe.exec(cmdStr)) !== null) {
    var tagPayload = gm[1].trim();
    if (!tagPayload) continue;
    var entries = tagPayload
      .split(";")
      .map(function (d) {
        return d.trim();
      })
      .filter(Boolean);
    for (var i = 0; i < entries.length; i++) {
      // Normalize: expand env vars and resolve to deduplicate ~\Desktop vs C:\Users\...\Desktop
      var entry = entries[i];
      var access = "rw";
      var dirRaw = entry;
      if (/^rw:/i.test(entry)) {
        access = "rw";
        dirRaw = entry.slice(3);
      } else if (/^ro:/i.test(entry)) {
        access = "ro";
        dirRaw = entry.slice(3);
      }
      var expanded = _pathExtraction.expandEnvVarsInCmd(dirRaw.trim());
      if (!expanded) continue;
      var resolved = pathMod.resolve(expanded).toLowerCase();
      var existing = pathAccess[resolved];
      if (!existing) {
        // First time seeing this path
        pathAccess[resolved] = { access: access, expanded: expanded };
      } else if (access === "rw" && existing.access === "ro") {
        // rw supersedes ro for the same path — upgrade
        pathAccess[resolved] = { access: "rw", expanded: expanded };
      }
      // else: duplicate with same or lower access — skip
    }
  }
  var allEntries = [];
  var keys = Object.keys(pathAccess);
  for (var k = 0; k < keys.length; k++) {
    var e = pathAccess[keys[k]];
    allEntries.push(e.access + ":" + e.expanded);
  }
  if (allEntries.length === 0) return null;
  // Process the merged, deduplicated payload
  var result = executeDeclarePayload(allEntries.join(";"));
  // If any denied path is a sensitive directory, block execution entirely.
  if (result.deniedDirs && result.deniedDirs.length > 0) {
    for (var di = 0; di < result.deniedDirs.length; di++) {
      var deniedEntry = result.deniedDirs[di];
      var deniedDir = deniedEntry.replace(/^(?:rw|ro):/i, "");
      if (sensitive.isSensitivePath(deniedDir)) {
        process.stderr.write(
          "[sandbox] Inline declare-access blocked: sensitive path denied: " + deniedDir + "\n",
        );
        return { blocked: true, sensitivePath: deniedDir };
      }
    }
  }
  // Strip ALL tags (and any surrounding comment prefix on the same line)
  var stripped = cmdStr.replace(
    /(?:#|\/\/|::|REM)?\s*\[declare-access\].*?\[\/declare-access\]/gi,
    "",
  );
  // Clean up empty lines left behind
  var rest = stripped.replace(/^[ \t]*[\r\n]+/gm, "").trim();
  return rest || null;
}

/** Build the human-readable output string from a declare-access result. */
function formatDeclareResult(declareResult) {
  var granted = declareResult.grantedDirs || [];
  var denied = declareResult.deniedDirs || [];
  var output = "Access declared. Granted: [" + granted.join(", ") + "]";
  if (denied.length > 0) output += " Denied: [" + denied.join(", ") + "]";
  return output;
}

/**
 * Rebuild shell args array with a new payload string.
 * Finds the -Command/-c flag in the args and replaces everything after it.
 */
function rebuildShellArgs(shellExe, origArgs, newPayload) {
  var bn = pathMod
    .basename(String(shellExe))
    .toLowerCase()
    .replace(/\.exe$/i, "");
  var result = [];
  if (bn === "cmd") {
    for (var i = 0; i < origArgs.length; i++) {
      result.push(origArgs[i]);
      if (/^\/[ck]$/i.test(origArgs[i])) {
        result.push(newPayload);
        return result;
      }
    }
  } else if (bn === "powershell" || bn === "pwsh") {
    for (var i = 0; i < origArgs.length; i++) {
      result.push(origArgs[i]);
      if (/^-(?:Command|c|File)$/i.test(origArgs[i])) {
        result.push(newPayload);
        return result;
      }
    }
  }
  // Fallback: replace the last arg
  result = origArgs.slice(0, -1);
  result.push(newPayload);
  return result;
}

// ── Install hooks ───────────────────────────────────────────────────────

function install(cp, getExternalApps) {
  // Node's fork() uses an internal spawn reference, so it must be wrapped
  // separately to keep the preload and live privacy level in child processes.
  if (cp.fork) {
    var _fork = cp.fork;
    cp.fork = function (modulePath, args, opts) {
      if (!S.state.sandboxActive) return _fork.apply(this, arguments);
      var forkOpts = getChildOptions(args, opts);
      if (forkOpts) {
        forkOpts = withCurrentPrivacyEnv(forkOpts);
        if (Array.isArray(args) || args === null || args === undefined) {
          opts = forkOpts;
          arguments[2] = opts;
        } else {
          args = forkOpts;
          arguments[1] = args;
        }
      }
      return _fork.apply(this, arguments);
    };
  }

  // ── cp.spawn ──

  var _spawn = cp.spawn;
  cp.spawn = function (cmd, args, opts) {
    if (S.state.sandboxActive) {
      var effectiveSpawnOpts = getChildOptions(args, opts);
      if (effectiveSpawnOpts) {
        effectiveSpawnOpts = withCurrentPrivacyEnv(effectiveSpawnOpts);
        if (Array.isArray(args) || args === null || args === undefined) {
          opts = effectiveSpawnOpts;
          arguments[2] = opts;
        } else {
          args = effectiveSpawnOpts;
          arguments[1] = args;
        }
      }
    }
    var bn = pathMod.basename(String(cmd));
    var isShell = isShellExe(cmd);
    var spawnOpts = getChildOptions(args, opts);
    var hasShellOpt = spawnOpts && spawnOpts.shell;
    process.stderr.write(
      "[sandbox-diag] spawn: cmd=" +
        String(cmd).substring(0, 80) +
        " isShell=" +
        isShell +
        " active=" +
        S.state.sandboxActive +
        " shell=" +
        !!hasShellOpt +
        "\n",
    );
    if (S.state.sandboxActive) {
      var _sensitiveDenied = preBlockSensitiveCommand(
        cmd,
        Array.isArray(args) ? args : [],
        spawnOpts && spawnOpts.cwd,
        !!hasShellOpt,
      );
      if (_sensitiveDenied) {
        process.stderr.write(
          "[sandbox] spawn: " +
            bn +
            " -> BLOCKED (" +
            (_sensitiveDenied.reason || "permission") +
            ")\n",
        );
        return createBlockedChild(_sensitiveDenied);
      }
    }
    if (S.state.sandboxActive && isShell) {
      // Intercept declare-access magic command — return synthetic stream
      var _spawnPayload = extractShellPayload(cmd, Array.isArray(args) ? args : []);
      var _spawnDeclare = tryDeclareAccess(_spawnPayload);
      if (_spawnDeclare) {
        var EventEmitter = require("events");
        var { Readable, Writable } = require("stream");
        var _declOut = formatDeclareResult(_spawnDeclare);
        var fakeChild = new EventEmitter();
        fakeChild.stdin = new Writable({
          write: function (c, e, cb) {
            cb();
          },
        });
        fakeChild.stdout = new Readable({
          read: function () {
            this.push(_declOut);
            this.push(null);
          },
        });
        fakeChild.stderr = new Readable({
          read: function () {
            this.push(null);
          },
        });
        fakeChild.pid = 0;
        fakeChild.killed = false;
        process.nextTick(function () {
          fakeChild.emit("close", 0, null);
          fakeChild.emit("exit", 0, null);
        });
        return fakeChild;
      }
      // Intercept inline declare-access — strip tag from payload, rebuild args
      var _spawnStripped = tryInlineDeclareAccess(_spawnPayload);
      if (_spawnStripped) {
        // If blocked due to sensitive path, return fake child with error message
        if (_spawnStripped.blocked) {
          var _sensPath = _spawnStripped.sensitivePath || "";
          var _sensMsg =
            'DENIED: "' +
            _sensPath +
            '" is inside a protected sensitive directory (.ssh, .gnupg, .aws, .azure, etc.) and cannot be accessed by the sandbox. This restriction is permanent and cannot be overridden.';
          var EventEmitter = require("events");
          var { Readable, Writable } = require("stream");
          var _sensChild = new EventEmitter();
          _sensChild.stdin = new Writable({
            write: function (c, e, cb) {
              cb();
            },
          });
          _sensChild.stdout = new Readable({
            read: function () {
              this.push(null);
            },
          });
          var _sensMsgBuf = _sensMsg;
          _sensChild.stderr = new Readable({
            read: function () {
              this.push(_sensMsgBuf + "\n");
              this.push(null);
              _sensMsgBuf = null;
            },
          });
          _sensChild.pid = 0;
          _sensChild.killed = true;
          process.nextTick(function () {
            _sensChild.emit("close", 1, null);
            _sensChild.emit("exit", 1, null);
          });
          return _sensChild;
        }
        var _newArgs = rebuildShellArgs(cmd, Array.isArray(args) ? args : [], _spawnStripped);
        var _newOpts = stripShell(spawnOpts);
        var _laArgs = buildLA(cmd, ensureUtf8Args(cmd, _newArgs));
        process.stderr.write(
          "[sandbox] spawn: " + bn + " -> AC (inline declare-access stripped)\\n",
        );
        return _spawn.call(this, S.LAUNCHER, _laArgs, _newOpts);
      }
      var approval = checkApproval(cmd, Array.isArray(args) ? args : [], getExternalApps);
      if (approval === "bypass") {
        process.stderr.write("[sandbox] spawn: " + bn + " -> BYPASS (approved)\n");
        return _spawn.apply(this, arguments);
      }
      if (isSafeDiagnosticCommand(cmd, Array.isArray(args) ? args : [])) {
        process.stderr.write("[sandbox] spawn: " + bn + " -> BYPASS (safe diagnostic)\n");
        return _spawn.apply(this, arguments);
      }
      var la = buildLA(cmd, ensureUtf8Args(cmd, Array.isArray(args) ? args : []));
      var co = stripShell(spawnOpts);
      var _denied = preBlockShellCommand(cmd, Array.isArray(args) ? args : [], co && co.cwd);
      if (_denied) {
        var _blockMsg =
          _denied.reason === "sensitive"
            ? 'DENIED: "' +
              _denied.path +
              '" is inside a protected sensitive directory (.ssh, .gnupg, .aws, .azure, etc.) and cannot be accessed by the sandbox. This restriction is permanent and cannot be overridden.'
            : "sandbox permission denied";
        process.stderr.write(
          "[sandbox] spawn: " + bn + " -> BLOCKED (" + (_denied.reason || "permission") + ")\n",
        );
        var EventEmitter = require("events");
        var { Readable, Writable } = require("stream");
        var fakeChild = new EventEmitter();
        fakeChild.stdin = new Writable({
          write: function (c, e, cb) {
            cb();
          },
        });
        fakeChild.stdout = new Readable({
          read: function () {
            this.push(null);
          },
        });
        var _blockMsgBuf = _blockMsg;
        fakeChild.stderr = new Readable({
          read: function () {
            this.push(_blockMsgBuf + "\n");
            this.push(null);
            _blockMsgBuf = null;
          },
        });
        fakeChild.pid = 0;
        fakeChild.killed = true;
        process.nextTick(function () {
          fakeChild.emit("close", 1, null);
          fakeChild.emit("exit", 1, null);
        });
        return fakeChild;
      }
      notifyExecCommand(cmd, Array.isArray(args) ? args : []);
      process.stderr.write("[sandbox] spawn: " + bn + " -> AC\n");
      var child = _spawn.call(this, S.LAUNCHER, la, co);
      var _stderrChunks = [];
      var _stdoutChunks = [];
      if (child.stderr)
        child.stderr.on("data", function (d) {
          _stderrChunks.push(d);
        });
      if (child.stdout)
        child.stdout.on("data", function (d) {
          _stdoutChunks.push(d);
        });
      child.on("close", function (code) {
        if (code !== 0 && code !== null) {
          var stderrStr = Buffer.concat(_stderrChunks).toString("utf-8");
          var stdoutStr = Buffer.concat(_stdoutChunks).toString("utf-8");
          var deniedPath = detectAccessDenied(stderrStr, stdoutStr);
          if (deniedPath) {
            var cmdPreview = String(cmd) + " " + (Array.isArray(args) ? args.join(" ") : "");
            handleAsyncAccessDenied(deniedPath, cmdPreview, "spawn");
          }
        }
      });
      return child;
    }
    return _spawn.apply(this, arguments);
  };

  // ── cp.spawnSync ──

  var _spawnSync = cp.spawnSync;
  cp.spawnSync = function (cmd, args, opts) {
    if (S.state.sandboxActive) {
      var effectiveSyncOpts = getChildOptions(args, opts);
      if (effectiveSyncOpts) {
        effectiveSyncOpts = withCurrentPrivacyEnv(effectiveSyncOpts);
        if (Array.isArray(args) || args === null || args === undefined) {
          opts = effectiveSyncOpts;
          arguments[2] = opts;
        } else {
          args = effectiveSyncOpts;
          arguments[1] = args;
        }
      }
    }
    var bn = pathMod.basename(String(cmd));
    var isShell = isShellExe(cmd);
    var syncOpts = getChildOptions(args, opts);
    var hasShellOpt = syncOpts && syncOpts.shell;
    process.stderr.write(
      "[sandbox-diag] spawnSync: cmd=" +
        String(cmd).substring(0, 80) +
        " isShell=" +
        isShell +
        " active=" +
        S.state.sandboxActive +
        "\n",
    );
    if (S.state.sandboxActive) {
      var _syncSensitiveDenied = preBlockSensitiveCommand(
        cmd,
        Array.isArray(args) ? args : [],
        syncOpts && syncOpts.cwd,
        !!hasShellOpt,
      );
      if (_syncSensitiveDenied) {
        process.stderr.write(
          "[sandbox] spawnSync: " +
            bn +
            " -> BLOCKED (" +
            (_syncSensitiveDenied.reason || "permission") +
            ")\n",
        );
        return createBlockedSyncResult(_syncSensitiveDenied);
      }
    }
    if (S.state.sandboxActive && isShell) {
      // Intercept declare-access magic command — return synthetic result
      var _syncPayload = extractShellPayload(cmd, Array.isArray(args) ? args : []);
      var _syncDeclare = tryDeclareAccess(_syncPayload);
      if (_syncDeclare) {
        var _declOut = formatDeclareResult(_syncDeclare);
        return {
          pid: 0,
          status: 0,
          signal: null,
          stdout: Buffer.from(_declOut, "utf-8"),
          stderr: Buffer.alloc(0),
          output: [null, Buffer.from(_declOut, "utf-8"), Buffer.alloc(0)],
          error: null,
        };
      }
      var approval = checkApproval(cmd, Array.isArray(args) ? args : [], getExternalApps);
      if (approval === "bypass") {
        process.stderr.write("[sandbox] spawnSync: " + bn + " -> BYPASS (approved)\n");
        return _spawnSync.apply(this, arguments);
      }
      if (isSafeDiagnosticCommand(cmd, Array.isArray(args) ? args : [])) {
        process.stderr.write("[sandbox] spawnSync: " + bn + " -> BYPASS (safe diagnostic)\n");
        return _spawnSync.apply(this, arguments);
      }
      var la = buildLA(cmd, ensureUtf8Args(cmd, Array.isArray(args) ? args : []));
      var co = stripShell(syncOpts);
      var _denied = preBlockShellCommand(cmd, Array.isArray(args) ? args : [], co && co.cwd);
      if (_denied) {
        var _blockMsg =
          _denied.reason === "sensitive"
            ? 'DENIED: "' +
              _denied.path +
              '" is inside a protected sensitive directory (.ssh, .gnupg, .aws, .azure, etc.) and cannot be accessed by the sandbox. This restriction is permanent and cannot be overridden.'
            : "EACCES: sandbox permission denied";
        process.stderr.write(
          "[sandbox] spawnSync: " + bn + " -> BLOCKED (" + (_denied.reason || "permission") + ")\n",
        );
        return {
          pid: 0,
          status: 1,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(_blockMsg),
          output: [null, Buffer.alloc(0), Buffer.from(_blockMsg)],
          error: null,
        };
      }
      notifyExecCommand(cmd, Array.isArray(args) ? args : []);
      process.stderr.write("[sandbox] spawnSync: " + bn + " -> AC\n");
      var result = _spawnSync.call(this, S.LAUNCHER, la, co);
      if (result.status !== 0) {
        var stderrStr = result.stderr ? result.stderr.toString("utf-8") : "";
        var stdoutStr = result.stdout ? result.stdout.toString("utf-8") : "";
        var deniedPath = detectAccessDenied(stderrStr, stdoutStr);
        if (deniedPath) {
          var cmdPreview = String(cmd) + " " + (Array.isArray(args) ? args.join(" ") : "");
          handleAsyncAccessDenied(deniedPath, cmdPreview, "spawnSync");
        }
      }
      return result;
    }
    return _spawnSync.apply(this, arguments);
  };

  // ── cp.execFile ──

  var _execFile = cp.execFile;
  cp.execFile = function (file, args, opts, cb) {
    if (S.state.sandboxActive) {
      var effectiveEfOpts = getChildOptions(args, opts);
      if (effectiveEfOpts) {
        effectiveEfOpts = withCurrentPrivacyEnv(effectiveEfOpts);
        if (Array.isArray(args) || args === null || args === undefined) {
          opts = effectiveEfOpts;
          arguments[2] = opts;
        } else {
          args = effectiveEfOpts;
          arguments[1] = args;
        }
      }
    }
    if (S.state.sandboxActive) {
      var _earlyEfOpts = getChildOptions(args, opts);
      var _earlyEfDenied = preBlockSensitiveCommand(
        file,
        Array.isArray(args) ? args : [],
        _earlyEfOpts && _earlyEfOpts.cwd,
        !!(_earlyEfOpts && _earlyEfOpts.shell),
      );
      if (_earlyEfDenied) {
        var _earlyEfCb = typeof args === "function" ? args : typeof opts === "function" ? opts : cb;
        return createBlockedChild(_earlyEfDenied, _earlyEfCb);
      }
    }
    if (S.state.sandboxActive && isShellExe(file)) {
      // Intercept declare-access magic command
      var _efPayload = extractShellPayload(file, Array.isArray(args) ? args : []);
      var _efDeclare = tryDeclareAccess(_efPayload);
      if (_efDeclare) {
        var _efCb = typeof args === "function" ? args : typeof opts === "function" ? opts : cb;
        var _declOut = formatDeclareResult(_efDeclare);
        if (typeof _efCb === "function") {
          process.nextTick(function () {
            _efCb(null, _declOut, "");
          });
        }
        return;
      }
      // Intercept inline declare-access — strip tag, rebuild args, execute
      var _efStripped = tryInlineDeclareAccess(_efPayload);
      if (_efStripped) {
        var _efNewArgs = rebuildShellArgs(file, Array.isArray(args) ? args : [], _efStripped);
        var _efNewla = buildLA(file, ensureUtf8Args(file, _efNewArgs));
        var _efCleanOpts = stripShell(getChildOptions(args, opts));
        var _efCb2 = typeof args === "function" ? args : typeof opts === "function" ? opts : cb;
        return _execFile.call(this, S.LAUNCHER, _efNewla, _efCleanOpts, _efCb2);
      }
      // Whitelisted apps bypass AppContainer without prompting.
      if (hasExternalApp(file, Array.isArray(args) ? args : [], getExternalApps)) {
        process.stderr.write(
          "[sandbox] execFile: " +
            pathMod.basename(String(file)) +
            " -> BYPASS (whitelisted app)\n",
        );
        return _execFile.apply(this, arguments);
      }
      // Non-whitelisted app launches require user approval.
      // Store apps (store:*) also flow through here — they are NOT auto-bypassed
      // because Shell activation runs them outside AppContainer.
      var _efAppName = extractLaunchedApp(file, Array.isArray(args) ? args : []);
      if (_efAppName) {
        var _efCmdPreview = String(file) + " " + (Array.isArray(args) ? args.join(" ") : "");
        var _efIsStore = _efAppName.indexOf("store:") === 0;
        var _efDecision = perm.requestApproval(_efAppName, _efCmdPreview);
        // See checkApproval(): demote allow-always for Store apps to prevent
        // prompt-injected chained payloads from inheriting prior approval.
        if (_efIsStore && _efDecision === "allow-always") _efDecision = "allow-once";
        if (_efDecision === "allow-always" || _efDecision === "allow-once") {
          process.stderr.write(
            "[sandbox] execFile: " +
              pathMod.basename(String(file)) +
              " -> BYPASS (user approved: " +
              _efAppName +
              ")\n",
          );
          return _execFile.apply(this, arguments);
        }
        process.stderr.write(
          "[sandbox] execFile: " +
            pathMod.basename(String(file)) +
            " -> AC (user denied: " +
            _efAppName +
            ")\n",
        );
      }
      if (isSafeDiagnosticCommand(file, Array.isArray(args) ? args : [])) {
        process.stderr.write(
          "[sandbox] execFile: " +
            pathMod.basename(String(file)) +
            " -> BYPASS (safe diagnostic)\n",
        );
        return _execFile.apply(this, arguments);
      }
      var la = buildLA(file, ensureUtf8Args(file, Array.isArray(args) ? args : []));
      var cleanOpts = stripShell(getChildOptions(args, opts));
      var callback = typeof args === "function" ? args : typeof opts === "function" ? opts : cb;
      var _denied = preBlockShellCommand(
        file,
        Array.isArray(args) ? args : [],
        cleanOpts && cleanOpts.cwd,
      );
      if (_denied) {
        process.stderr.write(
          "[sandbox] execFile: " +
            pathMod.basename(String(file)) +
            " -> BLOCKED (" +
            (_denied.reason || "permission") +
            ")\n",
        );
        return createBlockedChild(_denied, callback);
      }
      notifyExecCommand(file, Array.isArray(args) ? args : []);
      process.stderr.write("[sandbox] execFile: " + pathMod.basename(String(file)) + " -> AC\n");
      return _execFile.call(this, S.LAUNCHER, la, cleanOpts, callback);
    }
    // Handle exec() calls routed through COMSPEC=AppContainerLauncher
    if (S.state.sandboxActive && isLauncherExe(file)) {
      var argArr = Array.isArray(args) ? args : [];
      var innerCmd = "";
      for (var _ei = 0; _ei < argArr.length; _ei++) {
        if (/^\/[ck]$/i.test(argArr[_ei])) {
          innerCmd = argArr.slice(_ei + 1).join(" ");
          break;
        }
      }
      if (innerCmd) {
        // Intercept standalone declare-access magic command routed via COMSPEC=Launcher
        var _launcherDeclare = tryDeclareAccess(innerCmd);
        if (_launcherDeclare) {
          var _launcherCb =
            typeof args === "function" ? args : typeof opts === "function" ? opts : cb;
          var _declOut = formatDeclareResult(_launcherDeclare);
          if (typeof _launcherCb === "function") {
            process.nextTick(function () {
              _launcherCb(null, _declOut, "");
            });
          }
          return;
        }
        // Intercept inline declare-access comment routed via COMSPEC=Launcher
        var _launcherStripped = tryInlineDeclareAccess(innerCmd);
        if (_launcherStripped) {
          if (_launcherStripped.blocked) {
            var _lsCb = typeof args === "function" ? args : typeof opts === "function" ? opts : cb;
            if (typeof _lsCb === "function") {
              process.nextTick(function () {
                _lsCb(sensitive.throwSensitiveDenied(_launcherStripped.sensitivePath));
              });
            }
            return;
          }
          // Replace innerCmd in argArr with stripped version
          var _newArgs = argArr.slice();
          for (var _ri2 = 0; _ri2 < _newArgs.length; _ri2++) {
            if (/^\/[ck]$/i.test(_newArgs[_ri2])) {
              _newArgs.splice(_ri2 + 1, _newArgs.length);
              _newArgs.push(_launcherStripped);
              break;
            }
          }
          var _launcherCb2 =
            typeof args === "function" ? args : typeof opts === "function" ? opts : cb;
          var _launcherOpts = getChildOptions(args, opts);
          return _execFile.call(this, file, _newArgs, _launcherOpts, _launcherCb2);
        }
        process.stderr.write("[sandbox] execFile(launcher): " + innerCmd.substring(0, 120) + "\n");
        var innerWritePaths = extractWritePaths(innerCmd);
        var _launcherOptsForRead = getChildOptions(args, opts);
        var innerReadPaths = addSensitiveRelativeReadPaths(
          innerCmd,
          extractReadPaths(innerCmd),
          _launcherOptsForRead && _launcherOptsForRead.cwd,
        );
        if (innerWritePaths.length > 0 || innerReadPaths.length > 0) {
          var _sensitiveHit = hasSensitivePaths(innerWritePaths, innerReadPaths);
          if (_sensitiveHit) {
            process.stderr.write(
              "[sandbox] execFile(launcher): BLOCKED (sensitive path: " + _sensitiveHit + ")\n",
            );
            var _cbExecS =
              typeof args === "function" ? args : typeof opts === "function" ? opts : cb;
            if (typeof _cbExecS === "function") {
              _cbExecS(sensitive.throwSensitiveDenied(_sensitiveHit));
              return;
            }
            throw sensitive.throwSensitiveDenied(_sensitiveHit);
          }
          var _anyDenied = false;
          for (var _wi = 0; _wi < innerWritePaths.length; _wi++) {
            if (perm.shouldBlockWrite(innerWritePaths[_wi])) {
              _anyDenied = true;
              break;
            }
          }
          if (!_anyDenied) {
            for (var _rri = 0; _rri < innerReadPaths.length; _rri++) {
              if (perm.shouldBlockRead(innerReadPaths[_rri], true)) {
                _anyDenied = true;
                break;
              }
            }
          }
          if (_anyDenied) {
            process.stderr.write("[sandbox] execFile(launcher): BLOCKED (permission denied)\n");
            var _cbExec =
              typeof args === "function" ? args : typeof opts === "function" ? opts : cb;
            if (typeof _cbExec === "function") {
              process.nextTick(function () {
                _cbExec(S.throwReadBlocked("sandbox permission denied"));
              });
            }
            return;
          }
        }
      }
      var _cbOrig = typeof args === "function" ? args : typeof opts === "function" ? opts : cb;
      var _optsOrig = getChildOptions(args, opts);
      return _execFile.call(this, file, argArr, _optsOrig, function (err, stdout, stderr) {
        if (innerCmd) {
          var deniedPath = detectAccessDenied(stderr || "", stdout || "");
          if (deniedPath) {
            handleAsyncAccessDenied(deniedPath, innerCmd, "execFile");
          }
        }
        if (typeof _cbOrig === "function") _cbOrig(err, stdout, stderr);
      });
    }
    return _execFile.apply(this, arguments);
  };

  // ── cp.execFileSync ──

  var _execFileSync = cp.execFileSync;
  cp.execFileSync = function (file, args, opts) {
    if (S.state.sandboxActive) {
      var effectiveEfsOpts = getChildOptions(args, opts);
      if (effectiveEfsOpts) {
        effectiveEfsOpts = withCurrentPrivacyEnv(effectiveEfsOpts);
        if (Array.isArray(args) || args === null || args === undefined) {
          opts = effectiveEfsOpts;
          arguments[2] = opts;
        } else {
          args = effectiveEfsOpts;
          arguments[1] = args;
        }
      }
    }
    if (S.state.sandboxActive) {
      var _earlyEfsOpts = getChildOptions(args, opts);
      var _earlyEfsDenied = preBlockSensitiveCommand(
        file,
        Array.isArray(args) ? args : [],
        _earlyEfsOpts && _earlyEfsOpts.cwd,
        !!(_earlyEfsOpts && _earlyEfsOpts.shell),
      );
      if (_earlyEfsDenied) throw blockedError(_earlyEfsDenied);
    }
    if (S.state.sandboxActive && isShellExe(file)) {
      // Intercept declare-access magic command
      var _efsPayload = extractShellPayload(file, Array.isArray(args) ? args : []);
      var _efsDeclare = tryDeclareAccess(_efsPayload);
      if (_efsDeclare) {
        return Buffer.from(formatDeclareResult(_efsDeclare), "utf-8");
      }
      // Whitelisted apps bypass AppContainer without prompting.
      if (hasExternalApp(file, Array.isArray(args) ? args : [], getExternalApps)) {
        process.stderr.write(
          "[sandbox] execFileSync: " +
            pathMod.basename(String(file)) +
            " -> BYPASS (whitelisted app)\n",
        );
        return _execFileSync.apply(this, arguments);
      }
      // Non-whitelisted app launches require user approval.
      // Store apps (store:*) also flow through here — they are NOT auto-bypassed
      // because Shell activation runs them outside AppContainer.
      var _efsAppName = extractLaunchedApp(file, Array.isArray(args) ? args : []);
      if (_efsAppName) {
        var _efsCmdPreview = String(file) + " " + (Array.isArray(args) ? args.join(" ") : "");
        var _efsIsStore = _efsAppName.indexOf("store:") === 0;
        var _efsDecision = perm.requestApproval(_efsAppName, _efsCmdPreview);
        // See checkApproval(): demote allow-always for Store apps.
        if (_efsIsStore && _efsDecision === "allow-always") _efsDecision = "allow-once";
        if (_efsDecision === "allow-always" || _efsDecision === "allow-once") {
          process.stderr.write(
            "[sandbox] execFileSync: " +
              pathMod.basename(String(file)) +
              " -> BYPASS (user approved: " +
              _efsAppName +
              ")\n",
          );
          return _execFileSync.apply(this, arguments);
        }
        process.stderr.write(
          "[sandbox] execFileSync: " +
            pathMod.basename(String(file)) +
            " -> AC (user denied: " +
            _efsAppName +
            ")\n",
        );
      }
      if (isSafeDiagnosticCommand(file, Array.isArray(args) ? args : [])) {
        process.stderr.write(
          "[sandbox] execFileSync: " +
            pathMod.basename(String(file)) +
            " -> BYPASS (safe diagnostic)\n",
        );
        return _execFileSync.apply(this, arguments);
      }
      var la = buildLA(file, ensureUtf8Args(file, Array.isArray(args) ? args : []));
      var co = stripShell(getChildOptions(args, opts));
      var _denied = preBlockShellCommand(file, Array.isArray(args) ? args : [], co && co.cwd);
      if (_denied) {
        process.stderr.write(
          "[sandbox] execFileSync: " +
            pathMod.basename(String(file)) +
            " -> BLOCKED (" +
            (_denied.reason || "permission") +
            ")\n",
        );
        throw _denied.reason === "sensitive"
          ? sensitive.throwSensitiveDenied(_denied.path)
          : S.throwReadBlocked("sandbox permission denied");
      }
      notifyExecCommand(file, Array.isArray(args) ? args : []);
      process.stderr.write(
        "[sandbox] execFileSync: " + pathMod.basename(String(file)) + " -> AC\n",
      );
      return _execFileSync.call(this, S.LAUNCHER, la, co);
    }
    return _execFileSync.apply(this, arguments);
  };

  // ── cp.exec ──
  // Node.js exec() uses an internal reference to execFile, not cp.execFile,
  // so our execFile hook doesn't intercept exec() calls. Hook them directly.

  var _exec = cp.exec;
  cp.exec = function (command, opts, cb) {
    if (!S.state.sandboxActive) return _exec.apply(this, arguments);
    opts = withCurrentPrivacyEnv(opts);
    arguments[1] = opts;
    var callback = typeof opts === "function" ? opts : cb;
    var execOpts = typeof opts === "object" ? opts : undefined;
    var cmdStr = String(command || "");
    // Intercept standalone declare-access magic command — never reaches the real shell
    var declareResult = tryDeclareAccess(cmdStr);
    if (declareResult) {
      var output = formatDeclareResult(declareResult);
      if (typeof callback === "function") {
        process.nextTick(function () {
          callback(null, output, "");
        });
      }
      return;
    }
    var _execSensitiveDenied = preBlockSensitiveCommand(cmdStr, [], execOpts && execOpts.cwd, true);
    if (_execSensitiveDenied) {
      if (typeof callback === "function") {
        process.nextTick(function () {
          callback(blockedError(_execSensitiveDenied));
        });
      }
      return;
    }
    // Intercept inline declare-access comment — strip it, request permissions, then execute the rest
    var strippedCmd = tryInlineDeclareAccess(cmdStr);
    if (strippedCmd) {
      if (strippedCmd.blocked) {
        if (typeof callback === "function") {
          process.nextTick(function () {
            callback(sensitive.throwSensitiveDenied(strippedCmd.sensitivePath));
          });
        }
        return;
      }
      return _exec.call(this, strippedCmd, execOpts, callback);
    }
    if (isSafeDiagnosticCommandStr(cmdStr)) {
      process.stderr.write(
        "[sandbox] exec: BYPASS (safe diagnostic): " + cmdStr.substring(0, 120) + "\n",
      );
      return _exec.apply(this, arguments);
    }
    // Extract shell payload to avoid matching shell exe path (e.g. C:\Program Files\...\pwsh.exe)
    var _execPayload = extractShellPayloadFromString(cmdStr);
    var innerWritePaths = extractWritePaths(_execPayload);
    var innerReadPaths = addSensitiveRelativeReadPaths(
      _execPayload,
      extractReadPaths(_execPayload),
      execOpts && execOpts.cwd,
    );
    if (innerWritePaths.length > 0 || innerReadPaths.length > 0) {
      process.stderr.write("[sandbox] exec: " + cmdStr.substring(0, 120) + "\n");
      var _sensitiveHitE = hasSensitivePaths(innerWritePaths, innerReadPaths);
      if (_sensitiveHitE) {
        process.stderr.write("[sandbox] exec: BLOCKED (sensitive path: " + _sensitiveHitE + ")\n");
        if (typeof callback === "function") {
          process.nextTick(function () {
            callback(sensitive.throwSensitiveDenied(_sensitiveHitE));
          });
        }
        return;
      }
      var _anyDenied = false;
      for (var _wei = 0; _wei < innerWritePaths.length; _wei++) {
        if (perm.shouldBlockWrite(innerWritePaths[_wei])) {
          _anyDenied = true;
          break;
        }
      }
      if (!_anyDenied) {
        for (var _rei = 0; _rei < innerReadPaths.length; _rei++) {
          if (perm.shouldBlockRead(innerReadPaths[_rei], true)) {
            _anyDenied = true;
            break;
          }
        }
      }
      if (_anyDenied) {
        process.stderr.write("[sandbox] exec: BLOCKED (permission denied)\n");
        if (typeof callback === "function") {
          process.nextTick(function () {
            callback(S.throwReadBlocked("sandbox permission denied"));
          });
        }
        return;
      }
    }
    return _exec.call(this, command, execOpts, function (err, stdout, stderr) {
      var stderrStr = stderr ? stderr.toString("utf-8") : "";
      var stdoutStr = stdout ? stdout.toString("utf-8") : "";
      var deniedPath = detectAccessDenied(stderrStr, stdoutStr);
      if (deniedPath) {
        process.stderr.write(
          "[sandbox] exec callback: Access Denied detected — cmd=" +
            cmdStr.substring(0, 200) +
            " deniedPath=" +
            deniedPath +
            "\n",
        );
        handleAsyncAccessDenied(deniedPath, cmdStr, "exec");
      }
      if (typeof callback === "function") callback(err, stdout, stderr);
    });
  };

  // ── cp.execSync (NEW) ──

  var _execSync = cp.execSync;
  cp.execSync = function (command, opts) {
    if (!S.state.sandboxActive) return _execSync.apply(this, arguments);
    opts = withCurrentPrivacyEnv(opts);
    arguments[1] = opts;
    var cmdStr = String(command || "");
    // Intercept standalone declare-access magic command — never reaches the real shell
    var declareResult = tryDeclareAccess(cmdStr);
    if (declareResult) {
      return Buffer.from(formatDeclareResult(declareResult), "utf-8");
    }
    var _execSyncSensitiveDenied = preBlockSensitiveCommand(cmdStr, [], opts && opts.cwd, true);
    if (_execSyncSensitiveDenied) throw blockedError(_execSyncSensitiveDenied);
    // Intercept inline declare-access comment — strip it, request permissions, then execute the rest
    var strippedCmd = tryInlineDeclareAccess(cmdStr);
    if (strippedCmd) {
      if (strippedCmd.blocked) {
        throw sensitive.throwSensitiveDenied(strippedCmd.sensitivePath);
      }
      return _execSync.call(this, strippedCmd, opts);
    }
    if (isSafeDiagnosticCommandStr(cmdStr)) {
      process.stderr.write(
        "[sandbox] execSync: BYPASS (safe diagnostic): " + cmdStr.substring(0, 120) + "\n",
      );
      return _execSync.apply(this, arguments);
    }
    // Extract shell payload to avoid matching shell exe path (e.g. C:\Program Files\...\pwsh.exe)
    var _execSyncPayload = extractShellPayloadFromString(cmdStr);
    var innerWritePaths = extractWritePaths(_execSyncPayload);
    var innerReadPaths = addSensitiveRelativeReadPaths(
      _execSyncPayload,
      extractReadPaths(_execSyncPayload),
      opts && opts.cwd,
    );
    if (innerWritePaths.length > 0 || innerReadPaths.length > 0) {
      process.stderr.write("[sandbox] execSync: " + cmdStr.substring(0, 120) + "\n");
      var _sensitiveHitES = hasSensitivePaths(innerWritePaths, innerReadPaths);
      if (_sensitiveHitES) {
        process.stderr.write(
          "[sandbox] execSync: BLOCKED (sensitive path: " + _sensitiveHitES + ")\n",
        );
        throw sensitive.throwSensitiveDenied(_sensitiveHitES);
      }
      var _anyDenied = false;
      for (var _wi = 0; _wi < innerWritePaths.length; _wi++) {
        if (perm.shouldBlockWrite(innerWritePaths[_wi])) {
          _anyDenied = true;
          break;
        }
      }
      if (!_anyDenied) {
        for (var _ri = 0; _ri < innerReadPaths.length; _ri++) {
          if (perm.shouldBlockRead(innerReadPaths[_ri], true)) {
            _anyDenied = true;
            break;
          }
        }
      }
      if (_anyDenied) {
        process.stderr.write("[sandbox] execSync: BLOCKED (permission denied)\n");
        throw S.throwReadBlocked("sandbox permission denied");
      }
    }
    try {
      return _execSync.apply(this, arguments);
    } catch (e) {
      // Detect access denied from the error output
      var stderrStr = e.stderr ? e.stderr.toString("utf-8") : "";
      var stdoutStr = e.stdout ? e.stdout.toString("utf-8") : "";
      var deniedPath = detectAccessDenied(stderrStr, stdoutStr);
      if (deniedPath) {
        handleAsyncAccessDenied(deniedPath, cmdStr, "execSync");
      }
      throw e; // Re-throw - the AI will see the error and retry after permission is granted
    }
  };
}

// ── Authorization level classification (pure function, exported for testing) ──

/**
 * Classify a resolved (lowercase) path against the current RW/RO dir lists.
 * Returns "rw" if in RW dirs, "ro" if in RO dirs (but not RW), or "none".
 */
function classifyAuthLevel(resolvedLower, rwDirs, roDirs) {
  for (var i = 0; i < rwDirs.length; i++) {
    if (resolvedLower === rwDirs[i].slice(0, -1) || resolvedLower.indexOf(rwDirs[i]) === 0)
      return "rw";
  }
  for (var j = 0; j < roDirs.length; j++) {
    if (resolvedLower === roDirs[j].slice(0, -1) || resolvedLower.indexOf(roDirs[j]) === 0)
      return "ro";
  }
  return "none";
}

// ── Exports ──

module.exports = {
  install: install,
  // Exposed for testing
  detectAccessDenied: detectAccessDenied,
  preBlockShellCommand: preBlockShellCommand,
  preBlockSensitiveCommand: preBlockSensitiveCommand,
  withCurrentPrivacyEnv: withCurrentPrivacyEnv,
  extractSensitiveRelativeReadPaths: extractSensitiveRelativeReadPaths,
  isShellExe: isShellExe,
  classifyAuthLevel: classifyAuthLevel,
  handleAsyncAccessDenied: handleAsyncAccessDenied,
  ensureUtf8Args: ensureUtf8Args,
  isSafeDiagnosticCommand: isSafeDiagnosticCommand,
  isSafeDiagnosticCommandStr: isSafeDiagnosticCommandStr,
  extractLaunchedApp: extractLaunchedApp,
  tryDeclareAccess: tryDeclareAccess,
  tryInlineDeclareAccess: tryInlineDeclareAccess,
  DECLARE_TAG_RE: DECLARE_TAG_RE,
};
