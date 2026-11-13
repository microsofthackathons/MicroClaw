import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function normalizeNpmRegistry(value) {
  const message = "MicroClaw npm registry must be an absolute HTTP(S) URL without credentials or query.";
  if (typeof value !== "string" || !/^https?:\/\//i.test(value.trim()) ||
      /[\s\\]/.test(value.trim())) throw new Error(message);
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error(message); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username ||
      url.password || url.search || url.hash) throw new Error(message);
  return url.href.replace(/\/+$/, "");
}

export function resolveBuildNpmRegistry(environment = process.env) {
  const explicit = environment.MICROCLAW_NPM_REGISTRY || environment.MSIX_NPM_REGISTRY;
  if (explicit) return normalizeNpmRegistry(explicit);
  const filename = fileURLToPath(new URL("../../deployer/assets/npm-registry.json", import.meta.url));
  const config = JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, ""));
  if (config.schema !== 1) throw new Error("Unsupported MicroClaw npm source configuration.");
  return normalizeNpmRegistry(config.registry);
}

export function writeBundledNpmRegistry(resourcesDirectory, registry) {
  fs.mkdirSync(resourcesDirectory, { recursive: true });
  fs.writeFileSync(path.join(resourcesDirectory, "npm-registry.json"),
    JSON.stringify({ schema: 1, registry: normalizeNpmRegistry(registry) }, null, 2) + "\n");
}

export function npmRegistryEnvironment(environment, registry) {
  const settings = {
    npm_config_registry: normalizeNpmRegistry(registry),
    npm_config_replace_registry_host: "npmjs",
    npm_config_fetch_retries: "1",
    npm_config_fetch_retry_mintimeout: "1000",
    npm_config_fetch_retry_maxtimeout: "3000",
    npm_config_fetch_timeout: "60000",
  };
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([key]) => !Object.hasOwn(settings, key.toLowerCase()))),
    ...settings,
  };
}
