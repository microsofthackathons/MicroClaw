/**
 * sandbox-permission.js — Permission request and approval logic.
 *
 * Handles sync IPC permission requests (file + shell + app approval),
 * TTL-based caches, pending async request tracking, and decision processing.
 */
"use strict";

var path = require("path");
var fs = require("fs");

var S = require(path.join(__dirname, "sandbox-state.js"));

// ── Approval directory ──

var _approvalDir = (function () {
  var tmp = process.env.TEMP || process.env.TMP || "";
  return tmp ? path.join(tmp, "microclaw-sandbox-approval") : "";
})();

// ── Permission caches ──

var _filePermReadAllowed = {}; // dir -> expiry (RO grants)
var _filePermWriteAllowed = {}; // dir -> expiry (RW grants)
var _filePermDenied = new Set(); // paths denied this session

// Pending async permission requests: normalizedDir -> { resFile, timestamp }.
var _pendingAsyncDirs = {};
var PENDING_ASYNC_EXPIRY_MS = 120000;

function clearCaches() {
  _filePermReadAllowed = {};
  _filePermWriteAllowed = {};
  _filePermDenied.clear();
  _pendingAsyncDirs = {};
}

function cleanupPendingForAuthorizedDirs(rwDirs, roDirs) {
  for (var pKey in _pendingAsyncDirs) {
    for (var _di = 0; _di < rwDirs.length; _di++) {
      if (pKey === rwDirs[_di] || pKey.indexOf(rwDirs[_di]) === 0) {
        delete _pendingAsyncDirs[pKey];
        break;
      }
    }
    if (_pendingAsyncDirs[pKey]) {
      for (var _dj = 0; _dj < roDirs.length; _dj++) {
        if (pKey === roDirs[_dj] || pKey.indexOf(roDirs[_dj]) === 0) {
          delete _pendingAsyncDirs[pKey];
          break;
        }
      }
    }
  }
}

// ── Parent approval check ──

function isUnderApprovedParent(resolvedLower, now, checkReadCache) {
  var rLower = resolvedLower;
  if (rLower[rLower.length - 1] !== path.sep) rLower += path.sep;
  for (var key in _filePermWriteAllowed) {
    if (_filePermWriteAllowed[key] > now && key[key.length - 1] === path.sep) {
      if (rLower.indexOf(key) === 0 && rLower !== key) return true;
    }
  }
  if (checkReadCache) {
    for (var key in _filePermReadAllowed) {
      if (_filePermReadAllowed[key] > now && key[key.length - 1] === path.sep) {
        if (rLower.indexOf(key) === 0 && rLower !== key) return true;
      }
    }
  }
  return false;
}

// ── Pending async wait ──

function waitForPendingAsync(roDir) {
  var now = Date.now();
  var entry = _pendingAsyncDirs[roDir];
  var matchedKey = roDir;
  if (!entry) {
    for (var key in _pendingAsyncDirs) {
      if (roDir.indexOf(key) === 0) {
        entry = _pendingAsyncDirs[key];
        matchedKey = key;
        break;
      }
    }
  }
  if (!entry) return null;
  if (now - entry.timestamp > PENDING_ASYNC_EXPIRY_MS) {
    delete _pendingAsyncDirs[matchedKey];
    process.stderr.write("[sandbox] Pending async expired for: " + matchedKey + "\n");
    return null;
  }
  process.stderr.write("[sandbox] Blocking on pending async request for: " + roDir + "\n");
  var pollDeadline = now + PENDING_ASYNC_EXPIRY_MS;
  while (Date.now() < pollDeadline) {
    try {
      if (fs.existsSync(entry.resFile)) {
        var res = JSON.parse(fs.readFileSync(entry.resFile, "utf-8"));
        try {
          fs.unlinkSync(entry.resFile);
        } catch {}
        for (var k in _pendingAsyncDirs) {
          if (_pendingAsyncDirs[k] && _pendingAsyncDirs[k].resFile === entry.resFile)
            delete _pendingAsyncDirs[k];
        }
        process.stderr.write(
          "[sandbox] Pending async resolved: " + (res.decision || "deny") + " for " + roDir + "\n",
        );
        return res.decision || "deny";
      }
    } catch {}
    var buf = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buf), 0, 0, 200);
  }
  delete _pendingAsyncDirs[matchedKey];
  process.stderr.write("[sandbox] Pending async wait timed out for: " + roDir + "\n");
  return null;
}

// ── Decision handler ──

