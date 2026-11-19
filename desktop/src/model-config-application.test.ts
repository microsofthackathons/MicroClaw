import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyGatewayConfiguration,
  applyModelConfig,
  type ModelConfigUpdate,
} from "./model-config-application";
import { ensureGitHubCopilotProviderPlugin } from "./model-provider-plugins";
import { removeProviderConnectionConfig } from "./provider-connection-config";
import { runWindowsNodeMxcModelUpdate } from "./windows-node-mxc-model-config";

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
  function connectionFixture(providerKey = "minimax") {
    const state = fixture();
    state.gateway.serverVersion = "2026.10.10";
    state.gateway.methods.push("config.set");
    const request = state.gateway.request.getMockImplementation()!;
    state.gateway.request.mockImplementation((method, params) =>
      request(method === "config.set" ? "config.apply" : method, params),
    );
    const config = structuredClone(state.input.expectedConfig) as {
      models: { providers: Record<string, unknown> };
    };
    config.models.providers[providerKey] = {
      apiKey: "new-fixture-key",
      baseUrl: "https://provider.example/v1",
      api: "openai-completions",
      models: [],
    };
    state.input = { ...state.input, config, providerKey };
    return state;
  }

  it("saves only a new provider connection through config.set and verifies its applied revision", async () => {
    const state = connectionFixture();
    await applyModelConfig(state.deps, state.input);
    expect(state.gateway.request.mock.calls.map(([method]) => method)).toEqual([
      "config.get",
      "config.set",
      "config.get",
    ]);
    expect(state.gateway.request).toHaveBeenCalledWith(
      "config.set",
      {
        baseHash: "before",
        raw: JSON.stringify(state.input.config),
      },
      30_000,
    );
    expect(state.saved()).toEqual(state.input.config);
    expect(JSON.stringify(state.deps.log.mock.calls)).not.toContain("new-fixture-key");
  });

  it("accepts the default merge mode added with a new connection", async () => {
    const state = connectionFixture();
    (state.input.config as { models: Record<string, unknown> }).models.mode = "merge";
    await applyModelConfig(state.deps, state.input);
    expect(state.gateway.request.mock.calls.some(([method]) => method === "config.set")).toBe(true);
  });

  it("updates a Qwen key while preserving its registered models and default", async () => {
    const state = connectionFixture("qwen");
    const before = state.input.expectedConfig as {
      models: { providers: { qwen: { models: unknown[] } } };
    };
    const next = state.input.config as { models: { providers: { qwen: { models: unknown[] } } } };
    next.models.providers.qwen.models = structuredClone(before.models.providers.qwen.models);
    await applyModelConfig(state.deps, state.input);
    expect(state.gateway.request.mock.calls.some(([method]) => method === "config.set")).toBe(true);
    expect(state.saved()).toEqual(state.input.config);
  });

  it.each([
    "old-runtime",
    "missing-method",
    "restart-mode",
    "model-selection",
    "catalog-change",
    "plugin-change",
    "other-provider",
  ])("retains config.apply for %s", async (reason) => {
    const state = connectionFixture(reason === "other-provider" ? "custom" : "minimax");
    if (reason === "old-runtime") state.gateway.serverVersion = "2026.10.5";
    if (reason === "missing-method") state.gateway.methods = ["config.get", "config.apply"];
    if (reason === "restart-mode") {
      for (const config of [state.input.expectedConfig, state.input.config, state.saved()])
        (config as { gateway: Record<string, unknown> }).gateway.reload = { mode: "restart" };
    }
    if (reason === "model-selection")
      (
        state.input.config as { agents: { defaults: { model: { primary: string } } } }
      ).agents.defaults.model.primary = "minimax/new";
    if (reason === "catalog-change")
      (
        state.input.config as { models: { providers: { minimax: { models: unknown[] } } } }
      ).models.providers.minimax.models = [{ id: "new" }];
    if (reason === "plugin-change")
      (state.input.config as Record<string, unknown>).plugins = {
        entries: { minimax: { enabled: true } },
      };
    await applyModelConfig(state.deps, state.input);
    expect(state.gateway.request.mock.calls.some(([method]) => method === "config.apply")).toBe(
      true,
    );
    expect(state.gateway.request.mock.calls.some(([method]) => method === "config.set")).toBe(
      false,
    );
  });

  it("waits for config.set to become effective before reporting success", async () => {
    vi.useFakeTimers();
    const state = connectionFixture();
    state.setApplied(false);
    const pending = applyModelConfig(state.deps, state.input);
    await vi.advanceTimersByTimeAsync(500);
    expect(state.deps.log).not.toHaveBeenCalledWith(expect.stringContaining("hot-applied"));
    state.setApplied(true);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(state.deps.log).toHaveBeenLastCalledWith(expect.stringContaining("hot-applied"));
  });

  it("does not report success for a receipt that did not persist the requested connection", async () => {
    const state = connectionFixture();
    state.gateway.request.mockImplementation(async (method) =>
      method === "config.set" ? { ok: true, hash: "before" } : state.snapshot(),
    );
    await expect(applyModelConfig(state.deps, state.input)).rejects.toMatchObject({
      cause: { message: "The saved provider connection does not match the requested settings" },
    });
  });

  it("never replays config.set after losing its response", async () => {
    const state = connectionFixture();
    state.gateway.request
      .mockResolvedValueOnce(state.snapshot())
      .mockRejectedValueOnce(new Error("Lost response"));
    await expect(applyModelConfig(state.deps, state.input)).rejects.toThrow("No restart or retry");
    expect(state.gateway.request.mock.calls.map(([method]) => method)).toEqual([
      "config.get",
      "config.set",
    ]);
  });

  async function removalFixture() {
    const state = connectionFixture();
    await applyModelConfig(state.deps, state.input);
    state.gateway.request.mockClear();
    state.deps.log.mockClear();
    const expectedConfig = structuredClone(state.saved());
    const config = structuredClone(expectedConfig) as {
      models: { providers: Record<string, unknown> };
    };
    delete config.models.providers.minimax;
    state.input = { config, expectedConfig, action: "provider-remove", providerKey: "minimax" };
    return state;
  }

  it("removes an unused provider and its key through the verified lightweight write", async () => {
    const state = await removalFixture();
    await applyModelConfig(state.deps, state.input);
    expect(state.gateway.request.mock.calls.map(([method]) => method)).toEqual([
      "config.get",
      "config.set",
      "config.get",
    ]);
    expect(state.saved()).toEqual(state.input.config);
  });

  it.each(["string", "selector"])(
    "removes a referenced provider through config.set and clears its %s default",
    async (format) => {
      const state = await removalFixture();
      const agents = {
        defaults: {
          workspace: "keep",
          model:
            format === "string"
              ? "minimax/one"
              : { primary: "minimax/one", fallbacks: ["minimax/two", "qwen/old"] },
          models: { "minimax/one": {}, "qwen/old": { alias: "keep" } },
        },
      };
      for (const config of [state.input.expectedConfig, state.saved()])
        (config as Record<string, unknown>).agents = structuredClone(agents);
      state.input.config = removeProviderConnectionConfig(
        state.input.expectedConfig as Record<string, unknown>,
        "minimax",
      );
      const hooks = {
        readConfig: state.deps.readConfig,
        pause: vi.fn(async () => {}),
        apply: () => applyModelConfig(state.deps, state.input),
        restartSavedConfig: vi.fn(async () => {}),
        verify: vi.fn(async () => {}),
        resume: vi.fn(),
        failClosed: vi.fn(async () => {}),
      };
      await runWindowsNodeMxcModelUpdate(hooks);
      expect(state.gateway.request.mock.calls.map(([method]) => method)).toEqual([
        "config.get",
        "config.set",
        "config.get",
      ]);
      expect(state.saved()).toEqual(state.input.config);
      expect(hooks.resume).toHaveBeenCalledOnce();
      expect(hooks.restartSavedConfig).not.toHaveBeenCalled();
      expect(hooks.failClosed).not.toHaveBeenCalled();
      expect((state.input.expectedConfig as Record<string, unknown>).agents).toEqual(agents);
    },
  );

  it.each([
    "default-change",
    "agent-change",
    "workspace-change",
    "other-provider",
    "plugin-change",
    "retained-primary",
    "retained-fallback",
    "retained-catalog",
  ])("retains the complete application path for removal with %s", async (reason) => {
    const state = await removalFixture();
    const next = state.input.config as {
      models: { providers: Record<string, unknown> };
      agents: {
        defaults: { model: { primary: string }; workspace?: string };
        entries?: Record<string, unknown>;
        list?: unknown[];
      };
      plugins?: unknown;
    };
    if (reason === "default-change") next.agents.defaults.model.primary = "qwen/replacement";
    if (reason === "agent-change") next.agents.entries = { writer: { model: "qwen/old" } };
    if (reason === "workspace-change") next.agents.defaults.workspace = "different";
    if (reason === "other-provider") delete next.models.providers.qwen;
    if (reason === "plugin-change") next.plugins = { entries: { minimax: { enabled: false } } };
    if (reason.startsWith("retained-")) {
      for (const config of [state.input.expectedConfig, state.input.config, state.saved()] as Array<
        typeof next
      >) {
        if (reason === "retained-primary") config.agents.defaults.model.primary = "minimax/one";
        if (reason === "retained-fallback")
          config.agents.entries = { writer: { model: { fallbacks: ["minimax/one"] } } };
        if (reason === "retained-catalog")
          config.agents.list = [{ id: "writer", models: { "minimax/one": {} } }];
      }
    }
    await applyModelConfig(state.deps, state.input);
    expect(state.gateway.request.mock.calls.some(([method]) => method === "config.apply")).toBe(
      true,
    );
    expect(state.gateway.request.mock.calls.some(([method]) => method === "config.set")).toBe(
      false,
    );
  });

  it("does not claim removal when a provider remains present even without connection fields", async () => {
    const state = await removalFixture();
    const request = state.gateway.request.getMockImplementation()!;
    state.gateway.request.mockImplementation(async (method, params) => {
      if (method === "config.set") {
        const config = JSON.parse(String(params?.raw));
        config.models.providers.minimax = {};
        return request(method, { ...params, raw: JSON.stringify(config) });
      }
      return request(method, params);
    });
    await expect(applyModelConfig(state.deps, state.input)).rejects.toMatchObject({
      cause: { message: "The saved provider connection does not match the requested settings" },
    });
    expect(state.deps.log).not.toHaveBeenCalledWith(expect.stringContaining("hot-applied"));
  });

  it("does not report removal before the runtime revision settles", async () => {
    vi.useFakeTimers();
    const state = await removalFixture();
    state.setApplied(false);
    const pending = applyModelConfig(state.deps, state.input);
    await vi.advanceTimersByTimeAsync(500);
    expect(state.deps.log).not.toHaveBeenCalledWith(expect.stringContaining("hot-applied"));
    state.setApplied(true);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(state.saved()).toEqual(state.input.config);
  });

  it("rejects a removal receipt that retained the removed provider's model references", async () => {
    const state = await removalFixture();
    for (const config of [state.input.expectedConfig, state.saved()])
      (config as Record<string, unknown>).agents = {
        defaults: { model: { primary: "minimax/one" } },
      };
    state.input.config = removeProviderConnectionConfig(
      state.input.expectedConfig as Record<string, unknown>,
      "minimax",
    );
    const request = state.gateway.request.getMockImplementation()!;
    state.gateway.request.mockImplementation(async (method, params) => {
      if (method === "config.set") {
        const config = JSON.parse(String(params?.raw));
        config.agents = (state.input.expectedConfig as Record<string, unknown>).agents;
        return request(method, { ...params, raw: JSON.stringify(config) });
      }
      return request(method, params);
    });
    await expect(applyModelConfig(state.deps, state.input)).rejects.toMatchObject({
      cause: { message: "The saved model references do not match the requested removal" },
    });
    expect(state.deps.log).not.toHaveBeenCalledWith(expect.stringContaining("hot-applied"));
  });

  it("applies Copilot activation through the MXC model transaction", async () => {
    const state = fixture();
    const next = structuredClone(state.input.expectedConfig) as Record<string, unknown>;
    ensureGitHubCopilotProviderPlugin(next);
    state.input = {
      ...state.input,
      config: next,
      action: "copilot-prepare",
      providerKey: "github-copilot",
    };
    const hooks = {
      readConfig: state.deps.readConfig,
      pause: vi.fn(async () => {}),
      apply: () => applyModelConfig(state.deps, state.input),
      restartSavedConfig: vi.fn(async () => {}),
      verify: vi.fn(async () => {}),
      resume: vi.fn(),
      failClosed: vi.fn(async () => {}),
    };
    await runWindowsNodeMxcModelUpdate(hooks);
    expect(state.saved()).toEqual(next);
    expect(hooks.resume).toHaveBeenCalledOnce();
    expect(hooks.failClosed).not.toHaveBeenCalled();
  });

  it("applies plugin settings through the same revision-guarded Gateway path", async () => {
    const state = fixture();
    const next = {
      ...(state.input.expectedConfig as object),
      plugins: { entries: { "github-copilot": { enabled: true } } },
    };
    await applyGatewayConfiguration(state.deps, {
      config: next,
      expectedConfig: state.input.expectedConfig,
      context: "[plugin-config]",
      note: "Plugin settings",
      label: "plugin",
    });
    expect(state.gateway.request).toHaveBeenCalledWith(
      "config.apply",
      { baseHash: "before", raw: JSON.stringify(next), note: "Plugin settings" },
      30_000,
    );
    expect(state.saved()).toEqual(next);
  });

  it("does not report success when the Gateway did not save the requested plugin settings", async () => {
    const state = fixture();
    const next = {
      ...(state.input.expectedConfig as object),
      plugins: { entries: { "github-copilot": { enabled: true } } },
    };
    state.gateway.request.mockImplementation(async (method) => {
      if (method === "config.apply") return { ok: true, hash: "before" };
      return state.snapshot();
    });
    await expect(
      applyGatewayConfiguration(state.deps, {
        config: next,
        expectedConfig: state.input.expectedConfig,
        context: "[plugin-config]",
        note: "Plugin settings",
        label: "plugin",
      }),
    ).rejects.toMatchObject({
      cause: { message: "The saved plugin settings do not match the requested settings" },
    });
  });

  it("does not restart for plugin changes that were not saved as requested", async () => {
    const state = fixture();
    const next = {
      ...(state.input.expectedConfig as object),
      plugins: { entries: { "github-copilot": { enabled: true } } },
    };
    state.gateway.request.mockImplementation(async (method) => {
      if (method === "config.apply")
        return {
          ok: true,
          hash: "after",
          sentinel: { payload: { stats: { requiresRestart: true } } },
        };
      return state.snapshot();
    });
    await expect(
      applyGatewayConfiguration(state.deps, {
        config: next,
        expectedConfig: state.input.expectedConfig,
        context: "[plugin-config]",
        note: "Plugin settings",
        label: "plugin",
      }),
    ).rejects.toMatchObject({
      cause: { message: "The saved plugin settings do not match the requested settings" },
    });
  });

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
    const pending = applyModelConfig(state.deps, state.input);
    await expect(pending).rejects.toThrow("No restart or retry");
    await expect(pending).rejects.toMatchObject({
      cause: { name: "ModelConfigRestartRequiredError", savedHash: "after" },
    });
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
