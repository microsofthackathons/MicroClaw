type JsonObject = Record<string, unknown>;

export interface ModelConfigReloadPlan {
  restart: boolean;
  settleMs: number;
}

const DEFAULT_RELOAD_DEBOUNCE_MS = 300;
const HOT_RELOAD_SETTLE_BUFFER_MS = 150;
const RESTART_SETTLE_MS = 500;

function asJsonObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function resolveModelConfigReloadPlan(
  config: unknown,
  forceRestart = false,
): ModelConfigReloadPlan {
  const root = asJsonObject(config);
  const gateway = asJsonObject(root?.gateway);
  const reload = asJsonObject(gateway?.reload);
  const mode = typeof reload?.mode === "string" ? reload.mode : "hybrid";
  const configuredDebounce = reload?.debounceMs;
  const debounceMs =
    typeof configuredDebounce === "number" &&
    Number.isFinite(configuredDebounce) &&
    configuredDebounce >= 0
      ? configuredDebounce
      : DEFAULT_RELOAD_DEBOUNCE_MS;

  if (forceRestart || mode === "off" || mode === "restart") {
    return { restart: true, settleMs: RESTART_SETTLE_MS };
  }

  return {
    restart: false,
    settleMs: Math.max(debounceMs + HOT_RELOAD_SETTLE_BUFFER_MS, HOT_RELOAD_SETTLE_BUFFER_MS),
  };
}