function handlePermissionDecision(decision, roDir, isWrite) {
  var now = Date.now();
  if (decision === "allow-once") {
    if (isWrite) _filePermWriteAllowed[roDir] = now + 5000;
    else _filePermReadAllowed[roDir] = now + 5000;
    return false;
  } else if (decision === "grant-rw") {
    _filePermWriteAllowed[roDir] = Infinity;
    return false;
  } else if (decision === "grant-ro") {
    if (isWrite) {
      _filePermDenied.add(roDir);
      return true;
    }
    _filePermReadAllowed[roDir] = Infinity;
    return false;
  } else if (decision === "timeout") {
    // Block this request but don't permanently deny — next access will re-prompt
    return true;
  } else {
    _filePermDenied.add(roDir);
    return true;
  }
}

// ── File permission request (sync IPC) ──

function requestFilePermission(filePath, roDir, accessNeeded) {
  if (!_approvalDir) return "deny";
  try {
    fs.mkdirSync(_approvalDir, { recursive: true });
  } catch {}
  var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  var resFile = path.join(_approvalDir, "response-" + id + ".json");
  var stackTrace = "";
  try {
    throw new Error();
  } catch (e) {
    stackTrace = (e.stack || "")
      .split("\n")
      .slice(2, 6)
      .map(function (l) {
        return l.trim();
      })
      .join(" ← ");
  }
  if (typeof process.send === "function") {
    process.send({
      type: "sandbox-file-permission-request",
      id: id,
      filePath: filePath,
      roDir: roDir,
      accessNeeded: accessNeeded || "rw",
      command: S.state._currentCmdPreview ? S.state._currentCmdPreview.substring(0, 500) : null,
      callerStack: stackTrace.substring(0, 500) || null,
      responseFile: resFile,
    });
    process.stderr.write(
      "[sandbox] File permission requested via IPC for: " +
        filePath +
        " command=" +
        (S.state._currentCmdPreview || "(none)") +
        "\n",
    );
  } else {
    return "deny";
  }
  var deadline = S.PERMISSION_TIMEOUT_MS > 0 ? Date.now() + S.PERMISSION_TIMEOUT_MS : 0;
  while (deadline === 0 || Date.now() < deadline) {
    try {
      if (fs.existsSync(resFile)) {
        var res = JSON.parse(fs.readFileSync(resFile, "utf-8"));
        try {
          fs.unlinkSync(resFile);
        } catch {}
        return res.decision || "deny";
      }
    } catch {}
    var buf = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buf), 0, 0, 200);
  }
  process.stderr.write("[sandbox] File permission timeout for: " + filePath + "\n");
  return "deny";
}

// ── shouldBlockWrite / shouldBlockRead ──

function shouldBlockWrite(filePath) {
  if (!S.isBlockedPath(filePath)) return false;
  var resolved;
  try {
    resolved = path.resolve(String(filePath)).toLowerCase();
  } catch {
    return true;
  }
  var roDir = S.findRestrictedDir(resolved);
  var now = Date.now();
  if (_filePermWriteAllowed[roDir] && _filePermWriteAllowed[roDir] > now) return false;
  if (_filePermWriteAllowed[resolved] && _filePermWriteAllowed[resolved] > now) return false;
  if (isUnderApprovedParent(resolved, now, false)) return false;
  if (_filePermDenied.has(roDir)) return true;
  var pendingDecision = waitForPendingAsync(roDir);
  if (pendingDecision) return handlePermissionDecision(pendingDecision, roDir, true);
  var decision = requestFilePermission(resolved, roDir, "rw");
  if (decision === "allow-once") {
    _filePermWriteAllowed[roDir] = now + 5000;
    return false;
  } else if (decision === "grant-rw") {
    _filePermWriteAllowed[roDir] = Infinity;
    return false;
  } else if (decision === "grant-ro") {
    _filePermDenied.add(roDir);
    return true;
  } else if (decision === "timeout") {
    return true;
  } else {
    _filePermDenied.add(roDir);
    return true;
  }
}

