import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

// ── Mock window.openclaw ──
const mockLoadHistory = vi.fn().mockResolvedValue({ messages: [] });
const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const mockAbort = vi.fn().mockResolvedValue(undefined);
const mockDeleteSession = vi.fn().mockResolvedValue(undefined);
const mockGenerateSessionTitle = vi.fn().mockResolvedValue("Summary title");
const mockIsConnected = vi.fn().mockResolvedValue(false);
const mockGetSettings = vi.fn().mockResolvedValue({});

Object.defineProperty(globalThis, "window", {
  value: {
    ...globalThis.window,
    openclaw: {
      chat: {
        loadHistory: mockLoadHistory,
        sendMessage: mockSendMessage,
        abort: mockAbort,
        deleteSession: mockDeleteSession,
        generateSessionTitle: mockGenerateSessionTitle,
        isConnected: mockIsConnected,
        onEvent: vi.fn(),
        onToolEvent: vi.fn(),
        onExecCommand: vi.fn(),
      },
      config: { needsSetup: vi.fn().mockResolvedValue(false) },
      gateway: {
        getPort: vi.fn().mockResolvedValue(18789),
        getStatus: vi.fn().mockResolvedValue("running"),
        onStatus: vi.fn(),
        onLog: vi.fn(),
        onWsConnected: vi.fn(),
        onWsDisconnected: vi.fn(),
        restart: vi.fn(),
      },
      settings: { get: mockGetSettings },
      sandbox: { onPermissionRequest: vi.fn() },
      skills: { pendingIntegrityResult: vi.fn().mockResolvedValue(null) },
      cron: { list: vi.fn().mockResolvedValue({ jobs: [] }) },
    },
  },
  writable: true,
});

// Mock localStorage for sessions store dependency.
// Stub unconditionally — jsdom's built-in localStorage has been observed to
// degrade on the self-hosted Windows runner (jsdom emits a warning about
// `--localstorage-file` and ships an object missing setItem). Replacing it
// here gives every test a known-good in-memory implementation.
const storage: Record<string, string> = {};
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
      storage[key] = value;
    },
    removeItem: (key: string) => {
      delete storage[key];
    },
    clear: () => {
      Object.keys(storage).forEach((k) => delete storage[k]);
    },
  },
  writable: true,
});

import {
  applyChatDelta,
  classifyChatError,
  modelAuthRecoveryInitialFamily,
  requiresModelAuthRecovery,
  useChatStore,
} from "./chat";
import { useSessionStore } from "./sessions";
// ChatEventPayload is declared globally in env.d.ts

describe("classifyChatError", () => {
  it("treats a Copilot token-exchange 404 as an authentication failure", () => {
    expect(classifyChatError("Copilot token exchange failed: HTTP 404")).toEqual({
      code: "copilot_auth",
      raw: "Copilot token exchange failed: HTTP 404",
      status: 404,
    });
  });

  it("keeps ordinary 404 responses classified as endpoint errors", () => {
    expect(classifyChatError("Request failed: HTTP 404")).toMatchObject({
      code: "not_found",
      status: 404,
    });
  });

  it("opens provider selection for a missing per-agent model credential", () => {
    const error = classifyChatError(
      'No API key found for provider "github-copilot". | missing-provider-auth',
    );

    expect(error).toMatchObject({ code: "missing_provider_auth" });
    expect(requiresModelAuthRecovery(error)).toBe(true);
    expect(modelAuthRecoveryInitialFamily(error)).toBeUndefined();
  });

  it("opens Copilot directly only for an explicit Copilot token failure", () => {
    const error = classifyChatError("Copilot token exchange failed: HTTP 403");

    expect(modelAuthRecoveryInitialFamily(error)).toBe("github-copilot");
  });
});

