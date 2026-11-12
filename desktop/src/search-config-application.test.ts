import { describe, expect, it, vi } from "vitest";
import { applySearchConfig } from "./search-config-application";
import { applyWindowsNodeCommandPolicy } from "./windows-node-mxc";

type JsonObject = Record<string, unknown>;

function fixture(provider = "brave") {
  const nodeId = "fixture-node";
  let config = applyWindowsNodeCommandPolicy(
    {
      gateway: { mode: "local", bind: "loopback" },
      agents: { entries: { main: {} } },
      plugins: { allow: ["canvas"], entries: { canvas: { enabled: true } } },
      tools: { web: { search: { provider: "parallel-free" }, fetch: { enabled: true } } },
      hooks: { enabled: true },
    },
    nodeId,
  );
  const original = structuredClone(config);
  const target = structuredClone(config);
  (target.tools as { web: { search: unknown } }).web.search =
    provider === "parallel-free" ? { provider } : { provider, apiKey: "fixture" };
  let hash = "before";
  const state = {
    pluginInstalled: false,
    pluginEnabled: true,
    pluginActive: true,
    pluginRuntimeFailure: false,
    activateOnApply: false,
    reloadStaysUnloaded: false,
    invalidSnapshot: false,
    restartRequired: false,
    afterInstall: () => {},
  };
  const id = provider === "parallel-free" ? "parallel" : provider;
  const gateway = {
    connected: true,
    serverVersion: "2026.10.5+microclaw",
    connectionGeneration: 1,
    methods: [
      "config.get",
      "config.apply",
      "plugins.list",
      "plugins.inspect",
      "plugins.install",
      "plugins.setEnabled",
      "plugins.reload",
    ],
    request: vi.fn(async (method: string, params: JsonObject): Promise<unknown> => {
      switch (method) {
        case "config.get":
          return {
            valid: !state.invalidSnapshot,
            hash,
            config: structuredClone(config),
            configRevisionHash: hash,
            appliedConfigHash: hash,
          };
        case "plugins.list":
          return {
            plugins: [
              {
                id,
                installed: state.pluginInstalled,
                enabled: state.pluginEnabled,
                version: "2026.10.5",
                runtime: {
                  state: state.pluginRuntimeFailure
                    ? "service-failed"
                    : state.pluginActive
                      ? "active"
                      : "unloaded",
                },
              },
            ],
            mutationAllowed: true,
          };
        case "plugins.install":
        case "plugins.setEnabled":
        case "plugins.reload": {
          state.pluginInstalled = true;
          state.pluginEnabled = true;
          if (method !== "plugins.reload" || !state.reloadStaysUnloaded) state.pluginActive = true;
          if (method !== "plugins.reload") {
            const plugins = config.plugins as { allow: string[]; entries: JsonObject };
            if (!plugins.allow.includes(id)) plugins.allow.push(id);
            plugins.entries[id] = { enabled: true };
            hash = "plugin";
            state.afterInstall();
          }
          return { ok: true, restartRequired: false, runtime: { generation: 1, pluginIds: [id] } };
        }
        case "plugins.inspect":
          return {
            ok: true,
            plugin: {
              id,
              installed: state.pluginInstalled,
              enabled: state.pluginEnabled,
              version: "2026.10.5",
            },
          };
        case "config.apply":
          expect(params.baseHash).toBe(hash);
          config = JSON.parse(String(params.raw));
          if (state.activateOnApply) state.pluginActive = true;
          hash = "after";
          return {
            ok: true,
            hash,
            sentinel: { payload: { stats: { requiresRestart: state.restartRequired } } },
          };
        default:
          throw new Error(`Unexpected request: ${method}`);
      }
    }),
  };
  const deps = {
    gateway: () => gateway,
    readConfig: () => structuredClone(config),
    assertCurrent: vi.fn(),
    assertMxcReady: vi.fn(async () => undefined),
    nodeId: () => nodeId,
    wait: vi.fn().mockResolvedValue(undefined),
  };
  return {
    state,
    gateway,
    deps,
    original,
    target,
    current: () => structuredClone(config),
    change: (change: (value: JsonObject) => void) => change(config),
  };
}

