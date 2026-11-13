import { isDeepStrictEqual } from "node:util";
import { hasConfiguredModel } from "./model-setup";
import { assertWindowsNodeMxcModelOrPluginChange } from "./windows-node-mxc-model-config";

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "$schema",
  "meta",
  "models",
  "agents",
  "tools",
  "gateway",
  "skills",
  "plugins",
  "browser",
  "commands",
  "permissions",
  "hooks",
  "cron",
  "mcp",
  "channels",
  "telemetry",
  "memory",
  "logging",
  "sandbox",
]);

export function assertConfigWriteAllowed(
  config: unknown,
  _existingConfig: unknown,
): asserts config is Record<string, unknown> {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error("config:write — invalid config: must be a plain object");
  }

  const existingConfig =
    typeof _existingConfig === "object" &&
    _existingConfig !== null &&
    !Array.isArray(_existingConfig)
      ? _existingConfig
      : {};
  const keys = new Set([...Object.keys(existingConfig), ...Object.keys(config)]);
  const changedUnknownKeys = [...keys].filter(
    (key) =>
      !ALLOWED_TOP_LEVEL_KEYS.has(key) &&
      !isDeepStrictEqual(
        (config as Record<string, unknown>)[key],
        (existingConfig as Record<string, unknown>)[key],
      ),
  );
  if (changedUnknownKeys.length > 0) {
    throw new Error(`config:write — disallowed top-level keys: ${changedUnknownKeys.join(", ")}`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a configuration object`);
  }
  return value as Record<string, unknown>;
}

function withoutSearchSettings(value: unknown): Record<string, unknown> {
  const config = structuredClone(object(value, "Gateway configuration"));
  if (config.tools !== undefined) {
    const tools = object(config.tools, "Gateway tools");
    if (tools.web !== undefined) {
      const web = object(tools.web, "Gateway web tools");
      delete web.search;
      delete web.searchProviders;
      if (Object.keys(web).length === 0) delete tools.web;
    }
    if (Object.keys(tools).length === 0) delete config.tools;
  }
  return config;
}

export function assertWindowsNodeMxcSearchOnlyChange(before: unknown, after: unknown): void {
  if (!isDeepStrictEqual(withoutSearchSettings(before), withoutSearchSettings(after))) {
    throw new Error("Search settings may not change other Gateway configuration");
  }
}

export function isPluginOnlyChange(before: unknown, after: unknown): boolean {
  const original = structuredClone(object(before, "Original Gateway configuration"));
  const next = structuredClone(object(after, "Gateway configuration"));
  const pluginsChanged = !isDeepStrictEqual(original.plugins, next.plugins);
  delete original.plugins;
  delete next.plugins;
  return pluginsChanged && isDeepStrictEqual(original, next);
}

export function assertInitialModelSetupChange(
  before: unknown,
  after: unknown,
  providerKey: string,
): void {
  const original = before === null ? {} : object(before, "Original Gateway configuration");
  const next = object(after, "Gateway configuration");
  if (hasConfiguredModel(original)) throw new Error("Initial model setup is already complete");
  if (!hasConfiguredModel(next)) throw new Error("Initial setup must configure a model");
  const providers = object(object(next.models, "Models").providers, "Model providers");
  object(providers[providerKey], "Selected model provider");
  const agents = object(next.agents, "Agents");
  const defaults = object(agents.defaults, "Agent defaults");
  const primary = object(defaults.model, "Default model").primary;
  if (
    typeof primary !== "string" ||
    !primary.startsWith(`${providerKey}/`) ||
    !primary.slice(providerKey.length + 1)
  ) {
    throw new Error("Initial setup must select a model from the configured provider");
  }

  const comparison = structuredClone(original);
  if (comparison.gateway === undefined || comparison.gateway === null) {
    const gateway = object(next.gateway, "Initial Gateway");
    const auth = object(gateway.auth, "Initial Gateway authentication");
    if (
      Object.keys(gateway).some((key) => !["port", "bind", "mode", "auth"].includes(key)) ||
      typeof gateway.port !== "number" ||
      !Number.isInteger(gateway.port) ||
      gateway.port < 1 ||
      gateway.port > 65535 ||
      gateway.bind !== "loopback" ||
      gateway.mode !== "local" ||
      Object.keys(auth).some((key) => !["mode", "token"].includes(key)) ||
      auth.mode !== "token" ||
      typeof auth.token !== "string" ||
      !/^[a-f0-9]{32,128}$/i.test(auth.token)
    ) {
      throw new Error("Initial Gateway must use local loopback and token authentication");
    }
    comparison.gateway = gateway;
  }
  assertWindowsNodeMxcModelOrPluginChange(comparison, next);
}
