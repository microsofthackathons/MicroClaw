import { describe, expect, it, vi } from "vitest";
import {
  extractMainSessionKey,
  GatewayClient,
  isAgentWarmupEvent,
  normalizeGatewayChannelsStatus,
  type GatewayEventFrame,
} from "./gateway-client";
import { AGENT_WARMUP_SESSION_KEY } from "./constants";

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

describe("isAgentWarmupEvent", () => {
  it("recognizes reserved chat and tool events", () => {
    const events: GatewayEventFrame[] = [
      {
        type: "event",
        event: "chat",
        payload: { sessionKey: AGENT_WARMUP_SESSION_KEY, state: "delta" },
      },
      {
        type: "event",
        event: "agent",
        payload: { sessionKey: AGENT_WARMUP_SESSION_KEY, stream: "tool" },
      },
    ];

    expect(events.every(isAgentWarmupEvent)).toBe(true);
    expect(
      isAgentWarmupEvent({
        type: "event",
        event: "chat",
        payload: { sessionKey: "agent:main:main", state: "delta" },
      }),
    ).toBe(false);
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

  describe("GatewayClient.warmUpAgent", () => {
    type PrivateMessageHandler = {
      handleMessage(raw: string): void;
    };

    function createClient() {
      const onEvent = vi.fn();
      const client = Object.create(GatewayClient.prototype) as GatewayClient;
      Object.assign(client, {
        opts: { port: 18789, token: "", onEvent },
        _mainSessionKey: "agent:main:main",
        agentWarmupPromise: null,
        agentWarmupWaiter: null,
        agentWarmupCleanupPromise: null,
        agentWarmupCleanupPending: false,
      });
      const request = vi.spyOn(client, "request").mockResolvedValue(undefined);
      const handleMessage = (client as unknown as PrivateMessageHandler).handleMessage.bind(client);
      return { client, request, handleMessage, onEvent };
    }

    function emitWarmupChat(
      handleMessage: (raw: string) => void,
      state: "delta" | "final" | "aborted" | "error",
    ) {
      handleMessage(
        JSON.stringify({
          type: "event",
          event: "chat",
          payload: {
            runId: "warmup-run",
            sessionKey: AGENT_WARMUP_SESSION_KEY,
            state,
            deltaText: state === "delta" ? "r" : undefined,
          },
        }),
      );
    }

    it("aborts on the first delta, deletes the transcript, and suppresses the event", async () => {
      const { client, request, handleMessage, onEvent } = createClient();

      const warming = client.warmUpAgent(1_000);
      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledWith(
          "chat.send",
          expect.objectContaining({ sessionKey: AGENT_WARMUP_SESSION_KEY }),
        );
      });
      emitWarmupChat(handleMessage, "delta");

      await expect(warming).resolves.toEqual({ outcome: "delta", transcriptDeleted: true });
      expect(request).toHaveBeenCalledWith("chat.abort", {
        sessionKey: AGENT_WARMUP_SESSION_KEY,
      });
      expect(request).toHaveBeenCalledWith("sessions.delete", {
        key: AGENT_WARMUP_SESSION_KEY,
        deleteTranscript: true,
      });
      expect(onEvent).not.toHaveBeenCalled();
    });

    it("accepts a terminal event before any delta", async () => {
      const { client, handleMessage } = createClient();

      const warming = client.warmUpAgent(1_000);
      emitWarmupChat(handleMessage, "final");

      await expect(warming).resolves.toEqual({ outcome: "terminal", transcriptDeleted: true });
    });

    it("returns one single-flight promise for concurrent callers", () => {
      const { client } = createClient();

      const first = client.warmUpAgent(1_000);
      const second = client.warmUpAgent(1_000);

      expect(second).toBe(first);
    });

    it("returns immediately when chat.send rejects", async () => {
      const { client, request } = createClient();
      request.mockImplementation((method) => {
        if (method === "chat.send") return Promise.reject(new Error("provider unauthorized"));
        return Promise.resolve(undefined);
      });

      await expect(client.warmUpAgent(30_000)).resolves.toEqual({
        outcome: "error",
        transcriptDeleted: false,
      });
      expect(request).toHaveBeenCalledWith("chat.abort", {
        sessionKey: AGENT_WARMUP_SESSION_KEY,
      });
    });

    it("fails open at the timeout and starts cleanup", async () => {
      vi.useFakeTimers();
      const { client, request } = createClient();

      const warming = client.warmUpAgent(25);
      await vi.advanceTimersByTimeAsync(25);

      await expect(warming).resolves.toEqual({ outcome: "timeout", transcriptDeleted: false });
      expect(request).toHaveBeenCalledWith("chat.abort", {
        sessionKey: AGENT_WARMUP_SESSION_KEY,
      });
      vi.useRealTimers();
    });

    it("includes stale cleanup in the same hard timeout", async () => {
      vi.useFakeTimers();
      const { client, request } = createClient();
      Object.assign(client, { agentWarmupCleanupPending: true });
      request.mockImplementation(() => new Promise(() => undefined));

      const warming = client.warmUpAgent(25);
      await vi.advanceTimersByTimeAsync(25);

      await expect(warming).resolves.toEqual({ outcome: "timeout", transcriptDeleted: false });
      expect(request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      vi.useRealTimers();
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