describe("useChatStore — stale stream recovery", () => {
  beforeEach(() => {
    Object.keys(storage).forEach((k) => delete storage[k]);
    setActivePinia(createPinia());
    vi.restoreAllMocks();
    mockLoadHistory.mockResolvedValue({ messages: [] });
  });

  describe("protocol-compatible chat deltas", () => {
    beforeEach(() => {
      Object.keys(storage).forEach((k) => delete storage[k]);
      setActivePinia(createPinia());
    });

    function activeStore() {
      const store = useChatStore();
      store.streaming = true;
      store.sessionKey = "main";
      store.resolvedSessionKey = "agent:main:main";
      return store;
    }

    it("appends protocol-v4 deltaText chunks", () => {
      const store = activeStore();

      store.handleChatEvent({
        runId: "r1",
        sessionKey: "agent:main:main",
        state: "delta",
        deltaText: "Hel",
      });
      store.handleChatEvent({
        runId: "r1",
        sessionKey: "agent:main:main",
        state: "delta",
        deltaText: "lo",
      });

      expect(store.streamText).toBe("Hello");
    });

    it("replaces accumulated text when protocol v4 requests replacement", () => {
      const store = activeStore();
      store.streamText = "stale";

      store.handleChatEvent({
        runId: "r1",
        sessionKey: "agent:main:main",
        state: "delta",
        deltaText: "authoritative",
        replace: true,
      });

      expect(store.streamText).toBe("authoritative");
    });

    it("keeps the protocol-v3 accumulated message fallback", () => {
      const store = activeStore();
      store.streamText = "Hel";

      store.handleChatEvent({
        runId: "r1",
        sessionKey: "agent:main:main",
        state: "delta",
        message: { role: "assistant", content: "Hello" },
      });

      expect(store.streamText).toBe("Hello");
    });

    it("does not replace a longer legacy accumulation with an older message", () => {
      expect(
        applyChatDelta(
          "Hello",
          {
            runId: "r1",
            sessionKey: "agent:main:main",
            state: "delta",
            message: { role: "assistant", content: "Hel" },
          },
          "Hel",
        ),
      ).toBe("Hello");
    });
  });

  it("initialises lastStreamEventAt as null", () => {
    const store = useChatStore();
    expect(store.lastStreamEventAt).toBeNull();
  });

  it("checkStaleStream is a no-op when not streaming", () => {
    const store = useChatStore();
    store.checkStaleStream();
    expect(store.streaming).toBe(false);
  });

  it("checkStaleStream does not reset streaming within the timeout window", () => {
    const store = useChatStore();
    // Simulate an active stream
    store.streaming = true;
    store.streamStartedAt = Date.now();
    (store as any).lastStreamEventAt = Date.now();

    store.checkStaleStream();
    expect(store.streaming).toBe(true);
  });

  it("checkStaleStream resets streaming after the timeout elapses", () => {
    const store = useChatStore();
    store.streaming = true;
    store.streamStartedAt = Date.now() - 100_000; // 100 seconds ago
    (store as any).lastStreamEventAt = Date.now() - 100_000;

    store.checkStaleStream(); // default 90s threshold
    expect(store.streaming).toBe(false);
    expect(store.chatRunId).toBeNull();
    expect(store.streamStartedAt).toBeNull();
    expect(store.lastStreamEventAt).toBeNull();
    expect(mockLoadHistory).toHaveBeenCalled();
  });

  it("checkStaleStream respects a custom (shorter) timeout", () => {
    const store = useChatStore();
    store.streaming = true;
    store.streamStartedAt = Date.now() - 35_000; // 35 seconds ago
    (store as any).lastStreamEventAt = Date.now() - 35_000;

    // Default 90s — should NOT reset
    store.checkStaleStream();
    expect(store.streaming).toBe(true);

    // Custom 30s — SHOULD reset
    store.checkStaleStream(30_000);
    expect(store.streaming).toBe(false);
  });

  it("checkStaleStream falls back to streamStartedAt when no events were received", () => {
    const store = useChatStore();
    store.streaming = true;
    store.streamStartedAt = Date.now() - 100_000;
    // lastStreamEventAt is null — no events ever arrived

    store.checkStaleStream();
    expect(store.streaming).toBe(false);
  });

  it("checkStaleStream extends timeout when a tool call is in progress", () => {
    const store = useChatStore();
    store.streaming = true;
    store.streamStartedAt = Date.now() - 200_000; // 200 seconds ago
    (store as any).lastStreamEventAt = Date.now() - 200_000;
    // A tool call is still running (e.g. a long build command)
    store.streamToolCalls = [{ id: "tc1", name: "exec", done: false }];

    // Default 90s would trigger, but active tool bumps to 10 min
    store.checkStaleStream();
    expect(store.streaming).toBe(true);
  });

  it("checkStaleStream resets even with active tool after extended timeout", () => {
    const store = useChatStore();
    store.streaming = true;
    store.streamStartedAt = Date.now() - 700_000; // 700 seconds ago
    (store as any).lastStreamEventAt = Date.now() - 700_000;
    store.streamToolCalls = [{ id: "tc1", name: "exec", done: false }];

    // 700s > 600s (10 min active-tool threshold) → should reset
    store.checkStaleStream();
    expect(store.streaming).toBe(false);
  });

  it("checkStaleStream uses normal timeout when all tool calls are done", () => {
    const store = useChatStore();
    store.streaming = true;
    store.streamStartedAt = Date.now() - 100_000;
    (store as any).lastStreamEventAt = Date.now() - 100_000;
    // Tool call is completed — no active tools
    store.streamToolCalls = [{ id: "tc1", name: "exec", done: true }];

    // 100s > 90s default → should reset (no active tool protection)
    store.checkStaleStream();
    expect(store.streaming).toBe(false);
  });

  it("handleChatEvent updates lastStreamEventAt on delta", () => {
    const store = useChatStore();
    store.streaming = true;
    store.sessionKey = "main";
    store.resolvedSessionKey = "agent:main:main";

    const before = Date.now();
    store.handleChatEvent({
      runId: "r1",
      sessionKey: "agent:main:main",
      state: "delta",
      message: { role: "assistant", content: "Hello" },
    } as ChatEventPayload);

    expect(store.lastStreamEventAt).toBeGreaterThanOrEqual(before);
    expect(store.lastStreamEventAt).toBeLessThanOrEqual(Date.now());
  });

  it("handleChatEvent clears stream state and generates a summary title on final", async () => {
    const store = useChatStore();
    store.streaming = true;
    store.sessionKey = "main";
    store.resolvedSessionKey = "agent:main:main";
    (store as any).lastStreamEventAt = Date.now();
    const initialTitleRefreshRevision = store.sessionTitleRefreshRevision;

    store.handleChatEvent({
      runId: "r1",
      sessionKey: "agent:main:main",
      state: "final",
      message: { role: "assistant", content: "Done" },
    } as ChatEventPayload);

    expect(store.streaming).toBe(false);
    expect(store.lastStreamEventAt).toBeNull();
    expect(store.sessionTitleRefreshRevision).toBe(initialTitleRefreshRevision + 1);
    expect(mockGenerateSessionTitle).toHaveBeenCalledWith("agent:main:main");
    await vi.waitFor(() => {
      expect(store.sessionTitleRefreshRevision).toBe(initialTitleRefreshRevision + 2);
    });
  });

  it("handleChatEvent clears lastStreamEventAt on aborted", () => {
    const store = useChatStore();
    store.streaming = true;
    store.sessionKey = "main";
    store.resolvedSessionKey = "agent:main:main";
    (store as any).lastStreamEventAt = Date.now();

    store.handleChatEvent({
      runId: "r1",
      sessionKey: "agent:main:main",
      state: "aborted",
    } as ChatEventPayload);

    expect(store.streaming).toBe(false);
    expect(store.lastStreamEventAt).toBeNull();
  });

  it("handleChatEvent clears lastStreamEventAt on error", () => {
    const store = useChatStore();
    store.streaming = true;
    store.sessionKey = "main";
    store.resolvedSessionKey = "agent:main:main";
    (store as any).lastStreamEventAt = Date.now();

    store.handleChatEvent({
      runId: "r1",
      sessionKey: "agent:main:main",
      state: "error",
      errorMessage: "boom",
    } as ChatEventPayload);

    expect(store.streaming).toBe(false);
    expect(store.lastStreamEventAt).toBeNull();
  });

  it("handleToolEvent updates lastStreamEventAt", () => {
    const store = useChatStore();
    store.streaming = true;
    store.sessionKey = "main";
    store.resolvedSessionKey = "agent:main:main";

    const before = Date.now();
    store.handleToolEvent({
      runId: "r1",
      sessionKey: "agent:main:main",
      stream: "tool",
      data: { phase: "start", name: "exec", toolCallId: "tc1" },
    });

    expect(store.lastStreamEventAt).toBeGreaterThanOrEqual(before);
  });

  it("checkStaleStream clears streamToolCalls", () => {
    const store = useChatStore();
    store.streaming = true;
    store.streamStartedAt = Date.now() - 100_000;
    (store as any).lastStreamEventAt = Date.now() - 100_000;
    // All tool calls are done — no active-tool protection
    store.streamToolCalls = [{ id: "tc1", name: "exec", done: true }];

    store.checkStaleStream();
    expect(store.streaming).toBe(false);
    expect(store.streamToolCalls).toEqual([]);
  });
});

