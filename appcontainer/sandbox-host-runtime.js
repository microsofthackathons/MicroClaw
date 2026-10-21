"use strict";

var path = require("node:path");
var fs = require("node:fs");
var crypto = require("node:crypto");
var moduleApi = require("node:module");
var urls = require("node:url");
var hostSpawnSync = require("node:child_process").spawnSync;
var hostReadFileSync = fs.readFileSync;
var hostRealpathSync = fs.realpathSync.native || fs.realpathSync;
var installed = false;
var nativeProcessStartTime;
var PINNED_MODULES = Object.freeze({
  "dist/pid-alive-CPS_shDt.mjs": "15370817b8250160bfba29d3e0c46d8f1f09579b65abd0c83fc47c44c7ff4280",
  "dist/native-hook-relay/pid-alive-Cnn-Mjdg.mjs":
    "6e3f9c71e55eceb3e7bfe1c6d27fc992026155e7eee38601d11f79d73955ce20",
  "dist/gateway-state-owner-C3Vdziw8.mjs":
    "ec013bac1c0ef8620e100dd51293260dea8eeffed3ad10e4def459e2536a1629",
  "dist/infra/sqlite-readonly-location.worker.js":
    "3217eaf9a6dc432f046675ecd38dd1b7ef3e315d6973b0157107c02194a67942",
  "dist/managed-handoff-runtime.mjs":
    "4a420be6ca65ee3e046be8f4eb7c1ae8aefd91d5bff625c03c2f6ec4173ea3dc",
  "dist/native-hook-relay/sqlite-readonly-location-cleanup-B3jqoryh.mjs":
    "fa82681c7ace7282db05cb1ce9ed02c2d6135d8cc6ac57974b9a7540df0487d3",
  "dist/package-update-activation-recovery.mjs":
    "0d866c09a3432e1cf7add4a39bed3bfc3e79c14eec12c1d1be759c4a57a6673f",
  "dist/process/supervisor/service-child-group-anchor.js":
    "0d26c64945c664a42d9e3e583b894ac15983a50bb6bb2b0fb8085fb4d7a83fd8",
  "dist/state/openclaw-state-lease-heartbeat.worker.js":
    "fa0bd52ec7656711f842aa24732f9c0583150c836e5c2d88a27c0e3f7520270a",
  "dist/state/openclaw-state-read.worker.js":
    "47b30b692100aea7a55edb7a4e912e3436eb3c88d780efed698acde9d20b4818",
});
var PINNED_MODULES_BY_VERSION = Object.freeze({
  "2026.9.3": Object.freeze({
    "dist/windows-process-start-zFVtrrwG.mjs":
      "5219dff227af5e6fc51105d79a933729475e36ccb06bcc950421bb7f1d17167b",
    "dist/managed-handoff-runtime.mjs":
      "ea9760365cb67600fbc23715ec081c2ba991a33bff82912c3d3cf3eda5ae6c65",
    "dist/update-managed-service-handoff-lease-nmNHRx6U.mjs":
      "d7a79053b2c23fd585d9b51ef9462f7772b5e4a2a13ba5b3ebc73cab125aed58",
  }),
  "2026.10.3": PINNED_MODULES,
});
var BOOT_ARGUMENTS = Object.freeze([
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "(Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
]);
var HOST_ENVIRONMENT = Object.freeze(buildBootIdentityInvocation(process.env).options.env);

function buildBootIdentityInvocation(environment) {
  var systemRoot = environment.SystemRoot || environment.WINDIR || "C:\\Windows";
  var executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  var env = {};
  [
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramData",
  ].forEach(function (name) {
    if (environment[name] !== undefined) env[name] = environment[name];
  });
  env.SystemRoot = systemRoot;
  env.WINDIR = systemRoot;
  env.PSModulePath = path.join(path.dirname(executable), "Modules");
  return {
    command: executable,
    args: BOOT_ARGUMENTS.slice(),
    options: {
      cwd: path.dirname(executable),
      env: env,
      encoding: "utf8",
      timeout: 5000,
      killSignal: "SIGKILL",
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: false,
      stdio: ["ignore", "pipe", "ignore"],
    },
  };
}

