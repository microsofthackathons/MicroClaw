import { afterEach, describe, expect, it, vi } from "vitest";
import { selectDefaultModel } from "./default-model-selection";
import { GatewayRequestError } from "./gateway-client";
import { MODEL_APPLY_SETTLE_TIMEOUT_MS } from "./constants";

function fixture(target = "cloud/b") {
  const config = {
    agents: {
      defaults: {
        model: { primary: "cloud/a", fallbacks: ["cloud/fallback"] },
        models: { "cloud/a": { alias: "A" } },
        modelPolicy: { allow: ["cloud/a"] },
      },
      entries: { main: {}, writer: { model: { primary: "cloud/a" } } },
    },
    models: {
      providers: { cloud: { apiKey: "fixture-only", models: [{ id: "a" }, { id: "b" }] } },
    },
    auth: { profiles: { copilot: { provider: "github-copilot", mode: "token" } } },
  };
  const before = structuredClone(config);
  let applied = true;
  const handle = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    if (method === "config.get")
      return {
        valid: true,
        hash: "revision",
        config: structuredClone(config),
        configRevisionHash: "disk-revision",
        appliedConfigHash: applied ? "disk-revision" : "old-revision",
      };
    if (method === "config.patch") {
      expect(params).toEqual({
        baseHash: "revision",
        raw: JSON.stringify({ agents: { defaults: { model: { primary: target } } } }),
      });
      config.agents.defaults.model.primary = target;
      return {
        ok: true,
        config: structuredClone(config),
        sentinel: { payload: { stats: { requiresRestart: false } } },
      };
    }
    if (method === "models.authStatus")
      return { providers: [{ provider: "github-copilot", status: "ok" }] };
    if (method === "models.list")
      return {
        models: [
          { provider: "github-copilot", id: "gpt-6-sol", name: "GPT-6 Sol", available: true },
        ],
      };
    throw new Error(`Unexpected RPC ${method}`);
  };
  const request = vi.fn(handle);
  const gateway = {
    connected: true,
    serverVersion: "2026.9.3",
    connectionGeneration: 1,
    methods: ["config.get", "config.patch", "models.authStatus", "models.list"],
    request,
  };
  const deps = { gateway: () => gateway, readConfig: () => config, assertMutable: vi.fn() };
  const select = () => selectDefaultModel(deps, { modelRef: target, expectedConfig: before });
  return {
    config,
    before,
    request,
    handle,
    gateway,
    deps,
    select,
    setApplied: (value: boolean) => {
      applied = value;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("default model hot selection", () => {
  it("rejects realtime models before any default-model RPC", async () => {
    const f = fixture("qwen/qwen3.8-omni-flash-realtime");
    await expect(f.select()).rejects.toThrow("UNSUPPORTED_CHAT_MODEL");
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(["2026.9.3", "2026.10.2", "2026.10.3"])(
    "writes only the primary using CAS on %s without inference or restart",
    async (version) => {
      const f = fixture();
      f.gateway.serverVersion = version;
      await expect(f.select()).resolves.toEqual({ modelRef: "cloud/b" });
      expect(f.config).toEqual({
        ...f.before,
        agents: {
          ...f.before.agents,
          defaults: {
            ...f.before.agents.defaults,
            model: { ...f.before.agents.defaults.model, primary: "cloud/b" },
          },
        },
      });
      expect(f.request.mock.calls.map(([method]) => method)).toEqual([
        "config.get",
        "config.patch",
        "config.get",
      ]);
    },
  );

  it("uses only the authenticated prepared Copilot catalogue, never discovery", async () => {
    const f = fixture("github-copilot/gpt-6-sol");
    await expect(f.select()).resolves.toEqual({ modelRef: "github-copilot/gpt-6-sol" });
    expect(f.request).toHaveBeenCalledWith(
      "models.list",
      { view: "all", preparedOnly: true },
      undefined,
    );
    expect(f.config.agents.defaults.modelPolicy).toEqual(f.before.agents.defaults.modelPolicy);
  });

  it.each([
    null,
    {},
    { modelRef: "cloud/b" },
    { modelRef: "*", expectedConfig: {} },
    { modelRef: "cloud/b", expectedConfig: {}, extra: true },
  ])("rejects invalid selection input %j before any request", async (input) => {
    const f = fixture();
    await expect(selectDefaultModel(f.deps, input)).rejects.toThrow(/exact configured/);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("keeps local selection on its preparation-checked route", async () => {
    const f = fixture("llama-cpp/qwen3.5-4b-q4_k_m");
    await expect(f.select()).rejects.toThrow(/local model selection/);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("rejects a stale caller snapshot before any mutation", async () => {
    const f = fixture();
    f.config.agents.defaults.model.primary = "cloud/newer";
    await expect(f.select()).rejects.toThrow(/changed while editing/);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("rechecks edits and permissions after awaited reads", async () => {
    const f = fixture();
    f.request.mockImplementation(async (method, params) => {
      const result = await f.handle(method, params);
      if (method === "config.get") f.config.agents.defaults.model.primary = "cloud/newer";
      return result;
    });
    await expect(f.select()).rejects.toThrow(/changed while editing/);
    expect(f.request.mock.calls.some(([method]) => method === "config.patch")).toBe(false);
    const locked = fixture();
    locked.deps.assertMutable.mockImplementation(() => {
      throw new Error("Configuration is locked");
    });
    await expect(locked.select()).rejects.toThrow("Configuration is locked");
    expect(locked.request).not.toHaveBeenCalled();
  });

  it("refuses a changed connection before patching", async () => {
    const f = fixture();
    f.request.mockImplementation(async (method, params) => {
      const result = await f.handle(method, params);
      f.gateway.connectionGeneration++;
      return result;
    });
    await expect(f.select()).rejects.toThrow(/connection changed/);
    expect(f.request.mock.calls.some(([method]) => method === "config.patch")).toBe(false);
  });

  it("does not rewrite an already-selected model", async () => {
    const f = fixture("cloud/a");
    await expect(f.select()).resolves.toEqual({ modelRef: "cloud/a" });
    expect(f.request.mock.calls.every(([method]) => method === "config.get")).toBe(true);
  });

  it("waits for the applied revision rather than claiming a disk write is ready", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setApplied(false);
    let complete = false;
    const pending = f.select().then(() => {
      complete = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(complete).toBe(false);
    f.setApplied(true);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(complete).toBe(true);
    expect(f.request.mock.calls.filter(([method]) => method === "config.patch")).toHaveLength(1);
  });

  it("bounds an unapplied selection and reports saved-but-unconfirmed without replaying it", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setApplied(false);
    const pending = expect(f.select()).rejects.toThrow(/saved.*application could not be confirmed/);
    await vi.advanceTimersByTimeAsync(MODEL_APPLY_SETTLE_TIMEOUT_MS + 500);
    await pending;
    expect(f.config.agents.defaults.model.primary).toBe("cloud/b");
    expect(f.request.mock.calls.filter(([method]) => method === "config.patch")).toHaveLength(1);
  });

  it.each(["INVALID_REQUEST", "FORBIDDEN"])(
    "preserves a definitive %s patch rejection",
    async (code) => {
      const f = fixture();
      f.request.mockImplementation((method, params) => {
        if (method === "config.patch") throw new GatewayRequestError("Patch rejected", code);
        return f.handle(method, params);
      });
      await expect(f.select()).rejects.toThrow("Patch rejected");
      expect(f.config).toEqual(f.before);
    },
  );

  it("reports an uncertain write without retrying or rolling back", async () => {
    const f = fixture();
    f.request.mockImplementation((method, params) => {
      if (method === "config.patch") throw new Error("Connection lost");
      return f.handle(method, params);
    });
    await expect(f.select()).rejects.toThrow(/may have been saved/);
    expect(f.request.mock.calls.filter(([method]) => method === "config.patch")).toHaveLength(1);
  });

  it("surfaces an explicit upstream restart requirement instead of claiming hot-apply success", async () => {
    const f = fixture();
    f.request.mockImplementation(async (method, params) => {
      const result = await f.handle(method, params);
      return method === "config.patch"
        ? {
            ok: true,
            config: f.config,
            sentinel: { payload: { stats: { requiresRestart: true } } },
          }
        : result;
    });
    await expect(f.select()).rejects.toThrow(/requires a Gateway restart/);
  });

  it("rejects unconfigured or unauthenticated models without touching the default", async () => {
    const f = fixture("cloud/unknown");
    await expect(f.select()).rejects.toThrow(/not configured/);
    const copilot = fixture("github-copilot/gpt-6-sol");
    copilot.request.mockImplementation((method, params) =>
      method === "models.authStatus"
        ? Promise.resolve({ providers: [] })
        : copilot.handle(method, params),
    );
    await expect(copilot.select()).rejects.toThrow(/Sign in/);
    expect(copilot.config).toEqual(copilot.before);
  });
});
