import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

// Mock localStorage
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

import { useSessionStore } from "./sessions";
import { AGENT_WARMUP_SESSION_KEY } from "../../../src/constants";

describe("useSessionStore", () => {
  beforeEach(() => {
    // Clear localStorage and re-create pinia
    Object.keys(storage).forEach((k) => delete storage[k]);
    setActivePinia(createPinia());
  });

  it("starts with empty sessions", () => {
    const store = useSessionStore();
    expect(store.sessions).toEqual([]);
    expect(store.currentKey).toBeNull();
  });

  it("ensureSession creates a new session", () => {
    const store = useSessionStore();
    store.ensureSession("test-1");
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0].key).toBe("test-1");
    expect(store.currentKey).toBe("test-1");
  });

  it("ensureSession is idempotent", () => {
    const store = useSessionStore();
    store.ensureSession("test-1");
    store.ensureSession("test-1");
    expect(store.sessions).toHaveLength(1);
  });

  it("never creates or selects the reserved warm-up session", () => {
    const store = useSessionStore();

    store.ensureSession(AGENT_WARMUP_SESSION_KEY);
    store.reconcileEmptySessions(AGENT_WARMUP_SESSION_KEY, "main");

    expect(store.sessions).toEqual([]);
    expect(store.currentKey).toBeNull();
  });

  it("reconciles stale empty sessions with the canonical main session", () => {
    const store = useSessionStore();
    store.ensureSession("session-stale-1");
    store.ensureSession("session-stale-2");

    store.reconcileEmptySessions("agent:main:main", "main");

    expect(store.sessions).toEqual([
      expect.objectContaining({
        key: "agent:main:main",
        agentId: "main",
      }),
    ]);
    expect(store.currentKey).toBe("agent:main:main");
  });

  it("does not discard sessions that contain messages during reconciliation", () => {
    const store = useSessionStore();
    store.ensureSession("existing");
    store.updateSession("existing", { title: "Existing chat", preview: "hello" });
    store.ensureSession("session-stale");

    store.reconcileEmptySessions("agent:main:main", "main");

    expect(store.sessions).toHaveLength(2);
    expect(store.sessions).toContainEqual(
      expect.objectContaining({ key: "existing", preview: "hello" }),
    );
    expect(store.sessions).toContainEqual(
      expect.objectContaining({ key: "agent:main:main", agentId: "main" }),
    );
  });

  it("ensureSession sets the default title from i18n", () => {
    const store = useSessionStore();
    store.ensureSession("test-1");
    // The i18n system returns the key when not initialized
    // (or the translated text if locale is set)
    expect(store.sessions[0].title).toBeTruthy();
  });

  it("updateSession changes title and preview", () => {
    const store = useSessionStore();
    store.ensureSession("test-1");
    store.updateSession("test-1", { title: "My Chat", preview: "Hello..." });
    expect(store.sessions[0].title).toBe("My Chat");
    expect(store.sessions[0].preview).toBe("Hello...");
  });

  it("removeSession deletes a session", () => {
    const store = useSessionStore();
    store.ensureSession("test-1");
    store.ensureSession("test-2");
    store.removeSession("test-1");
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0].key).toBe("test-2");
  });

  it("toggles and persists a pinned session", () => {
    const store = useSessionStore();
    store.ensureSession("test-1");

    store.togglePinned("test-1");

    expect(store.sessions[0].pinned).toBe(true);
    expect(JSON.parse(storage["openclaw-sessions"])[0].pinned).toBe(true);

    store.togglePinned("test-1");
    expect(store.sessions[0].pinned).toBe(false);
  });

  it("canonicalizeSession replaces a local alias", () => {
    const store = useSessionStore();
    store.ensureSession("main");
    store.updateSession("main", { title: "Existing chat", preview: "hello" });

    store.canonicalizeSession("main", "global");

    expect(store.sessions).toEqual([
      expect.objectContaining({
        key: "global",
        title: "Existing chat",
        preview: "hello",
      }),
    ]);
    expect(store.currentKey).toBe("global");
  });

  it("canonicalizeSession merges duplicate aliases without losing metadata", () => {
    const store = useSessionStore();
    store.ensureSession("main");
    store.updateSession("main", { title: "Existing chat", preview: "hello" });
    store.ensureSession("global");

    store.canonicalizeSession("main", "global");

    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0]).toMatchObject({
      key: "global",
      title: "Existing chat",
      preview: "hello",
    });
  });

  it("autoTitle updates title from first user message", () => {
    const store = useSessionStore();
    store.ensureSession("test-1");
    store.autoTitle("test-1", "Help me write a Python script for data analysis");
    // .slice(0, 30) may cut mid-word — just verify it starts correctly and is ≤ 30 chars
    expect(store.sessions[0].title).toHaveLength(30);
    expect(store.sessions[0].title).toMatch(/^Help me write a Python script/);
  });

  it("autoTitle truncates to 30 chars", () => {
    const store = useSessionStore();
    store.ensureSession("test-1");
    store.autoTitle("test-1", "A".repeat(50));
    expect(store.sessions[0].title.length).toBeLessThanOrEqual(30);
  });

  it("autoTitle does not overwrite a manually set title", () => {
    const store = useSessionStore();
    store.ensureSession("test-1");
    store.updateSession("test-1", { title: "Custom Title" });
    store.autoTitle("test-1", "This should not replace");
    expect(store.sessions[0].title).toBe("Custom Title");
  });

  it("uses the Gateway title for display and falls back to the local title", () => {
    const store = useSessionStore();
    store.ensureSession("test-1");
    store.updateSession("test-1", { title: "Local title" });
    const session = store.sessions[0];

    expect(store.getDisplayTitle(session)).toBe("Local title");

    store.setGatewayTitles({ "test-1": "Gateway title" });
    expect(store.getDisplayTitle(session)).toBe("Gateway title");

    store.setGatewayTitles({});
    expect(store.getDisplayTitle(session)).toBe("Local title");
  });

  it("sortedSessions returns sessions sorted by updatedAt descending", () => {
    const store = useSessionStore();
    store.ensureSession("old");
    store.ensureSession("new");
    // Force different timestamps
    const oldSession = store.sessions.find((s) => s.key === "old")!;
    const newSession = store.sessions.find((s) => s.key === "new")!;
    oldSession.updatedAt = 1000;
    newSession.updatedAt = 2000;
    const sorted = store.sortedSessions;
    expect(sorted[0].key).toBe("new");
  });

  it("persists sessions to localStorage", () => {
    const store = useSessionStore();
    store.ensureSession("persist-test");
    const raw = storage["openclaw-sessions"];
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].key).toBe("persist-test");
  });

  it("loads sessions from localStorage on init", () => {
    storage["openclaw-sessions"] = JSON.stringify([
      { key: "loaded", title: "Loaded Session", createdAt: 1, updatedAt: 1, preview: "" },
    ]);
    setActivePinia(createPinia());
    const store = useSessionStore();
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0].key).toBe("loaded");
  });

  it("keeps historical Singer sessions visible under Creative Muse", () => {
    storage["openclaw-sessions"] = JSON.stringify([
      {
        key: "agent:singer:legacy",
        title: "Legacy draft",
        createdAt: 1,
        updatedAt: 1,
        preview: "lyrics",
        agentId: "singer",
      },
    ]);
    setActivePinia(createPinia());

    const store = useSessionStore();

    expect(store.sessions[0]).toMatchObject({
      key: "agent:singer:legacy",
      agentId: "creative-muse",
      title: "Legacy draft",
    });
  });

  it("keeps historical Master sessions visible under Dr. Pulse", () => {
    storage["openclaw-sessions"] = JSON.stringify([
      {
        key: "agent:master:legacy",
        title: "Legacy system check",
        createdAt: 1,
        updatedAt: 1,
        preview: "diagnose",
        agentId: "master",
      },
    ]);
    setActivePinia(createPinia());

    const store = useSessionStore();

    expect(store.sessions[0]).toMatchObject({
      key: "agent:master:legacy",
      agentId: "dr-pulse",
      title: "Legacy system check",
    });
  });

  it("keeps historical Leopard sessions visible under Market Sentinel", () => {
    storage["openclaw-sessions"] = JSON.stringify([
      {
        key: "agent:leopard:legacy",
        title: "Legacy market review",
        createdAt: 1,
        updatedAt: 1,
        preview: "market",
        agentId: "leopard",
      },
    ]);
    setActivePinia(createPinia());

    const store = useSessionStore();

    expect(store.sessions[0]).toMatchObject({
      key: "agent:leopard:legacy",
      agentId: "market-sentinel",
      title: "Legacy market review",
    });
  });

  it("removes a persisted reserved warm-up session on load", () => {
    storage["openclaw-sessions"] = JSON.stringify([
      {
        key: AGENT_WARMUP_SESSION_KEY,
        title: "Hidden warm-up",
        createdAt: 1,
        updatedAt: 1,
        preview: "ping",
      },
      { key: "visible", title: "Visible", createdAt: 1, updatedAt: 1, preview: "" },
    ]);
    setActivePinia(createPinia());

    const store = useSessionStore();

    expect(store.sessions.map((session) => session.key)).toEqual(["visible"]);
  });

  it("handles corrupted localStorage gracefully", () => {
    storage["openclaw-sessions"] = "not valid json{{{";
    setActivePinia(createPinia());
    const store = useSessionStore();
    expect(store.sessions).toEqual([]);
  });
});
