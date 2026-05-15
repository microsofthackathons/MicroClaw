/**
 * Tests for studio-backend store and config modules.
 *
 * The store is the core state engine — it validates states, persists to disk,
 * and manages guest agents. These tests exercise it in isolation (no HTTP).
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

// ── Helpers to isolate each test with a temp data dir ──

function createIsolatedModules(tmpDir) {
  // Point config at the temp dir before loading store
  const configPath = require.resolve("./config");
  const storePath = require.resolve("./store");

  // Clear module cache so each test gets fresh state
  delete require.cache[configPath];
  delete require.cache[storePath];

  // Override DATA_DIR via env before requiring config
  process.env.STUDIO_DATA_DIR = tmpDir;

  const config = require("./config");
  config.ensureDirectories();

  const store = require("./store");
  store.loadState();
  store.loadAgents();

  return { config, store };
}

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-test-"));
});

afterEach(() => {
  delete process.env.STUDIO_DATA_DIR;
  // Clean up temp dir
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── VALID_STATES ──

describe("config.VALID_STATES", () => {
  it("includes all expected agent states", () => {
    const { config } = createIsolatedModules(tmpDir);
    const expected = ["idle", "writing", "researching", "executing", "syncing", "error"];
    for (const state of expected) {
      expect(config.VALID_STATES.has(state), `missing state: ${state}`).toBe(true);
    }
  });

  it("does not include arbitrary strings", () => {
    const { config } = createIsolatedModules(tmpDir);
    expect(config.VALID_STATES.has("dancing")).toBe(false);
    expect(config.VALID_STATES.has("")).toBe(false);
  });
});

// ── updateMainState ──

describe("store.updateMainState", () => {
  it("updates state to a valid value", () => {
    const { store } = createIsolatedModules(tmpDir);
    const result = store.updateMainState({ state: "writing", detail: "drafting" });
    expect(result.state).toBe("writing");
    expect(result.detail).toBe("drafting");
  });

  it("rejects an invalid state", () => {
    const { store } = createIsolatedModules(tmpDir);
    expect(() => store.updateMainState({ state: "dancing" })).toThrow("Invalid state");
  });

  it("defaults to idle when state is empty", () => {
    const { store } = createIsolatedModules(tmpDir);
    const result = store.updateMainState({});
    expect(result.state).toBe("idle");
  });

  it("truncates detail to 200 characters", () => {
    const { store } = createIsolatedModules(tmpDir);
    const longDetail = "x".repeat(300);
    const result = store.updateMainState({ state: "writing", detail: longDetail });
    expect(result.detail.length).toBe(200);
  });

  it("clamps progress to 0-100", () => {
    const { store } = createIsolatedModules(tmpDir);
    expect(store.updateMainState({ state: "idle", progress: -10 }).progress).toBe(0);
    expect(store.updateMainState({ state: "idle", progress: 200 }).progress).toBe(100);
    expect(store.updateMainState({ state: "idle", progress: 50 }).progress).toBe(50);
  });

  it("persists state to disk", () => {
    const { config, store } = createIsolatedModules(tmpDir);
    store.updateMainState({ state: "executing", detail: "running tests" });
    const saved = JSON.parse(fs.readFileSync(config.STATE_FILE, "utf-8"));
    expect(saved.state).toBe("executing");
    expect(saved.detail).toBe("running tests");
  });
});

// ── getMainState ──

describe("store.getMainState", () => {
  it("returns the current state", () => {
    const { store } = createIsolatedModules(tmpDir);
    store.updateMainState({ state: "researching", detail: "searching docs" });
    const state = store.getMainState();
    expect(state.state).toBe("researching");
    expect(state.detail).toBe("searching docs");
  });

  it("returns idle by default", () => {
    const { store } = createIsolatedModules(tmpDir);
    expect(store.getMainState().state).toBe("idle");
  });
});

// ── State persistence round-trip ──

describe("state persistence", () => {
  it("survives load → save → reload cycle", () => {
    const { store } = createIsolatedModules(tmpDir);
    store.updateMainState({ state: "executing", detail: "running tests" });

    // Reload from disk with fresh modules
    const { store: store2 } = createIsolatedModules(tmpDir);
    const restored = store2.getMainState();
    expect(restored.state).toBe("executing");
    expect(restored.detail).toBe("running tests");
  });
});

// ── Guest agents ──

describe("guest agents", () => {
  it("join and list a guest agent", () => {
    const { store } = createIsolatedModules(tmpDir);
    const agent = store.joinAgent({ name: "Helper" });
    expect(agent.name).toBe("Helper");
    expect(agent.id).toBeTruthy();

    const agents = store.listGuestAgents();
    expect(agents.length).toBe(1);
    expect(agents[0].name).toBe("Helper");
  });

  it("pushAgentState updates an existing agent", () => {
    const { store } = createIsolatedModules(tmpDir);
    const agent = store.joinAgent({ name: "Helper" });
    const updated = store.pushAgentState({ id: agent.id, state: "writing", detail: "coding" });
    expect(updated.state).toBe("writing");
    expect(updated.detail).toBe("coding");
  });

  it("pushAgentState throws for unknown agent", () => {
    const { store } = createIsolatedModules(tmpDir);
    expect(() => store.pushAgentState({ id: "nonexistent", state: "idle" })).toThrow(
      "Agent not found",
    );
  });

  it("leaveAgent removes the agent", () => {
    const { store } = createIsolatedModules(tmpDir);
    const agent = store.joinAgent({ name: "Helper" });
    store.leaveAgent({ id: agent.id });
    expect(store.listGuestAgents().length).toBe(0);
  });

  it("cleanStaleGuests removes expired agents", () => {
    const { config, store } = createIsolatedModules(tmpDir);
    store.joinAgent({ name: "OldGuest" });
    // Simulate time passing beyond TTL
    const futureTime = Date.now() + config.GUEST_TTL_MS + 1000;
    store.cleanStaleGuests(futureTime);
    expect(store.listGuestAgents().length).toBe(0);
  });
});
