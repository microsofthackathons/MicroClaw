import { GatewayRequestError, type GatewayChannelsStatusPayload } from "./gateway-client";

const WEIXIN_PLUGIN_ID = "openclaw-weixin";
const APPLY_TIMEOUT_MS = 30_000;

interface WeixinGateway {
  connected: boolean;
  connectionGeneration: number;
  methods: readonly string[];
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  getChannelsStatus(timeoutMs?: number): Promise<GatewayChannelsStatusPayload>;
}

interface Dependencies {
  gateway(): WeixinGateway | null;
  assertMutable(): void;
}

export class WeixinPluginActivationError extends Error {
  constructor(
    message: string,
    readonly restartRequired = false,
  ) {
    super(message);
    this.name = "WeixinPluginActivationError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function isKnownWeixinQrStartRejection(error: unknown): boolean {
  return (
    error instanceof GatewayRequestError &&
    (error.code === "INVALID_REQUEST" || error.code === "FORBIDDEN")
  );
}

export function isWeixinLoginReady(status: GatewayChannelsStatusPayload): boolean {
  const channel = status.channels?.[WEIXIN_PLUGIN_ID];
  return !!channel && channel.enabled !== false;
}

export async function setWeixinPluginEnabled(deps: Dependencies, enabled: boolean): Promise<void> {
  if (typeof enabled !== "boolean") throw new Error("Supply a boolean WeChat plugin state");
  deps.assertMutable();
  const gateway = deps.gateway();
  if (!gateway?.connected) throw new Error("Gateway not connected");
  if (
    !gateway.methods.includes("plugins.setEnabled") ||
    (enabled && !gateway.methods.includes("channels.status"))
  ) {
    throw new Error("This Gateway does not support live WeChat plugin activation");
  }
  const generation = gateway.connectionGeneration;
  const assertCurrent = () => {
    deps.assertMutable();
    if (
      deps.gateway() !== gateway ||
      !gateway.connected ||
      gateway.connectionGeneration !== generation
    )
      throw new Error("Gateway connection changed while applying the WeChat plugin state");
  };
  const deadline = Date.now() + APPLY_TIMEOUT_MS;
  const result = record(
    await gateway.request(
      "plugins.setEnabled",
      { pluginId: WEIXIN_PLUGIN_ID, enabled },
      APPLY_TIMEOUT_MS,
    ),
  );
  assertCurrent();
  if (result.restartRequired === true) {
    throw new WeixinPluginActivationError("The WeChat plugin requires a Gateway restart", true);
  }
  const runtime = record(result.runtime);
  if (
    result.ok !== true ||
    !Number.isInteger(runtime.generation) ||
    !Array.isArray(runtime.pluginIds) ||
    !runtime.pluginIds.includes(WEIXIN_PLUGIN_ID)
  )
    throw new Error("The Gateway did not confirm the WeChat plugin runtime application");
  if (!enabled) return;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("The WeChat channel is not ready yet; retry activation");
    const status = await gateway.getChannelsStatus(remaining);
    assertCurrent();
    if (isWeixinLoginReady(status)) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
  }
}
