/**
 * path-extraction.js — Shared path extraction logic for sandbox-preload.
 *
 * SECURITY NOTE: Path extraction is a best-effort UX optimization, NOT a
 * security boundary. It uses regex heuristics to guess which file paths a
 * shell command will access. This is inherently incomplete — shell features
 * like variable expansion, heredocs, process substitution, and encoded
 * characters can produce paths that regex cannot detect.
 *
 * The actual security enforcement is the OS-level Windows AppContainer,
 * whose ACLs are applied by AppContainerLauncher.exe at process creation
 * time. Commands that pass path-extraction checks still run inside the
 * AppContainer and are subject to kernel-enforced access control.
 *
 * Path extraction serves two UX purposes:
 *   1. Pre-blocking: show permission dialogs BEFORE execution so the user
 *      can grant access proactively (avoids a confusing "access denied").
 *   2. Post-failure detection: parse stderr after AppContainer denies
 *      access to surface a grant dialog for the next attempt.
 *
 * All functions are pure (no side effects) except expandEnvVarsInCmd which
 * reads process.env.
 */
"use strict";

var path = require("path");

// ── Helpers ──

function cleanExtractedPath(p) {
  p = p
    .replace(/["']+$/g, "")
    .replace(/,+$/, "")
    .replace(/[\\\/]+$/, "")
    .replace(/[)]+$/, "");
  if (/[*?]/.test(p)) {
    p = path.dirname(p);
  }
  return p;
}

function dedup(arr) {
  var seen = {};
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var k = arr[i].toLowerCase();
    if (!seen[k]) {
      seen[k] = true;
      out.push(arr[i]);
    }
  }
  return out;
}

/**
 * Expand environment variable references in command text.
 *
 * SECURITY NOTE: This function is part of the UX pre-blocking layer, not
 * a security boundary.  A crafted command could use env vars to construct
 * paths that evade regex extraction (e.g. split across multiple variables).
 * This is acceptable because the actual access control is enforced by
 * Windows AppContainer ACLs at the kernel level — env expansion here only
 * improves the accuracy of permission prompts shown to the user.
 *
 * Handles: $env:VAR, %VAR%, ~/, $HOME/
 */
