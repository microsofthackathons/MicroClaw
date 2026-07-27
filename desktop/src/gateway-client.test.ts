import { describe, expect, it, vi } from "vitest";
import { GatewayClient, normalizeGatewayChannelsStatus } from "./gateway-client";

describe("normalizeGatewayChannelsStatus", () => {
  it("preserves Gateway order and derives connection state from accounts", () => {
    const channels = normalizeGatewayChannelsStatus({
      channels: {
        signal: { connected: false },
        "openclaw-weixin": {},
      },
      channelAccounts: {
        "openclaw-weixin": [{ running: true }],
      },
      channelOrder: ["openclaw-weixin", "signal"],
      channelLabels: {
        "openclaw-weixin": "Weixin",
        signal: "Signal",
      },
      channelMeta: [
        {
          id: "openclaw-weixin",
          label: "Weixin fallback",
          systemImage: "weixin.svg",
        },
      ],
    });

    expect(channels).toEqual([
      {
        id: "openclaw-weixin",
        name: "Weixin",
        icon: "weixin.svg",
        type: "openclaw-weixin",
        connected: true,
      },
      {
        id: "signal",
        name: "Signal",
        icon: "",
        type: "signal",
        connected: false,
      },
    ]);
  });
});

describe("GatewayClient.deleteSession", () => {
  function createClient() {
    return Object.create(GatewayClient.prototype) as GatewayClient;
  }

  it("deletes ordinary sessions and their transcripts", async () => {
    const client = createClient();
    const request = vi.spyOn(client, "request").mockResolvedValue(undefined);

    await client.deleteSession("agent:main:session-123");

    expect(request).toHaveBeenCalledWith("sessions.delete", {
      key: "agent:main:session-123",
      deleteTranscript: true,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("resets an agent's main session instead of attempting to delete it", async () => {
    const client = createClient();
    const request = vi.spyOn(client, "request").mockResolvedValue(undefined);

    await client.deleteSession("agent:painter:main");

    expect(request).toHaveBeenCalledWith("sessions.reset", {
      key: "agent:painter:main",
      reason: "reset",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not mask ordinary deletion failures with a session reset", async () => {
    const client = createClient();
    const request = vi.spyOn(client, "request").mockRejectedValue(new Error("permission denied"));

    await expect(client.deleteSession("agent:main:session-123")).rejects.toThrow(
      "permission denied",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});
