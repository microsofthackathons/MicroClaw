import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "./gateway-client";
import {
  isKnownWeixinQrStartRejection,
  isWeixinLoginReady,
  setWeixinPluginEnabled,
  WeixinPluginActivationError,
} from "./weixin-plugin-lifecycle";

function fixture() {
  const gateway = {
    connected: true,
    connectionGeneration: 1,
    methods: ["plugins.setEnabled", "channels.status"],
    request: vi.fn().mockResolvedValue({
      ok: true,
      restartRequired: false,
      runtime: { operationId: "activation", generation: 2, pluginIds: ["openclaw-weixin"] },
    }),
    getChannelsStatus: vi.fn().mockResolvedValue({
      channels: { "openclaw-weixin": { configured: false } },
    }),
  };
  const deps = { gateway: () => gateway, assertMutable: vi.fn() };
  return { gateway, deps };
}

afterEach(() => vi.useRealTimers());

describe("WeChat plugin live activation", () => {
  it("requires a registered, enabled channel rather than an authenticated account", () => {
    expect(isWeixinLoginReady({ channels: {} })).toBe(false);
    expect(isWeixinLoginReady({ channels: { "openclaw-weixin": { enabled: false } } })).toBe(false);
    expect(isWeixinLoginReady({ channels: { "openclaw-weixin": { configured: false } } })).toBe(
      true,
    );
  });
  it("uses the managed plugin lifecycle and confirms an unlinked channel without restarting", async () => {
    const { gateway, deps } = fixture();
    await setWeixinPluginEnabled(deps, true);
    expect(gateway.request).toHaveBeenCalledExactlyOnceWith(
      "plugins.setEnabled",
      { pluginId: "openclaw-weixin", enabled: true },
      30_000,
    );
    expect(gateway.getChannelsStatus).toHaveBeenCalledOnce();
  });

  it("waits for registration without requiring a healthy old account to log in again", async () => {
    vi.useFakeTimers();
    const { gateway, deps } = fixture();
    gateway.getChannelsStatus
      .mockResolvedValueOnce({ channels: {} })
      .mockResolvedValueOnce({ channels: {} })
      .mockResolvedValue({
        channels: { "openclaw-weixin": { configured: true, running: false } },
        channelAccounts: { "openclaw-weixin": [{ configured: true, running: false }] },
      });
    const done = vi.fn();
    const operation = setWeixinPluginEnabled(deps, true).then(done);
    await vi.advanceTimersByTimeAsync(250);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    await operation;
    expect(done).toHaveBeenCalledOnce();
    expect(gateway.request).toHaveBeenCalledOnce();
  });

  it("disables through the lifecycle receipt without waiting for a removed channel", async () => {
    const { gateway, deps } = fixture();
    await setWeixinPluginEnabled(deps, false);
    expect(gateway.request).toHaveBeenCalledWith(
      "plugins.setEnabled",
      { pluginId: "openclaw-weixin", enabled: false },
      30_000,
    );
    expect(gateway.getChannelsStatus).not.toHaveBeenCalled();
  });

  it.each([undefined, { generation: 2, pluginIds: ["another-plugin"] }])(
    "does not accept an unrelated or missing application receipt: %j",
    async (runtime) => {
      const { gateway, deps } = fixture();
      gateway.request.mockResolvedValue({ ok: true, runtime });
      await expect(setWeixinPluginEnabled(deps, true)).rejects.toThrow("did not confirm");
      expect(gateway.getChannelsStatus).not.toHaveBeenCalled();
    },
  );

  it("exposes an explicit restart requirement without starting a restart", async () => {
    const { gateway, deps } = fixture();
    gateway.request.mockResolvedValue({ ok: true, restartRequired: true });
    const error = await setWeixinPluginEnabled(deps, true).catch((cause) => cause);
    expect(error).toBeInstanceOf(WeixinPluginActivationError);
    expect(error.restartRequired).toBe(true);
    expect(gateway.request).toHaveBeenCalledOnce();
    expect(gateway.getChannelsStatus).not.toHaveBeenCalled();
  });

  it("bounds readiness waits without repeating writes or restarting", async () => {
    vi.useFakeTimers();
    const { gateway, deps } = fixture();
    gateway.getChannelsStatus.mockResolvedValue({ channels: {} });
    const operation = setWeixinPluginEnabled(deps, true);
    const failure = expect(operation).rejects.toThrow("not ready yet");
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(gateway.request).toHaveBeenCalledOnce();
  });

  it.each(["disconnected", "unsupported", "locked", "invalid"])(
    "does not persist changes when %s",
    async (state) => {
      const { gateway, deps } = fixture();
      if (state === "disconnected") gateway.connected = false;
      if (state === "unsupported") gateway.methods = [];
      if (state === "locked")
        deps.assertMutable.mockImplementation(() => {
          throw new Error("MXC locked");
        });
      await expect(
        setWeixinPluginEnabled(deps, state === "invalid" ? ("yes" as never) : true),
      ).rejects.toThrow();
      expect(gateway.request).not.toHaveBeenCalled();
    },
  );

  it("rejects a receipt from a replaced connection", async () => {
    const { gateway, deps } = fixture();
    gateway.request.mockImplementation(async () => {
      gateway.connectionGeneration++;
      return { ok: true };
    });
    await expect(setWeixinPluginEnabled(deps, true)).rejects.toThrow("connection changed");
    expect(gateway.getChannelsStatus).not.toHaveBeenCalled();
  });

  it("does not report readiness from a reconnected Gateway", async () => {
    const { gateway, deps } = fixture();
    gateway.getChannelsStatus.mockImplementation(async () => {
      gateway.connectionGeneration++;
      return { channels: { "openclaw-weixin": { configured: false } } };
    });
    await expect(setWeixinPluginEnabled(deps, true)).rejects.toThrow("connection changed");
    expect(gateway.request).toHaveBeenCalledOnce();
  });

  it("revalidates MXC mutability after the asynchronous application", async () => {
    const { gateway, deps } = fixture();
    deps.assertMutable
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error("MXC locked");
      });
    await expect(setWeixinPluginEnabled(deps, true)).rejects.toThrow("MXC locked");
    expect(gateway.getChannelsStatus).not.toHaveBeenCalled();
  });
});

describe("QR start rejection certainty", () => {
  it.each(["INVALID_REQUEST", "FORBIDDEN"])("recognizes a pre-execution %s rejection", (code) => {
    expect(isKnownWeixinQrStartRejection(new GatewayRequestError("rejected", code))).toBe(true);
  });

  it.each([
    new Error("timed out"),
    new GatewayRequestError("failed", "UNAVAILABLE"),
    new Error("FORBIDDEN"),
  ])(
    "does not treat a timeout, execution failure, or message text as proof of cancellation: %s",
    (error) => {
      expect(isKnownWeixinQrStartRejection(error)).toBe(false);
    },
  );
});