describe("useChatStore — recoverAfterReconnect", () => {
  beforeEach(() => {
    Object.keys(storage).forEach((k) => delete storage[k]);
    setActivePinia(createPinia());
    vi.restoreAllMocks();
    mockLoadHistory.mockResolvedValue({ messages: [] });
  });

  it("is a no-op when not streaming", async () => {
    const store = useChatStore();
    store.streaming = false;
    const callsBefore = mockLoadHistory.mock.calls.length;
    await store.recoverAfterReconnect();
    expect(store.streaming).toBe(false);
    // recoverAfterReconnect should not have called loadHistory
    expect(mockLoadHistory.mock.calls.length).toBe(callsBefore);
  });

  it("resets streaming when server has more messages", async () => {
    const store = useChatStore();
    store.streaming = true;
    store.sessionKey = "main";
    store.resolvedSessionKey = "agent:main:main";
    store.messages = [{ role: "user", content: "Hello" }];
    // Server returned 2 messages (user + assistant final)
    mockLoadHistory.mockResolvedValue({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
    });

    await store.recoverAfterReconnect();
    expect(store.streaming).toBe(false);
    expect(store.streamToolCalls).toEqual([]);
    expect(store.lastStreamEventAt).toBeNull();
  });

  it("stays streaming when server has same message count (task still running)", async () => {
    const store = useChatStore();
    store.streaming = true;
    store.sessionKey = "main";
    store.resolvedSessionKey = "agent:main:main";
    store.messages = [{ role: "user", content: "Hello" }];
    // Server still has only the user message — task is still running
    mockLoadHistory.mockResolvedValue({
      messages: [{ role: "user", content: "Hello" }],
    });

    await store.recoverAfterReconnect();
    expect(store.streaming).toBe(true);
  });

  it("works correctly even with active tool calls", async () => {
    const store = useChatStore();
    store.streaming = true;
    store.sessionKey = "main";
    store.resolvedSessionKey = "agent:main:main";
    store.messages = [{ role: "user", content: "Build the project" }];
    // Active tool call (long-running)
    store.streamToolCalls = [{ id: "tc1", name: "exec", done: false }];
    // But server says it's done
    mockLoadHistory.mockResolvedValue({
      messages: [
        { role: "user", content: "Build the project" },
        { role: "assistant", content: "Build complete." },
      ],
    });

    await store.recoverAfterReconnect();
    // Should reset despite active tool call — server is authoritative
    expect(store.streaming).toBe(false);
    expect(store.streamToolCalls).toEqual([]);
  });

  it("tolerates loadHistory failure gracefully", async () => {
    const store = useChatStore();
    store.streaming = true;
    store.sessionKey = "main";
    mockLoadHistory.mockRejectedValue(new Error("network error"));

    // Should not throw — falls back to stale-stream poll
    await store.recoverAfterReconnect();
    expect(store.streaming).toBe(true); // unchanged
  });
});

