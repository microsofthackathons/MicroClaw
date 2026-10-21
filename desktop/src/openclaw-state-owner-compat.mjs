import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { isAbsolute, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const PINNED_OPENCLAW_VERSION = "2026.10.3";
export const PINNED_PID_MODULE = "pid-alive-CPS_shDt.mjs";
export const PINNED_PID_SHA256 = "15370817b8250160bfba29d3e0c46d8f1f09579b65abd0c83fc47c44c7ff4280";
export const PINNED_NATIVE_PLUGIN_MODULE = "plugin-generation-artifact-BfVPxt5p.mjs";
export const PINNED_NATIVE_PLUGIN_SHA256 =
  "7e85c00946c7a17c2858c9cfcfa206854e92a1e9c10ca2e4c106d81dfca8ef04";
const NATIVE_COMPANION_COPY =
  "\t\t\t\tcopyPluginSourceFile(member.source, member.boundary, target);\n" +
  "\t\t\t\tfs.chmodSync(target, 384 | Number(member.stat.mode & 64n));";
const LIVE_PID_CHECK = 'if (err.code !== "EPERM") return false;';
const DEAD_PID_CHECK = 'return err.code === "ESRCH";';
let enumerateProcesses;

export function readWindowsProcessIds(enumerate) {
  for (let capacity = 4096; capacity <= 262144; capacity *= 2) {
    const processIds = Buffer.alloc(capacity);
    const bytesReturned = Buffer.alloc(4);
    if (!enumerate(processIds, capacity, bytesReturned)) return null;
    const bytes = bytesReturned.readUInt32LE();
    if (bytes > capacity || bytes % 4 !== 0) return null;
    if (bytes === capacity) continue;
    const result = [];
    for (let offset = 0; offset < bytes; offset += 4) {
      result.push(processIds.readUInt32LE(offset));
    }
    return result;
  }
  return null;
}

export function isWindowsPidDefinitelyAbsent(pid, readIds) {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 4294967295) return false;
  try {
    const ids = readIds
      ? readIds()
      : process.platform === "win32" && enumerateProcesses
        ? readWindowsProcessIds(enumerateProcesses)
        : null;
    return Array.isArray(ids) && ids.includes(process.pid) && !ids.includes(pid);
  } catch {
    return false;
  }
}

export function patchPinnedWindowsPidSource(source) {
  for (const check of [LIVE_PID_CHECK, DEAD_PID_CHECK]) {
    const index = source.indexOf(check);
    if (index < 0 || source.indexOf(check, index + check.length) >= 0) {
      throw new Error("The pinned Windows process owner patch did not match exactly once");
    }
  }
  const patched = source
    .replace(
      LIVE_PID_CHECK,
      'if (err.code !== "EPERM" || microclawIsWindowsPidDefinitelyAbsent(pid)) return false;',
    )
    .replace(
      DEAD_PID_CHECK,
      'return err.code === "ESRCH" || (err.code === "EPERM" && microclawIsWindowsPidDefinitelyAbsent(pid));',
    );
  return (
    `import { isWindowsPidDefinitelyAbsent as microclawIsWindowsPidDefinitelyAbsent } from ${JSON.stringify(import.meta.url)};\n` +
    patched
  );
}

export function patchPinnedWindowsNativePluginSource(source) {
  const index = source.indexOf(NATIVE_COMPANION_COPY);
  if (
    index < 0 ||
    source.indexOf(NATIVE_COMPANION_COPY, index + NATIVE_COMPANION_COPY.length) >= 0
  ) {
    throw new Error("The pinned native plugin snapshot patch did not match exactly once");
  }
  return source.replace(
    NATIVE_COMPANION_COPY,
    NATIVE_COMPANION_COPY + "\n\t\t\t\twithPluginSourceFile(target, capturedRoot, () => {});",
  );
}

