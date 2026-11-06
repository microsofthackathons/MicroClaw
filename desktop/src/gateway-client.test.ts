import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractMainSessionKey,
  buildSessionTitlePrompt,
  GatewayClient,
  GatewayRequestError,
  isAgentWarmupEvent,
  normalizeSessionTitle,
  normalizeGatewayChannelsStatus,
  shouldHandleGatewayDisconnect,
  type GatewayEventFrame,
  type GatewayResponseFrame,
} from "./gateway-client";
import {
  AGENT_WARMUP_SESSION_KEY,
  WS_RECONNECT_INITIAL_MS,
  WS_RECONNECT_MAX_MS,
  WS_RECONNECT_MULTIPLIER,
  WS_REQUEST_TIMEOUT_MS,
} from "./constants";
import { GatewaySessionObserver } from "./gateway-session-observer";

describe("GatewayClient agent roster", () => {
  it.each([undefined, 250])("forwards the roster RPC timeout budget %s", async (timeoutMs) => {
    const client = Object.create(GatewayClient.prototype) as GatewayClient;
    const result = { agents: [{ id: "main" }] };
    const request = vi.spyOn(client, "request").mockResolvedValue(result);

    await expect(client.listAgents(timeoutMs)).resolves.toEqual(result);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "agents.list",
      undefined,
      timeoutMs ?? WS_REQUEST_TIMEOUT_MS,
    );
  });

  it("clears an unanswered roster request when its remaining budget expires", async () => {
    vi.useFakeTimers();
    try {
      const client = Object.create(GatewayClient.prototype) as GatewayClient;
      const send = vi.fn();
      Object.assign(client, { pending: new Map(), ws: { readyState: 1, send } });
      const response = client.listAgents(250);
      const rejected = expect(response).rejects.toThrow(
        "request 'agents.list' timed out after 250ms",
      );

      await vi.advanceTimersByTimeAsync(250);
      await rejected;
      expect(client["pending"].size).toBe(0);
      expect(send).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GatewayClient WeChat QR login", () => {
  it.each([
    undefined,
    { accountId: "default", force: true, timeoutMs: 10_000 },
    { accountId: "default", channel: "another-channel" },
  ])("routes QR creation to WeChat instead of provider autodetection: %j", async (params) => {
    const client = Object.create(GatewayClient.prototype) as GatewayClient;
    const result = { qrDataUrl: "test-qr", message: "Scan to log in", sessionKey: "qr-session" };
    const request = vi.spyOn(client, "request").mockResolvedValue(result);

    await expect(client.weixinLoginQrStart(params)).resolves.toEqual(result);

    expect(request).toHaveBeenCalledExactlyOnceWith("web.login.start", {
      ...params,
      channel: "openclaw-weixin",
    });
  });

  it("routes QR completion to the same provider and preserves its session", async () => {
    const client = Object.create(GatewayClient.prototype) as GatewayClient;
    const request = vi.spyOn(client, "request").mockResolvedValue({ connected: true });

    const params = {
      accountId: "default",
      sessionKey: "qr-session",
      timeoutMs: 35_000,
      channel: "another-channel",
    };
    await client.weixinLoginQrWait(params);

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "web.login.wait",
      {
        channel: "openclaw-weixin",
        accountId: "default",
        sessionKey: "qr-session",
        timeoutMs: 35_000,
      },
      65_000,
    );
  });

  it("does not expire the transport before the requested QR long poll finishes", async () => {
    vi.useFakeTimers();
    try {
      const client = Object.create(GatewayClient.prototype) as GatewayClient;
      const send = vi.fn();
      Object.assign(client, { pending: new Map(), ws: { readyState: 1, send } });
      const response = client.weixinLoginQrWait({ accountId: "default", timeoutMs: 35_000 });
      const settled = vi.fn();
      void response.then(settled, settled);

      await vi.advanceTimersByTimeAsync(35_000);
      expect(settled).not.toHaveBeenCalled();

      const frame = JSON.parse(send.mock.calls[0][0]);
      client["handleMessage"](
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { connected: false, message: "Waiting for scan" },
        }),
      );
      await expect(response).resolves.toEqual({
        connected: false,
        message: "Waiting for scan",
      });
      expect(send).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels only the named QR session through the plugin without restarting Gateway", async () => {
    const client = Object.create(GatewayClient.prototype) as GatewayClient;
    const request = vi.spyOn(client, "request").mockResolvedValue({ cancelled: true });
    await expect(client.weixinLoginQrCancel("qr-session")).resolves.toEqual({ cancelled: true });
    expect(request).toHaveBeenCalledExactlyOnceWith("weixin.login.cancel", {
      sessionKey: "qr-session",
    });
  });

  it("keeps an unanswered QR long poll bounded without retrying it", async () => {
    vi.useFakeTimers();
    try {
      const client = Object.create(GatewayClient.prototype) as GatewayClient;
      const send = vi.fn();
      Object.assign(client, { pending: new Map(), ws: { readyState: 1, send } });
      const response = client.weixinLoginQrWait({ accountId: "default", timeoutMs: 35_000 });
      const rejected = expect(response).rejects.toThrow(
        "request 'web.login.wait' timed out after 65000ms",
      );

      await vi.advanceTimersByTimeAsync(65_000);
      await rejected;
      expect(client["pending"].size).toBe(0);
      expect(send).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GatewayClient approval capability", () => {
  it("retains the negotiated version and advertised methods", async () => {
    const client = Object.create(GatewayClient.prototype) as GatewayClient;
    Object.assign(client, {
      opts: {},
      sessionObserver: new GatewaySessionObserver(vi.fn()),
      connectSent: false,
      connectTimer: null,
      connectNonce: "test",
      deviceIdentity: {
        deviceId: "test",
        publicKey: "test",
        privateKey: Buffer.alloc(32, 1).toString("base64url"),
      },
      ws: { readyState: 1 },
    });
    vi.spyOn(client, "request").mockResolvedValue({
      server: { version: "2026.9.3" },
      features: { methods: ["models.list", "wizard.next", 42] },
    });
    client["sendConnect"]();
    await Promise.resolve();
    expect(client.serverVersion).toBe("2026.9.3");
    expect(client.methods).toEqual(["models.list", "wizard.next"]);
    expect(client.connectionGeneration).toBe(1);
    client["connectSent"] = false;
    client["sendConnect"]();
    await Promise.resolve();
    expect(client.connectionGeneration).toBe(2);
  });

  it("retains setup replies without a transport deadline and preserves typed errors", async () => {
    vi.useFakeTimers();
    try {
      const client = Object.create(GatewayClient.prototype) as GatewayClient;
      const send = vi.fn();
      Object.assign(client, { pending: new Map(), ws: { readyState: 1, send } });
      const request = client.request("openclaw.setup.prepare.start", {}, null);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(client["pending"].size).toBe(1);
      const frame = JSON.parse(send.mock.calls[0][0]);
      const rejected = expect(request).rejects.toMatchObject({
        name: "GatewayRequestError",
        code: "INVALID_REQUEST",
        details: { code: "WIZARD_NOT_FOUND" },
      });
      client["handleMessage"](
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: false,
          error: {
            message: "Not found",
            code: "INVALID_REQUEST",
            details: { code: "WIZARD_NOT_FOUND" },
          },
        }),
      );
      await rejected;
      expect(new GatewayRequestError("error")).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([true, false])(
    "passes the handler capability through the connect handshake: %s",
    async (supportsExecApprovals) => {
      const client = Object.create(GatewayClient.prototype) as GatewayClient;
      Object.assign(client, {
        opts: { port: 18789, token: "test-token", supportsExecApprovals },
        sessionObserver: new GatewaySessionObserver(vi.fn()),
        connectSent: false,
        connectTimer: null,
        connectNonce: "test-nonce",
        deviceIdentity: {
          deviceId: "test-device",
          publicKey: "test-public-key",
          privateKey: Buffer.alloc(32, 1).toString("base64url"),
        },
        ws: { readyState: 1 },
      });
      const request = vi.spyOn(client, "request").mockResolvedValue({});

      client["sendConnect"]();
      await Promise.resolve();

      expect(request).toHaveBeenCalledExactlyOnceWith(
        "connect",
        expect.objectContaining({
          caps: supportsExecApprovals ? ["tool-events", "exec-approvals"] : ["tool-events"],
        }),
      );
    },
  );
});

describe("GatewayClient handshake recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createHandshakeClient() {
    const client = Object.create(GatewayClient.prototype) as GatewayClient;
    const send = vi.fn();
    const connect = vi.fn();
    const close = vi.fn(() => client["scheduleReconnect"]());
    const onAuthError = vi.fn();
    Object.assign(client, {
      opts: { port: 18789, token: "test-token", onAuthError },
      sessionObserver: new GatewaySessionObserver(vi.fn()),
      pending: new Map(),
      sessionTitleWaiters: new Map(),
      closed: false,
      backoffMs: WS_RECONNECT_INITIAL_MS,
      connectSent: false,
      connectTimer: null,
      connectNonce: "test-nonce",
      connect,
      deviceIdentity: {
        deviceId: "test-device",
        publicKey: "test-public-key",
        privateKey: Buffer.alloc(32, 1).toString("base64url"),
      },
      ws: { readyState: 1, send, close },
    });
    const rejectHandshake = async (error: NonNullable<GatewayResponseFrame["error"]>) => {
      client["sendConnect"]();
      const request = JSON.parse(send.mock.calls[0][0]);
      client["handleMessage"](JSON.stringify({ type: "res", id: request.id, ok: false, error }));
      await vi.advanceTimersByTimeAsync(0);
    };
    return { client, connect, close, onAuthError, send, rejectHandshake };
  }

  it.each([
    {
      code: "INVALID_REQUEST",
      message: "unauthorized: too many failed authentication attempts (retry later)",
      details: { code: "AUTH_RATE_LIMITED", authReason: "rate_limited" },
    },
    { code: "INVALID_REQUEST", message: "Try later", details: { code: "AUTH_RATE_LIMITED" } },
    { code: "INVALID_REQUEST", message: "Try later", details: { authReason: "rate_limited" } },
    { code: "AUTH_RATE_LIMITED", message: "Try later" },
    { code: "INVALID_REQUEST", message: "unauthorized: rate limited" },
    {
      code: "INVALID_REQUEST",
      message: "unauthorized: too many failed authentication attempts (retry later)",
    },
  ])("honors the auth cooldown without requesting a Gateway restart: %j", async (error) => {
    const { client, connect, close, onAuthError, rejectHandshake } = createHandshakeClient();

    await rejectHandshake({ ...error, retryAfterMs: 60_000 });

    expect(onAuthError).not.toHaveBeenCalled();
    expect(client["closed"]).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledOnce();
  });

  it("caps excessive cooldowns without overflowing the reconnect timer", async () => {
    const { connect, onAuthError, rejectHandshake } = createHandshakeClient();
    await rejectHandshake({
      code: "AUTH_RATE_LIMITED",
      message: "Try later",
      retryAfterMs: 2_147_483_648,
    });

    expect(onAuthError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_147_483_646);
    expect(connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledOnce();
  });

  it("resets the reconnect backoff after a successful retry", async () => {
    const { client, connect, send, rejectHandshake } = createHandshakeClient();
    await rejectHandshake({
      code: "AUTH_RATE_LIMITED",
      message: "Try later",
      retryAfterMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledOnce();

    client["connectSent"] = false;
    client["sendConnect"]();
    const request = JSON.parse(send.mock.calls[1][0]);
    client["handleMessage"](JSON.stringify({ type: "res", id: request.id, ok: true, payload: {} }));
    await vi.advanceTimersByTimeAsync(0);

    expect(client.connected).toBe(true);
    expect(client["backoffMs"]).toBe(WS_RECONNECT_INITIAL_MS);
  });

  it.each([undefined, 0, -1, Number.POSITIVE_INFINITY])(
    "uses a conservative delay when the auth cooldown is absent or invalid: %s",
    async (retryAfterMs) => {
      const { connect, onAuthError, rejectHandshake } = createHandshakeClient();
      await rejectHandshake({
        code: "INVALID_REQUEST",
        message: "unauthorized: rate limited",
        retryAfterMs,
      });

      expect(onAuthError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(WS_RECONNECT_MAX_MS - 1);
      expect(connect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(connect).toHaveBeenCalledOnce();
    },
  );

  it.each(["unauthorized: gateway token missing", "gateway token mismatch"])(
    "still reports persistent authentication failures instead of reconnecting: %s",
    async (message) => {
      const { client, connect, close, onAuthError, rejectHandshake } = createHandshakeClient();
      await rejectHandshake({ code: "INVALID_REQUEST", message });

      expect(onAuthError).toHaveBeenCalledExactlyOnceWith(message);
      expect(client["closed"]).toBe(true);
      expect(close).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(connect).not.toHaveBeenCalled();
    },
  );

  it("keeps exponential reconnect backoff for other transient handshake failures", async () => {
    const { client, connect, onAuthError, rejectHandshake } = createHandshakeClient();
    await rejectHandshake({ code: "UNAVAILABLE", message: "Gateway temporarily unavailable" });

    expect(onAuthError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_INITIAL_MS - 1);
    expect(connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledOnce();
    client["scheduleReconnect"]();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_INITIAL_MS * WS_RECONNECT_MULTIPLIER - 1);
    expect(connect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});

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

  it("requests a local status snapshot with the startup caller's timeout", async () => {
    const client = Object.create(GatewayClient.prototype) as GatewayClient;
    const snapshot = {
      channels: { "openclaw-weixin": { configured: true } },
      channelAccounts: { "openclaw-weixin": [{ configured: true, running: true }] },
    };
    const request = vi.spyOn(client, "request").mockResolvedValue(snapshot);

    expect(await client.getChannelsStatus(1_500)).toBe(snapshot);
    expect(request).toHaveBeenCalledExactlyOnceWith("channels.status", { probe: false }, 1_500);
    expect(await client.listChannels()).toEqual({
      channels: [
        {
          id: "openclaw-weixin",
          name: "openclaw-weixin",
          icon: "",
          type: "openclaw-weixin",
          connected: true,
        },
      ],
    });
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

  describe("Gateway disconnect lifecycle", () => {
    it("ignores a socket close callback after the client was intentionally stopped", () => {
      expect(shouldHandleGatewayDisconnect(true)).toBe(false);
      expect(shouldHandleGatewayDisconnect(false)).toBe(true);
    });
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

  it("returns the Gateway acknowledgment with its actual run ID", async () => {
    const { client, request } = createClient();
    const acknowledgment = { runId: "actual-run", status: "started" };
    request.mockResolvedValueOnce(acknowledgment);
    expect(await client.sendChat("session-123", "hello")).toBe(acknowledgment);
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

describe("GatewayClient.loadHistory", () => {
  it("loads older pages so a tool-heavy turn does not lose its user message", async () => {
    const client = Object.create(GatewayClient.prototype) as GatewayClient;
    Object.assign(client, { _mainSessionKey: null, _connectionGeneration: 1 });
    const tools = Array.from({ length: 200 }, (_, index) => ({
      role: "assistant",
      content: [{ type: "thinking", thinking: `Step ${index}` }],
    }));
    const user = { role: "user", content: "Compare controller prices" };
    const latest = {
      sessionKey: "main",
      sessionId: "controller-session",
      messages: tools,
      olderCursor: "older-tools",
      hasMore: true,
      nextOffset: 200,
      sessionInfo: {
        key: "agent:main:main",
        isMain: true,
        hasActiveRun: false,
        activeRunIds: [],
      },
    };
    const request = vi
      .spyOn(client, "request")
      .mockResolvedValueOnce(latest)
      .mockResolvedValueOnce({
        ...latest,
        sessionKey: "agent:main:main",
        messages: [{ role: "assistant", content: "Starting comparison" }],
        olderCursor: "oldest-turn",
      })
      .mockResolvedValueOnce({
        ...latest,
        sessionKey: "agent:main:main",
        messages: [user],
        olderCursor: undefined,
        hasMore: false,
        sessionInfo: { ...latest.sessionInfo, hasActiveRun: true, activeRunIds: ["old-run"] },
      });

    const history = await client.loadHistory("main");

    expect(history.messages).toEqual([
      user,
      { role: "assistant", content: "Starting comparison" },
      ...tools,
    ]);
    expect(history.sessionInfo).toEqual(latest.sessionInfo);
    expect(history.sessionKey).toBe("agent:main:main");
    expect(request).toHaveBeenNthCalledWith(2, "chat.history", {
      sessionKey: "agent:main:main",
      limit: 200,
      cursor: "older-tools",
    });
    expect(request).toHaveBeenNthCalledWith(3, "chat.history", {
      sessionKey: "agent:main:main",
      limit: 200,
      cursor: "oldest-turn",
    });
  });

  it("follows the gateway's nextOffset when history has no page cursor", async () => {
    const client = Object.create(GatewayClient.prototype) as GatewayClient;
    const request = vi
      .spyOn(client, "request")
      .mockResolvedValueOnce({
        messages: [{ role: "assistant", content: "Latest reply" }],
        hasMore: true,
        nextOffset: 17,
      })
      .mockResolvedValueOnce({
        messages: [{ role: "user", content: "Original question" }],
        hasMore: false,
      });

    await expect(client.loadHistory("agent:main:main")).resolves.toMatchObject({
      messages: [
        { role: "user", content: "Original question" },
        { role: "assistant", content: "Latest reply" },
      ],
    });
    expect(request).toHaveBeenNthCalledWith(2, "chat.history", {
      sessionKey: "agent:main:main",
      limit: 200,
      offset: 17,
    });
  });

  it("rejects repeated pagination selectors rather than looping or hiding missing history", async () => {
    const client = Object.create(GatewayClient.prototype) as GatewayClient;
    const request = vi.spyOn(client, "request").mockResolvedValue({
      messages: [],
      olderCursor: "same-page",
    });

    await expect(client.loadHistory("agent:main:main")).rejects.toThrow(/pagination/i);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not combine history from different transcripts after a reset", async () => {
    const client = Object.create(GatewayClient.prototype) as GatewayClient;
    vi.spyOn(client, "request")
      .mockResolvedValueOnce({ sessionId: "before-reset", messages: [], olderCursor: "older" })
      .mockResolvedValueOnce({ sessionId: "after-reset", messages: [] });

    await expect(client.loadHistory("agent:main:main")).rejects.toThrow(/session/i);
  });

  it("canonicalizes an echoed alias and learns main identity without hello defaults", async () => {
    const client = Object.create(GatewayClient.prototype) as GatewayClient;
    Object.assign(client, { _mainSessionKey: null, _connectionGeneration: 1 });
    const history = {
      sessionKey: "main",
      messages: [{ role: "user", content: "Existing WeChat message" }],
      sessionInfo: {
        key: "agent:main:main",
        isMain: true,
        hasActiveRun: false,
        activeRunIds: [],
      },
    };
    const request = vi.spyOn(client, "request").mockResolvedValue(history);
    await expect(client.loadHistory("main")).resolves.toEqual({
      ...history,
      sessionKey: "agent:main:main",
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("chat.history", {
      sessionKey: "main",
      limit: 200,
    });
    expect(client.mainSessionKey).toBe("agent:main:main");
  });

  it("does not mistake another agent's main session for the default main alias", async () => {
    const client = Object.create(GatewayClient.prototype) as GatewayClient;
    Object.assign(client, { _mainSessionKey: null });
    vi.spyOn(client, "request").mockResolvedValue({
      sessionKey: "agent:other:main",
      sessionInfo: {
        key: "agent:other:main",
        isMain: true,
        hasActiveRun: false,
        activeRunIds: [],
      },
    });
    await client.loadHistory("agent:other:main");
    expect(client.mainSessionKey).toBeNull();
  });

  it("does not cache main identity from a previous connection", async () => {
    const client = Object.create(GatewayClient.prototype) as GatewayClient;
    Object.assign(client, { _mainSessionKey: null, _connectionGeneration: 1 });
    vi.spyOn(client, "request").mockImplementation(async () => {
      Object.assign(client, { _connectionGeneration: 2 });
      return {
        sessionKey: "main",
        sessionInfo: {
          key: "agent:main:main",
          isMain: true,
          hasActiveRun: false,
          activeRunIds: [],
        },
      };
    });
    await client.loadHistory("main");
    expect(client.mainSessionKey).toBeNull();
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
    const request = vi
      .spyOn(client, "request")
      .mockResolvedValue(undefined)
      .mockResolvedValueOnce({
        session: { key: "agent:main:session-123", isMain: false },
      });

    await client.deleteSession("agent:main:session-123");

    expect(request).toHaveBeenCalledWith("sessions.delete", {
      key: "agent:main:session-123",
      deleteTranscript: true,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("resets the exact canonical main session from the Gateway handshake", async () => {
    const client = createClient("global");
    const request = vi
      .spyOn(client, "request")
      .mockResolvedValue(undefined)
      .mockResolvedValueOnce({
        session: { key: "global" },
      });

    await client.deleteSession("global");

    expect(request).toHaveBeenCalledWith("sessions.reset", {
      key: "global",
      reason: "reset",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("resets a non-default agent's protected main session", async () => {
    const client = createClient("agent:painter:main");
    const request = vi
      .spyOn(client, "request")
      .mockResolvedValue(undefined)
      .mockResolvedValueOnce({
        session: { key: "agent:writer:main", isMain: true },
      });

    await client.deleteSession("agent:writer:main");

    expect(request).toHaveBeenCalledWith("sessions.reset", {
      key: "agent:writer:main",
      reason: "reset",
    });
  });

  it.each(["main", "agent:main:main"])(
    "resolves %s without hello defaults and revokes canonical approvals before resetting",
    async (key) => {
      const client = createClient(null);
      const request = vi
        .spyOn(client, "request")
        .mockResolvedValue(undefined)
        .mockResolvedValueOnce({
          session: { key: "agent:main:main", isMain: true },
        });
      const beforeDelete = vi.fn(async () => {
        expect(request).toHaveBeenCalledTimes(1);
      });
      await client.deleteSession(key, beforeDelete);
      expect(request).toHaveBeenNthCalledWith(1, "sessions.describe", {
        key,
        includeDerivedTitles: false,
        includeLastMessage: false,
      });
      expect(beforeDelete).toHaveBeenCalledExactlyOnceWith("agent:main:main");
      expect(request).toHaveBeenNthCalledWith(2, "sessions.reset", {
        key: "agent:main:main",
        reason: "reset",
      });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("does not infer protection from a main-named suffix", async () => {
    const client = createClient(null);
    const request = vi
      .spyOn(client, "request")
      .mockResolvedValue(undefined)
      .mockResolvedValueOnce({
        session: { key: "agent:writer:main", isMain: false },
      });
    await client.deleteSession("agent:writer:main");
    expect(request).toHaveBeenLastCalledWith("sessions.delete", {
      key: "agent:writer:main",
      deleteTranscript: true,
    });
  });

  it("exposes an explicit reset operation", async () => {
    const client = createClient();
    const request = vi.spyOn(client, "request").mockResolvedValue(undefined);

    await client.resetSession("agent:writer:main");

    expect(request).toHaveBeenCalledExactlyOnceWith("sessions.reset", {
      key: "agent:writer:main",
      reason: "reset",
    });
  });

  it("allows idempotent deletion of a session no longer in the catalog", async () => {
    const client = createClient(null);
    const request = vi
      .spyOn(client, "request")
      .mockResolvedValue(undefined)
      .mockResolvedValueOnce({ session: null });
    await client.deleteSession("agent:main:removed");
    expect(request).toHaveBeenLastCalledWith("sessions.delete", {
      key: "agent:main:removed",
      deleteTranscript: true,
    });
  });

  it.each([
    undefined,
    {},
    { session: {} },
    { session: { key: "" } },
    { session: { key: " agent:main:session-123" } },
    { session: { key: "agent:main:session-123", isMain: "true" } },
    { session: { key: "agent:other:main", isMain: true } },
  ])("rejects malformed or mismatched session descriptions %# without mutation", async (result) => {
    const client = createClient();
    const request = vi.spyOn(client, "request").mockResolvedValueOnce(result);
    const beforeDelete = vi.fn();
    await expect(client.deleteSession("agent:main:session-123", beforeDelete)).rejects.toThrow();
    expect(beforeDelete).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not reset or delete after a connection change during resolution or revocation", async () => {
    for (const phase of ["describe", "revoke"]) {
      const client = createClient();
      Object.assign(client, { _connectionGeneration: 1 });
      const request = vi.spyOn(client, "request").mockImplementation(async () => {
        if (phase === "describe") Object.assign(client, { _connectionGeneration: 2 });
        return { session: { key: "agent:main:main", isMain: true } };
      });
      await expect(
        client.deleteSession("main", async () => {
          Object.assign(client, { _connectionGeneration: 2 });
        }),
      ).rejects.toThrow("Gateway connection changed");
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  it("does not mutate a session when approval revocation fails", async () => {
    const client = createClient();
    const request = vi.spyOn(client, "request").mockResolvedValueOnce({
      session: { key: "agent:main:main", isMain: true },
    });
    await expect(
      client.deleteSession("main", async () => {
        throw new Error("revocation failed");
      }),
    ).rejects.toThrow("revocation failed");
    expect(request).toHaveBeenCalledTimes(1);
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

  it("does not reset an ordinary session after deletion is rejected", async () => {
    const client = createClient();
    const request = vi
      .spyOn(client, "request")
      .mockResolvedValueOnce({ session: { key: "agent:main:session-123", isMain: false } })
      .mockRejectedValueOnce(new Error("permission denied"));
    await expect(client.deleteSession("agent:main:session-123")).rejects.toThrow(
      "permission denied",
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).not.toHaveBeenCalledWith("sessions.reset", expect.anything());
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
