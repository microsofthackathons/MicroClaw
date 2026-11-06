import { describe, expect, it, vi } from "vitest";
import { ModelConfigRestartRequiredError } from "./model-setup";
import {
  assertWindowsNodeMxcModelOnlyChange,
  assertWindowsNodeMxcModelSettingsUnchanged,
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

describe("MXC model-only configuration boundary", () => {
  it("binds restarted model settings while allowing Gateway-owned metadata to change", () => {
    const before = config();
    expect(() =>
      assertWindowsNodeMxcModelSettingsUnchanged(before, {
        ...before,
        meta: { lastTouchedAt: "new" },
      }),
    ).not.toThrow();
    expect(() =>
      assertWindowsNodeMxcModelSettingsUnchanged(before, {
        ...before,
        models: { providers: { unexpected: {} } },
      }),
    ).toThrow("saved model settings changed");
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
    expect(() => assertWindowsNodeMxcModelOnlyChange(before, after)).not.toThrow();
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
    expect(() => assertWindowsNodeMxcModelOnlyChange(before, after)).not.toThrow();
    expect(() => assertWindowsNodeMxcModelOnlyChange(after, before)).not.toThrow();
  });

  it.each([
    "tools",
    "gateway",
    "plugins",
    "hooks",
    "cron",
    "sandbox",
    "permissions",
    "channels",
    "unknown",
  ])("rejects a %s change even when it accompanies a model update", (key) => {
    const before = config();
    expect(() =>
      assertWindowsNodeMxcModelOnlyChange(before, {
        ...before,
        models: { providers: { qwen: {} } },
        [key]: { changed: true },
      }),
    ).toThrow("Other Gateway configuration remains locked");
  });

  it.each([
    { defaults: { tools: { allow: ["*"] } } },
    { defaults: { workspace: "C:\\Other" } },
    { entries: { main: { tools: { allow: ["*"] } } } },
    { list: [{ id: "new-agent" }] },
  ])("rejects agent policy and roster changes: %j", (agents) => {
    const before = config();
    expect(() =>
      assertWindowsNodeMxcModelOnlyChange(before, {
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
    expect(() => assertWindowsNodeMxcModelOnlyChange(config(), after)).toThrow();
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
