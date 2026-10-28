import type { GatewayChannelsStatusPayload } from "./gateway-client";

export type WeixinQrStart = {
  ok: boolean;
  qrDataUrl?: string;
  sessionKey?: string;
  message: string;
  restartRequired?: boolean;
};

export type WeixinQrWait = {
  connected: boolean;
  pending?: boolean;
  expired?: boolean;
  cancelled?: boolean;
  qrDataUrl?: string;
  message: string;
  restartRequired?: boolean;
};

export type WeixinQrSnapshot = {
  state: "idle" | "starting" | "waiting" | "expired" | "connected" | "error";
  qrDataUrl?: string;
  message: string;
};

export class WeixinQrSession {
  private generation = 0;
  private snapshot: WeixinQrSnapshot = { state: "idle", message: "" };
  private starting: Promise<WeixinQrStart> | null = null;
  private result: WeixinQrStart | null = null;
  private polling: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;

  get status(): WeixinQrSnapshot {
    return { ...this.snapshot };
  }

  reset(): void {
    this.generation++;
    this.starting = null;
    this.result = null;
    this.polling = null;
    this.snapshot = { state: "idle", message: "" };
  }

  cancel(cancel: (sessionKey?: string) => Promise<void>): Promise<void> {
    if (this.stopping) {
      this.generation++;
      return this.stopping;
    }
    const active = this.snapshot.state === "starting" || this.snapshot.state === "waiting";
    const starting = this.starting;
    const result = this.result;
    const polling = this.polling;
    this.reset();
    const stopping = (async () => {
      const started = starting ? await starting : result;
      await cancel(active ? started?.sessionKey : undefined);
      if (polling) await polling;
    })();
    this.stopping = stopping;
    const settled = () => {
      if (this.stopping === stopping) this.stopping = null;
    };
    void stopping.then(settled, settled);
    return stopping;
  }

  start(
    start: () => Promise<WeixinQrStart>,
    wait: (sessionKey: string) => Promise<WeixinQrWait>,
  ): Promise<WeixinQrStart> {
    if (this.stopping) {
      const generation = this.generation;
      return this.stopping.then(() =>
        generation === this.generation
          ? this.start(start, wait)
          : { ok: false, message: "Login cancelled" },
      );
    }
    if (this.starting) return this.starting;
    if (this.snapshot.state === "waiting" && this.result) {
      return Promise.resolve({ ...this.result, qrDataUrl: this.snapshot.qrDataUrl });
    }
    const generation = ++this.generation;
    this.snapshot = { state: "starting", message: "" };
    const starting = this.begin(start, wait, generation);
    this.starting = starting;
    void starting.finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    return starting;
  }

  private async begin(
    start: () => Promise<WeixinQrStart>,
    wait: (sessionKey: string) => Promise<WeixinQrWait>,
    generation: number,
  ): Promise<WeixinQrStart> {
    try {
      const result = await start();
      if (generation !== this.generation)
        return { ...result, ok: false, message: "Login cancelled" };
      this.result = result;
      if (!result.ok || !result.qrDataUrl || !result.sessionKey) {
        this.snapshot = { state: "error", message: result.message };
        return result;
      }
      this.snapshot = { state: "waiting", qrDataUrl: result.qrDataUrl, message: result.message };
      this.polling = this.poll(wait, result.sessionKey, generation);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (generation === this.generation) this.snapshot = { state: "error", message };
      return { ok: false, message };
    }
  }

  private async poll(
    wait: (sessionKey: string) => Promise<WeixinQrWait>,
    sessionKey: string,
    generation: number,
  ): Promise<void> {
    try {
      while (generation === this.generation) {
        const result = await wait(sessionKey);
        if (generation !== this.generation) return;
        this.snapshot = {
          state: result.connected
            ? "connected"
            : result.expired
              ? "expired"
              : result.pending
                ? "waiting"
                : "error",
          message: result.message,
          ...(result.pending || result.expired
            ? { qrDataUrl: result.qrDataUrl ?? this.snapshot.qrDataUrl }
            : {}),
        };
        if (!result.pending || result.connected) return;
      }
    } catch (error) {
      if (generation === this.generation) {
        this.snapshot = {
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }
}

export function getWeixinRuntimeConnection(
  status: GatewayChannelsStatusPayload,
  accountId: string | undefined,
): { connected: boolean; connecting: boolean } {
  const account = status.channelAccounts?.["openclaw-weixin"]?.find(
    (entry) => entry.accountId === accountId,
  );
  return {
    connected: Boolean(accountId && account?.connected === true),
    connecting: Boolean(accountId && account?.running && !account.connected),
  };
}

export function ensureDefaultWeixinPlugin(value: object): boolean {
  const config = value as {
    plugins?: {
      entries?: Record<string, { enabled?: boolean }>;
      allow?: string[];
    };
  };
  config.plugins ??= {};
  config.plugins.entries ??= {};
  const entry = config.plugins.entries["openclaw-weixin"] ?? {};
  let changed = entry.enabled !== true;
  config.plugins.entries["openclaw-weixin"] = { ...entry, enabled: true };
  config.plugins.allow ??= [];
  if (!config.plugins.allow.includes("openclaw-weixin")) {
    config.plugins.allow.push("openclaw-weixin");
    changed = true;
  }
  return changed;
}
