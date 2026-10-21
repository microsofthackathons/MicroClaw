import { isModelProviderSupported } from "./model-provider-policy";
import { isDeepStrictEqual } from "node:util";
import { MODEL_APPLY_SETTLE_TIMEOUT_MS } from "./constants";

type JsonObject = Record<string, unknown>;

export function assertModelConfigUnchanged(expected: unknown, current: unknown): void {
  if (!isDeepStrictEqual(expected ?? {}, current ?? {})) {
    throw new Error("Model configuration changed while editing; reload it and try again");
  }
}

function asJsonObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function getPrimaryModel(config: JsonObject): string | undefined {
  const agents = asJsonObject(config.agents);
  const defaults = asJsonObject(agents?.defaults);
  const model = defaults?.model;
  if (typeof model === "string") return model;
  const modelConfig = asJsonObject(model);
  return typeof modelConfig?.primary === "string" ? modelConfig.primary : undefined;
}

/** Confirm the applied revision, not just the config file written by the RPC. */
export async function waitForDefaultModelApplied(
  modelRef: string,
  readSnapshot: (timeoutMs: number) => Promise<unknown>,
): Promise<boolean> {
  const deadline = Date.now() + MODEL_APPLY_SETTLE_TIMEOUT_MS;
  while (true) {
    const snapshot = asJsonObject(await readSnapshot(Math.max(1, deadline - Date.now())));
    const config = asJsonObject(snapshot?.config);
    if (snapshot?.valid !== true || !config)
      throw new Error("The saved Gateway configuration is invalid");
    if (getPrimaryModel(config) !== modelRef)
      throw new Error("The saved model selection changed; reload the model settings");
    if (
      typeof snapshot.configRevisionHash === "string" &&
      snapshot.configRevisionHash.length > 0 &&
      snapshot.appliedConfigHash === snapshot.configRevisionHash
    )
      return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export function hasConfiguredModel(config: unknown): boolean {
  const root = asJsonObject(config);
  if (!root) return false;

  const models = asJsonObject(root.models);
  const providers = asJsonObject(models?.providers);
  return Boolean(providers && Object.keys(providers).some(isModelProviderSupported));
}
