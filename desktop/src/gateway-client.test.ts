import { describe, expect, it, vi } from "vitest";
import {
  extractMainSessionKey,
  GatewayClient,
  normalizeGatewayChannelsStatus,
} from "./gateway-client";

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

describe("extractMainSessionKey", () => {
  it("reads the canonical main key from the Gateway hello snapshot", () => {
    expect(
      extractMainSessionKey({
        snapshot: { sessionDefaults: { mainSessionKey: "global" } },
      }),
    ).toBe("global");
  });

  it("returns null for a malformed Gateway hello snapshot", () => {
    expect(extractMainSessionKey({ snapshot: { sessionDefaults: [] } })).toBeNull();
  });
});

describe("GatewayClient.deleteSession", () => {
  function createClient(mainSessionKey: string | null = "agent:main:main") {
    const client = Object.create(GatewayClient.prototype) as GatewayClient;
    Object.defineProperty(client, "_mainSessionKey", {
      value: mainSessionKey,
      writable: true,
    });
    return client;
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

  it("resets the exact canonical main session from the Gateway handshake", async () => {
    const client = createClient("global");
    const request = vi.spyOn(client, "request").mockResolvedValue(undefined);

    await client.deleteSession("global");

    expect(request).toHaveBeenCalledWith("sessions.reset", {
      key: "global",
      reason: "reset",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("deletes a non-default agent's main-named session", async () => {
    const client = createClient("agent:painter:main");
    const request = vi.spyOn(client, "request").mockResolvedValue(undefined);

    await client.deleteSession("agent:writer:main");

    expect(request).toHaveBeenCalledWith("sessions.delete", {
      key: "agent:writer:main",
      deleteTranscript: true,
    });
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