function isBootIdentityInvocation(command, args, options) {
  return (
    command === "powershell.exe" &&
    !(options && options.shell) &&
    Array.isArray(args) &&
    args.length === BOOT_ARGUMENTS.length &&
    BOOT_ARGUMENTS.every(function (argument, index) {
      return args[index] === argument;
    })
  );
}

function readWindowsBootIdentity() {
  if (process.platform !== "win32") throw new Error("The Windows host probe is unavailable");
  var invocation = buildBootIdentityInvocation(HOST_ENVIRONMENT);
  var started = Date.now();
  var result = hostSpawnSync(invocation.command, invocation.args, invocation.options);
  process.stderr.write("[host-runtime] boot identity probe " + (Date.now() - started) + "ms\n");
  return result;
}

function processIdentityArguments(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 4294967295) {
    throw new Error("Invalid Windows process identity PID");
  }
  return BOOT_ARGUMENTS.slice(0, 3).concat(
    "$process = [System.Diagnostics.Process]::GetProcessById(" +
      pid +
      '); try { [Console]::Out.Write($process.StartTime.ToUniversalTime().ToString("o")) } finally { $process.Dispose() }',
  );
}

function processIdentityRequest(command, args, options) {
  if (
    (options && options.shell) ||
    !Array.isArray(args) ||
    args.length !== 4 ||
    typeof args[3] !== "string"
  )
    return null;
  var executable = buildBootIdentityInvocation(HOST_ENVIRONMENT).command;
  if (path.resolve(String(command)).toLowerCase() !== path.resolve(executable).toLowerCase()) {
    return null;
  }
  var match = /^\$process = \[System\.Diagnostics\.Process\]::GetProcessById\((\d{1,10})\);/.exec(
    args[3],
  );
  if (!match) return null;
  var pid = Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 0 || pid > 4294967295) return null;
  var expected = processIdentityArguments(pid);
  return expected.every(function (argument, index) {
    return args[index] === argument;
  })
    ? pid
    : null;
}

function loadNativeProcessStartTime(packageDirectory) {
  var kernel32 = moduleApi
    .createRequire(path.join(packageDirectory, "package.json"))("koffi")
    .load("kernel32.dll");
  var openProcess = kernel32.func(
    "void * __stdcall OpenProcess(uint32_t access, int32_t inheritHandle, uint32_t processId)",
  );
  var getProcessTimes = kernel32.func(
    "int32_t __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernel, void *user)",
  );
  var closeHandle = kernel32.func("int32_t __stdcall CloseHandle(void *handle)");
  return function (pid) {
    var handle = openProcess(4096, 0, pid);
    if (!handle) return null;
    try {
      var creation = Buffer.alloc(8);
      if (!getProcessTimes(handle, creation, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)))
        return null;
      var ticks = creation.readBigUInt64LE();
      return ticks === 0n ? null : Number(ticks / 10000n - 11644473600000n);
    } finally {
      closeHandle(handle);
    }
  };
}

function readWindowsProcessIdentity(pid) {
  var args = processIdentityArguments(pid);
  if (process.platform !== "win32") throw new Error("The Windows host probe is unavailable");
  var started = Date.now();
  try {
    var timestamp = nativeProcessStartTime ? nativeProcessStartTime(pid) : null;
    if (timestamp !== null) {
      process.stderr.write(
        "[host-runtime] process identity native " + (Date.now() - started) + "ms\n",
      );
      return { status: 0, signal: null, stdout: new Date(timestamp).toISOString(), stderr: "" };
    }
  } catch {}
  var invocation = buildBootIdentityInvocation(HOST_ENVIRONMENT);
  var result = hostSpawnSync(invocation.command, args, invocation.options);
  process.stderr.write("[host-runtime] process identity probe " + (Date.now() - started) + "ms\n");
  return result;
}

