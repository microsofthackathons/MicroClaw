import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

// Mock window.openclaw before importing stores
const mockOnclaw = {
  gateway: {
    onStatus: vi.fn(() => vi.fn()),
    onLog: vi.fn(() => vi.fn()),
    onWsConnected: vi.fn(() => vi.fn()),
    onWsDisconnected: vi.fn(() => vi.fn()),
    getStatus: vi.fn().mockResolvedValue("stopped"),
    getPort: vi.fn().mockResolvedValue(18789),
    restart: vi.fn().mockResolvedValue(undefined),
  },
  chat: {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    loadHistory: vi.fn().mockResolvedValue({ messages: [] }),
    abort: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn(() => vi.fn()),
  },
  skills: {
    onIntegrityAlert: vi.fn(() => vi.fn()),
  },
  agents: {
    list: vi.fn().mockResolvedValue({ agents: [] }),
  },
  settings: {
    get: vi.fn().mockResolvedValue({ language: "en-US" }),
    set: vi.fn(),
  },
  plugin: {
    weixin: {
      getStatus: vi.fn().mockResolvedValue({ loggedIn: false }),
    },
  },
};

Object.defineProperty(globalThis, "window", {
  value: { openclaw: mockOnclaw, localStorage: createMockLocalStorage() },
  writable: true,
});

function createMockLocalStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      Object.keys(store).forEach((k) => delete store[k]);
    },
  };
}

import { useGatewayStore } from "./gateway";

describe("useGatewayStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("starts with default values", () => {
    const store = useGatewayStore();
    expect(store.status).toBe("stopped");
    expect(store.port).toBe(0);
    expect(store.logs).toEqual([]);
    expect(store.ready).toBe(false);
    expect(store.warming).toBe(false);
    expect(store.weixinLoggedIn).toBe(false);
  });

  it("addLog appends messages", () => {
    const store = useGatewayStore();
    store.addLog("line 1");
    store.addLog("line 2");
    expect(store.logs).toEqual(["line 1", "line 2"]);
  });

  it("addLog trims at 600 to keep 500", () => {
    const store = useGatewayStore();
    // Add 601 lines
    for (let i = 0; i < 601; i++) {
      store.addLog(`line ${i}`);
    }
    expect(store.logs.length).toBe(500);
    expect(store.logs[0]).toBe("line 101");
    expect(store.logs[499]).toBe("line 600");
  });

  it("addLog does NOT trim at exactly 500", () => {
    const store = useGatewayStore();
    for (let i = 0; i < 500; i++) {
      store.addLog(`line ${i}`);
    }
    expect(store.logs.length).toBe(500);
    // Add one more — still under 600 threshold
    store.addLog("line 500");
    expect(store.logs.length).toBe(501);
  });

  it("markReady sets ready to true", () => {
    const store = useGatewayStore();
    expect(store.ready).toBe(false);
    store.markReady();
    expect(store.ready).toBe(true);
  });

  it("deduplicates warming and clears it when ready", () => {
    const store = useGatewayStore();
    expect(store.beginWarming()).toBe(true);
    expect(store.beginWarming()).toBe(false);
    expect(store.warming).toBe(true);

    store.markReady();

    expect(store.warming).toBe(false);
    expect(store.ready).toBe(true);
  });

  it("resetReady sets ready back to false", () => {
    const store = useGatewayStore();
    store.markReady();
    store.resetReady();
    expect(store.ready).toBe(false);
    expect(store.warming).toBe(false);
  });

  it("ignores stale readiness completion after a security transition starts", () => {
    const store = useGatewayStore();
    const staleEpoch = store.readinessEpoch;
    store.resetReady();

    store.markReady(staleEpoch);

    expect(store.ready).toBe(false);
    store.markReady(store.readinessEpoch);
    expect(store.ready).toBe(true);
  });

  it("markReady is idempotent", () => {
    const store = useGatewayStore();
    store.markReady();
    store.markReady();
    expect(store.ready).toBe(true);
  });
});
