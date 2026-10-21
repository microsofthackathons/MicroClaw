import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { LOCAL_MODEL_PRESETS } from "./local-model-catalog";
import type { LocalModelFileStatus } from "./local-model-types";

type JsonObject = Record<string, unknown>;
const MAX_PRESET_BYTES = 128 * 1024;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function localPath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && !/^(?:\\\\|\/\/)/.test(value);
}

function failureStatus(error: unknown): LocalModelFileStatus {
  const code = object(error)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  console.warn("[local-model-files] Could not inspect managed model metadata:", error);
  return "unknown";
}

function fileStatus(file: unknown): LocalModelFileStatus {
  if (!localPath(file)) return "unknown";
  try {
    const info = statSync(file);
    return info.isFile() && info.size > 0 ? "present" : "missing";
  } catch (error) {
    return failureStatus(error);
  }
}

/** Inspect only pinned cache filenames; do not scan directories or read weights. */
export function inspectManagedLocalModelCache(
  provider: JsonObject,
  stateDir: string,
): Map<string, LocalModelFileStatus> {
  const configured = object(provider.params)?.modelCacheDir;
  const cacheDir = configured === undefined ? join(stateDir, "models", "llama.cpp") : configured;
  return new Map(
    LOCAL_MODEL_PRESETS.map((preset): [string, LocalModelFileStatus] => {
      if (!localPath(cacheDir)) return [preset.modelRef, "unknown"];
      try {
        const info = statSync(join(cacheDir, preset.cacheFile));
        return [
          preset.modelRef,
          info.isFile() && info.size === preset.downloadBytes ? "present" : "missing",
        ];
      } catch (error) {
        return [preset.modelRef, failureStatus(error)];
      }
    }),
  );
}

function readPreset(file: string): string {
  const descriptor = openSync(file, "r");
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > MAX_PRESET_BYTES) {
      throw new Error("Managed model preset is not a bounded regular file");
    }
    const buffer = Buffer.alloc(MAX_PRESET_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes > MAX_PRESET_BYTES) throw new Error("Managed model preset exceeds the size limit");
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

export function parseManagedModelPaths(contents: string): Map<string, string> {
  const paths = new Map<string, string>();
  let section = "";
  for (const line of contents.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const entry = /^\s*(?:model|m|LLAMA_ARG_MODEL)\s*=\s*(.*?)\s*$/.exec(line);
    if (!section || section === "*" || !entry) continue;
    const value = entry[1];
    const quoted = /^(["'])(.*?)\1\s*(?:[;#].*)?$/.exec(value);
    paths.set(section, quoted ? quoted[2] : value.replace(/\s+[;#].*$/, "").trim());
  }
  return paths;
}

/** Read only the small router preset and file metadata, never GGUF contents or a model endpoint. */
export function inspectLocalModelFiles(provider: JsonObject): Map<string, LocalModelFileStatus> {
  const models = (Array.isArray(provider.models) ? provider.models : [])
    .map(object)
    .filter((model): model is JsonObject => Boolean(model && typeof model.id === "string"));
  const service = object(provider.localService);
  if (!service) return new Map(models.map((model) => [String(model.id), "external"]));
  const args = Array.isArray(service.args) ? service.args : [];
  const presetIndex = args.indexOf("--models-preset");
  const preset = presetIndex >= 0 ? args[presetIndex + 1] : undefined;
  let paths: Map<string, string> | undefined;
  if (preset !== undefined) {
    if (!localPath(preset)) return new Map(models.map((model) => [String(model.id), "unknown"]));
    try {
      paths = parseManagedModelPaths(readPreset(preset));
    } catch (error) {
      const status = failureStatus(error);
      return new Map(models.map((model) => [String(model.id), status]));
    }
  }
  return new Map(
    models.map((model) => {
      const id = String(model.id);
      const file = paths?.get(id) ?? object(model.params)?.modelPath;
      return [id, fileStatus(file)];
    }),
  );
}
