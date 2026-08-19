import { describe, expect, it, vi } from "vitest";
import {
  extractMainSessionKey,
  buildSessionTitlePrompt,
  GatewayClient,
  isAgentWarmupEvent,
  normalizeSessionTitle,
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

describe("session summary titles", () => {
  it("builds a bounded transcript prompt from user and assistant turns", () => {
    const prompt = buildSessionTitlePrompt([
      { role: "system", content: "hidden" },
      { role: "user", content: [{ type: "text", text: "Plan a Japan trip" }] },
      { role: "assistant", content: "Here is a seven-day itinerary" },
    ]);

    expect(prompt).toContain("user: Plan a Japan trip");
    expect(prompt).toContain("assistant: Here is a seven-day itinerary");
    expect(prompt).not.toContain("hidden");
  });

  it("normalizes the model response to a single plain-text title", () => {
    expect(normalizeSessionTitle("## “日本七日游规划”\nExtra detail")).toBe("日本七日游规划");
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

describe("GatewayClient.sendChat", () => {
  function createClient() {
    const client = Object.create(GatewayClient.prototype) as GatewayClient;
    Object.assign(client, { opts: { port: 18789, token: "" } });
    const request = vi.spyOn(client, "request").mockResolvedValue(undefined);
    return { client, request };
  }

  it("preserves the existing payload when no attachments are provided", async () => {
    const { client, request } = createClient();

    await client.sendChat("session-123", "hello");

    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.not.objectContaining({ attachments: expect.anything() }),
    );
  });

  it("adds gateway-compatible attachment objects when provided", async () => {
    const { client, request } = createClient();
    await client.sendChat("session-123", "", [
      {
        type: "image",
        mimeType: "image/png",
        fileName: "pixel.png",
        size: 3,
        content: "AQID",
      },
    ]);

    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "session-123",
        message: "",
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "pixel.png",
            content: "AQID",
          },
        ],
      }),
    );
  });

  it("does not issue or queue chat.send when the ingress gate rejects", async () => {
    const { client, request } = createClient();
    const beforeChatSend = vi.fn().mockRejectedValue(new Error("MXC ingress is locked"));
    Object.assign(client, { opts: { port: 18789, token: "", beforeChatSend } });

    await expect(client.sendChat("session-123", "blocked")).rejects.toThrow(
      "MXC ingress is locked",
    );
    expect(request).not.toHaveBeenCalled();

    beforeChatSend.mockResolvedValue(undefined);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
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

    function createClient(beforeChatSend?: () => Promise<void>) {
      const onEvent = vi.fn();
      const client = Object.create(GatewayClient.prototype) as GatewayClient;
      Object.assign(client, {
        opts: { port: 18789, token: "", onEvent, beforeChatSend },
        _mainSessionKey: "agent:main:main",
        agentWarmupPromise: null,
        agentWarmupWaiter: null,
        agentWarmupAbortPromise: null,
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

    it("aborts on the first delta without calling sessions.delete", async () => {
      const { client, request, handleMessage, onEvent } = createClient();

      const warming = client.warmUpAgent(1_000);
      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledWith(
          "chat.send",
          expect.objectContaining({ sessionKey: AGENT_WARMUP_SESSION_KEY }),
        );
      });
      emitWarmupChat(handleMessage, "delta");

      await expect(warming).resolves.toEqual({ outcome: "delta", transcriptDeleted: false });
      expect(request).toHaveBeenCalledWith("chat.abort", {
        sessionKey: AGENT_WARMUP_SESSION_KEY,
      });
      expect(request).not.toHaveBeenCalledWith("sessions.delete", expect.anything());
      expect(onEvent).not.toHaveBeenCalled();
    });

    it("accepts a terminal event before any delta", async () => {
      const { client, handleMessage } = createClient();

      const warming = client.warmUpAgent(1_000);
      emitWarmupChat(handleMessage, "final");

      await expect(warming).resolves.toEqual({ outcome: "terminal", transcriptDeleted: false });
    });

    it("sends only one warm-up turn for concurrent callers", async () => {
      const { client, request, handleMessage } = createClient();

      const first = client.warmUpAgent(1_000);
      const second = client.warmUpAgent(1_000);
      emitWarmupChat(handleMessage, "final");

      expect(second).toBe(first);
      await expect(first).resolves.toEqual({ outcome: "terminal", transcriptDeleted: false });
      expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
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

    it("does not issue or replay a warm-up turn while ingress is locked", async () => {
      const beforeChatSend = vi.fn().mockRejectedValue(new Error("MXC ingress is locked"));
      const { client, request } = createClient(beforeChatSend);

      await expect(client.warmUpAgent(30_000)).resolves.toEqual({
        outcome: "error",
        transcriptDeleted: false,
      });
      expect(request).not.toHaveBeenCalledWith("chat.send", expect.anything());

      beforeChatSend.mockResolvedValue(undefined);
      await Promise.resolve();
      expect(request).not.toHaveBeenCalledWith("chat.send", expect.anything());
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

    it("does not wait for chat.send acknowledgement or the abort RPC", async () => {
      const { client, request } = createClient();
      request.mockImplementation((method) => {
        if (method === "chat.send" || method === "chat.abort") {
          return new Promise(() => undefined);
        }
        return Promise.resolve(undefined);
      });

      const warming = client.warmUpAgent(30_000);
      emitWarmupChat(
        (client as unknown as PrivateMessageHandler).handleMessage.bind(client),
        "delta",
      );

      await expect(warming).resolves.toEqual({ outcome: "delta", transcriptDeleted: false });
      expect(request).not.toHaveBeenCalledWith("sessions.delete", expect.anything());
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

describe("GatewayClient.listSessionTitles", () => {
  it("uses OpenClaw's built-in derived titles and returns requested sessions only", async () => {
    const client = Object.create(GatewayClient.prototype) as GatewayClient;
    const request = vi.spyOn(client, "request").mockResolvedValue({
      sessions: [
        { key: "session-0", derivedTitle: "First title" },
        { key: "other", derivedTitle: "Not requested" },
      ],
    });
    const keys = Array.from({ length: 70 }, (_, index) => `session-${index}`);

    const result = await client.listSessionTitles(keys);

    expect(request).toHaveBeenCalledWith("sessions.list", {
      includeDerivedTitles: true,
      limit: 200,
    });
    expect(result).toEqual({ titles: { "session-0": "First title" } });
  });
});

describe("GatewayClient.generateSessionTitle", () => {
  it("persists the generated summary and deletes the hidden transcript", async () => {
    const client = Object.create(GatewayClient.prototype) as GatewayClient;
    (client as any).sessionTitleWaiters = new Map();
    (client as any).sessionTitlePromises = new Map();
    vi.spyOn(client, "loadHistory").mockResolvedValue({
      messages: [
        { role: "user", content: "Plan a Japan trip" },
        { role: "assistant", content: "Here is a seven-day itinerary" },
      ],
    });
    const request = vi.spyOn(client, "request").mockResolvedValue(undefined);
    vi.spyOn(client, "sendChat").mockImplementation(async (titleSessionKey) => {
      queueMicrotask(() => {
        (client as any).handleMessage(
          JSON.stringify({
            type: "event",
            event: "chat",
            payload: {
              sessionKey: titleSessionKey,
              state: "final",
              message: { role: "assistant", content: "Japan itinerary" },
            },
          }),
        );
      });
    });

    await expect(client.generateSessionTitle("agent:travel:main")).resolves.toBe("Japan itinerary");
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:travel:main",
      label: "Japan itinerary",
    });
    expect(request).toHaveBeenCalledWith("sessions.delete", {
      key: expect.stringMatching(/^agent:travel:microclaw-title-/),
      deleteTranscript: true,
    });
  });
});
