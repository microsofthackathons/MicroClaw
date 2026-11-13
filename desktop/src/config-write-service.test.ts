import { describe, expect, it, vi } from "vitest";
import { writeGuardedConfig } from "./config-write-service";
import { applyWindowsNodeCommandPolicy } from "./windows-node-mxc";

const nodeId = "fixture-node";
const intent = { kind: "initial-setup", providerKey: "custom" } as const;
const gateway = {
  port: 18789,
  bind: "loopback",
  mode: "local",
  auth: { mode: "token", token: "a".repeat(32) },
};

function modelSetup(before: Record<string, unknown> = {}) {
  const agents = (before.agents ?? {}) as Record<string, unknown>;
  const defaults = (agents.defaults ?? {}) as Record<string, unknown>;
  return {
    ...before,
    gateway: before.gateway ?? gateway,
    models: { mode: "merge", providers: { custom: { apiKey: "fixture", models: [{ id: "m" }] } } },
    agents: { ...agents, defaults: { ...defaults, model: { primary: "custom/m" } } },
  };
}

function fixture(
  options: {
    mxc?: boolean;
    connected?: boolean;
    running?: boolean;
    current?: Record<string, unknown> | null;
  } = {},
) {
  let current = structuredClone(options.current ?? null);
  let exists = current !== null;
  let mxc = options.mxc ?? true;
  let connected = options.connected ?? false;
  let running = options.running ?? false;
  const deps = {
    readConfig: vi.fn(() => structuredClone(current)),
    configFileExists: vi.fn(() => exists),
    isMxcEnabled: vi.fn(() => mxc),
    assertMutable: vi.fn(),
    requireActiveContainment: vi.fn().mockResolvedValue(undefined),
    isGatewayConnected: vi.fn(() => connected),
    isGatewayRunning: vi.fn(() => running),
    assertGatewayPortAvailable: vi.fn().mockResolvedValue(undefined),
    defaultGatewayPort: 18789,
    nodeId: vi.fn(() => nodeId),
    persist: vi.fn((next: Record<string, unknown>) => {
      current = structuredClone(next);
      exists = true;
    }),
    applyModel: vi.fn().mockResolvedValue(undefined),
    applyPlugins: vi.fn(async (next: unknown) => {
      current = structuredClone(next as Record<string, unknown>);
    }),
    applySearch: vi.fn(async (next: unknown) => {
      current = structuredClone(next as Record<string, unknown>);
    }),
    startServices: vi.fn().mockResolvedValue(undefined),
  };
  return {
    deps,
    saved: () => current,
    setCurrent: (next: Record<string, unknown> | null) => {
      current = structuredClone(next);
      exists = current !== null;
    },
    setMxc: (value: boolean) => {
      mxc = value;
    },
    setRunning: (value: boolean) => {
      running = value;
    },
    setConnected: (value: boolean) => {
      connected = value;
    },
    setFileExists: (value: boolean) => {
      exists = value;
    },
  };
}

function routedConfig() {
  return applyWindowsNodeCommandPolicy(
    {
      gateway,
      agents: { entries: { main: {} } },
      tools: { web: { search: { provider: "brave", apiKey: "old" }, fetch: { enabled: true } } },
      hooks: { enabled: true },
    },
    nodeId,
  );
}

function searchChange(before: Record<string, unknown>) {
  const next = structuredClone(before);
  const tools = next.tools as Record<string, unknown>;
  const web = tools.web as Record<string, unknown>;
  web.search = { provider: "tavily", apiKey: "new" };
  return next;
}

