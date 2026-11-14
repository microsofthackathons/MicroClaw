import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface NpmRegistryPaths {
  installDir: string;
  resourcesDir?: string;
  defaultConfigPath?: string;
}

export function normalizeNpmRegistry(value: unknown): string {
  const message =
    "MicroClaw npm registry must be an absolute HTTP(S) URL without credentials or query.";
  if (typeof value !== "string" || !/^https?:\/\//i.test(value.trim()) ||
      /[\s\\]/.test(value.trim())) throw new Error(message);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(message);
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username ||
      url.password || url.search || url.hash) throw new Error(message);
  return url.href.replace(/\/+$/, "");
}

function readOptionalJson(filename: string): Record<string, unknown> | undefined {
  let contents: string;
  try {
    contents = fs.readFileSync(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("MicroClaw npm source configuration could not be read.", { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(contents.replace(/^\uFEFF/, ""));
  } catch {
    // JSON parser diagnostics may include operator-supplied registry credentials.
    throw new Error("MicroClaw npm source configuration contains invalid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("MicroClaw npm source configuration must be an object.");
  return value as Record<string, unknown>;
}

export function resolveMicroClawNpmRegistry(
  environment: NodeJS.ProcessEnv,
  locations: NpmRegistryPaths,
): string {
  if (environment.MICROCLAW_NPM_REGISTRY)
    return normalizeNpmRegistry(environment.MICROCLAW_NPM_REGISTRY);
  const dedicated = path.join(locations.installDir, "install-state", "npm-registry.json");
  // Older installations recorded their selected source in the committed manifest.
  const saved = readOptionalJson(dedicated);
  if (saved) {
    if (saved.schema !== 1) throw new Error("Unsupported MicroClaw npm source configuration.");
    return normalizeNpmRegistry(saved.registry);
  }
  const manifest = readOptionalJson(path.join(locations.installDir, "install-state", "install-manifest.json"));
  if (manifest?.npmRegistry !== undefined) return normalizeNpmRegistry(manifest.npmRegistry);
  for (const filename of [
    ...(locations.resourcesDir ? [path.join(locations.resourcesDir, "npm-registry.json")] : []),
    locations.defaultConfigPath ?? path.resolve(__dirname, "../../deployer/assets/npm-registry.json"),
  ]) {
    const config = readOptionalJson(filename);
    if (!config) continue;
    if (config.schema !== 1) throw new Error("Unsupported MicroClaw npm source configuration.");
    return normalizeNpmRegistry(config.registry);
  }
  throw new Error("MicroClaw default npm source configuration is missing.");
}

export function microClawNpmEnvironment(
  environment: NodeJS.ProcessEnv,
  locations: NpmRegistryPaths = {
    installDir: environment.MICROCLAW_DIR || path.join(os.homedir(), ".microclaw"),
    resourcesDir: process.resourcesPath,
  },
): Record<string, string> {
  const registry = resolveMicroClawNpmRegistry(environment, locations);
  const settings: Record<string, string> = {
    npm_config_registry: registry,
    npm_config_replace_registry_host: "npmjs",
    npm_config_fetch_retries: "1",
    npm_config_fetch_retry_mintimeout: "1000",
    npm_config_fetch_retry_maxtimeout: "3000",
    npm_config_fetch_timeout: "60000",
  };
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && !Object.hasOwn(settings, key.toLowerCase())) result[key] = value;
  }
  return { ...result, ...settings };
}
