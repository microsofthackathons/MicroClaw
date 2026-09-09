import { afterEach, describe, expect, it, vi } from "vitest";
import { POST_SPAWN_CHANNEL_READY_TIMEOUT_MS } from "./constants";
import type { GatewayChannelsStatusPayload } from "./gateway-client";
import {
  isWeixinStartupComplete,
  requiresPostSpawnChannelCheck,
  waitForPostSpawnChannels,
} from "./post-spawn-restart";

describe("requiresPostSpawnChannelCheck", () => {
  it("skips the channel check when WeChat is absent or disabled", () => {
    expect(requiresPostSpawnChannelCheck(null)).toBe(false);
    expect(
      requiresPostSpawnChannelCheck({
        plugins: { entries: { "openclaw-weixin": { enabled: false } } },
      }),
    ).toBe(false);
  });

  it("checks an enabled WeChat channel before deciding to restart", () => {
    expect(
      requiresPostSpawnChannelCheck({
        plugins: { entries: { "openclaw-weixin": { enabled: true } } },
      }),
    ).toBe(true);
  });
});

const runningStatus: GatewayChannelsStatusPayload = {
  channels: { "openclaw-weixin": { configured: true } },
  channelAccounts: {
    "openclaw-weixin": [{ enabled: true, configured: true, running: true }],
  },
};
const stoppedStatus: GatewayChannelsStatusPayload = {
  channels: { "openclaw-weixin": { configured: true } },
  channelAccounts: {
    "openclaw-weixin": [{ enabled: true, configured: true, running: false, linked: true }],
  },
};

describe("isWeixinStartupComplete", () => {
  it("accepts running accounts without a connected field", () => {
    expect(isWeixinStartupComplete(runningStatus)).toBe(true);
  });

  it("does not mistake linked credentials for a running provider", () => {
    expect(isWeixinStartupComplete(stoppedStatus)).toBe(false);
  });

  it("does not restart an installed channel that has not been configured", () => {
    expect(
      isWeixinStartupComplete({
        channels: { "openclaw-weixin": { configured: false } },
        channelAccounts: { "openclaw-weixin": [] },
      }),
    ).toBe(true);
  });

  it("ignores disabled and unconfigured accounts but checks every active account", () => {
    expect(
      isWeixinStartupComplete({
        channels: runningStatus.channels,
        channelAccounts: {
          "openclaw-weixin": [
            { enabled: false, configured: true, running: false },
            { configured: false, running: false },
            { configured: true, running: true },
          ],
        },
      }),
    ).toBe(true);
    expect(
      isWeixinStartupComplete({
        channels: runningStatus.channels,
        channelAccounts: {
          "openclaw-weixin": [
            { configured: true, running: true },
            { configured: true, running: false },
          ],
        },
      }),
    ).toBe(false);
  });

  const incompleteStatuses: Array<GatewayChannelsStatusPayload | null | undefined> = [
    null,
    undefined,
    {},
    { channels: {} },
    { channels: { "openclaw-weixin": {} } },
  ];
  it.each(incompleteStatuses)("requires recovery when startup is not attested: %j", (status) => {
    expect(isWeixinStartupComplete(status)).toBe(false);
  });
});

describe("waitForPostSpawnChannels", () => {
  afterEach(() => vi.useRealTimers());

  it("releases an already running channel without a fixed delay or restart", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const readStatus = vi.fn().mockResolvedValue(runningStatus);
    const result = await waitForPostSpawnChannels({
      readStatus,
      isCurrent: () => true,
      onError: vi.fn(),
    });

    expect(result).toBe("ready");
    expect(Date.now() - startedAt).toBe(0);
    expect(readStatus).toHaveBeenCalledExactlyOnceWith(POST_SPAWN_CHANNEL_READY_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets a channel finish starting within the existing grace period", async () => {
    vi.useFakeTimers();
    const readStatus = vi
      .fn()
      .mockResolvedValueOnce(stoppedStatus)
      .mockResolvedValue(runningStatus);
    const result = waitForPostSpawnChannels({
      readStatus,
      isCurrent: () => true,
      onError: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBe("ready");
    expect(readStatus).toHaveBeenNthCalledWith(2, 4_500);
  });

  it("retains the bounded compatibility restart for a provider that never starts", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const readStatus = vi.fn().mockResolvedValue(stoppedStatus);
    const result = waitForPostSpawnChannels({
      readStatus,
      isCurrent: () => true,
      onError: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(POST_SPAWN_CHANNEL_READY_TIMEOUT_MS);
    expect(await result).toBe("restart");
    expect(Date.now() - startedAt).toBe(POST_SPAWN_CHANNEL_READY_TIMEOUT_MS);
    expect(readStatus).toHaveBeenCalledTimes(10);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs a status timeout and does not add another delay before recovery", async () => {
    vi.useFakeTimers();
    const error = new Error("channels.status timed out");
    const onError = vi.fn();
    const readStatus = vi.fn(
      (timeoutMs: number) =>
        new Promise<GatewayChannelsStatusPayload>((_, reject) =>
          setTimeout(() => reject(error), timeoutMs),
        ),
    );
    const result = waitForPostSpawnChannels({ readStatus, isCurrent: () => true, onError });

    await vi.advanceTimersByTimeAsync(POST_SPAWN_CHANNEL_READY_TIMEOUT_MS);
    expect(await result).toBe("restart");
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(readStatus).toHaveBeenCalledOnce();
  });

  it("recovers from a transient status error without restarting a healthy provider", async () => {
    vi.useFakeTimers();
    const error = new Error("channel inventory not ready");
    const onError = vi.fn();
    const readStatus = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(runningStatus);
    const result = waitForPostSpawnChannels({ readStatus, isCurrent: () => true, onError });

    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBe("ready");
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("cancels recovery if the Gateway changes during the grace period", async () => {
    vi.useFakeTimers();
    let current = true;
    const readStatus = vi.fn().mockResolvedValue(stoppedStatus);
    const result = waitForPostSpawnChannels({
      readStatus,
      isCurrent: () => current,
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    current = false;
    await vi.advanceTimersByTimeAsync(500);

    expect(await result).toBe("cancelled");
    expect(readStatus).toHaveBeenCalledOnce();
  });

  it("cancels a replaced or disconnected Gateway instead of restarting its successor", async () => {
    let current = true;
    const result = await waitForPostSpawnChannels({
      readStatus: async () => {
        current = false;
        return runningStatus;
      },
      isCurrent: () => current,
      onError: vi.fn(),
    });
    expect(result).toBe("cancelled");
  });

  it("does not query an obsolete Gateway", async () => {
    const readStatus = vi.fn();
    expect(
      await waitForPostSpawnChannels({ readStatus, isCurrent: () => false, onError: vi.fn() }),
    ).toBe("cancelled");
    expect(readStatus).not.toHaveBeenCalled();
  });
});