describe("guarded configuration writes", () => {
  it.each([
    { entries: { "github-copilot": { enabled: true, config: { option: "value" } } } },
    { allow: ["other"], deny: ["github-copilot"], entries: { other: { enabled: false } } },
    undefined,
  ])("applies plugin settings with MXC on: %j", async (plugins) => {
    const before = { ...routedConfig(), plugins: { entries: { old: { enabled: true } } } };
    const next: Record<string, unknown> = structuredClone(before);
    if (plugins === undefined) delete next.plugins;
    else next.plugins = plugins;
    const state = fixture({ current: before });
    await writeGuardedConfig(state.deps, next, before);
    expect(state.deps.requireActiveContainment).toHaveBeenCalledOnce();
    expect(state.deps.applyPlugins).toHaveBeenCalledExactlyOnceWith(next, before);
    expect(state.saved()).toEqual(next);
    expect(state.deps.persist).not.toHaveBeenCalled();
  });

  it("does not allow a plugin write to alter command routing or use a stale snapshot", async () => {
    const before = routedConfig();
    const next = { ...before, plugins: { entries: { example: { enabled: true } } } };
    const state = fixture({ current: before });
    const unsafe = { ...next, tools: { exec: { host: "gateway" } } };
    await expect(writeGuardedConfig(state.deps, unsafe, before)).rejects.toThrow("Search settings");
    state.setCurrent({ ...before, hooks: { enabled: false } });
    await expect(writeGuardedConfig(state.deps, next, before)).rejects.toThrow("changed");
    expect(state.deps.applyPlugins).not.toHaveBeenCalled();
  });

  it("does not apply plugin changes if configuration changes while checking MXC readiness", async () => {
    const before = routedConfig();
    const next = { ...before, plugins: { entries: { example: { enabled: true } } } };
    const state = fixture({ current: before });
    state.deps.requireActiveContainment.mockImplementation(async () => {
      state.setCurrent({ ...before, hooks: { enabled: false } });
    });
    await expect(writeGuardedConfig(state.deps, next, before)).rejects.toThrow("changed");
    expect(state.deps.applyPlugins).not.toHaveBeenCalled();
  });

  it("saves only search settings under attested MXC without changing routing", async () => {
    const before = routedConfig();
    const state = fixture({ current: before });
    const next = searchChange(before);
    await writeGuardedConfig(state.deps, next, before);
    expect(state.deps.requireActiveContainment).toHaveBeenCalledOnce();
    expect(state.deps.applySearch).toHaveBeenCalledExactlyOnceWith(
      next,
      before,
      expect.any(Function),
    );
    expect(state.deps.persist).not.toHaveBeenCalled();
    expect(state.deps.startServices).not.toHaveBeenCalled();
    expect(state.saved()?.gateway).toEqual(before.gateway);
    expect(state.saved()?.agents).toEqual(before.agents);
  });

  it("uses the same guarded search application while MXC is Off", async () => {
    const before = routedConfig();
    const state = fixture({ mxc: false, current: before });
    const next = searchChange(before);
    await writeGuardedConfig(state.deps, next, before, { kind: "search-settings" });
    expect(state.deps.requireActiveContainment).not.toHaveBeenCalled();
    expect(state.deps.applySearch).toHaveBeenCalledExactlyOnceWith(
      next,
      before,
      expect.any(Function),
    );
    expect(state.deps.persist).not.toHaveBeenCalled();
  });

  it.each(["gateway", "hooks", "exec"] as const)(
    "rejects a search update that also changes %s",
    async (section) => {
      const before = routedConfig();
      const next = searchChange(before);
      if (section === "gateway") next.gateway = { port: 1 };
      if (section === "hooks") next.hooks = { enabled: false };
      if (section === "exec") (next.tools as Record<string, unknown>).exec = { host: "gateway" };
      const state = fixture({ current: before });
      await expect(writeGuardedConfig(state.deps, next, before)).rejects.toThrow("Search settings");
      expect(state.deps.persist).not.toHaveBeenCalled();
    },
  );

  it("rejects missing or stale snapshots, runtime changes and containment transitions", async () => {
    const before = routedConfig();
    const next = searchChange(before);
    const missing = fixture({ current: before });
    await expect(writeGuardedConfig(missing.deps, next)).rejects.toThrow("Reload");
    const stale = fixture({ current: before });
    stale.deps.requireActiveContainment.mockImplementation(async () => {
      stale.setCurrent({ ...before, hooks: { enabled: false } });
    });
    await expect(writeGuardedConfig(stale.deps, next, before)).rejects.toThrow("changed");
    const transition = fixture({ current: before });
    transition.deps.requireActiveContainment.mockImplementation(async () =>
      transition.setMxc(false),
    );
    await expect(writeGuardedConfig(transition.deps, next, before)).rejects.toThrow("mode changed");
    expect(stale.deps.persist).not.toHaveBeenCalled();
    expect(transition.deps.persist).not.toHaveBeenCalled();
  });

  it("does not save when the MXC lifecycle locks after readiness verification", async () => {
    const before = routedConfig();
    const state = fixture({ current: before });
    state.deps.assertMutable
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("Security transition");
      });
    await expect(writeGuardedConfig(state.deps, searchChange(before), before)).rejects.toThrow(
      "Security transition",
    );
    expect(state.deps.persist).not.toHaveBeenCalled();
  });

  it("does not accept an already-drifted command-routing policy", async () => {
    const before = routedConfig();
    (before.tools as Record<string, unknown>).exec = { host: "gateway" };
    const state = fixture({ current: before });
    await expect(writeGuardedConfig(state.deps, searchChange(before), before)).rejects.toThrow(
      "command routing is not ready",
    );
    expect(state.deps.persist).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "creates initial settings and starts services with MXC=%s",
    async (mxc) => {
      const state = fixture({ mxc });
      await writeGuardedConfig(state.deps, modelSetup(), null, intent);
      expect(state.deps.assertGatewayPortAvailable).toHaveBeenCalledExactlyOnceWith(18789);
      expect(state.deps.startServices).toHaveBeenCalledOnce();
      expect(state.saved()).toMatchObject({
        models: { providers: { custom: { apiKey: "fixture" } } },
        tools: { exec: { host: "node", node: nodeId } },
        gateway: { bind: "loopback", auth: { mode: "token" } },
      });
    },
  );

  it.each([true, false])(
    "uses the guarded live model path for connected setup with MXC=%s",
    async (mxc) => {
      const before = routedConfig();
      const next = modelSetup(before);
      const state = fixture({ mxc, current: before, connected: true, running: true });
      await writeGuardedConfig(state.deps, next, before, intent);
      expect(state.deps.applyModel).toHaveBeenCalledExactlyOnceWith({
        config: next,
        expectedConfig: before,
        action: "provider-save",
        providerKey: "custom",
      });
      expect(state.deps.persist).not.toHaveBeenCalled();
    },
  );

  it("rejects setup changes outside the selected model and safe initial Gateway", async () => {
    const state = fixture();
    const unsafe = { ...modelSetup(), hooks: { enabled: true } };
    await expect(writeGuardedConfig(state.deps, unsafe, null, intent)).rejects.toThrow("model");
    await expect(
      writeGuardedConfig(
        state.deps,
        { ...modelSetup(), gateway: { ...gateway, bind: "lan" } },
        null,
        intent,
      ),
    ).rejects.toThrow("loopback");
    expect(state.deps.persist).not.toHaveBeenCalled();
  });

  it("rejects an already configured model, an unreadable file and invalid write intent", async () => {
    const configured = modelSetup();
    const state = fixture({ current: configured });
    await expect(writeGuardedConfig(state.deps, configured, configured, intent)).rejects.toThrow(
      "already complete",
    );
    const unreadable = fixture();
    unreadable.setFileExists(true);
    await expect(writeGuardedConfig(unreadable.deps, modelSetup(), null, intent)).rejects.toThrow(
      "unreadable",
    );
    await expect(
      writeGuardedConfig(fixture().deps, modelSetup(), null, { kind: "setup" }),
    ).rejects.toThrow("intent");
  });

  it("does not write while a Gateway starts or another process owns the port", async () => {
    const state = fixture();
    state.deps.assertGatewayPortAvailable.mockImplementation(async () => state.setRunning(true));
    await expect(writeGuardedConfig(state.deps, modelSetup(), null, intent)).rejects.toThrow(
      "Gateway started",
    );
    expect(state.deps.persist).not.toHaveBeenCalled();
    const occupied = fixture();
    occupied.deps.assertGatewayPortAvailable.mockRejectedValue(new Error("Port is occupied"));
    await expect(writeGuardedConfig(occupied.deps, modelSetup(), null, intent)).rejects.toThrow(
      "occupied",
    );
    expect(occupied.deps.persist).not.toHaveBeenCalled();
  });

  it("reports startup failure after preserving the saved initial configuration", async () => {
    const state = fixture();
    state.deps.startServices.mockRejectedValue(new Error("unavailable"));
    await expect(writeGuardedConfig(state.deps, modelSetup(), null, intent)).rejects.toThrow(
      "settings were saved",
    );
    expect(state.saved()).not.toBeNull();
  });

  it("preserves Off-mode writes while pinning command routing and rejecting stale edits", async () => {
    const before = { gateway, agents: { entries: { main: {} } } };
    const state = fixture({ mxc: false, current: before });
    const next = { ...before, hooks: { enabled: true } };
    await writeGuardedConfig(state.deps, next, before);
    expect(state.saved()).toMatchObject({ tools: { exec: { host: "node", node: nodeId } } });
    await expect(writeGuardedConfig(state.deps, next, before)).rejects.toThrow("changed");
  });
});
