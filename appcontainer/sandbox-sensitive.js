/**
 * sandbox-sensitive.js — Sensitive path detection and blocking.
 *
 * Standalone module. Single source of truth for which paths are
 * considered sensitive and must never be accessed by the sandbox.
 * Does NOT depend on sandbox-permission.js or sandbox-state.js.
 */
"use strict";

var path = require("path");

// ── Default sensitive directories (relative to user home) ──

var SENSITIVE_DIRS = [".ssh", ".gnupg", ".aws", ".azure", path.join(".config", "gcloud")];

var _home = (process.env.USERPROFILE || process.env.HOME || "").toLowerCase();
var _resolvedSensitive = _home
  ? SENSITIVE_DIRS.map(function (d) {
      return path.join(_home, d).toLowerCase();
    })
  : [];

/**
 * Check if a file path is under a sensitive directory.
 * Pure function, no side effects, no IPC, no caching.
 */
function isSensitivePath(filePath) {
  if (!_home || !filePath) return false;
  var resolved;
  try {
    resolved = path.resolve(String(filePath)).toLowerCase();
  } catch (e) {
    return false;
  }
  for (var i = 0; i < _resolvedSensitive.length; i++) {
    var s = _resolvedSensitive[i];
    if (resolved === s || resolved.indexOf(s + path.sep) === 0) return true;
  }
  return false;
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
    resolved = path
      .resolve(String(dirPath))
      .toLowerCase()
      .replace(/[\\/]+$/, "");
  } catch (e) {
    return false;
  }
  var homeNorm = _home.replace(/[\\/]+$/, "");
  return resolved === homeNorm || homeNorm.indexOf(resolved + path.sep) === 0;
}

module.exports = {
  SENSITIVE_DIRS: SENSITIVE_DIRS,
  isSensitivePath: isSensitivePath,
  parentOfSensitive: parentOfSensitive,
  throwSensitiveDenied: throwSensitiveDenied,
};
