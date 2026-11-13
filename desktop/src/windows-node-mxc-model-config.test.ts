import { describe, expect, it, vi } from "vitest";
import { ModelConfigRestartRequiredError } from "./model-setup";
import { ensureGitHubCopilotProviderPlugin } from "./model-provider-plugins";
import {
  assertWindowsNodeMxcModelOrPluginChange,
  assertWindowsNodeMxcModelAndPluginSettingsUnchanged,
  runWindowsNodeMxcModelUpdate,
} from "./windows-node-mxc-model-config";

function config() {
  return {
    models: { providers: {} },
    agents: {
      defaults: { tools: { allow: ["exec"] }, workspace: "C:\\Work" },
      entries: { main: { tools: { allow: ["exec"] } } },
    },
    gateway: { port: 18789, nodes: { allowCommands: ["system.run"] } },
  };
}

describe("MXC model and plugin configuration boundary", () => {
  it("binds restarted model settings while allowing Gateway-owned metadata to change", () => {
    const before = config();
    expect(() =>
      assertWindowsNodeMxcModelAndPluginSettingsUnchanged(before, {
        ...before,
        meta: { lastTouchedAt: "new" },
      }),
    ).not.toThrow();
    expect(() =>
      assertWindowsNodeMxcModelAndPluginSettingsUnchanged(before, {
        ...before,
        models: { providers: { unexpected: {} } },
      }),
    ).toThrow("saved model or plugin settings changed");
    expect(() =>
      assertWindowsNodeMxcModelAndPluginSettingsUnchanged(before, {
        ...before,
        plugins: { entries: { "github-copilot": { enabled: false } } },
      }),
    ).toThrow("saved model or plugin settings changed");
  });
  it("allows provider credentials, model definitions and selectors without mutating its inputs", () => {
    const before = config();
    const after = {
      ...before,
      models: {
        mode: "merge",
        providers: {
          qwen: {
            apiKey: "test-key-not-a-secret",
            baseUrl: "https://example.invalid/v1",
            models: [{ id: "qwen-plus" }],
          },
        },
      },
      agents: {
        ...before.agents,
        defaults: {
          ...before.agents.defaults,
          model: { primary: "qwen/qwen-plus" },
          models: { "qwen/qwen-plus": { params: { thinking: "low" } } },
        },
      },
    };
    const original = structuredClone(after);
    expect(() => assertWindowsNodeMxcModelOrPluginChange(before, after)).not.toThrow();
    expect(after).toEqual(original);
  });

  it("allows adding and removing empty model-only containers and Gateway commit metadata", () => {
    const before = { gateway: { port: 18789 } };
    const after = {
      ...before,
      models: { providers: {} },
      agents: { defaults: { model: "qwen/qwen-plus" } },
      meta: { lastTouchedAt: "now", lastTouchedVersion: "version" },
    };
    expect(() => assertWindowsNodeMxcModelOrPluginChange(before, after)).not.toThrow();
    expect(() => assertWindowsNodeMxcModelOrPluginChange(after, before)).not.toThrow();
  });

  it("allows only new, enabled Gateway migration markers during an update", () => {
    const before = config();
    const after = {
      ...before,
      plugins: { entries: { "github-copilot": { enabled: true } } },
      meta: {
        lastTouchedVersion: "2026.10.10",
        migrations: { modelPolicyAllowlist: true, utilityModelSeparation: true },
      },
    };
    expect(() => assertWindowsNodeMxcModelOrPluginChange(before, after)).not.toThrow();
    expect(after.meta.migrations).toEqual({
      modelPolicyAllowlist: true,
      utilityModelSeparation: true,
    });
    expect(() =>
      assertWindowsNodeMxcModelOrPluginChange(before, {
        ...after,
        meta: { migrations: { modelPolicyAllowlist: false } },
      }),
    ).toThrow("Other Gateway configuration remains locked");
    expect(() =>
      assertWindowsNodeMxcModelOrPluginChange(before, {
        ...after,
        meta: { migrations: { unexpected: true } },
      }),
    ).toThrow("Other Gateway configuration remains locked");
    const existing = { ...before, meta: { migrations: { modelPolicyAllowlist: false } } };
    expect(() => assertWindowsNodeMxcModelOrPluginChange(existing, after)).toThrow(
      "Other Gateway configuration remains locked",
    );
  });

  it("allows unrestricted plugin configuration changes alongside model updates", () => {
    const before = {
      ...config(),
      plugins: { allow: ["old"], entries: { old: { enabled: true } } },
    };
    const after = {
      ...config(),
      models: { providers: { copilot: {} } },
      plugins: {
        allow: ["github-copilot"],
        deny: ["old"],
        entries: { "github-copilot": { enabled: true, config: { option: "value" } } },
      },
    };
    expect(() => assertWindowsNodeMxcModelOrPluginChange(before, after)).not.toThrow();
    expect(() => assertWindowsNodeMxcModelOrPluginChange(after, before)).not.toThrow();
  });

  it("allows the Copilot provider helper to enable a denied plugin during model setup", () => {
    const before = {
      ...config(),
      plugins: {
        allow: ["other"],
        deny: ["github-copilot"],
        entries: { "github-copilot": { enabled: false } },
      },
    };
    const after = structuredClone(before);
    expect(ensureGitHubCopilotProviderPlugin(after)).toBe(true);
    expect(() => assertWindowsNodeMxcModelOrPluginChange(before, after)).not.toThrow();
    expect(after.plugins.entries["github-copilot"].enabled).toBe(true);
    expect(after.plugins.allow).toContain("github-copilot");
    expect(after.plugins.deny).not.toContain("github-copilot");
  });

  it.each(["tools", "gateway", "hooks", "cron", "sandbox", "permissions", "channels", "unknown"])(
    "rejects a %s change even when it accompanies a model update",
    (key) => {
      const before = config();
      expect(() =>
        assertWindowsNodeMxcModelOrPluginChange(before, {
          ...before,
          models: { providers: { qwen: {} } },
          [key]: { changed: true },
        }),
      ).toThrow("Other Gateway configuration remains locked");
    },
  );

  it.each([
    { defaults: { tools: { allow: ["*"] } } },
    { defaults: { workspace: "C:\\Other" } },
    { entries: { main: { tools: { allow: ["*"] } } } },
    { list: [{ id: "new-agent" }] },
  ])("rejects agent policy and roster changes: %j", (agents) => {
    const before = config();
    expect(() =>
      assertWindowsNodeMxcModelOrPluginChange(before, {
        ...before,
        agents: { ...before.agents, ...agents },
      }),
    ).toThrow("Other Gateway configuration remains locked");
  });

  it.each([
    null,
    [],
    { agents: [] },
    { agents: { defaults: null } },
    { models: [] },
    { models: { providers: null } },
  ])("rejects malformed configuration: %j", (after) => {
    expect(() => assertWindowsNodeMxcModelOrPluginChange(config(), after)).toThrow();
  });
});

