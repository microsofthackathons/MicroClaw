import { isDeepStrictEqual } from "node:util";
import { assertModelConfigUnchanged, ModelConfigRestartRequiredError } from "./model-setup";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Model configuration must contain valid configuration objects");
  return value as JsonObject;
}

function nonModelConfiguration(value: unknown): JsonObject {
  const config = structuredClone(object(value));
  if (config.models !== undefined) {
    const models = object(config.models);
    if (models.providers !== undefined) object(models.providers);
  }
  delete config.models;
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
    // The Gateway stamps these fields when committing an otherwise model-only update.
    delete meta.lastTouchedAt;
    delete meta.lastTouchedVersion;
    if (Object.keys(meta).length === 0) delete config.meta;
  }
  return config;
}

export function assertWindowsNodeMxcModelOnlyChange(before: unknown, after: unknown): void {
  if (!isDeepStrictEqual(nonModelConfiguration(before), nonModelConfiguration(after)))
    throw new Error(
      "MXC model setup may change only model providers, the default model and per-model settings. Other Gateway configuration remains locked.",
    );
}

export function assertWindowsNodeMxcModelSettingsUnchanged(before: unknown, after: unknown): void {
  const project = (value: unknown) => {
    const config = object(value);
    const defaults = object(object(config.agents ?? {}).defaults ?? {});
    return { models: config.models, model: defaults.model, defaultsModels: defaults.models };
  };
  if (!isDeepStrictEqual(project(before), project(after)))
    throw new Error("The saved model settings changed during the required Gateway restart");
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
  const before = structuredClone(hooks.readConfig());
  try {
    await hooks.pause();
    let result: T;
    try {
      result = await hooks.apply();
    } catch (error) {
      const hash = restartHash(error);
      if (!hash) throw error;
      assertWindowsNodeMxcModelOnlyChange(before, hooks.readConfig());
      result = await hooks.restartSavedConfig(hash);
    }
    const applied = structuredClone(hooks.readConfig());
    assertWindowsNodeMxcModelOnlyChange(before, applied);
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
        "Model update could not be confirmed and MXC recovery failed. Execution remains locked.",
        { cause: lockingError },
      );
    }
    throw new Error(
      "Model update could not be confirmed. It may have been saved; execution remains locked. Reload settings and retry MXC readiness before continuing.",
      { cause: error },
    );
  }
}