describe("applying web search settings", () => {
  it.each([
    ["brave", "brave"],
    ["tavily", "tavily"],
    ["parallel-free", "parallel"],
  ])("installs and hot-applies %s without changing command routing", async (provider, id) => {
    const test = fixture(provider);
    await applySearchConfig(test.deps, test.target, test.original);
    expect(test.gateway.request).toHaveBeenCalledWith(
      "plugins.install",
      {
        source: "npm",
        spec: `@openclaw/${id}-plugin@2026.10.5`,
        expectedPluginId: id,
      },
      300_000,
    );
    expect(test.current()).toMatchObject({
      plugins: { entries: { [id]: { enabled: true } } },
      tools: { exec: { host: "node", node: "fixture-node" }, web: { search: { provider } } },
      hooks: { enabled: true },
    });
    const config = test.current();
    expect(((config.tools as JsonObject).web as JsonObject).search).toEqual({ provider });
    if (provider !== "parallel-free") {
      expect(config.plugins).toMatchObject({
        entries: { [id]: { config: { webSearch: { apiKey: "fixture" } } } },
      });
    }
    expect(test.gateway.request).not.toHaveBeenCalledWith("gateway.restart", expect.anything());
    expect(test.deps.assertMxcReady).toHaveBeenCalledOnce();
  });

  it.each([
    ["active", true, true, null],
    ["disabled", false, true, "plugins.setEnabled"],
    ["inactive", true, false, "plugins.reload"],
  ])("handles an already installed %s plugin", async (_label, enabled, active, operation) => {
    const test = fixture();
    test.state.pluginInstalled = true;
    test.state.pluginEnabled = enabled;
    test.state.pluginActive = active;
    await applySearchConfig(test.deps, test.target, test.original);
    const calls = test.gateway.request.mock.calls.map(([method]) => method);
    expect(calls).not.toContain("plugins.install");
    if (operation) expect(calls).toContain(operation);
  });

  it("removes obsolete search-provider configuration while preserving other web settings", async () => {
    const test = fixture();
    const legacy = { brave: { apiKey: "legacy" } };
    ((test.original.tools as JsonObject).web as JsonObject).searchProviders = legacy;
    test.change((config) => {
      ((config.tools as JsonObject).web as JsonObject).searchProviders = legacy;
    });

    await applySearchConfig(test.deps, test.target, test.original);
    const web = (test.current().tools as { web: JsonObject }).web;
    expect(web).not.toHaveProperty("searchProviders");
    expect(web.fetch).toEqual({ enabled: true });
    expect(web.search).toEqual({ provider: "brave" });
    expect(test.current().plugins).toMatchObject({
      entries: { brave: { config: { webSearch: { apiKey: "fixture" } } } },
    });
  });

  it("preserves unrelated provider configuration and credentials while updating the key", async () => {
    const test = fixture();
    test.state.pluginInstalled = true;
    const entries = (test.original.plugins as { entries: JsonObject }).entries;
    entries.brave = {
      enabled: true,
      config: { other: "preserved", webSearch: { apiKey: "old", count: 4 } },
    };
    entries.tavily = { config: { webSearch: { apiKey: "other-provider" } } };
    test.change((config) => {
      config.plugins = structuredClone(test.original.plugins);
    });
    await applySearchConfig(test.deps, test.target, test.original);
    expect(test.current().plugins).toMatchObject({
      entries: {
        brave: { config: { other: "preserved", webSearch: { apiKey: "fixture", count: 4 } } },
        tavily: { config: { webSearch: { apiKey: "other-provider" } } },
      },
    });
  });

  it("rejects concurrent changes to the target plugin configuration", async () => {
    const test = fixture();
    test.state.afterInstall = () =>
      test.change((config) => {
        const entries = (config.plugins as { entries: JsonObject }).entries;
        entries.brave = { enabled: true, config: { webSearch: { apiKey: "concurrent" } } };
      });
    await expect(applySearchConfig(test.deps, test.target, test.original)).rejects.toThrow(
      "changed during plugin setup",
    );
    expect(test.gateway.request.mock.calls.map(([method]) => method)).not.toContain("config.apply");
  });

  it.each(["", "  ", 42, null])(
    "rejects an invalid API key without Gateway requests: %j",
    async (key) => {
      const test = fixture();
      ((test.target.tools as JsonObject).web as { search: JsonObject }).search.apiKey = key;
      await expect(applySearchConfig(test.deps, test.target, test.original)).rejects.toThrow(
        "API key is invalid",
      );
      expect(test.gateway.request).not.toHaveBeenCalled();
    },
  );

  it("rejects unrelated configuration changes during plugin installation", async () => {
    const test = fixture();
    test.state.afterInstall = () => test.change((config) => (config.hooks = { enabled: false }));
    await expect(applySearchConfig(test.deps, test.target, test.original)).rejects.toThrow(
      "changed during plugin setup",
    );
    expect(test.gateway.request.mock.calls.map(([method]) => method)).not.toContain("config.apply");
  });

  it("preserves the Gateway's automatic version stamp during plugin installation", async () => {
    const test = fixture();
    test.state.afterInstall = () =>
      test.change((config) => {
        config.meta = { lastTouchedVersion: "2026.10.5" };
      });
    await applySearchConfig(test.deps, test.target, test.original);
    expect(test.current().meta).toEqual({ lastTouchedVersion: "2026.10.5" });
  });

  it("rejects unrelated metadata changes during plugin installation", async () => {
    const test = fixture();
    test.state.afterInstall = () =>
      test.change((config) => {
        config.meta = { unrelated: true, lastTouchedVersion: "2026.10.5" };
      });
    await expect(applySearchConfig(test.deps, test.target, test.original)).rejects.toThrow(
      "changed during plugin setup",
    );
    expect(test.gateway.request.mock.calls.map(([method]) => method)).not.toContain("config.apply");
  });

  it("preserves only the known migration markers added by the Gateway during installation", async () => {
    const test = fixture();
    test.state.afterInstall = () =>
      test.change((config) => {
        config.meta = {
          migrations: { modelPolicyAllowlist: true, utilityModelSeparation: true },
          lastTouchedVersion: "2026.10.5",
        };
      });
    await applySearchConfig(test.deps, test.target, test.original);
    expect(test.current().meta).toEqual({
      migrations: { modelPolicyAllowlist: true, utilityModelSeparation: true },
      lastTouchedVersion: "2026.10.5",
    });
  });

  it.each([{ modelPolicyAllowlist: false }, { modelPolicyAllowlist: true, unrelated: true }])(
    "rejects unexpected migration metadata changes: %j",
    async (migrations) => {
      const test = fixture();
      test.state.afterInstall = () =>
        test.change((config) => {
          config.meta = { migrations };
        });
      await expect(applySearchConfig(test.deps, test.target, test.original)).rejects.toThrow(
        "changed during plugin setup",
      );
      expect(test.gateway.request.mock.calls.map(([method]) => method)).not.toContain(
        "config.apply",
      );
    },
  );

  it("does not ignore changes to existing migration markers", async () => {
    const test = fixture();
    test.original.meta = { migrations: { modelPolicyAllowlist: false } };
    test.change((config) => {
      config.meta = { migrations: { modelPolicyAllowlist: false } };
    });
    test.state.afterInstall = () =>
      test.change((config) => {
        config.meta = { migrations: { modelPolicyAllowlist: true } };
      });
    await expect(applySearchConfig(test.deps, test.target, test.original)).rejects.toThrow(
      "changed during plugin setup",
    );
  });

  it("does not apply settings when the installed plugin reports a runtime failure", async () => {
    const test = fixture();
    test.state.afterInstall = () => {
      test.state.pluginRuntimeFailure = true;
    };
    await expect(applySearchConfig(test.deps, test.target, test.original)).rejects.toThrow(
      "plugin is not active (runtime state: service-failed)",
    );
    expect(test.gateway.request.mock.calls.map(([method]) => method)).not.toContain("config.apply");
  });

  it("selects an unloaded plugin before verifying that hot apply activated it", async () => {
    const test = fixture();
    test.state.afterInstall = () => {
      test.state.pluginActive = false;
    };
    test.state.activateOnApply = true;
    await applySearchConfig(test.deps, test.target, test.original);
    const calls = test.gateway.request.mock.calls.map(([method]) => method);
    expect(calls).toContain("config.apply");
    expect(calls).not.toContain("plugins.reload");
    expect(calls.lastIndexOf("plugins.list")).toBeGreaterThan(calls.indexOf("config.apply"));
  });

  it("does not report success when the selected plugin remains unloaded", async () => {
    const test = fixture();
    test.state.afterInstall = () => {
      test.state.pluginActive = false;
    };
    test.state.reloadStaysUnloaded = true;
    await expect(applySearchConfig(test.deps, test.target, test.original)).rejects.toThrow(
      "may have been saved",
    );
    const calls = test.gateway.request.mock.calls.map(([method]) => method);
    expect(calls.indexOf("plugins.reload")).toBeGreaterThan(calls.indexOf("config.apply"));
    expect(calls.filter((method) => method === "plugins.reload")).toHaveLength(1);
  });

  it("allows disabled search to retain an unloaded provider", async () => {
    const test = fixture();
    test.state.afterInstall = () => {
      test.state.pluginActive = false;
    };
    ((test.target.tools as JsonObject).web as { search: JsonObject }).search.enabled = false;
    await applySearchConfig(test.deps, test.target, test.original);
    expect(test.gateway.request.mock.calls.map(([method]) => method)).not.toContain(
      "plugins.reload",
    );
    expect(test.deps.assertMxcReady).toHaveBeenCalledOnce();
  });

  it("does not report success when the post-apply MXC readiness check fails", async () => {
    const test = fixture();
    test.deps.assertMxcReady.mockRejectedValue(new Error("MXC readiness drifted"));
    await expect(applySearchConfig(test.deps, test.target, test.original)).rejects.toThrow(
      "may have been saved",
    );
    expect(test.gateway.request.mock.calls.map(([method]) => method)).toContain("config.apply");
    expect(test.deps.assertMxcReady).toHaveBeenCalledOnce();
  });

  it("does not install a plugin for an invalid Gateway configuration", async () => {
    const test = fixture();
    test.state.invalidSnapshot = true;
    await expect(applySearchConfig(test.deps, test.target, test.original)).rejects.toThrow(
      "unavailable or invalid",
    );
    expect(test.gateway.request.mock.calls.map(([method]) => method)).not.toContain(
      "plugins.install",
    );
  });

  it("reports an unconfirmed restart-requiring write without claiming success", async () => {
    const test = fixture();
    test.state.restartRequired = true;
    await expect(applySearchConfig(test.deps, test.target, test.original)).rejects.toThrow(
      "may have been saved",
    );
  });

  it("rejects unsupported providers without issuing Gateway requests", async () => {
    const test = fixture("unknown");
    await expect(applySearchConfig(test.deps, test.target, test.original)).rejects.toThrow(
      "Unsupported web search provider",
    );
    expect(test.gateway.request).not.toHaveBeenCalled();
  });
});
