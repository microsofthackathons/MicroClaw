import { isDeepStrictEqual } from "node:util";
import { removeGatewayAddedMigrationMarkers } from "./gateway-config-migrations";
import { assertModelConfigUnchanged, ModelConfigRestartRequiredError } from "./model-setup";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Model configuration must contain valid configuration objects");
  return value as JsonObject;
}

function nonModelOrPluginConfiguration(value: unknown, expectedMeta: JsonObject): JsonObject {
  const config = structuredClone(object(value));
  if (config.models !== undefined) {
    const models = object(config.models);
    if (models.providers !== undefined) object(models.providers);
  }
  delete config.models;
  delete config.plugins;
  if (config.agents !== undefined) {
    const agents = object(config.agents);
    if (agents.defaults !== undefined) {
      const defaults = object(agents.defaults);
      delete defaults.model;
      delete defaults.models;
      if (Object.keys(defaults).length === 0) delete agents.defaults;
    }
    if (Object.keys(agents).length === 0) delete config.agents;
  }
  if (config.meta !== undefined) {
    const meta = object(config.meta);
    // The Gateway stamps these fields when committing a configuration update.
    delete meta.lastTouchedAt;
    delete meta.lastTouchedVersion;
    removeGatewayAddedMigrationMarkers(meta, expectedMeta);
    if (Object.keys(meta).length === 0) delete config.meta;
  }
  return config;
}

export function assertWindowsNodeMxcModelOrPluginChange(before: unknown, after: unknown): void {
  const config = object(before);
  const expectedMeta = config.meta === undefined ? {} : object(config.meta);
  if (
    !isDeepStrictEqual(
      nonModelOrPluginConfiguration(before, expectedMeta),
      nonModelOrPluginConfiguration(after, expectedMeta),
    )
  )
    throw new Error(
      "MXC configuration update may change only model or plugin settings. Other Gateway configuration remains locked.",
    );
}

export function assertWindowsNodeMxcModelAndPluginSettingsUnchanged(
  before: unknown,
  after: unknown,
): void {
  const project = (value: unknown) => {
    const config = object(value);
    const defaults = object(object(config.agents ?? {}).defaults ?? {});
    return {
      models: config.models,
      model: defaults.model,
      defaultsModels: defaults.models,
      plugins: config.plugins,
    };
  };
  if (!isDeepStrictEqual(project(before), project(after)))
    throw new Error(
      "The saved model or plugin settings changed during the required Gateway restart",
    );
}

function restartHash(error: unknown): string | null {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (error instanceof ModelConfigRestartRequiredError) return error.savedHash || null;
    error = error.cause;
  }
  return null;
}

export interface WindowsNodeMxcModelUpdateHooks<T> {
  label?: "Model" | "Plugin";
  readConfig(): unknown;
  pause(): Promise<void>;
  apply(): Promise<T>;
  restartSavedConfig(hash: string): Promise<T>;
  verify(): Promise<void>;
  resume(): void;
  failClosed(): Promise<void>;
}

export async function runWindowsNodeMxcModelUpdate<T>(
  hooks: WindowsNodeMxcModelUpdateHooks<T>,
): Promise<T> {
  const label = hooks.label ?? "Model";
  const before = structuredClone(hooks.readConfig());
  try {
    await hooks.pause();
    let result: T;
    try {
      result = await hooks.apply();
    } catch (error) {
      const hash = restartHash(error);
      if (!hash) throw error;
      assertWindowsNodeMxcModelOrPluginChange(before, hooks.readConfig());
      result = await hooks.restartSavedConfig(hash);
    }
    const applied = structuredClone(hooks.readConfig());
    assertWindowsNodeMxcModelOrPluginChange(before, applied);
    await hooks.verify();
    assertModelConfigUnchanged(applied, hooks.readConfig());
    hooks.resume();
    return result;
  } catch (error) {
    try {
      await hooks.failClosed();
    } catch (lockingError) {
      throw new AggregateError(
        [error, lockingError],
        `${label} update could not be confirmed and MXC recovery failed. Execution remains locked.`,
        { cause: lockingError },
      );
    }
    throw new Error(
      `${label} update could not be confirmed. It may have been saved; execution remains locked. Reload settings and retry MXC readiness before continuing.`,
      { cause: error },
    );
  }
}