function createControlPlaneHooks(packageDirectory) {
  if (!packageDirectory || !path.isAbsolute(packageDirectory)) {
    throw new Error("The trusted OpenClaw package directory is unavailable");
  }
  var root = hostRealpathSync(packageDirectory);
  var metadata = JSON.parse(hostReadFileSync(path.join(root, "package.json"), "utf8"));
  var pinnedModules = Object.prototype.hasOwnProperty.call(
    PINNED_MODULES_BY_VERSION,
    metadata.version,
  )
    ? PINNED_MODULES_BY_VERSION[metadata.version]
    : undefined;
  if (metadata.name !== "openclaw" || !pinnedModules) {
    throw new Error("The OpenClaw host runtime bridge requires a pinned supported runtime");
  }
  var verifiedModules = new Set();
  var providerUrl = urls.pathToFileURL(__filename).href;
  var bridgeSource = [
    'import childProcess from "node:child_process";',
    "import hostRuntime from " + JSON.stringify(providerUrl) + ";",
    'export * from "node:child_process";',
    "export default childProcess;",
    "export const spawn = childProcess.spawn;",
    "export const exec = childProcess.exec;",
    "export const execFile = childProcess.execFile;",
    "export const execSync = childProcess.execSync;",
    "export const execFileSync = childProcess.execFileSync;",
    "export const fork = childProcess.fork;",
    "export function spawnSync(command, args, options) {",
    "  if (hostRuntime.isBootIdentityInvocation(command, args, options)) {",
    "    return hostRuntime.readWindowsBootIdentity();",
    "  }",
    "  const processId = hostRuntime.processIdentityRequest(command, args, options);",
    "  if (processId !== null) return hostRuntime.readWindowsProcessIdentity(processId);",
    "  return childProcess.spawnSync(command, args, options);",
    "}",
  ].join("\n");
  var bridgeUrl = "data:text/javascript," + encodeURIComponent(bridgeSource);
  return {
    load: function (url, context, nextLoad) {
      var result = nextLoad(url, context);
      if (!url.startsWith("file:")) return result;
      var file = urls.fileURLToPath(url);
      var relative = path.relative(root, file).split(path.sep).join("/");
      var expected = Object.prototype.hasOwnProperty.call(pinnedModules, relative)
        ? pinnedModules[relative]
        : undefined;
      if (!expected) return result;
      verifiedModules.delete(url);
      if (hostRealpathSync(file) !== path.join(root, relative)) {
        throw new Error("The OpenClaw control-plane module resolves outside its trusted path");
      }
      if (
        result.source === null ||
        result.source === undefined ||
        crypto.createHash("sha256").update(result.source).digest("hex") !== expected
      ) {
        throw new Error("The pinned OpenClaw control-plane module changed: " + relative);
      }
      verifiedModules.add(url);
      return result;
    },
    resolve: function (specifier, context, nextResolve) {
      if (
        (specifier === "node:child_process" || specifier === "child_process") &&
        verifiedModules.has(context.parentURL)
      ) {
        return { url: bridgeUrl, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  };
}

function initialize(packageDirectory) {
  if (installed || process.platform !== "win32" || !packageDirectory) return;
  moduleApi.registerHooks(createControlPlaneHooks(packageDirectory));
  try {
    nativeProcessStartTime = loadNativeProcessStartTime(packageDirectory);
  } catch {}
  installed = true;
}

module.exports = {
  PINNED_MODULES: PINNED_MODULES,
  PINNED_MODULES_BY_VERSION: PINNED_MODULES_BY_VERSION,
  buildBootIdentityInvocation: buildBootIdentityInvocation,
  isBootIdentityInvocation: isBootIdentityInvocation,
  readWindowsBootIdentity: readWindowsBootIdentity,
  processIdentityArguments: processIdentityArguments,
  processIdentityRequest: processIdentityRequest,
  readWindowsProcessIdentity: readWindowsProcessIdentity,
  createControlPlaneHooks: createControlPlaneHooks,
  initialize: initialize,
};