function expandEnvVarsInCmd(cmd) {
  cmd = cmd.replace(/\$env:([a-zA-Z_][a-zA-Z0-9_]*)/gi, function (match, name) {
    return process.env[name.toUpperCase()] || process.env[name] || match;
  });
  cmd = cmd.replace(/%([a-zA-Z_][a-zA-Z0-9_]*)%/g, function (match, name) {
    return process.env[name.toUpperCase()] || process.env[name] || match;
  });
  var home = process.env.USERPROFILE || "";
  if (home) {
    // Expand PowerShell $HOME automatic variable (maps to USERPROFILE on Windows)
    cmd = cmd.replace(/\$HOME(?=[\\\/])/g, home);
    cmd = cmd.replace(/(?:^|[\s"'])~([\\\/])/g, function (match, sep) {
      return match[0] === "~" ? home + sep : match[0] + home + sep;
    });
  }
  // Resolve PowerShell Join-Path calls into a single path so downstream
  // regex patterns see the actual combined path instead of just the base.
  // Handles: Join-Path <base> '<relative>' / Join-Path <base> "<relative>"
  // and also: Join-Path <base> <relative> (unquoted, no spaces in relative)
  cmd = cmd.replace(
    /\bJoin-Path\s+(?:-(?:Path|ChildPath)\s+)?["']?([a-zA-Z]:\\[^"'\s]*)["']?\s+(?:-ChildPath\s+)?["']([^"']+)["']/gi,
    function (_m, base, child) {
      return path.join(base, child);
    },
  );
  cmd = cmd.replace(
    /\bJoin-Path\s+(?:-(?:Path|ChildPath)\s+)?["']?([a-zA-Z]:\\[^"'\s]*)["']?\s+(?:-ChildPath\s+)?([^\s|;>"'(),]+)/gi,
    function (_m, base, child) {
      return path.join(base, child);
    },
  );
  return cmd;
}

// ── Shell payload extraction ──

/**
 * Extract the shell command payload, stripping the shell executable and its
 * flags so that path extraction only sees the user's actual command.
 */
function extractShellPayload(cmd, args) {
  var argArr = Array.isArray(args) ? args : [];
  var payload = "";
  var bn = path
    .basename(String(cmd))
    .toLowerCase()
    .replace(/\.exe$/i, "");
  if (bn === "cmd") {
    for (var i = 0; i < argArr.length; i++) {
      if (/^\/[ck]$/i.test(argArr[i])) {
        payload = argArr.slice(i + 1).join(" ");
        break;
      }
    }
    if (!payload) payload = argArr.join(" ");
  } else if (bn === "powershell" || bn === "pwsh") {
    for (var i = 0; i < argArr.length; i++) {
      if (/^-(?:Command|c|File)$/i.test(argArr[i])) {
        payload = argArr.slice(i + 1).join(" ");
        break;
      }
    }
    if (!payload) {
      for (var i = 0; i < argArr.length; i++) {
        if (!/^-/.test(argArr[i])) {
          payload = argArr.slice(i).join(" ");
          break;
        }
      }
    }
    if (!payload) payload = argArr.join(" ");
  } else {
    for (var i = 0; i < argArr.length; i++) {
      if (!/^[-\/]/.test(argArr[i])) {
        payload = argArr.slice(i).join(" ");
        break;
      }
    }
    if (!payload) payload = argArr.join(" ");
  }
  // Only strip wrapping quotes if the entire payload is enclosed in matching quotes.
  // Don't strip independently — e.g. Move-Item 'src' 'dst' ends with a closing
  // quote that belongs to the destination path, not payload wrapping.
  if (
    (payload[0] === '"' && payload[payload.length - 1] === '"') ||
    (payload[0] === "'" && payload[payload.length - 1] === "'")
  ) {
    payload = payload.slice(1, -1);
  }
  return payload;
}

/**
 * Extract the shell command payload from a single raw command string.
 * Detects shell executables (cmd, powershell, pwsh) at the start of the string
 * and strips them along with their flags to return only the user's command.
 * If no shell prefix is detected, returns the original string unchanged.
 *
 * Handles both quoted ("C:\Program Files\...\pwsh.exe") and unquoted paths.
 */
function extractShellPayloadFromString(cmdStr) {
  var s = cmdStr.trim();
  // Try to extract the executable: either quoted path or unquoted first token
  var exe, rest;
  if (s[0] === '"') {
    var closeQuote = s.indexOf('"', 1);
    if (closeQuote < 0) return cmdStr;
    exe = s.substring(1, closeQuote);
    rest = s.substring(closeQuote + 1).trim();
  } else if (s[0] === "'") {
    var closeQuote = s.indexOf("'", 1);
    if (closeQuote < 0) return cmdStr;
    exe = s.substring(1, closeQuote);
    rest = s.substring(closeQuote + 1).trim();
  } else {
    // Unquoted: first token up to whitespace. But paths with spaces
    // (e.g. "C:\Program Files\...\pwsh.exe") get split prematurely.
    // Heuristic: if the first token looks like a drive path but isn't a
    // known shell, scan forward for ".exe " to find the real exe boundary.
    var spaceIdx = s.indexOf(" ");
    if (spaceIdx < 0) return cmdStr;
    exe = s.substring(0, spaceIdx);
    rest = s.substring(spaceIdx + 1).trim();
    var testBn = path
      .basename(exe)
      .toLowerCase()
      .replace(/\.exe$/i, "");
    var KNOWN_SHELLS = { cmd: 1, powershell: 1, pwsh: 1, bash: 1, sh: 1, wsl: 1 };
    if (!KNOWN_SHELLS[testBn] && /^[a-zA-Z]:\\/.test(exe)) {
      // Likely a path with spaces — search for ".exe " boundary
      var exeMatch = s.match(/^([a-zA-Z]:\\[^"]*?\.exe)\s/i);
      if (exeMatch) {
        exe = exeMatch[1];
        rest = s.substring(exeMatch[0].length - 1).trim();
      }
    }
  }
  var bn = path
    .basename(exe)
    .toLowerCase()
    .replace(/\.exe$/i, "");
  if (
    bn !== "cmd" &&
    bn !== "powershell" &&
    bn !== "pwsh" &&
    bn !== "bash" &&
    bn !== "sh" &&
    bn !== "wsl"
  ) {
    return cmdStr; // Not a shell — return as-is
  }
  // Split rest into args and delegate to extractShellPayload
  var args = [];
  var remaining = rest;
  while (remaining) {
    remaining = remaining.replace(/^\s+/, "");
    if (!remaining) break;
    if (remaining[0] === '"') {
      var end = remaining.indexOf('"', 1);
      if (end < 0) {
        args.push(remaining.substring(1));
        break;
      }
      args.push(remaining.substring(1, end));
      remaining = remaining.substring(end + 1);
    } else if (remaining[0] === "'") {
      var end = remaining.indexOf("'", 1);
      if (end < 0) {
        args.push(remaining.substring(1));
        break;
      }
      args.push(remaining.substring(1, end));
      remaining = remaining.substring(end + 1);
    } else {
      var sp = remaining.indexOf(" ");
      if (sp < 0) {
        args.push(remaining);
        break;
      }
      args.push(remaining.substring(0, sp));
      remaining = remaining.substring(sp + 1);
    }
  }
  return extractShellPayload(exe, args);
}

// ── Path extraction patterns ──

var WRITE_PATTERNS = [
  // PowerShell write cmdlets — quoted paths
  /Out-File\s+(?:-FilePath\s+)?["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /Set-Content\s+(?:-Path\s+)?["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /Add-Content\s+(?:-Path\s+)?["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /New-Item\s+(?:-\w+\s+\S+\s+)*(?:-(?:Path|LiteralPath)\s+)?["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /Remove-Item\s+(?:-(?:Path|LiteralPath)\s+)?(?:-Recurse\s+)?(?:-Force\s+)?["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /Rename-Item\s+(?:-(?:Path|LiteralPath)\s+)?["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /Copy-Item\s+.+?\s+(?:-Destination\s+)?["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /Move-Item\s+.+?\s+(?:-Destination\s+)?["']([a-zA-Z]:\\[^"']*?)["']/gi,
  // PowerShell Copy-Item/Move-Item with explicit -Destination (named param)
  // Must come before the generic unquoted patterns so -Destination is matched
  // even when -Path is also used (e.g. Move-Item -Path src -Destination dst).
  /(?:Copy-Item|Move-Item)\s+.*?-Destination\s+["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /(?:Copy-Item|Move-Item)\s+.*?-Destination\s+([a-zA-Z]:\\[^\s|;>,]*)/gi,
  // PowerShell write cmdlets — unquoted paths (comma = separator)
  /Out-File\s+(?:-FilePath\s+)?([a-zA-Z]:\\[^\s|;>,]*)/gi,
  /Set-Content\s+(?:-Path\s+)?([a-zA-Z]:\\[^\s|;>,]*)/gi,
  /Add-Content\s+(?:-Path\s+)?([a-zA-Z]:\\[^\s|;>,]*)/gi,
  /New-Item\s+(?:-\w+\s+\S+\s+)*(?:-(?:Path|LiteralPath)\s+)?([a-zA-Z]:\\[^\s|;>,]*)/gi,
  /Remove-Item\s+(?:-(?:Path|LiteralPath)\s+)?(?:-Recurse\s+)?(?:-Force\s+)?([a-zA-Z]:\\[^\s|;>,]*)/gi,
  /Rename-Item\s+(?:-(?:Path|LiteralPath)\s+)?([a-zA-Z]:\\[^\s|;>,]*)/gi,
  /Copy-Item\s+.+?\s+(?:-Destination\s+)?([a-zA-Z]:\\[^\s|;>,]*)/gi,
  /Move-Item\s+.+?\s+(?:-Destination\s+)?([a-zA-Z]:\\[^\s|;>,]*)/gi,
  // PowerShell download/web — quoted then unquoted
  /(?:Invoke-WebRequest|iwr|curl|wget)\s+.*?(?:-OutFile|-o|-O)\s+["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /(?:Invoke-WebRequest|iwr|curl|wget)\s+.*?(?:-OutFile|-o|-O)\s+([a-zA-Z]:\\[^\s|;>,]*)/gi,
  // PowerShell Tee-Object — quoted then unquoted
  /Tee-Object\s+(?:-FilePath\s+)?["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /Tee-Object\s+(?:-FilePath\s+)?([a-zA-Z]:\\[^\s|;>,]*)/gi,
  // PowerShell Export-Csv — quoted then unquoted
  /Export-Csv\s+(?:-Path\s+)?["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /Export-Csv\s+(?:-Path\s+)?([a-zA-Z]:\\[^\s|;>,]*)/gi,
  // PowerShell archive — quoted then unquoted
  /(?:Expand-Archive|Compress-Archive)\s+.*?-(?:DestinationPath|Destination)\s+["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /(?:Expand-Archive|Compress-Archive)\s+.*?-(?:DestinationPath|Destination)\s+([a-zA-Z]:\\[^\s|;>,]*)/gi,
  // PowerShell aliases: cp, mv, rm — destination/target (quoted then unquoted)
  /\bcp\s+.+?\s+["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /\bcp\s+.+?\s+([a-zA-Z]:\\[^\s|;,]*)/gi,
  /\bmv\s+.+?\s+["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /\bmv\s+.+?\s+([a-zA-Z]:\\[^\s|;,]*)/gi,
  /\brm\s+(?:-[a-z]+\s+)*["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /\brm\s+(?:-[a-z]+\s+)*([a-zA-Z]:\\[^\s|;,]*)/gi,
  // cmd redirections
  />{1,2}\s*["']([a-zA-Z]:\\[^"']*?)["']/g,
  />{1,2}\s*([a-zA-Z]:\\[^\s|;,]*)/g,
  // cmd copy/move/del/mkdir — quoted then unquoted (including aliases)
  /\b(?:copy|xcopy)\s+.+?\s+["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /\b(?:copy|xcopy)\s+.+?\s+([a-zA-Z]:\\[^\s|;,]*)/gi,
  /\brobocopy\s+.+?\s+["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /\brobocopy\s+.+?\s+([a-zA-Z]:\\[^\s|;,]*)/gi,
  /\bmove\s+.+?\s+["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /\bmove\s+.+?\s+([a-zA-Z]:\\[^\s|;,]*)/gi,
  /\b(?:del|erase)\s+(?:\/[a-z]\s+)*["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /\b(?:del|erase)\s+(?:\/[a-z]\s+)*([a-zA-Z]:\\[^\s|;,]*)/gi,
  /\b(?:mkdir|md)\s+["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /\b(?:mkdir|md)\s+([a-zA-Z]:\\[^\s|;,]*)/gi,
  /\b(?:rmdir|rd)\s+(?:\/[a-z]\s+)*["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /\b(?:rmdir|rd)\s+(?:\/[a-z]\s+)*([a-zA-Z]:\\[^\s|;,]*)/gi,
  /\b(?:ren|rename)\s+["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /\b(?:ren|rename)\s+([a-zA-Z]:\\[^\s|;,]*)/gi,
  // Python open("path", "w"/"a"/"x")
  /open\s*\(\s*["']([a-zA-Z]:\\[^"']+)["']\s*,\s*["'][waxWAX]/g,
  // Python shutil
  /shutil\.(?:copy2?|move|copytree)\s*\(.+?,\s*["']([a-zA-Z]:\\[^"']+)/g,
  // Node.js fs write
  /fs\.(?:writeFileSync|appendFileSync|copyFileSync)\s*\(\s*["']([a-zA-Z]:\\[^"']+)/g,
  // .NET write methods
  /\[?System\.IO\.(?:File|Directory)\]?::(?:WriteAll|Append|Create|Delete|Move|Copy)\w*\s*\(\s*["']([a-zA-Z]:\\[^"']+)/gi,
];

var READ_PATTERNS = [
  // PowerShell read cmdlets — quoted (full names + aliases)
  // The (?:-\w+\s+)* eats switch params like -Force, -Recurse before the path.
  /(?:Get-Content|gc)\s+(?:-\w+\s+)*(?:-(?:Path|LiteralPath)\s+)?["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /(?:Get-ChildItem|gci|ls)\s+(?:-\w+\s+)*(?:-(?:Path|LiteralPath)\s+)?["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /(?:Get-Item|gi)\s+(?:-\w+\s+)*(?:-(?:Path|LiteralPath)\s+)?["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /Test-Path\s+(?:-\w+\s+)*(?:-(?:Path|LiteralPath)\s+)?["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /Resolve-Path\s+(?:-\w+\s+)*(?:-(?:Path|LiteralPath)\s+)?["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /(?:Select-String|sls)\s+(?:-\w+\s+)*(?:-(?:Path|LiteralPath)\s+)?["']([a-zA-Z]:\\[^"']*?)["']/gi,
  // PowerShell read cmdlets — unquoted (full names + aliases, comma = separator)
  /(?:Get-Content|gc)\s+(?:-\w+\s+)*(?:-(?:Path|LiteralPath)\s+)?([a-zA-Z]:\\[^\s|;>(),]*)/gi,
  /(?:Get-ChildItem|gci|ls)\s+(?:-\w+\s+)*(?:-(?:Path|LiteralPath)\s+)?([a-zA-Z]:\\[^\s|;>(),]*)/gi,
  /(?:Get-Item|gi)\s+(?:-\w+\s+)*(?:-(?:Path|LiteralPath)\s+)?([a-zA-Z]:\\[^\s|;>(),]*)/gi,
  /Test-Path\s+(?:-\w+\s+)*(?:-(?:Path|LiteralPath)\s+)?([a-zA-Z]:\\[^\s|;>(),]*)/gi,
  /Resolve-Path\s+(?:-\w+\s+)*(?:-(?:Path|LiteralPath)\s+)?([a-zA-Z]:\\[^\s|;>(),]*)/gi,
  /(?:Select-String|sls)\s+(?:-\w+\s+)*(?:-(?:Path|LiteralPath)\s+)?([a-zA-Z]:\\[^\s|;>(),]*)/gi,
  // PowerShell Import-Csv / Get-FileHash — quoted then unquoted
  /(?:Import-Csv|Get-FileHash)\s+(?:-(?:Path|LiteralPath)\s+)?["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /(?:Import-Csv|Get-FileHash)\s+(?:-(?:Path|LiteralPath)\s+)?([a-zA-Z]:\\[^\s|;>(),]*)/gi,
  // cmd read commands — quoted then unquoted
  /\b(?:type|more)\s+["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /\b(?:type|more)\s+([a-zA-Z]:\\[^\s|;>(),]*)/gi,
  /\b(?:dir|ls|gci|tree)\s+(?:\/[a-z]\s+)*["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /\b(?:dir|ls|gci|tree)\s+(?:\/[a-z]\s+)*([a-zA-Z]:\\[^\s|;>(),]*)/gi,
  /\bfind(?:str)?\s+(?:\/[a-z]\s+)*(?:["'][^"']+["']\s+)?["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /\bfind(?:str)?\s+(?:\/[a-z]\s+)*(?:["'][^"']+["']\s+)?([a-zA-Z]:\\[^\s|;>(),]*)/gi,
  // cat / head / tail — quoted then unquoted
  /\b(?:cat|head|tail)\s+["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /\b(?:cat|head|tail)\s+([a-zA-Z]:\\[^\s|;>(),]*)/gi,
  // icacls (read-only usage) — unquoted
  /\bicacls\s+["']([a-zA-Z]:\\[^"']*?)["']/gi,
  /\bicacls\s+([a-zA-Z]:\\[^\s|;>(),]*)/gi,
  // Python open("path", "r") or open("path")
  /open\s*\(\s*["']([a-zA-Z]:\\[^"']+)["']\s*(?:\)|,\s*["'][rR])/g,
  // .NET read methods
  /\[?System\.IO\.(?:File|Directory)\]?::(?:Read|Get|Exists|Open)\w*\s*\(\s*["']([a-zA-Z]:\\[^"']+)/gi,
  // Generic fallback: quoted path
  /["']([a-zA-Z]:\\[^"'\s]+)["']/g,
  // Generic fallback: unquoted path (comma = separator)
  /(?:^|[\s,])([a-zA-Z]:\\[^\s|;>"'(),]+)/g,
];

function runPatterns(patterns, cmd) {
  var paths = [];
  for (var i = 0; i < patterns.length; i++) {
    var pat = new RegExp(patterns[i].source, patterns[i].flags);
    var m;
    while ((m = pat.exec(cmd)) !== null) {
      if (m[1]) {
        var p = cleanExtractedPath(m[1]);
        if (p && /^[a-zA-Z]:\\/.test(p)) paths.push(p);
      }
    }
  }
  return dedup(paths);
}

function extractWritePaths(command) {
  var cmd = expandEnvVarsInCmd(String(command || ""));
  return runPatterns(WRITE_PATTERNS, cmd);
}

function extractReadPaths(command) {
  var cmd = expandEnvVarsInCmd(String(command || ""));
  return runPatterns(READ_PATTERNS, cmd);
}

// ── System path filtering ──

/**
 * Matches shell executable paths that should never be treated as user target paths.
 * e.g. C:\Windows\System32\cmd.exe, C:\Program Files\PowerShell\7\pwsh.exe
 */
var SHELL_PATH_RE = /^[a-zA-Z]:\\(?:Windows|Program Files)\\.*?(?:cmd|powershell|pwsh)\.exe/i;

/**
 * Matches system directories that should never trigger permission requests.
 * e.g. C:\Windows\..., C:\Program Files\..., C:\ProgramData\...
 */
var SYSTEM_DIR_RE = /^[a-zA-Z]:\\(?:Windows|Program\b|ProgramData)(?:\s|\\|$)/i;

/**
 * Filter out system/shell executable paths from an array of extracted paths.
 * Prevents shell executables (cmd.exe, powershell.exe, pwsh.exe) and system
 * directories from being mistaken for user-requested paths.
 */
function filterSystemPaths(paths) {
  var out = [];
  for (var i = 0; i < paths.length; i++) {
    if (!SHELL_PATH_RE.test(paths[i]) && !SYSTEM_DIR_RE.test(paths[i])) {
      out.push(paths[i]);
    }
  }
  return out;
}

// ── Exports ──

module.exports = {
  cleanExtractedPath: cleanExtractedPath,
  dedup: dedup,
  expandEnvVarsInCmd: expandEnvVarsInCmd,
  extractShellPayload: extractShellPayload,
  extractShellPayloadFromString: extractShellPayloadFromString,
  extractWritePaths: extractWritePaths,
  extractReadPaths: extractReadPaths,
  filterSystemPaths: filterSystemPaths,
  // Exported for direct testing
  WRITE_PATTERNS: WRITE_PATTERNS,
  READ_PATTERNS: READ_PATTERNS,
  SHELL_PATH_RE: SHELL_PATH_RE,
  SYSTEM_DIR_RE: SYSTEM_DIR_RE,
};