describe("useChatStore — session key learning", () => {
  beforeEach(() => {
    Object.keys(storage).forEach((k) => delete storage[k]);
    setActivePinia(createPinia());
    vi.restoreAllMocks();
    mockLoadHistory.mockResolvedValue({ messages: [] });
  });

  it("learns the resolved session key from first delta event", () => {
    const store = useChatStore();
    const sessionStore = useSessionStore();
    store.streaming = true;
    store.sessionKey = "session-abc";
    sessionStore.ensureSession("session-abc");

    store.handleChatEvent({
      runId: "r1",
      sessionKey: "agent:main:session-abc",
      state: "delta",
      message: { role: "assistant", content: "Hi" },
    } as ChatEventPayload);

    expect(store.sessionKey).toBe("agent:main:session-abc");
    expect(store.resolvedSessionKey).toBe("agent:main:session-abc");
    expect(sessionStore.sessions.map((session) => session.key)).toEqual(["agent:main:session-abc"]);
  });

  it("drops events from unrelated sessions", () => {
    const store = useChatStore();
    store.streaming = true;
    store.sessionKey = "session-abc";
    store.resolvedSessionKey = "agent:main:session-abc";

    // Event from a completely different session
    store.handleChatEvent({
      runId: "r2",
      sessionKey: "agent:main:session-xyz",
      state: "final",
      message: { role: "assistant", content: "Wrong session" },
    } as ChatEventPayload);

    // Should still be streaming (event was dropped)
    expect(store.streaming).toBe(true);
  });

  it("does not canonicalize a session from a substring-only event match", () => {
    const store = useChatStore();
    const sessionStore = useSessionStore();
    store.streaming = true;
    store.sessionKey = "session-abc";
    sessionStore.ensureSession("session-abc");

    store.handleChatEvent({
      runId: "r2",
      sessionKey: "agent:main:session-abc-extra",
      state: "delta",
      message: { role: "assistant", content: "Wrong session" },
    } as ChatEventPayload);

    expect(store.sessionKey).toBe("session-abc");
    expect(store.resolvedSessionKey).toBeNull();
    expect(sessionStore.sessions.map((session) => session.key)).toEqual(["session-abc"]);
  });
});

describe("useChatStore — draft sessions", () => {
  beforeEach(() => {
    Object.keys(storage).forEach((k) => delete storage[k]);
    setActivePinia(createPinia());
    vi.restoreAllMocks();
    mockLoadHistory.mockResolvedValue({ messages: [] });
  });

  it("does not persist a new empty session until a message is sent", () => {
    const store = useChatStore();
    store.messages = [{ role: "user", content: "existing" }];

    store.newSession();

    const persisted = JSON.parse(storage["openclaw-sessions"] ?? "[]");
    expect(store.sessionKey).toMatch(/^session-/);
    expect(store.messages).toEqual([]);
    expect(persisted.some((s: { key: string }) => s.key === store.sessionKey)).toBe(false);
  });

  it("persists a draft session when the first message is sent", async () => {
    const store = useChatStore();
    store.newSession("coder");
    const key = store.sessionKey;

    await store.sendMessage("hello draft");

    const persisted = JSON.parse(storage["openclaw-sessions"] ?? "[]");
    expect(
      persisted.some(
        (s: { key: string; title: string; agentId?: string }) =>
          s.key === key && s.title === "hello draft" && s.agentId === "coder",
      ),
    ).toBe(true);
  });

  it("encodes a non-default agent into the session key so the gateway routes to it", () => {
    const store = useChatStore();
    store.newSession("coder");
    expect(store.sessionKey).toMatch(/^agent:coder:session-/);
    expect(store.currentSessionAgentId).toBe("coder");
  });

  it("keeps a bare session key for the default (main) agent", () => {
    const store = useChatStore();
    store.newSession("main");
    expect(store.sessionKey).toMatch(/^session-/);
    expect(store.currentSessionAgentId).toBe("main");
  });

  it("attributes historical Singer session keys to Creative Muse", () => {
    const store = useChatStore();
    store.newSession("singer");
    expect(store.sessionKey).toMatch(/^agent:singer:session-/);
    expect(store.currentSessionAgentId).toBe("creative-muse");
  });
});

