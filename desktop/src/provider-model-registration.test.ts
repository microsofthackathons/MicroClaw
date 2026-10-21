import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerProviderCatalogModel,
  parseProviderCatalogSelection,
} from "./provider-model-registration";
import { selectDefaultModel } from "./default-model-selection";
import type { ProviderCatalogResult } from "./provider-model-catalog";

function fixture() {
  const config = {
    models: {
      providers: {
        qwen: {
          baseUrl: "https://provider.example/v1",
          apiKey: "fixture",
          api: "openai-completions",
          models: [{ id: "old", name: "Old", input: ["text", "image"] }],
        },
      },
    },
    agents: {
      defaults: { model: { primary: "qwen/old" }, modelPolicy: { allow: ["qwen/*"] } },
      entries: { writer: { model: "qwen/old" } },
    },
  };
  let applied = true;
  const before = structuredClone(config);
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "config.get")
      return {
        valid: true,
        hash: "base",
        config: structuredClone(config),
        configRevisionHash: "current",
        appliedConfigHash: applied ? "current" : "previous",
      };
    if (method === "config.patch") {
      expect(params?.baseHash).toBe("base");
      const patch = JSON.parse(String(params?.raw));
      if (patch.models) config.models.providers.qwen.models = patch.models.providers.qwen.models;
      if (patch.agents) config.agents.defaults.model.primary = patch.agents.defaults.model.primary;
      return { ok: true, config: structuredClone(config) };
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const gateway = {
    connected: true,
    serverVersion: "2026.10.2",
    connectionGeneration: 1,
    methods: ["config.get", "config.patch"],
    request,
  };
  const deps = {
    gateway: () => gateway,
    readConfig: () => config,
    assertMutable: vi.fn(),
    discover: vi.fn<() => Promise<ProviderCatalogResult>>().mockResolvedValue({
      ok: true,
      models: ["old", "live-one", "live-two"],
    }),
  };
  const register = () => registerProviderCatalogModel(deps, "qwen/live-one", before);
  return {
    deps,
    before,
    gateway,
    request,
    register,
    config: () => config,
    setApplied: (value: boolean) => {
      applied = value;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("live provider model registration", () => {
  it("rejects incompatible models even when previously registered", async () => {
    const f = fixture();
    const id = "qwen3.8-omni-flash-realtime";
    f.config().models.providers.qwen.models.push({ id, name: id, input: ["text"] });
    await expect(
      registerProviderCatalogModel(f.deps, `qwen/${id}`, structuredClone(f.config())),
    ).rejects.toThrow("UNSUPPORTED_CHAT_MODEL");
    expect(f.deps.discover).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { modelRef: "qwen/new" },
    { modelRef: "custom/new", expectedConfig: {} },
    { modelRef: "qwen/*", expectedConfig: {} },
    { modelRef: "qwen/new", expectedConfig: {}, unexpected: true },
  ])("rejects invalid public registration input", (input) => {
    expect(() => parseProviderCatalogSelection(input)).toThrow(/exact managed provider/);
  });

  it("registers only the requested live ID using CAS without credentials, policies or defaults in the patch", async () => {
    const f = fixture();
    await f.register();
    expect(f.config().models.providers.qwen.models.map((model) => model.id)).toEqual([
      "old",
      "live-one",
    ]);
    expect(f.config().agents).toEqual(f.before.agents);
    expect(f.config().models.providers.qwen.apiKey).toBe("fixture");
    const patch = JSON.parse(
      String(f.request.mock.calls.find(([method]) => method === "config.patch")?.[1]?.raw),
    );
    expect(Object.keys(patch)).toEqual(["models"]);
    expect(Object.keys(patch.models.providers.qwen)).toEqual(["models"]);
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "config.get",
      "config.patch",
      "config.get",
    ]);
  });

  it("hot-selects a newly discovered default and preserves agent overrides and policy", async () => {
    const f = fixture();
    await expect(
      selectDefaultModel(
        {
          ...f.deps,
          prepareModel: (ref, expected) => registerProviderCatalogModel(f.deps, ref, expected),
        },
        { modelRef: "qwen/live-one", expectedConfig: f.before },
      ),
    ).resolves.toEqual({ modelRef: "qwen/live-one" });
    expect(f.config().agents.entries).toEqual(f.before.agents.entries);
    expect(f.config().agents.defaults.modelPolicy).toEqual(f.before.agents.defaults.modelPolicy);
    expect(
      f.request.mock.calls.every(([method]) => ["config.get", "config.patch"].includes(method)),
    ).toBe(true);
  });

  it("does not rediscover or patch registered and non-managed models", async () => {
    const f = fixture();
    await registerProviderCatalogModel(f.deps, "qwen/old", f.before);
    await registerProviderCatalogModel(f.deps, "github-copilot/model", f.before);
    expect(f.deps.discover).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("allows remembering an already registered model without a registry mutation", async () => {
    const f = fixture();
    f.deps.assertMutable.mockImplementation(() => {
      throw new Error("Active chat");
    });
    await expect(registerProviderCatalogModel(f.deps, "qwen/old", f.before)).resolves.toEqual(
      f.before,
    );
    await expect(f.register()).rejects.toThrow("Active chat");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.deps.discover).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, error: "authentication" },
    { ok: true, models: ["unrelated"] },
  ] as const)("refuses failures or IDs absent from the live catalog", async (result) => {
    const f = fixture();
    f.deps.discover.mockResolvedValue(
      result.ok ? { ok: true, models: [...result.models] } : result,
    );
    await expect(f.register()).rejects.toThrow(/catalog/);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("rejects concurrent configuration edits and connection changes before patching", async () => {
    const f = fixture();
    f.deps.discover.mockImplementation(async () => {
      f.config().models.providers.qwen.apiKey = "changed";
      return { ok: true, models: ["live-one"] };
    });
    await expect(f.register()).rejects.toThrow(/changed while editing/);
    expect(f.request).not.toHaveBeenCalled();
    const g = fixture();
    g.deps.discover.mockImplementation(async () => {
      g.gateway.connectionGeneration++;
      return { ok: true, models: ["live-one"] };
    });
    await expect(g.register()).rejects.toThrow(/connection changed/);
    expect(g.request).not.toHaveBeenCalled();
  });

  it("waits for the applied revision, not merely the saved model definition", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setApplied(false);
    let complete = false;
    const pending = f.register().then(() => {
      complete = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(complete).toBe(false);
    f.setApplied(true);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(complete).toBe(true);
  });

  it("does not restart or replay an uncertain registration", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params) => {
      const result = await original(method, params);
      if (method === "config.patch") throw new Error("Lost response after commit");
      return result;
    });
    await expect(f.register()).rejects.toThrow(/may have been saved/);
    expect(f.request.mock.calls.filter(([method]) => method === "config.patch")).toHaveLength(1);
    expect(f.config().agents).toEqual(f.before.agents);
  });
});