function transaction() {
  let saved: unknown = config();
  const calls: string[] = [];
  const hooks = {
    readConfig: () => saved,
    pause: vi.fn(async () => {
      calls.push("pause");
    }),
    apply: vi.fn(async () => {
      calls.push("apply");
      saved = { ...config(), models: { providers: { qwen: {} } } };
      return "selected";
    }),
    restartSavedConfig: vi.fn(async (_hash: string) => {
      calls.push("restart");
      return "selected";
    }),
    verify: vi.fn(async () => {
      calls.push("verify");
    }),
    resume: vi.fn(() => {
      calls.push("resume");
    }),
    failClosed: vi.fn(async () => {
      calls.push("lock");
    }),
  };
  return {
    hooks,
    calls,
    setConfig: (next: unknown) => {
      saved = next;
    },
  };
}

describe("MXC model update transaction", () => {
  it("pauses work and attests the new runtime before releasing ingress without restarting", async () => {
    const state = transaction();
    await expect(runWindowsNodeMxcModelUpdate(state.hooks)).resolves.toBe("selected");
    expect(state.calls).toEqual(["pause", "apply", "verify", "resume"]);
    expect(state.hooks.restartSavedConfig).not.toHaveBeenCalled();
  });

  it("accepts plugin activation during the guarded model update", async () => {
    const state = transaction();
    state.hooks.apply.mockImplementation(async () => {
      state.setConfig({
        ...config(),
        plugins: { entries: { "github-copilot": { enabled: true } } },
      });
      return "selected";
    });
    await expect(runWindowsNodeMxcModelUpdate(state.hooks)).resolves.toBe("selected");
    expect(state.calls).toEqual(["pause", "verify", "resume"]);
  });

  it("accepts Gateway migration markers written when the plugin is activated", async () => {
    const state = transaction();
    state.hooks.apply.mockImplementation(async () => {
      state.setConfig({
        ...config(),
        plugins: { entries: { "github-copilot": { enabled: true } } },
        meta: {
          migrations: { modelPolicyAllowlist: true, utilityModelSeparation: true },
        },
      });
      return "selected";
    });
    await expect(runWindowsNodeMxcModelUpdate(state.hooks)).resolves.toBe("selected");
    expect(state.hooks.resume).toHaveBeenCalledOnce();
  });

  it("restarts only an explicitly acknowledged saved revision, never repeating the write", async () => {
    const state = transaction();
    state.hooks.apply.mockRejectedValue(
      new Error("unconfirmed", {
        cause: new ModelConfigRestartRequiredError("saved-revision"),
      }),
    );
    await expect(runWindowsNodeMxcModelUpdate(state.hooks)).resolves.toBe("selected");
    expect(state.calls).toEqual(["pause", "restart", "verify", "resume"]);
    expect(state.hooks.restartSavedConfig).toHaveBeenCalledExactlyOnceWith("saved-revision");
    expect(state.hooks.apply).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Error("restart required"),
    new Error("lost Gateway response"),
    new ModelConfigRestartRequiredError(""),
  ])("does not restart on an uncertain or unbound result: %s", async (error) => {
    const state = transaction();
    state.hooks.apply.mockRejectedValue(error);
    await expect(runWindowsNodeMxcModelUpdate(state.hooks)).rejects.toThrow(
      "execution remains locked",
    );
    expect(state.hooks.restartSavedConfig).not.toHaveBeenCalled();
    expect(state.hooks.resume).not.toHaveBeenCalled();
    expect(state.hooks.failClosed).toHaveBeenCalledOnce();
  });

  it("rejects a security-policy change observed after the Gateway write", async () => {
    const state = transaction();
    state.hooks.apply.mockImplementation(async () => {
      state.setConfig({ ...config(), tools: { exec: { host: "gateway" } } });
      return "selected";
    });

    await expect(runWindowsNodeMxcModelUpdate(state.hooks)).rejects.toThrow(
      "execution remains locked",
    );
    expect(state.hooks.verify).not.toHaveBeenCalled();
    expect(state.hooks.resume).not.toHaveBeenCalled();
  });

  it("does not reopen ingress if configuration changes while attestation is running", async () => {
    const state = transaction();
    state.hooks.verify.mockImplementation(async () => {
      state.setConfig({ ...config(), models: { providers: { unexpected: {} } } });
    });
    await expect(runWindowsNodeMxcModelUpdate(state.hooks)).rejects.toThrow(
      "execution remains locked",
    );
    expect(state.hooks.resume).not.toHaveBeenCalled();
    expect(state.hooks.failClosed).toHaveBeenCalledOnce();
  });

  it.each(["pause", "verify", "restartSavedConfig", "resume"] as const)(
    "remains locked after a %s failure",
    async (stage) => {
      const state = transaction();
      if (stage === "restartSavedConfig")
        state.hooks.apply.mockRejectedValue(new ModelConfigRestartRequiredError("saved"));
      state.hooks[stage].mockImplementation(() => {
        throw new Error(stage);
      });
      await expect(runWindowsNodeMxcModelUpdate(state.hooks)).rejects.toThrow(
        "execution remains locked",
      );
      expect(state.calls.at(-1)).toBe("lock");
    },
  );

  it("preserves both failures when locking also fails", async () => {
    const state = transaction();
    state.hooks.apply.mockRejectedValue(new Error("write failed"));
    state.hooks.failClosed.mockRejectedValue(new Error("stop failed"));
    await expect(runWindowsNodeMxcModelUpdate(state.hooks)).rejects.toBeInstanceOf(AggregateError);
  });
});
