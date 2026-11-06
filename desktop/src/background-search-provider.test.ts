import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BackgroundSearchProvider,
  SEARCH_SETUP_FILENAME,
  searchSetupUpgradeCommitted,
} from "./background-search-provider";

type JsonObject = Record<string, unknown>;
const roots: string[] = [];
const services: BackgroundSearchProvider[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-search-"));
  roots.push(root);
  const pendingPath = path.join(root, SEARCH_SETUP_FILENAME);
  const search = { provider: "parallel-free", maxResults: 7 };
  const suspendedSearch = { enabled: false, maxResults: 7 };
  fs.writeFileSync(
    pendingPath,
    JSON.stringify({ schemaVersion: 1, search, suspendedSearch, pluginEntry: { enabled: true } }),
  );
  let config = {
    gateway: { reload: { mode: "hybrid" } },
    tools: { web: { search: { ...suspendedSearch } as JsonObject, fetch: { enabled: true } } },
    plugins: { entries: {} as Record<string, JsonObject>, allow: ["other"] },
    models: { example: "preserved" },
  };
  let hash = "before";
  const state = {
    ready: true,
    plugin: { installed: false } as JsonObject,
    active: true,
    onInstall: () => {},
    installResult: {
      ok: true,
      restartRequired: false,
      runtime: { generation: 1, pluginIds: ["parallel"] },
    },
    failure: undefined as Error | undefined,
    applyFailure: undefined as Error | undefined,
    settleReads: 0,
  };
  const gateway = {
    connected: true,
    serverVersion: "2026.10.5+microclaw",
    connectionGeneration: 1,
    methods: [
      "plugins.list",
      "plugins.inspect",
      "plugins.install",
      "plugins.setEnabled",
      "plugins.reload",
      "config.get",
      "config.apply",
    ],
    request: vi.fn(async (method: string, params: JsonObject): Promise<unknown> => {
      switch (method) {
        case "config.get":
          return {
            valid: true,
            hash,
            config: structuredClone(config),
            configRevisionHash: hash,
            appliedConfigHash: hash === "after" && state.settleReads-- > 0 ? "before" : hash,
          };
        case "plugins.list":
          return { plugins: [state.plugin], mutationAllowed: true };
        case "plugins.inspect":
          return {
            plugin: {
              id: "parallel",
              installed: true,
              enabled: true,
              version: "2026.10.5",
              runtime: { state: state.active ? "active" : "service-failed" },
            },
          };
        case "plugins.install":
          if (state.failure) throw state.failure;
          state.onInstall();
          config.plugins.entries.parallel = { enabled: true };
          config.plugins.allow.push("parallel");
          return state.installResult;
        case "plugins.reload":
        case "plugins.setEnabled":
          return state.installResult;
        case "config.apply":
          expect(params.baseHash).toBe(hash);
          if (state.applyFailure) throw state.applyFailure;
          config = JSON.parse(String(params.raw));
          hash = "after";
          return { ok: true, hash };
        default:
          throw new Error(`Unexpected request: ${method}`);
      }
    }),
  };
  const log = vi.fn();
  const deps = { stateDir: () => root, gateway: () => gateway, ready: () => state.ready, log };
  const create = () => {
    const service = new BackgroundSearchProvider(deps);
    services.push(service);
    return service;
  };
  return { root, pendingPath, search, state, config, gateway, log, create, service: create() };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("background web search setup", () => {
  it("does not run before readiness or synchronously on the startup path", async () => {
    const test = fixture();
    test.state.ready = false;
    test.service.start();
    test.service.start();
    expect(test.gateway.request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(test.gateway.request).not.toHaveBeenCalled();
    test.state.ready = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fs.existsSync(test.pendingPath)).toBe(false);
  });

  it("installs a pinned plugin and hot-applies search while preserving other settings", async () => {
    const test = fixture();
    test.service.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.gateway.request).toHaveBeenCalledWith(
      "plugins.install",
      {
        source: "npm",
        spec: "@openclaw/parallel-plugin@2026.10.5",
        expectedPluginId: "parallel",
      },
      300_000,
    );
    const applied = test.gateway.request.mock.calls.find(([method]) => method === "config.apply");
    const config = JSON.parse(String(applied?.[1].raw));
    expect(config.tools.web.search).toEqual(test.search);
    expect(config.tools.web.fetch).toEqual({ enabled: true });
    expect(config.models).toEqual({ example: "preserved" });
    expect(config.plugins.allow).toEqual(["other", "parallel"]);
    expect(fs.existsSync(test.pendingPath)).toBe(false);
    expect(test.log).toHaveBeenLastCalledWith("Web search is ready; Gateway was not restarted");
  });

  it("does not enable search when the installed plugin reports a runtime failure", async () => {
    const test = fixture();
    test.state.active = false;
    test.service.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fs.existsSync(test.pendingPath)).toBe(true);
    expect(test.gateway.request.mock.calls.some(([method]) => method === "config.apply")).toBe(
      false,
    );
    expect(test.log).toHaveBeenLastCalledWith(expect.stringContaining("search remains disabled"));
  });

  it("keeps pending setup after a config conflict instead of forcing an overwrite", async () => {
    const test = fixture();
    test.state.applyFailure = new Error("baseHash conflict");
    test.service.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fs.existsSync(test.pendingPath)).toBe(true);
    expect(
      test.gateway.request.mock.calls.filter(([method]) => method === "config.apply"),
    ).toHaveLength(1);
    expect(test.log).toHaveBeenLastCalledWith(expect.stringContaining("baseHash conflict"));
  });

  it("leaves additional security review pending without acknowledging it automatically", async () => {
    const test = fixture();
    test.state.failure = new Error("PLUGIN_CAPABILITY_CONSENT_REQUIRED");
    test.service.start();
    await vi.advanceTimersByTimeAsync(5_000);
    const installs = test.gateway.request.mock.calls.filter(
      ([method]) => method === "plugins.install",
    );
    expect(installs).toHaveLength(1);
    expect(installs[0][1]).not.toHaveProperty("acknowledgeCapabilities");
    expect(installs[0][1]).not.toHaveProperty("acknowledgeInstallPolicyWarning");
    expect(fs.existsSync(test.pendingPath)).toBe(true);
  });

  it("retains failed downloads and retries only on a later launch", async () => {
    const test = fixture();
    test.state.failure = new Error("offline");
    test.service.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.log).toHaveBeenLastCalledWith(expect.stringContaining("offline"));
    expect(fs.existsSync(test.pendingPath)).toBe(true);
    test.service.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      test.gateway.request.mock.calls.filter(([method]) => method === "plugins.install"),
    ).toHaveLength(1);
    test.state.failure = undefined;
    test.create().start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fs.existsSync(test.pendingPath)).toBe(false);
  });

  it.each([
    [false, "disabled", "plugins.setEnabled"],
    [true, "unloaded", "plugins.reload"],
    [true, "active", undefined],
  ])("reuses an installed plugin (enabled=%s, runtime=%s)", async (enabled, runtime, method) => {
    const test = fixture();
    test.state.plugin = {
      id: "parallel",
      installed: true,
      version: "2026.10.5",
      enabled,
      runtime: { state: runtime },
    };
    test.service.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.gateway.request.mock.calls.some(([name]) => name === "plugins.install")).toBe(
      false,
    );
    if (method)
      expect(test.gateway.request.mock.calls.some(([name]) => name === method)).toBe(true);
    expect(fs.existsSync(test.pendingPath)).toBe(false);
  });

  it.each(["before", "during"])(
    "does not overwrite a provider changed %s installation",
    async (when) => {
      const test = fixture();
      const change = () => {
        test.config.tools.web.search = { provider: "brave", apiKey: "example" };
      };
      if (when === "before") change();
      else test.state.onInstall = change;
      test.service.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(test.gateway.request.mock.calls.some(([method]) => method === "config.apply")).toBe(
        false,
      );
      expect(test.config.tools.web.search.provider).toBe("brave");
      expect(fs.existsSync(test.pendingPath)).toBe(false);
    },
  );

  it("does not apply settings after a gateway generation change", async () => {
    const test = fixture();
    test.state.onInstall = () => {
      test.gateway.connectionGeneration++;
    };
    test.service.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fs.existsSync(test.pendingPath)).toBe(true);
    expect(test.gateway.request.mock.calls.some(([method]) => method === "config.apply")).toBe(
      false,
    );
  });

  it.each(["before", "during"])(
    "stops without changing search settings when quitting %s setup",
    async (when) => {
      const test = fixture();
      test.service.start();
      if (when === "before") test.service.stop();
      else test.state.onInstall = () => test.service.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fs.existsSync(test.pendingPath)).toBe(true);
      expect(test.gateway.request.mock.calls.some(([method]) => method === "config.apply")).toBe(
        false,
      );
    },
  );

  it("does not restart the gateway if the plugin cannot be hot-loaded", async () => {
    const test = fixture();
    test.state.installResult.restartRequired = true;
    test.service.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fs.existsSync(test.pendingPath)).toBe(true);
    expect(test.gateway.request.mock.calls.some(([method]) => method === "config.apply")).toBe(
      false,
    );
    expect(test.log).toHaveBeenLastCalledWith(expect.stringContaining("no restart attempted"));
  });

  it.each(["off", "restart"])("does not install with reload mode %s", async (mode) => {
    const test = fixture();
    test.config.gateway.reload.mode = mode;
    test.service.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.gateway.request.mock.calls.map(([method]) => method)).toEqual(["config.get"]);
    expect(fs.existsSync(test.pendingPath)).toBe(true);
  });

  it("waits for config hot-application before removing the pending request", async () => {
    const test = fixture();
    test.state.settleReads = 1;
    test.service.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fs.existsSync(test.pendingPath)).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(fs.existsSync(test.pendingPath)).toBe(false);
  });

  it("does nothing without a pending request", async () => {
    const test = fixture();
    fs.unlinkSync(test.pendingPath);
    test.service.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.gateway.request).not.toHaveBeenCalled();
  });

  it("does not use a pending file to install arbitrary packages", async () => {
    const test = fixture();
    fs.writeFileSync(
      test.pendingPath,
      JSON.stringify({ schemaVersion: 1, search: { provider: "other" } }),
    );
    test.service.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.gateway.request).not.toHaveBeenCalled();
    expect(fs.existsSync(test.pendingPath)).toBe(true);
  });
});

describe("installer handoff", () => {
  it("waits for the matching upgrade transaction to commit", () => {
    const test = fixture();
    expect(searchSetupUpgradeCommitted(test.root)).toBe(true);
    expect(searchSetupUpgradeCommitted(test.root, "expected")).toBe(false);
    fs.mkdirSync(path.join(test.root, "upgrade"));
    const manifest = path.join(test.root, "upgrade", "openclaw-upgrade.json");
    for (const [transaction, phase, expected] of [
      ["expected", "verifying", false],
      ["other", "committed", false],
      ["expected", "committed", true],
    ] as const) {
      fs.writeFileSync(manifest, JSON.stringify({ transaction_id: transaction, phase }));
      expect(searchSetupUpgradeCommitted(test.root, "expected")).toBe(expected);
    }
  });
});