describe("useChatStore — attachments", () => {
  const attachment: ChatAttachment = {
    type: "image",
    mimeType: "image/png",
    fileName: "pixel.png",
    size: 3,
    content: "AQID",
  };

  beforeEach(() => {
    Object.keys(storage).forEach((k) => delete storage[k]);
    setActivePinia(createPinia());
    mockSendMessage.mockReset().mockResolvedValue(undefined);
    mockLoadHistory.mockResolvedValue({ messages: [] });
  });

  it("forwards attachments and adds them to the optimistic user message", async () => {
    const store = useChatStore();
    store.sessionKey = "session-attachments";

    await expect(store.sendMessage("describe this", [attachment])).resolves.toBe(true);

    expect(mockSendMessage).toHaveBeenCalledWith("session-attachments", "describe this", [
      attachment,
    ]);
    expect(store.messages.at(-1)).toMatchObject({
      role: "user",
      attachments: [attachment],
    });
  });

  it("supports an attachment-only message", async () => {
    const store = useChatStore();

    await expect(store.sendMessage("", [attachment])).resolves.toBe(true);

    expect(mockSendMessage).toHaveBeenCalledWith("main", "", [attachment]);
    expect(store.messages.at(-1)?.content).toEqual([]);
  });

  it("removes the optimistic message and reports failure when IPC rejects", async () => {
    const store = useChatStore();
    mockSendMessage.mockRejectedValueOnce(new Error("Gateway not connected"));

    await expect(store.sendMessage("retry me", [attachment])).resolves.toBe(false);

    expect(store.messages).toEqual([]);
    expect(store.lastError?.raw).toContain("Gateway not connected");
  });

  it("rejects a concurrent send while the first message is in flight", async () => {
    const store = useChatStore();
    let resolveSend: (() => void) | undefined;
    mockSendMessage.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveSend = resolve;
      }),
    );

    const firstSend = store.sendMessage("first", [attachment]);
    await vi.waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));

    await expect(store.sendMessage("second", [attachment])).resolves.toBe(false);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    resolveSend?.();
    await expect(firstSend).resolves.toBe(true);
  });

  it("normalizes gateway-style base64 attachment blocks", () => {
    const store = useChatStore();

    expect(
      store.getMessageAttachments({
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AQID" },
          },
        ],
      }),
    ).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        fileName: "",
        size: 0,
        content: "AQID",
      },
    ]);
  });

  it("normalizes persisted gateway media metadata", () => {
    const store = useChatStore();

    expect(
      store.getMessageAttachments({
        role: "user",
        content: "see attached",
        MediaPaths: ["C:\\openclaw\\media\\report.pdf"],
        MediaTypes: ["application/pdf"],
      }),
    ).toEqual([
      {
        type: "file",
        mimeType: "application/pdf",
        fileName: "report.pdf",
        size: 0,
        content: "",
        mediaPath: "C:\\openclaw\\media\\report.pdf",
      },
    ]);
  });

  it("keeps distinct extensionless media paths as separate attachments", () => {
    const store = useChatStore();
    const attachments = store.getMessageAttachments({
      role: "user",
      content: "two images",
      MediaPaths: [
        "media://inbound/8f6cbb00-1234-4abc-8def-1234567890ab",
        "media://inbound/9f6cbb00-1234-4abc-8def-1234567890ab",
      ],
      MediaTypes: ["image/jpeg", "image/jpeg"],
    });

    expect(attachments).toHaveLength(2);
    expect(attachments.map((attachment) => attachment.mediaPath)).toEqual([
      "media://inbound/8f6cbb00-1234-4abc-8def-1234567890ab",
      "media://inbound/9f6cbb00-1234-4abc-8def-1234567890ab",
    ]);
  });

  it("uses a generic image name for an absolute UUID image path", () => {
    const store = useChatStore();
    const [attachment] = store.getMessageAttachments({
      role: "user",
      content: "image",
      MediaPaths: [
        "C:\\Users\\sunt\\.openclaw\\media\\inbound\\1be4ae56-6c48-4787-8fef-04c0cb29e130.png",
      ],
      MediaTypes: ["image/png"],
    });

    expect(attachment.fileName).toBe("");
    expect(attachment.mediaPath).toContain("\\media\\inbound\\");
  });

  it("removes the gateway UUID suffix from a non-image inbound filename", () => {
    const store = useChatStore();
    const [attachment] = store.getMessageAttachments({
      role: "user",
      content: "text",
      MediaPaths: [
        "C:\\Users\\sunt\\.openclaw\\media\\inbound\\permission_test---499c16ac-1817-41d7-87e3-045e7aed4fa2.txt",
      ],
      MediaTypes: ["text/plain"],
    });

    expect(attachment.fileName).toBe("permission_test.txt");
  });

  it("sanitizes an attachment gateway echo and uses only MediaPaths for its chips", async () => {
    const store = useChatStore();
    const question = "What is shown in the image and text file?";
    mockLoadHistory.mockResolvedValueOnce({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "[media attached: media://inbound/permission_test---abc123.txt (text/plain)]\n" +
                `${question}\n\n` +
                '<file name="permission_test---abc123.txt" mime="text/plain">\n\n' +
                '<<<EXTERNAL_UNTRUSTED_CONTENT id="external-1">>>\n' +
                "Source: External\n---\nsecret file contents\n" +
                '<<<END_EXTERNAL_UNTRUSTED_CONTENT id="external-1">>>\n' +
                "</file>",
            },
            { type: "image", data: "/9j/..." },
          ],
          MediaPaths: [
            "media://inbound/permission_test---abc123.txt",
            "media://inbound/8f6cbb00-1234-4abc-8def-1234567890ab",
          ],
          MediaTypes: ["text/plain", "image/jpeg"],
        },
      ],
    });

    await store.loadHistory();

    expect(store.extractText(store.messages[0])).toBe(question);
    expect(store.getMessageAttachments(store.messages[0])).toEqual([
      {
        type: "file",
        mimeType: "text/plain",
        fileName: "permission_test---abc123.txt",
        size: 0,
        content: "",
        mediaPath: "media://inbound/permission_test---abc123.txt",
      },
      {
        type: "image",
        mimeType: "image/jpeg",
        fileName: "",
        size: 0,
        content: "",
        mediaPath: "media://inbound/8f6cbb00-1234-4abc-8def-1234567890ab",
      },
    ]);
  });

  it("preserves optimistic text and original filenames across the gateway echo", async () => {
    const store = useChatStore();
    const question = "What is shown in both files?";
    const attachments: ChatAttachment[] = [
      attachment,
      {
        type: "file",
        mimeType: "text/plain",
        fileName: "permission_test.txt",
        size: 5,
        content: "aGVsbG8=",
      },
    ];

    await store.sendMessage(question, attachments);
    mockLoadHistory.mockResolvedValueOnce({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "[media attached: media://inbound/permission_test---abc123.txt (text/plain)]\n" +
                `${question}\n\n<file name="permission_test---abc123.txt" mime="text/plain">` +
                '<<<EXTERNAL_UNTRUSTED_CONTENT id="external-1">>>file contents' +
                '<<<END_EXTERNAL_UNTRUSTED_CONTENT id="external-1">>></file>',
            },
            { type: "image", data: "/9j/..." },
          ],
          MediaPaths: [
            "media://inbound/permission_test---abc123.txt",
            "media://inbound/8f6cbb00-1234-4abc-8def-1234567890ab",
          ],
          MediaTypes: ["text/plain", "image/jpeg"],
        },
      ],
    });

    await store.loadHistory();

    expect(store.extractText(store.messages[0])).toBe(question);
    expect(store.getMessageAttachments(store.messages[0])).toEqual(attachments);
  });

  it("does not sanitize user text without attachment evidence", () => {
    const store = useChatStore();
    const text = "  Please explain <file>this literal example</file>.  ";

    expect(store.extractText({ role: "user", content: text })).toBe(text);
  });

  it("does not apply optimistic metadata to a different attachment message", async () => {
    const store = useChatStore();
    await store.sendMessage("My local question", [attachment]);
    mockLoadHistory.mockResolvedValueOnce({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "[media attached: media://inbound/other.txt (text/plain)]\nA remote question",
            },
          ],
          MediaPaths: ["media://inbound/other.txt"],
          MediaTypes: ["text/plain"],
        },
      ],
    });

    await store.loadHistory();

    expect(store.extractText(store.messages[0])).toBe("A remote question");
    expect(store.getMessageAttachments(store.messages[0])[0].fileName).toBe("other.txt");
    expect(store.extractText(store.messages[1])).toBe("My local question");
    expect(store.getMessageAttachments(store.messages[1])[0].fileName).toBe("pixel.png");
  });

  it("does not reconcile a repeated prompt to an older history turn", async () => {
    const store = useChatStore();
    const repeatedQuestion = "Describe this attachment";
    const oldGatewayMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: `[media attached: media://inbound/old.txt (text/plain)]\n${repeatedQuestion}`,
        },
      ],
      MediaPaths: ["media://inbound/old.txt"],
      MediaTypes: ["text/plain"],
    };
    mockLoadHistory.mockResolvedValueOnce({ messages: [oldGatewayMessage] });
    await store.loadHistory();

    await store.sendMessage(repeatedQuestion, [attachment]);
    mockLoadHistory.mockResolvedValueOnce({ messages: [oldGatewayMessage] });
    await store.loadHistory();

    expect(store.messages).toHaveLength(2);
    expect(store.getMessageAttachments(store.messages[0])[0].fileName).toBe("old.txt");
    expect(store.getMessageAttachments(store.messages[1])[0].fileName).toBe("pixel.png");
  });
});