function shouldBlockRead(filePath, shellContext) {
  if (!S.isReadBlockedPath(filePath, shellContext)) return false;
  var resolved;
  try {
    resolved = path.resolve(String(filePath)).toLowerCase();
  } catch {
    return true;
  }
  var roDir = S.findRestrictedDir(resolved);
  var now = Date.now();
  if (_filePermWriteAllowed[roDir] && _filePermWriteAllowed[roDir] > now) return false;
  if (_filePermWriteAllowed[resolved] && _filePermWriteAllowed[resolved] > now) return false;
  if (_filePermReadAllowed[roDir] && _filePermReadAllowed[roDir] > now) return false;
  if (_filePermReadAllowed[resolved] && _filePermReadAllowed[resolved] > now) return false;
  if (isUnderApprovedParent(resolved, now, true)) return false;
  if (_filePermDenied.has(roDir)) return true;
  var pendingDecision = waitForPendingAsync(roDir);
  if (pendingDecision) return handlePermissionDecision(pendingDecision, roDir, false);
  var decision = requestFilePermission(resolved, roDir, "ro");
  if (decision === "allow-once") {
    _filePermReadAllowed[roDir] = now + 5000;
    return false;
  } else if (decision === "grant-rw") {
    _filePermWriteAllowed[roDir] = Infinity;
    return false;
  } else if (decision === "grant-ro") {
    _filePermReadAllowed[roDir] = Infinity;
    return false;
  } else if (decision === "timeout") {
    return true;
  } else {
    _filePermDenied.add(roDir);
    return true;
  }
}

// ── Shell permission request (sync IPC) ──

function requestShellPermission(deniedPath, commandPreview) {
  if (!_approvalDir || typeof process.send !== "function") return "deny";
  try {
    fs.mkdirSync(_approvalDir, { recursive: true });
  } catch {}
  var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  var resFile = path.join(_approvalDir, "response-" + id + ".json");
  var dirPath;
  try {
    var resolved = path.resolve(deniedPath).toLowerCase();
    dirPath = S.findRestrictedDir(resolved);
    if (dirPath.length > 3 && dirPath[dirPath.length - 1] === path.sep)
      dirPath = dirPath.slice(0, -1);
  } catch {
    dirPath = path.dirname(deniedPath);
  }
  process.send({
    type: "sandbox-shell-permission-request",
    id: id,
    deniedPath: deniedPath,
    dirPath: dirPath,
    command: commandPreview.substring(0, 300),
    accessNeeded: inferAccessNeeded(commandPreview),
    responseFile: resFile,
  });
  process.stderr.write("[sandbox] Shell permission requested for: " + deniedPath + "\n");
  var deadline = S.PERMISSION_TIMEOUT_MS > 0 ? Date.now() + S.PERMISSION_TIMEOUT_MS : 0;
  while (deadline === 0 || Date.now() < deadline) {
    try {
      if (fs.existsSync(resFile)) {
        var res = JSON.parse(fs.readFileSync(resFile, "utf-8"));
        try {
          fs.unlinkSync(resFile);
        } catch {}
        return res.decision || "deny";
      }
    } catch {}
    var buf = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buf), 0, 0, 200);
  }
  return "deny";
}

// ── App approval request (sync IPC) ──

function requestApproval(appName, commandPreview) {
  if (!_approvalDir) return "deny";
  try {
    fs.mkdirSync(_approvalDir, { recursive: true });
  } catch {}
  var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  var resFile = path.join(_approvalDir, "response-" + id + ".json");
  if (typeof process.send === "function") {
    process.send({
      type: "sandbox-approval-request",
      id: id,
      app: appName,
      command: commandPreview.substring(0, 200),
      responseFile: resFile,
    });
    process.stderr.write("[sandbox] Approval requested via IPC for: " + appName + "\n");
  } else {
    var reqFile = path.join(_approvalDir, "request-" + id + ".json");
    fs.writeFileSync(
      reqFile,
      JSON.stringify({
        id: id,
        app: appName,
        command: commandPreview.substring(0, 200),
        responseFile: resFile,
        timestamp: Date.now(),
      }),
    );
    process.stderr.write("[sandbox] Approval requested via file for: " + appName + "\n");
  }
  var deadline = S.PERMISSION_TIMEOUT_MS > 0 ? Date.now() + S.PERMISSION_TIMEOUT_MS : 0;
  while (deadline === 0 || Date.now() < deadline) {
    try {
      if (fs.existsSync(resFile)) {
        var res = JSON.parse(fs.readFileSync(resFile, "utf-8"));
        try {
          fs.unlinkSync(resFile);
        } catch {}
        return res.decision || "deny";
      }
    } catch {}
    var buf = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buf), 0, 0, 200);
  }
  process.stderr.write("[sandbox] Approval timeout for: " + appName + "\n");
  return "deny";
}

// ── Async permission request sender ──

