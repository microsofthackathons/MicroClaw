import { GatewayRequestError } from "./gateway-client";
import { assertChatModelSupported } from "./provider-model-capabilities";
import { assertModelProviderSupported } from "./model-provider-policy";
import { supportsLocalModelGatewayVersion, type LocalModelGateway } from "./local-model-service";
import {
  assertModelConfigUnchanged,
  getPrimaryModel,
  waitForDefaultModelApplied,
} from "./model-setup";

export interface DefaultModelSelection {
  modelRef: string;
  expectedConfig: unknown;
}

interface Dependencies {
  gateway():
    | (Pick<
        LocalModelGateway,
        "connected" | "serverVersion" | "connectionGeneration" | "methods"
      > & {
        request(
          method: string,
          params?: Record<string, unknown>,
          timeoutMs?: number,
        ): Promise<unknown>;
      })
    | null;
  readConfig(): unknown;
  assertMutable(): void;
  prepareModel?(modelRef: string, expectedConfig: unknown): Promise<unknown>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function selectDefaultModel(
  deps: Dependencies,
  input: unknown,
): Promise<{ modelRef: string }> {
  const params = object(input);
  const ref = params.modelRef;
  if (
    Object.keys(params).some((key) => key !== "modelRef" && key !== "expectedConfig") ||
    !Object.hasOwn(params, "expectedConfig") ||
    typeof ref !== "string" ||
    ref.length > 1024 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*\/[^\s\\*]+$/.test(ref)
  )
    throw new Error(
      "Choose an exact configured default model and supply the original configuration",
    );
  if (ref.startsWith("llama-cpp/"))
    throw new Error("Use local model selection so preparation and file checks are preserved");
  assertModelProviderSupported(ref);
  assertChatModelSupported(ref);
  deps.assertMutable();
  let expectedConfig = params.expectedConfig;
  assertModelConfigUnchanged(expectedConfig, deps.readConfig());
  if (deps.prepareModel) expectedConfig = await deps.prepareModel(ref, expectedConfig);
  deps.assertMutable();
  assertModelConfigUnchanged(expectedConfig, deps.readConfig());
  const gateway = deps.gateway();
  if (!gateway?.connected || !supportsLocalModelGatewayVersion(gateway.serverVersion))
    throw new Error("Default model selection requires a connected, supported OpenClaw Gateway");
  for (const method of ["config.get", "config.patch"]) {
    if (!gateway.methods.includes(method)) throw new Error(`Gateway does not support ${method}`);
  }
  const generation = gateway.connectionGeneration;
  const assertCurrent = () => {
    deps.assertMutable();
    if (
      deps.gateway() !== gateway ||
      !gateway.connected ||
      gateway.connectionGeneration !== generation
    )
      throw new Error("Gateway connection changed; reload the model settings");
  };
  const request = async (method: string, values: Record<string, unknown>, timeoutMs?: number) => {
    assertCurrent();
    const result = await gateway.request(method, values, timeoutMs);
    assertCurrent();
    return object(result);
  };
  const snapshot = await request("config.get", {});
  if (
    snapshot.valid !== true ||
    typeof snapshot.hash !== "string" ||
    !snapshot.hash ||
    !snapshot.config
  )
    throw new Error("The Gateway configuration is unavailable or invalid");
  const config = object(snapshot.config);
  const slash = ref.indexOf("/");
  const providerId = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  const provider = object(object(object(config.models).providers)[providerId]);
  if (
    !Array.isArray(provider.models) ||
    !provider.models.some((model) => object(model).id === modelId)
  )
    throw new Error("The selected model is not configured");
  assertModelConfigUnchanged(expectedConfig, deps.readConfig());
  if (getPrimaryModel(config) !== ref) {
    let result: Record<string, unknown>;
    try {
      result = await request("config.patch", {
        baseHash: snapshot.hash,
        raw: JSON.stringify({ agents: { defaults: { model: { primary: ref } } } }),
      });
    } catch (cause) {
      if (
        cause instanceof GatewayRequestError &&
        (cause.code === "INVALID_REQUEST" || cause.code === "FORBIDDEN")
      )
        throw cause;
      throw new Error(
        "The default model change could not be confirmed. It may have been saved; reload settings before retrying. No retry or rollback was attempted.",
        { cause },
      );
    }
    if (result.ok !== true || getPrimaryModel(object(result.config)) !== ref)
      throw new Error(
        "The saved default model could not be confirmed; reload settings before retrying",
      );
    const stats = object(object(object(result.sentinel).payload).stats);
    if (stats.requiresRestart === true)
      throw new Error(
        "The model settings were saved, but OpenClaw requires a Gateway restart to apply them",
      );
  }
  try {
    const applied = await waitForDefaultModelApplied(ref, (timeoutMs) =>
      request("config.get", {}, timeoutMs),
    );
    if (!applied) throw new Error("The Gateway is still applying the saved model settings");
  } catch (cause) {
    throw new Error(
      "The default model is saved, but its application could not be confirmed. Reload settings before retrying; no restart or rollback was attempted.",
      { cause },
    );
  }
  return { modelRef: ref };
}