describe("useChatStore — privacy", () => {
  beforeEach(() => {
    Object.keys(storage).forEach((k) => delete storage[k]);
    setActivePinia(createPinia());
    mockSendMessage.mockReset().mockResolvedValue(undefined);
  });

  it("sends PII unchanged when privacy defaults to basic", async () => {
    const store = useChatStore();

    await store.sendMessage("phone 13812345678");

    expect(mockSendMessage).toHaveBeenCalledWith("main", "phone 13812345678", undefined);
  });

  it("redacts PII before sending in strict mode", async () => {
    mockGetSettings.mockResolvedValueOnce({ privacyLevel: "strict" });
    const store = useChatStore();

    await store.sendMessage("phone 13812345678");

    expect(mockSendMessage).toHaveBeenCalledWith("main", "phone 138****5678", undefined);
  });

  it("honors disabled Strict categories while redacting enabled ones", async () => {
    mockGetSettings.mockResolvedValueOnce({
      privacyLevel: "strict",
      privacyControls: {
        phone: false,
        idCard: true,
        bankCard: true,
        email: true,
        apiKey: true,
      },
    });
    const store = useChatStore();

    await store.sendMessage("phone 13812345678 email alice@example.com");

    expect(mockSendMessage).toHaveBeenCalledWith(
      "main",
      "phone 13812345678 email al***@example.com",
      undefined,
    );
  });

  it("defaults missing legacy Strict controls to enabled", async () => {
    mockGetSettings.mockResolvedValueOnce({ privacyLevel: "strict", privacyControls: {} });
    const store = useChatStore();

    await store.sendMessage("phone 13812345678 email alice@example.com");

    expect(mockSendMessage).toHaveBeenCalledWith(
      "main",
      "phone 138****5678 email al***@example.com",
      undefined,
    );
  });
});

describe("useChatStore — session deletion", () => {
  beforeEach(() => {
    Object.keys(storage).forEach((k) => delete storage[k]);
    setActivePinia(createPinia());
    mockDeleteSession.mockReset().mockResolvedValue(undefined);
  });

  it("uses the canonical main key and removes its local alias before deletion", async () => {
    const store = useChatStore();
    const sessionStore = useSessionStore();
    sessionStore.ensureSession("main");
    sessionStore.updateSession("main", { title: "Existing chat", preview: "hello" });
    sessionStore.ensureSession("global");
    store.messages = [{ role: "user", content: "hello" }];

    store.setMainSessionKey("global");

    expect(store.sessionKey).toBe("global");
    expect(sessionStore.sessions).toHaveLength(1);
    expect(sessionStore.sessions[0]).toMatchObject({
      key: "global",
      title: "Existing chat",
      preview: "hello",
    });

    await store.deleteSession("global");

    expect(mockDeleteSession).toHaveBeenCalledWith("global");
    expect(sessionStore.sessions.some((session) => session.key === "main")).toBe(false);
    expect(store.sessionKey).toBe("global");
    expect(store.resolvedSessionKey).toBe("global");
    expect(sessionStore.sessions).toEqual([
      expect.objectContaining({ key: "global", agentId: "main", preview: "" }),
    ]);
    expect(store.messages).toEqual([]);
  });

  it("does not persist a generated empty draft after deleting the last session", async () => {
    const store = useChatStore();
    const sessionStore = useSessionStore();
    sessionStore.ensureSession("session-123");
    store.sessionKey = "session-123";

    await store.deleteSession("session-123");

    expect(store.sessionKey).toMatch(/^session-/);
    expect(sessionStore.sessions).toEqual([]);
    expect(JSON.parse(storage["openclaw-sessions"] ?? "[]")).toEqual([]);
  });

  it("preserves local state when Gateway deletion fails", async () => {
    const store = useChatStore();
    const sessionStore = useSessionStore();
    sessionStore.ensureSession("session-123");
    store.sessionKey = "session-123";
    store.messages = [{ role: "user", content: "keep me" }];
    mockDeleteSession.mockRejectedValueOnce(new Error("Gateway not connected"));

    await expect(store.deleteSession("session-123")).rejects.toThrow("Gateway not connected");

    expect(sessionStore.sessions.some((session) => session.key === "session-123")).toBe(true);
    expect(store.sessionKey).toBe("session-123");
    expect(store.messages).toEqual([{ role: "user", content: "keep me" }]);
  });
});