function sendAsyncPermissionRequest(type, deniedPath, dirPath, command, accessNeeded) {
  if (typeof process.send !== "function") return;
  var asyncResFile = path.join(
    _approvalDir,
    "async-response-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + ".json",
  );
  var asyncDirNorm = S.findRestrictedDir(path.resolve(dirPath).toLowerCase());
  _pendingAsyncDirs[asyncDirNorm] = { resFile: asyncResFile, timestamp: Date.now() };
  process.send({
    type: type,
    deniedPath: deniedPath,
    dirPath: dirPath,
    command: command.substring(0, 300),
    accessNeeded: accessNeeded,
    responseFile: asyncResFile,
  });
  process.stderr.write("[sandbox] Async permission request sent for: " + deniedPath + "\n");
}

// ── Access-need inference ──

var READ_ONLY_CMDS = [
  "dir",
  "ls",
  "get-childitem",
  "gci",
  "type",
  "cat",
  "get-content",
  "gc",
  "find",
  "findstr",
  "select-string",
  "sls",
  "tree",
  "more",
  "less",
  "where",
  "where.exe",
  "which",
  "fc",
  "comp",
  "test-path",
  "resolve-path",
  "get-item",
  "gi",
  "get-itemproperty",
  "gp",
  "get-acl",
  "get-filehash",
  "import-csv",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "icacls",
  "attrib",
];
var READ_ONLY_SET = {};
for (var _roi = 0; _roi < READ_ONLY_CMDS.length; _roi++) {
  READ_ONLY_SET[READ_ONLY_CMDS[_roi]] = true;
}
var WRITE_REDIRECT_RE = /[|]\s*(?:out-file|set-content|add-content|tee-object)|>>|>[^>&]/i;

function inferAccessNeeded(commandPreview) {
  if (!commandPreview) return "rw";
  var cmd = String(commandPreview).trim();
  var prev = "";
  while (prev !== cmd) {
    prev = cmd;
    // Strip full-path shell executables: "C:\...\cmd.exe", "C:\...\pwsh.exe", "C:\...\powershell.exe"
    cmd = cmd.replace(/^"?[a-zA-Z]:\\[^"]*\\(cmd|powershell|pwsh)(?:\.exe)?"?\s+/i, "$1 ");
    cmd = cmd.replace(/^(?:cmd(?:\.exe)?)\s+(?:\/[a-z]\s+)*/i, "");
    cmd = cmd.replace(/^(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*/i, "");
    cmd = cmd.replace(/^["']/, "");
  }
  if (WRITE_REDIRECT_RE.test(cmd)) return "rw";
  if (/New-Object\s+-ComObject\b/i.test(cmd) && !/\.InvokeVerb|\.MoveHere|\.CopyHere/i.test(cmd))
    return "ro";
  if (/^\[?System\.IO\.(?:File|Directory)::(?:Read|Get|Exists|Open)/i.test(cmd)) return "ro";
  if (/^\[?System\.IO\.(?:File|Directory)::(?:WriteAll|Append|Create|Delete|Move|Copy)/i.test(cmd))
    return "rw";
  var m = cmd.match(/^["']?([a-z](?:[a-z0-9_-]*[a-z0-9])?)(?:\.exe)?["']?/i);
  if (!m) return "rw";
  var first = m[1].toLowerCase();
  if (!READ_ONLY_SET[first]) return "rw";
  if (first === "icacls" && /\/(?:grant|deny|remove|setowner|reset|save|restore)/i.test(cmd))
    return "rw";
  if (first === "attrib" && /\s[+-][a-z]/i.test(cmd)) return "rw";
  return "ro";
}

// ── Exports ──

module.exports = {
  // Cache management
  clearCaches: clearCaches,
  cleanupPendingForAuthorizedDirs: cleanupPendingForAuthorizedDirs,
  // Permission checks
  shouldBlockWrite: shouldBlockWrite,
  shouldBlockRead: shouldBlockRead,
  // Request functions
  requestFilePermission: requestFilePermission,
  requestShellPermission: requestShellPermission,
  requestApproval: requestApproval,
  sendAsyncPermissionRequest: sendAsyncPermissionRequest,
  // Utilities
  inferAccessNeeded: inferAccessNeeded,
  handlePermissionDecision: handlePermissionDecision,
  isUnderApprovedParent: isUnderApprovedParent,
  // Exposed for cp-hooks async fallback
  _filePermWriteAllowed: function () {
    return _filePermWriteAllowed;
  },
  _filePermReadAllowed: function () {
    return _filePermReadAllowed;
  },
  _approvalDir: _approvalDir,
};
