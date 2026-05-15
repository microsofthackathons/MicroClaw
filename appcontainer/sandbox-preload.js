/**
 * sandbox-preload.js - Loaded via NODE_OPTIONS="--require <this-file>"
 * Intercepts child process creation and wraps shell executables via AppContainer.
 * Sandbox activates immediately on load for all processes (main gateway
 * and forked workers). No bypass window exists.
 *
 * External app whitelist (OPENCLAW_AC_EXTERNAL_APPS):
 *   Comma-separated list of executable base names (e.g. "outlook,chrome,excel").
 *   When a sandboxed shell command references a whitelisted app, the entire
 *   spawn call bypasses AppContainer so the app can use COM/RPC/named pipes.
 *
 * Module structure:
 *   sandbox-state.js      — Shared state, directory lists, path utilities
 *   sandbox-permission.js — Permission request logic, caches, approval flow
 *   sandbox-fs-hooks.js   — fs and fs/promises monkey-patches
 *   sandbox-cp-hooks.js   — child_process hooks (spawn, exec, execFile, etc.)
 *   path-extraction.js    — Shell command path extraction (pure functions)
 */
"use strict";

var path = require("path");

// ── External app whitelist (read from HMAC-signed file or env var) ──

var _extAppsFile = (function () {
  var appdata = process.env.APPDATA || "";
  return appdata ? path.join(appdata, "microclaw", "sandbox-external-apps.json") : "";
})();
var _extAppsHmacKey = process.env.OPENCLAW_SANDBOX_HMAC_KEY || "";
var _extAppsCache = null;
var _extAppsMtime = 0;
var _extAppsLastCheck = 0;
var EXT_APPS_CHECK_INTERVAL = 5000;

function getExternalApps() {
  var now = Date.now();
  if (_extAppsCache && now - _extAppsLastCheck < EXT_APPS_CHECK_INTERVAL) return _extAppsCache;
  _extAppsLastCheck = now;
  if (_extAppsFile && _extAppsHmacKey) {
    try {
      var fsMod = require("fs");
      var stat = fsMod.statSync(_extAppsFile);
      var mtime = stat.mtimeMs;
      if (!_extAppsCache || mtime !== _extAppsMtime) {
        var raw = fsMod.readFileSync(_extAppsFile, "utf-8");
        var obj = JSON.parse(raw);
        var crypto = require("crypto");
        var expected = crypto
          .createHmac("sha256", _extAppsHmacKey)
          .update(JSON.stringify(obj.apps))
          .digest("hex");
        if (obj.hmac !== expected) {
          process.stderr.write(
            "[sandbox] WARNING: external apps file HMAC mismatch — ignoring (possible tampering)\n",
          );
          if (!_extAppsCache) _extAppsCache = [];
          return _extAppsCache;
        }
        var _shellBlock = S.SHELL_NAMES_SET;
        _extAppsCache = Array.isArray(obj.apps)
          ? obj.apps
              .map(function (s) {
                return String(s).trim().toLowerCase();
              })
              .filter(function (s) {
                return s && !_shellBlock.has(s);
              })
          : [];
        _extAppsMtime = mtime;
        process.stderr.write(
          "[sandbox] Loaded external apps (verified): " + _extAppsCache.join(",") + "\n",
        );
      }
    } catch (e) {
      if (!_extAppsCache) {
        var envStr = process.env.OPENCLAW_AC_EXTERNAL_APPS || "";
        var _fb1 = S.SHELL_NAMES_SET;
        _extAppsCache = envStr
          ? envStr
              .split(",")
              .map(function (s) {
                return s
                  .trim()
                  .toLowerCase()
                  .replace(/\.exe$/i, "");
              })
              .filter(function (s) {
                return s && !_fb1.has(s);
              })
          : [];
      }
    }
  } else if (!_extAppsCache) {
    var envStr = process.env.OPENCLAW_AC_EXTERNAL_APPS || "";
    var _fb2 = S.SHELL_NAMES_SET;
    _extAppsCache = envStr
      ? envStr
          .split(",")
          .map(function (s) {
            return s
              .trim()
              .toLowerCase()
              .replace(/\.exe$/i, "");
          })
          .filter(function (s) {
            return s && !_fb2.has(s);
          })
      : [];
  }
  return _extAppsCache;
}

// ── Main initialization ──

var LAUNCHER = process.env.COMSPEC;
var isLauncherConfigured = LAUNCHER && /AppContainerLauncher/i.test(LAUNCHER);

if (isLauncherConfigured) {
  var S = require(path.join(__dirname, "sandbox-state.js"));
  var fsMod = require("fs");
  var cp = require("child_process");
  // Activate sandbox immediately — no bypass window.
  // Safe diagnostic commands (ping, hostname, etc.) are already allowed
  // through the isSafeDiagnosticCommand check in sandbox-cp-hooks.js.
  // Other startup commands (e.g. netstat) route through AppContainer,
  // which is the correct security posture.
  S.state.sandboxActive = true;

  // Install IPC message handler for session/dirs updates
  S.setupMessageHandler();

  // Install fs hooks (write blocking, read blocking, new stat/symlink/etc.)
  require(path.join(__dirname, "sandbox-fs-hooks.js")).install(fsMod);

  // Install child_process hooks (spawn, exec, execFile, execSync, etc.)
  require(path.join(__dirname, "sandbox-cp-hooks.js")).install(cp, getExternalApps);

  process.stderr.write("[sandbox-preload] Loaded - sandbox active immediately\n");
}