describe("useChatStore — clearing history", () => {
  beforeEach(() => {
    Object.keys(storage).forEach((k) => delete storage[k]);
    setActivePinia(createPinia());
    window.openclaw.chat.clearHistory = vi.fn().mockResolvedValue({ cleared: 2 });
  });

  it("returns to the canonical main session without creating another empty chat", async () => {
    const store = useChatStore();
    const sessionStore = useSessionStore();
    store.setMainSessionKey("global");
    sessionStore.ensureSession("session-123");

    await store.clearAllHistory();

    expect(store.sessionKey).toBe("global");
    expect(store.resolvedSessionKey).toBe("global");
    expect(sessionStore.sessions).toEqual([
      expect.objectContaining({ key: "global", agentId: "main", preview: "" }),
    ]);
  });
});

// ── Message content extraction tests ──

describe("useChatStore — extractTextOnly", () => {
  beforeEach(() => {
    Object.keys(storage).forEach((k) => delete storage[k]);
    setActivePinia(createPinia());
  });

  it("extracts text from a simple string content", () => {
    const store = useChatStore();
    expect(store.extractTextOnly({ role: "assistant", content: "Hello" })).toBe("Hello");
  });

  it("extracts only text blocks from content-block array", () => {
    const store = useChatStore();
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "Let me help." },
        { type: "tool_use", id: "t1", name: "exec", input: { command: "ls" } },
        { type: "tool_result", tool_use_id: "t1", content: "file1.txt" },
        { type: "text", text: "Here are the files." },
      ],
    };
    const result = store.extractTextOnly(msg);
    expect(result).toContain("Let me help.");
    expect(result).toContain("Here are the files.");
    expect(result).not.toContain("exec");
    expect(result).not.toContain("file1.txt");
  });

  it("extracts text from OpenClaw toolCall format without including tool data", () => {
    const store = useChatStore();
    // OpenClaw assistant message with only toolCall blocks — no text
    const msg = {
      role: "assistant",
      content: [{ type: "toolCall", name: "read", id: "call_123" }],
    };
    expect(store.extractTextOnly(msg)).toBeNull();
  });

  it("returns text from message with thinking + text blocks", () => {
    const store = useChatStore();
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Let me analyze this..." },
        { type: "text", text: "The answer is 42." },
      ],
    };
    const result = store.extractTextOnly(msg);
    expect(result).toBe("The answer is 42.");
    expect(result).not.toContain("analyze");
  });

  it("returns null when content array has no text blocks", () => {
    const store = useChatStore();
    const msg = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Hmm..." }],
    };
    expect(store.extractTextOnly(msg)).toBeNull();
  });
});

describe("useChatStore — extractThinking", () => {
  beforeEach(() => {
    Object.keys(storage).forEach((k) => delete storage[k]);
    setActivePinia(createPinia());
  });

  it("returns null for message without thinking blocks", () => {
    const store = useChatStore();
    expect(store.extractThinking({ role: "assistant", content: "Hello" })).toBeNull();
  });

  it("extracts thinking content from thinking blocks", () => {
    const store = useChatStore();
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Step 1: analyze the request" },
        { type: "text", text: "Here is my answer." },
      ],
    };
    const result = store.extractThinking(msg);
    expect(result).toBe("Step 1: analyze the request");
  });

  it("extracts reasoning content from reasoning blocks", () => {
    const store = useChatStore();
    const msg = {
      role: "assistant",
      content: [
        { type: "reasoning", reasoning: "The user wants X" },
        { type: "text", text: "Result" },
      ],
    };
    expect(store.extractThinking(msg)).toBe("The user wants X");
  });

  it("combines multiple thinking blocks", () => {
    const store = useChatStore();
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "First thought" },
        { type: "thinking", thinking: "Second thought" },
        { type: "text", text: "Conclusion" },
      ],
    };
    const result = store.extractThinking(msg);
    expect(result).toContain("First thought");
    expect(result).toContain("Second thought");
  });

  it("returns null for string content (no blocks)", () => {
    const store = useChatStore();
    expect(store.extractThinking({ role: "assistant", content: "plain text" })).toBeNull();
  });
});

