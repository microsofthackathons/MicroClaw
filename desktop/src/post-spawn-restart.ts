import { POST_SPAWN_CHANNEL_READY_TIMEOUT_MS } from "./constants";
import type { GatewayChannelsStatusPayload } from "./gateway-client";

interface PluginConfig {
  plugins?: {
    entries?: Record<string, { enabled?: boolean }>;
  };
}

export function requiresPostSpawnChannelCheck(config: PluginConfig | null): boolean {
  return config?.plugins?.entries?.["openclaw-weixin"]?.enabled === true;
}

export function isWeixinStartupComplete(
  status: GatewayChannelsStatusPayload | null | undefined,
): boolean {
  const summary = status?.channels?.["openclaw-weixin"];
  if (!summary) return false;

  const accounts = status?.channelAccounts?.["openclaw-weixin"];
  if (accounts?.length) {
    return accounts.every(
      (account) =>
        account.enabled === false || account.configured === false || account.running === true,
    );
  }
  // An installed channel with no login has nothing to start. A linked account,
  // on the other hand, is not proof that its provider actually started.
  return summary.configured === false || summary.running === true;
}

export async function waitForPostSpawnChannels(options: {
  readStatus: (timeoutMs: number) => Promise<GatewayChannelsStatusPayload>;
  isCurrent: () => boolean;
  onError: (error: unknown) => void;
}): Promise<"ready" | "restart" | "cancelled"> {
  const deadline = Date.now() + POST_SPAWN_CHANNEL_READY_TIMEOUT_MS;
  while (options.isCurrent()) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return "restart";
    try {
      const status = await options.readStatus(remainingMs);
      if (!options.isCurrent()) return "cancelled";
      if (isWeixinStartupComplete(status)) return "ready";
    } catch (error) {
      if (!options.isCurrent()) return "cancelled";
      options.onError(error);
    }
    const delayMs = Math.min(500, deadline - Date.now());
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return "cancelled";
}