export function validatePinnedWindowsNativePluginPackage(packageDir) {
  if (!packageDir || !isAbsolute(packageDir)) {
    throw new Error("Native plugin compatibility requires an absolute OpenClaw package path");
  }
  const metadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  if (metadata.name !== "openclaw") throw new Error("Unexpected OpenClaw package identity");
  if (metadata.version !== PINNED_OPENCLAW_VERSION) return null;
  const file = realpathSync(join(packageDir, "dist", PINNED_NATIVE_PLUGIN_MODULE));
  const source = readFileSync(file);
  if (createHash("sha256").update(source).digest("hex") !== PINNED_NATIVE_PLUGIN_SHA256) {
    throw new Error("The OpenClaw native plugin module differs from the pinned source");
  }
  patchPinnedWindowsNativePluginSource(source.toString("utf8"));
  return { file };
}

export function validatePinnedWindowsPidPackage(packageDir) {
  if (!packageDir || !isAbsolute(packageDir)) {
    throw new Error("Windows state owner compatibility requires an absolute OpenClaw package path");
  }
  const metadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  if (metadata.name !== "openclaw") throw new Error("Unexpected OpenClaw package identity");
  if (metadata.version !== PINNED_OPENCLAW_VERSION) return null;
  const file = realpathSync(join(packageDir, "dist", PINNED_PID_MODULE));
  const source = readFileSync(file);
  if (createHash("sha256").update(source).digest("hex") !== PINNED_PID_SHA256) {
    throw new Error("The OpenClaw process owner module differs from the pinned source");
  }
  patchPinnedWindowsPidSource(source.toString("utf8"));
  return { file };
}

export function initializeWindowsStateOwnerCompatibility(packageDir) {
  if (process.platform !== "win32") return false;
  const target = validatePinnedWindowsPidPackage(packageDir);
  if (!target) return false;
  const nativePluginTarget = validatePinnedWindowsNativePluginPackage(packageDir);
  const require = createRequire(join(packageDir, "package.json"));
  let nativeEnumerate;
  enumerateProcesses = (...args) => {
    nativeEnumerate ??= require("koffi")
      .load("psapi.dll")
      .func(
        "int32_t __stdcall EnumProcesses(void *processIds, uint32_t bytes, void *bytesReturned)",
      );
    return nativeEnumerate(...args);
  };
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url.startsWith("file:") && url.includes(PINNED_NATIVE_PLUGIN_MODULE)) {
        if (realpathSync(fileURLToPath(url)) !== nativePluginTarget.file) return result;
        if (result.source === undefined || result.source === null) {
          throw new Error("The pinned OpenClaw native plugin source is unavailable");
        }
        const source =
          typeof result.source === "string" ? result.source : Buffer.from(result.source);
        if (createHash("sha256").update(source).digest("hex") !== PINNED_NATIVE_PLUGIN_SHA256) {
          throw new Error("The OpenClaw native plugin module changed before loading");
        }
        return { ...result, source: patchPinnedWindowsNativePluginSource(source.toString()) };
      }
      if (!url.startsWith("file:") || !url.includes(PINNED_PID_MODULE)) return result;
      if (realpathSync(fileURLToPath(url)) !== target.file) return result;
      if (result.source === undefined || result.source === null) {
        throw new Error("The pinned OpenClaw process owner source is unavailable");
      }
      const source = typeof result.source === "string" ? result.source : Buffer.from(result.source);
      if (createHash("sha256").update(source).digest("hex") !== PINNED_PID_SHA256) {
        throw new Error("The OpenClaw process owner module changed before loading");
      }
      return { ...result, source: patchPinnedWindowsPidSource(source.toString()) };
    },
  });
  return true;
}

if (process.platform === "win32" && process.env.MICROCLAW_WINDOWS_STATE_OWNER_COMPAT === "1") {
  initializeWindowsStateOwnerCompatibility(process.env.MICROCLAW_OPENCLAW_PACKAGE_DIR);
}