describe("useChatStore — extractToolUseBlocks", () => {
  beforeEach(() => {
    Object.keys(storage).forEach((k) => delete storage[k]);
    setActivePinia(createPinia());
  });

  it("returns empty array for string content", () => {
    const store = useChatStore();
    expect(store.extractToolUseBlocks({ role: "assistant", content: "Hello" })).toEqual([]);
  });

  it("extracts tool_use blocks with names and inputs", () => {
    const store = useChatStore();
    const msg = {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "exec", input: { command: "ls -la" } },
        { type: "tool_result", tool_use_id: "t1", content: "file1.txt\nfile2.txt" },
      ],
    };
    const tools = store.extractToolUseBlocks(msg);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toContain("exec");
    expect(tools[0].result).toContain("file1.txt");
  });

  it("handles read tool with path input", () => {
    const store = useChatStore();
    const msg = {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "read", input: { path: "/etc/config" } },
        { type: "tool_result", tool_use_id: "t1", content: "config data" },
      ],
    };
    const tools = store.extractToolUseBlocks(msg);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toContain("read");
    expect(tools[0].name).toContain("/etc/config");
  });

  it("returns empty for content with only text blocks", () => {
    const store = useChatStore();
    const msg = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    };
    expect(store.extractToolUseBlocks(msg)).toEqual([]);
  });
});

describe("useChatStore — thinking + text coexistence", () => {
  beforeEach(() => {
    Object.keys(storage).forEach((k) => delete storage[k]);
    setActivePinia(createPinia());
  });

  it("message with thinking and text should have both extractable independently", () => {
    const store = useChatStore();
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I need to consider..." },
        { type: "text", text: "Here is my final answer." },
      ],
    };
    // Both should be independently extractable (not mutually exclusive)
    expect(store.extractThinking(msg)).toBeTruthy();
    expect(store.extractTextOnly(msg)).toBeTruthy();
    expect(store.extractThinking(msg)).toContain("consider");
    expect(store.extractTextOnly(msg)).toContain("final answer");
  });

  it("message with thinking, tool_use, tool_result, and text extracts all independently", () => {
    const store = useChatStore();
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Let me run a command" },
        { type: "text", text: "I'll check your files." },
        { type: "tool_use", id: "t1", name: "exec", input: { command: "dir" } },
        { type: "tool_result", tool_use_id: "t1", content: "folder1\nfolder2" },
        { type: "text", text: "Found 2 folders." },
      ],
    };
    expect(store.extractThinking(msg)).toContain("run a command");
    expect(store.extractTextOnly(msg)).toContain("check your files");
    expect(store.extractTextOnly(msg)).toContain("Found 2 folders");
    expect(store.extractTextOnly(msg)).not.toContain("folder1");
    expect(store.extractToolUseBlocks(msg)).toHaveLength(1);
    expect(store.extractToolUseBlocks(msg)[0].result).toContain("folder1");
  });

  it("OpenClaw format: toolCall-only message has no text and no thinking", () => {
    const store = useChatStore();
    const msg = {
      role: "assistant",
      content: [
        { type: "toolCall", name: "exec", id: "call_abc" },
        { type: "toolCall", name: "read", id: "call_def" },
      ],
    };
    expect(store.extractTextOnly(msg)).toBeNull();
    expect(store.extractThinking(msg)).toBeNull();
    expect(store.extractToolUseBlocks(msg)).toEqual([]); // toolCall ≠ tool_use
  });

  it("OpenClaw toolResult message text extraction works", () => {
    const store = useChatStore();
    const msg = {
      role: "toolResult",
      content: [{ type: "text", text: '{"status": "error", "error": "ENOENT"}' }],
    };
    // extractTextOnly returns the text even though role is toolResult
    expect(store.extractTextOnly(msg)).toContain("ENOENT");
  });
});

// ── Template structure guard tests ──
// These tests read the actual .vue template files and verify structural
// constraints that are easy to accidentally break during refactoring.
// They act as regression guards for bugs like the v-else-if thinking panel issue.

import { readFileSync } from "fs";
import { resolve } from "path";

function readVueTemplate(relativePath: string): string {
  const abs = resolve(__dirname, "..", relativePath);
  return readFileSync(abs, "utf-8");
}

describe("template structure guards", () => {
  it("ChatView wires clipboard paste through the image attachment handler", () => {
    const content = readVueTemplate("views/ChatView.vue");
    expect(content).toContain('@paste="handlePaste"');
    expect(content).toContain("window.openclaw.attachment.importClipboardImages");
  });

  // Guard against the thinking panel v-else-if regression:
  // hasThinking must NOT appear in a v-else-if directive, because that makes
  // the thinking panel mutually exclusive with the text content rendering.
  // It must be a v-if inside a shared v-else block instead.

  const templateFiles = ["views/ChatView.vue", "components/chat/ChatMessageList.vue"];

  for (const file of templateFiles) {
    it(`${file}: hasThinking must not be in v-else-if (would hide model reply)`, () => {
      let content: string;
      try {
        content = readVueTemplate(file);
      } catch {
        // File may not exist (e.g. before refactoring) — skip
        return;
      }
      // Check that no line has v-else-if="hasThinking(..."
      const lines = content.split("\n");
      const badLines = lines.filter((line) => /v-else-if\s*=\s*"hasThinking/.test(line));
      expect(
        badLines,
        `Found v-else-if="hasThinking(...)" in ${file} — this makes thinking panel mutually exclusive with text content. Use v-if inside a v-else block instead.`,
      ).toEqual([]);
    });

    it(`${file}: isToolMessage skip must not swallow all other rendering branches`, () => {
      let content: string;
      try {
        content = readVueTemplate(file);
      } catch {
        return;
      }
      // After isToolMessage template, the next branch should be v-else (wrapper)
      // not v-else-if (which would create another exclusive branch)
      const lines = content.split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/isToolMessage.*exec panel/.test(lines[i]) || /v-if="isToolMessage/.test(lines[i])) {
          // Look at the next few non-empty lines for the thinking section
          for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
            if (/hasThinking/.test(lines[j])) {
              expect(lines[j]).not.toMatch(/v-else-if/);
              break;
            }
          }
        }
      }
    });
  }
});
