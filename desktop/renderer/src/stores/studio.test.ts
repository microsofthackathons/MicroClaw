import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { nextTick } from "vue";
import { useStudioStore } from "./studio";
import { useChatStore } from "./chat";

const mockStudioStart = vi.fn().mockResolvedValue(18789);
const mockStudioStop = vi.fn().mockResolvedValue(undefined);
const mockStudioGetStatus = vi.fn().mockResolvedValue("stopped");
const mockStudioGetPort = vi.fn().mockResolvedValue(18789);
let statusListener: ((status: string) => void) | null = null;
const mockStudioOnStatus = vi.fn((cb: (status: string) => void) => {
  statusListener = cb;
  return () => {
    if (statusListener === cb) statusListener = null;
  };
});

const mockFetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/status")) {
    return {
      ok: true,
      json: async () => ({
        state: "idle",
        detail: "",
        progress: 0,
        name: "Star",
        updatedAt: Date.now(),
      }),
    } as Response;
  }
  if (url.endsWith("/agents")) {
    return {
      ok: true,
      json: async () => [],
    } as Response;
  }
  if (url.endsWith("/set_state")) {
    return {
      ok: true,
      json: async () => ({ ok: true }),
    } as Response;
  }
  return {
    ok: true,
    json: async () => ({}),
  } as Response;
});

const mockLoadHistory = vi.fn().mockResolvedValue({ messages: [] });

function hasSetStateCall(): boolean {
  return mockFetch.mock.calls.some(([input]) => String(input).endsWith("/set_state"));
}

function getSetStateBodies(): Array<{ state?: string; detail?: string; progress?: number }> {
  return mockFetch.mock.calls
    .filter(([input]) => String(input).endsWith("/set_state"))
    .map(([, init]) => {
      const body = init?.body;
      return typeof body === "string" ? JSON.parse(body) : {};
    });
}

describe("useStudioStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    statusListener = null;

    mockStudioGetStatus.mockResolvedValue("stopped");
    mockStudioGetPort.mockResolvedValue(18789);

    Object.defineProperty(globalThis, "window", {
      value: {
        ...globalThis.window,
        openclaw: {
          ...(globalThis.window as any)?.openclaw,
          studio: {
            start: mockStudioStart,
            stop: mockStudioStop,
            getStatus: mockStudioGetStatus,
            getPort: mockStudioGetPort,
            onStatus: mockStudioOnStatus,
          },
          chat: {
            loadHistory: mockLoadHistory,
            sendMessage: vi.fn(),
            abort: vi.fn(),
            isConnected: vi.fn().mockResolvedValue(false),
            onEvent: vi.fn(() => vi.fn()),
            onToolEvent: vi.fn(() => vi.fn()),
            onExecCommand: vi.fn(() => vi.fn()),
          },
          settings: {
            get: vi.fn().mockResolvedValue({}),
          },
        },
      },
      writable: true,
      configurable: true,
    });

    vi.stubGlobal("fetch", mockFetch);

    // Stub localStorage unconditionally — see chat.test.ts for context on
    // why we don't trust jsdom's built-in implementation in CI.
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps manual override active until user clears it", async () => {
    const studio = useStudioStore();
    const chat = useChatStore();

    studio.initialize();
    studio.backendStatus = "running";
    studio.backendPort = 18789;

    await studio.setManualState("executing", "manual");
    expect(studio.isManualOverrideActive()).toBe(true);

    mockFetch.mockClear();
    chat.streaming = true;
    chat.streamToolCalls = [{ id: "t1", name: "search", done: false } as any];
    await nextTick();
    await Promise.resolve();

    expect(hasSetStateCall()).toBe(false);

    studio.teardown();
  });

  it("resumes auto mapping only after clearManualOverride", async () => {
    const studio = useStudioStore();
    const chat = useChatStore();

    studio.backendStatus = "running";
    studio.backendPort = 18789;
    chat.streaming = true;
    chat.streamToolCalls = [{ id: "t1", name: "search", done: false } as any];
    chat.sending = false;

    await studio.setManualState("executing", "manual");
    expect(studio.isManualOverrideActive()).toBe(true);

    mockFetch.mockClear();
    studio.clearManualOverride();
    await Promise.resolve();

    const bodies = getSetStateBodies();
    expect(studio.isManualOverrideActive()).toBe(false);
    expect(bodies.length).toBe(1);
    expect(bodies[0].state).toBe("researching");
  });

  it("does not POST duplicate set_state payloads", async () => {
    const studio = useStudioStore();

    studio.backendStatus = "running";
    studio.backendPort = 18789;

    mockFetch.mockClear();
    await studio.setManualState("writing", "same");
    await studio.setManualState("writing", "same");

    const bodies = getSetStateBodies();
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toMatchObject({ state: "writing", detail: "same", progress: 0 });
  });

  it("starts polling on running and stops polling on failed", async () => {
    vi.useFakeTimers();

    const studio = useStudioStore();
    studio.initialize();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(statusListener).toBeTypeOf("function");
    expect(vi.getTimerCount()).toBe(0);

    statusListener?.("running");
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(3000);
    await Promise.resolve();

    statusListener?.("failed");
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);

    studio.teardown();
  });
});
