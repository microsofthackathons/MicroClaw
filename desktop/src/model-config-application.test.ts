import { afterEach, describe, expect, it, vi } from "vitest";
import { applyModelConfig, type ModelConfigUpdate } from "./model-config-application";

function fixture() {
  const before = {
    models: { providers: { qwen: { apiKey: "private-fixture-key", models: [{ id: "old" }] } } },
    agents: { defaults: { model: { primary: "qwen/old" } } },
    gateway: { port: 18789 },
  };
  let saved: unknown = structuredClone(before);
  let hash = "before";
  let applied = true;
  const snapshot = () => ({
    valid: true,
    hash,
    configRevisionHash: hash,
    appliedConfigHash: applied ? hash : "previous",
  });
  const request = vi.fn(
    async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      if (method === "config.get") return snapshot();
      if (method === "config.apply") {
        saved = JSON.parse(String(params?.raw));
        hash = "after";
        return { ok: true, hash };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  );
  const gateway = {
    connected: true,
    serverVersion: "2026.10.5",
    connectionGeneration: 1,
    methods: ["config.get", "config.apply"],
    request,
  };
  const deps = {
    gateway: () => gateway,
    readConfig: vi.fn(() => saved),
    assertMutable: vi.fn(),
    log: vi.fn(),
  };
  const input: ModelConfigUpdate = {
    config: {
      ...before,
      models: { providers: { qwen: { apiKey: "private-fixture-key", models: [{ id: "new" }] } } },
    },
    expectedConfig: before,
    action: "provider-save",
    providerKey: "qwen",
  };
  return {
    deps,
    gateway,
    input,
    snapshot,
    saved: () => saved,
    setApplied: (value: boolean) => {
      applied = value;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("applyModelConfig", () => {
  it("applies the complete configuration with a revision guard and confirms runtime application", async () => {
    const state = fixture();
    await applyModelConfig(state.deps, state.input);
    expect(state.gateway.request.mock.calls.map(([method]) => method)).toEqual([
      "config.get",
      "config.apply",
      "config.get",
    ]);
    expect(state.gateway.request).toHaveBeenCalledWith(
      "config.apply",
      { baseHash: "before", raw: JSON.stringify(state.input.config), note: "provider-save: qwen" },
      30_000,
    );
    expect(state.saved()).toEqual(state.input.config);
    expect(state.deps.log).toHaveBeenLastCalledWith(
      "[model-config] action=provider-save provider=qwen status=hot-applied",
    );
    expect(JSON.stringify(state.deps.log.mock.calls)).not.toContain("private-fixture-key");
  });

  it.each(["provider-remove", "model-remove", "copilot-save", "copilot-disconnect"] as const)(
    "supports deletions and replacements for %s without retaining removed array entries",
    async (action) => {
      const state = fixture();
      state.input.action = action;
      state.input.config = {
        models: { providers: {} },
        agents: { defaults: {} },
        gateway: { port: 18789 },
      };
      await applyModelConfig(state.deps, state.input);
      expect(state.saved()).toEqual(state.input.config);
      expect(
        state.gateway.request.mock.calls.filter(([method]) => method === "config.apply"),
      ).toHaveLength(1);
    },
  );

  it("checks unchanged Copilot preparation without writing the configuration again", async () => {
    const state = fixture();
    state.input.config = state.input.expectedConfig;
    state.input.action = "copilot-prepare";
    state.input.providerKey = "github-copilot";
    await applyModelConfig(state.deps, state.input);
    expect(state.gateway.request.mock.calls.every(([method]) => method === "config.get")).toBe(
      true,
    );
  });

  it("rejects stale configuration and blocked mutations before contacting the Gateway", async () => {
    const stale = fixture();
    stale.deps.readConfig.mockReturnValue({ changed: true });
    await expect(applyModelConfig(stale.deps, stale.input)).rejects.toThrow(
      "configuration changed",
    );
    expect(stale.gateway.request).not.toHaveBeenCalled();
    const blocked = fixture();
    blocked.deps.assertMutable.mockImplementation(() => {
      throw new Error("Streaming");
    });
    await expect(applyModelConfig(blocked.deps, blocked.input)).rejects.toThrow("Streaming");
    expect(blocked.gateway.request).not.toHaveBeenCalled();
  });

  it("keeps application pending until the runtime revision matches", async () => {
    vi.useFakeTimers();
    const state = fixture();
    state.setApplied(false);
    const pending = applyModelConfig(state.deps, state.input);
    await vi.advanceTimersByTimeAsync(500);
    expect(state.deps.log).not.toHaveBeenCalledWith(expect.stringContaining("hot-applied"));
    state.setApplied(true);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(state.deps.log).toHaveBeenLastCalledWith(expect.stringContaining("hot-applied"));
  });

  it("does not repeat an uncertain application or try to restart the Gateway", async () => {
    const state = fixture();
    state.gateway.request
      .mockResolvedValueOnce(state.snapshot())
      .mockRejectedValueOnce(new Error("Lost response"));
    await expect(applyModelConfig(state.deps, state.input)).rejects.toThrow("No restart or retry");
    expect(state.gateway.request.mock.calls.map(([method]) => method)).toEqual([
      "config.get",
      "config.apply",
    ]);
    expect(state.deps.log).toHaveBeenLastCalledWith(expect.stringContaining("unconfirmed"));
  });

  it("does not report success when the Gateway requests a restart", async () => {
    const state = fixture();
    state.gateway.request.mockResolvedValueOnce(state.snapshot()).mockResolvedValueOnce({
      ok: true,
      hash: "after",
      sentinel: { payload: { stats: { requiresRestart: true } } },
    });
    await expect(applyModelConfig(state.deps, state.input)).rejects.toThrow("No restart or retry");
    expect(state.deps.log).not.toHaveBeenCalledWith(expect.stringContaining("hot-applied"));
  });

  it("rejects disconnected Gateways and unsafe logging context without writing", async () => {
    const disconnected = fixture();
    disconnected.gateway.connected = false;
    await expect(applyModelConfig(disconnected.deps, disconnected.input)).rejects.toThrow(
      "connected",
    );
    expect(disconnected.gateway.request).not.toHaveBeenCalled();
    const unsafe = fixture();
    unsafe.input.providerKey = "qwen\nsecret";
    await expect(applyModelConfig(unsafe.deps, unsafe.input)).rejects.toThrow("change reason");
    expect(unsafe.deps.log).not.toHaveBeenCalled();
  });
});
