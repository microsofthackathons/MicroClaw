/**
 * sandbox-state.js — Shared state and path utilities for sandbox-preload modules.
 *
 * Holds directory lists (RO, RW, safe), permission caches, and path-checking
 * functions used by both fs hooks and child_process hooks.
 */
"use strict";

var path = require("path");

// ── Configuration ──

var PERMISSION_TIMEOUT_MS = parseInt(process.env.OPENCLAW_SANDBOX_PERMISSION_TIMEOUT || "0", 10);
var SHELL_NAMES_SET = new Set([
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
var LAUNCHER = process.env.COMSPEC;
var CNAME = process.env.OPENCLAW_SANDBOX_NAME || "MicroClaw";
var CAPS = (process.env.OPENCLAW_SANDBOX_CAPS || "").split(",").filter(Boolean);
var ACTIVATION_DELAY_MS = 0;

// ── Mutable state ──

var state = {
  sandboxActive: false,
  _roDirs: [],
  _rwDirs: [],
  _currentCmdPreview: null,
};

// ── Directory initialization ──

function normDirList(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map(function (d) {
      d = d.trim();
      if (!d) return "";
      var n = path.resolve(d).toLowerCase();
      if (n[n.length - 1] !== path.sep) n += path.sep;
      return n;
    })
    .filter(Boolean);
}

state._roDirs = normDirList(process.env.OPENCLAW_SANDBOX_DIRS_RO || "");
state._rwDirs = normDirList(process.env.OPENCLAW_SANDBOX_DIRS_RW || "");

// ── Safe paths ──

var _safePaths = (function () {
  var dirs = [];
  var home = process.env.USERPROFILE || "";
  if (home) {
    dirs.push(path.resolve(home, ".openclaw").toLowerCase() + path.sep);
    // Legacy Node.js install location (zip extract). Still recognised for
    // upgrades; new installs use the MSI default below.
    dirs.push(path.resolve(home, ".openclaw-node").toLowerCase() + path.sep);
  }
  // Standard per-machine and per-user Node.js MSI install locations.
  var programFiles = process.env.ProgramFiles || "";
  if (programFiles) {
    dirs.push(path.resolve(programFiles, "nodejs").toLowerCase() + path.sep);
  }
  var localAppData =
    process.env.LOCALAPPDATA ||
    (home ? path.join(home, "AppData", "Local") : "");
  if (localAppData) {
    dirs.push(
      path.resolve(localAppData, "Programs", "nodejs").toLowerCase() + path.sep
    );
  }
  // Allow runtime override (mirrors OPENCLAW_NODE_DIR used by the deployer).
  var overrideDir = process.env.OPENCLAW_NODE_DIR || "";
  if (overrideDir) {
    dirs.push(path.resolve(overrideDir).toLowerCase() + path.sep);
  }
  var stateDir = process.env.OPENCLAW_STATE_DIR || "";
  if (stateDir) dirs.push(path.resolve(stateDir).toLowerCase() + path.sep);
  var tmp = process.env.TEMP || process.env.TMP || "";
  if (tmp) dirs.push(path.resolve(tmp).toLowerCase() + path.sep);
  var appdata = process.env.APPDATA || "";
  if (appdata) dirs.push(path.resolve(appdata, "microclaw").toLowerCase() + path.sep);
  var systemDrive = process.env.SystemDrive || "C:";
  dirs.push(path.resolve(systemDrive, "tmp", "openclaw").toLowerCase() + path.sep);
  return dirs;
})();

var _safeExactPaths = (function () {
  var paths = [];
  var home = process.env.USERPROFILE || "";
  if (home) paths.push(path.resolve(home).toLowerCase());
  var drives = new Set();
  drives.add((process.env.SystemDrive || "C:").toLowerCase());
  if (home) drives.add(path.parse(home).root.replace(/\\$/, "").toLowerCase());
  drives.forEach(function (d) {
    paths.push(d);
  });
  return paths;
})();

// ── Path checking functions ──

function isNonFilePath(p) {
  var s = String(p);
  if (s.indexOf("\\\\.\\") === 0 || s.indexOf("\\\\?\\") === 0) return true;
  if (/^\\\\[.?]\\/.test(s)) return true;
  return false;
}

function isSafePath(resolvedLower) {
  for (var j = 0; j < _safeExactPaths.length; j++) {
    if (resolvedLower === _safeExactPaths[j]) return true;
  }
  for (var i = 0; i < _safePaths.length; i++) {
    if (resolvedLower === _safePaths[i].slice(0, -1) || resolvedLower.indexOf(_safePaths[i]) === 0)
      return true;
  }
  return false;
}

function isSafePrefixPath(resolvedLower) {
  for (var i = 0; i < _safePaths.length; i++) {
    if (resolvedLower === _safePaths[i].slice(0, -1) || resolvedLower.indexOf(_safePaths[i]) === 0)
      return true;
  }
  return false;
}

function isBlockedPath(filePath) {
  if (!state.sandboxActive || !filePath) return false;
  if (isNonFilePath(filePath)) return false;
  var resolved;
  try {
    resolved = path.resolve(String(filePath)).toLowerCase();
  } catch {
    return false;
  }
  if (isSafePath(resolved)) return false;
  var rwMatchLen = 0;
  for (var j = 0; j < state._rwDirs.length; j++) {
    var rw = state._rwDirs[j];
    if ((resolved === rw.slice(0, -1) || resolved.indexOf(rw) === 0) && rw.length > rwMatchLen)
      rwMatchLen = rw.length;
  }
  var roMatchLen = 0;
  for (var i = 0; i < state._roDirs.length; i++) {
    var ro = state._roDirs[i];
    if ((resolved === ro.slice(0, -1) || resolved.indexOf(ro) === 0) && ro.length > roMatchLen)
      roMatchLen = ro.length;
  }
  if (rwMatchLen > 0 && rwMatchLen > roMatchLen) return false;
  return true;
}

var _selfDir = path.resolve(__dirname).toLowerCase() + path.sep;

function isReadBlockedPath(filePath, shellContext) {
  if (!state.sandboxActive || !filePath) return false;
  if (isNonFilePath(filePath)) return false;
  var resolved;
  try {
    resolved = path.resolve(String(filePath)).toLowerCase();
  } catch {
    return false;
  }
  // Allow reading any file in the sandbox module directory (our own infrastructure)
  if (resolved.indexOf(_selfDir) === 0) return false;
  if (shellContext ? isSafePrefixPath(resolved) : isSafePath(resolved)) return false;
  for (var j = 0; j < state._rwDirs.length; j++) {
    var rw = state._rwDirs[j];
    if (resolved === rw.slice(0, -1) || resolved.indexOf(rw) === 0) return false;
  }
  for (var i = 0; i < state._roDirs.length; i++) {
    var ro = state._roDirs[i];
    if (resolved === ro.slice(0, -1) || resolved.indexOf(ro) === 0) return false;
  }
  return true;
}

function findRestrictedDir(resolvedLower) {
  var best = "";
  for (var i = 0; i < state._roDirs.length; i++) {
    var ro = state._roDirs[i];
    if (
      (resolvedLower === ro.slice(0, -1) || resolvedLower.indexOf(ro) === 0) &&
      ro.length > best.length
    )
      best = ro;
  }
  // When the path matches an existing RO dir, use the file's immediate parent
  // directory (not the RO zone root) as the grant target. This allows granting
  // RW to a subdirectory while keeping the rest of the RO zone read-only.
  // e.g. file=c:\a\b\test.txt, roDir=c:\a\ → request for c:\a\b\ (not c:\a\)
  var hasExt = /\.[a-z0-9]{1,10}$/i.test(resolvedLower);
  var dir = hasExt ? path.dirname(resolvedLower) : resolvedLower;
  if (dir[dir.length - 1] !== path.sep) dir += path.sep;
  if (best) {
    // If the file's parent dir IS the RO dir itself, return the RO dir
    if (dir === best) return best;
    // Otherwise return the more specific parent directory
    return dir;
  }
  if (/^[a-z]:\\$/i.test(dir)) {
    var asDir = resolvedLower;
    if (asDir[asDir.length - 1] !== path.sep) asDir += path.sep;
    return asDir;
  }
  return dir;
}

function throwReadOnly(filePath) {
  var err = new Error("EACCES: sandbox read-only directory, write blocked: " + filePath);
  err.code = "EACCES";
  err.errno = -4092;
  err.syscall = "open";
  err.path = String(filePath);
  return err;
}

function throwReadBlocked(filePath) {
  var err = new Error("EACCES: sandbox unauthorized directory, read blocked: " + filePath);
  err.code = "EACCES";
  err.errno = -4092;
  err.syscall = "open";
  err.path = String(filePath);
  return err;
}

// ── IPC message handling for state updates ──

function setupMessageHandler() {
  process.on("message", function (msg) {
    if (!msg) return;
    if (msg.type === "sandbox-session-changed") {
      var perm = require(path.join(__dirname, "sandbox-permission.js"));
      perm.clearCaches();
      process.stderr.write("[sandbox] Session changed — cleared file permission caches\n");
    } else if (msg.type === "sandbox-dirs-updated") {
      state._roDirs = normDirList((msg.ro || []).join(","));
      state._rwDirs = normDirList((msg.rw || []).join(","));
      var perm = require(path.join(__dirname, "sandbox-permission.js"));
      perm.cleanupPendingForAuthorizedDirs(state._rwDirs, state._roDirs);
      process.stderr.write(
        "[sandbox] Dirs updated — RO: " +
          state._roDirs.length +
          ", RW: " +
          state._rwDirs.length +
          "\n",
      );
    }
  });
}

// ── Exports ──

module.exports = {
  // Config
  PERMISSION_TIMEOUT_MS: PERMISSION_TIMEOUT_MS,
  SHELL_NAMES_SET: SHELL_NAMES_SET,
  LAUNCHER: LAUNCHER,
  CNAME: CNAME,
  CAPS: CAPS,
  ACTIVATION_DELAY_MS: ACTIVATION_DELAY_MS,
  // State
  state: state,
  // Path functions
  normDirList: normDirList,
  isNonFilePath: isNonFilePath,
  isSafePath: isSafePath,
  isSafePrefixPath: isSafePrefixPath,
  isBlockedPath: isBlockedPath,
  isReadBlockedPath: isReadBlockedPath,
  findRestrictedDir: findRestrictedDir,
  throwReadOnly: throwReadOnly,
  throwReadBlocked: throwReadBlocked,
  _safePaths: _safePaths,
  // Setup
  setupMessageHandler: setupMessageHandler,
};
