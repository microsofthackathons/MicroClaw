/**
 * sandbox-sensitive.js — Sensitive path detection and blocking.
 *
 * Single source of truth for which paths are considered sensitive and must
 * never be accessed by the sandbox.
 */
"use strict";

var path = require("path");
var S = require(path.join(__dirname, "sandbox-state.js"));
var fileURLToPath = require("url").fileURLToPath;

// ── Default sensitive directories (relative to user home) ──

var SENSITIVE_DIRS = [".ssh", ".gnupg", ".aws", ".azure", path.join(".config", "gcloud")];
var SENSITIVE_FILE_PATTERNS = [
  ".env",
  ".env.*",
  "*_key*",
  "*.key",
  "*.pem",
  "*.crt",
  "*.cer",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
  "credentials.*",
];

var _home = (process.env.USERPROFILE || process.env.HOME || "").toLowerCase();
var _resolvedSensitive = _home
  ? SENSITIVE_DIRS.map(function (d) {
      return path.join(_home, d).toLowerCase();
    })
  : [];

function normalizeFilePath(filePath) {
  if (!filePath) return "";
  var value = filePath;
  if (
    typeof value === "object" &&
    value !== null &&
    String(value.protocol || "").toLowerCase() === "file:"
  ) {
    try {
      return fileURLToPath(value);
    } catch (e) {
      return "";
    }
  }
  var raw = String(value);
  if (/^file:/i.test(raw)) {
    try {
      return fileURLToPath(raw);
    } catch (e) {
      return "";
    }
  }
  return raw;
}

/**
 * Check if a file path is under a sensitive directory.
 * Pure function, no side effects, no IPC, no caching.
 */
function isSensitivePath(filePath) {
  if (!_home || !filePath) return false;
  var resolved;
  try {
    var normalized = normalizeFilePath(filePath);
    if (!normalized) return false;
    resolved = S.resolvePathLower(normalized);
  } catch (e) {
    return false;
  }
  for (var i = 0; i < _resolvedSensitive.length; i++) {
    var s = _resolvedSensitive[i];
    if (resolved === s || resolved.indexOf(s + path.sep) === 0) return true;
  }
  return false;
}

/** Check filename patterns that require confirmation before reads. */
function isSensitiveFile(filePath) {
  if (!filePath) return false;
  var base;
  try {
    base = path.basename(normalizeFilePath(filePath)).split(":")[0].toLowerCase();
  } catch (e) {
    return false;
  }
  if (!base) return false;
  if (base === ".env" || base.indexOf(".env.") === 0) return true;
  if (base.indexOf("_key") !== -1) return true;
  if (/\.(?:key|pem|crt|cer|p12|pfx)$/.test(base)) return true;
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(base)) return true;
  return base === "credentials" || base.indexOf("credentials.") === 0;
}

/**
 * Create an Error for sensitive path access denial.
 * Message is distinct from normal permission denial to prevent
 * the agent from retrying or requesting permission.
 */
function throwSensitiveDenied(filePath) {
  var err = new Error(
    'DENIED: "' +
      filePath +
      '" is inside a protected sensitive directory ' +
      "(.ssh, .gnupg, .aws, etc.) and cannot be accessed by the sandbox. " +
      "This restriction is permanent and cannot be overridden.",
  );
  err.code = "SENSITIVE_PATH_DENIED";
  return err;
}

/**
 * Check if a directory is a parent of (or equal to) a sensitive directory.
 * Returns true for the home dir and any ancestor of home, since they
 * could contain sensitive subdirectories like .ssh.
 * Used to prevent auto-granting broad directory access.
 */
function parentOfSensitive(dirPath) {
  if (!_home || !dirPath) return false;
  var resolved;
  try {
    var normalized = normalizeFilePath(dirPath);
    if (!normalized) return false;
    resolved = S.resolvePathLower(normalized).replace(/[\\/]+$/, "");
  } catch (e) {
    return false;
  }
  var homeNorm = _home.replace(/[\\/]+$/, "");
  return resolved === homeNorm || homeNorm.indexOf(resolved + path.sep) === 0;
}

module.exports = {
  SENSITIVE_DIRS: SENSITIVE_DIRS,
  SENSITIVE_FILE_PATTERNS: SENSITIVE_FILE_PATTERNS,
  normalizeFilePath: normalizeFilePath,
  isSensitivePath: isSensitivePath,
  isSensitiveFile: isSensitiveFile,
  parentOfSensitive: parentOfSensitive,
  throwSensitiveDenied: throwSensitiveDenied,
};
