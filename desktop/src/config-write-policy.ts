import { isDeepStrictEqual } from "node:util";

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

export function assertConfigWriteAllowed(config: unknown, _existingConfig: unknown): void {
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
