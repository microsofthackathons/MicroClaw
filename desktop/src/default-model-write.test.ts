import { describe, expect, it } from "vitest";
import { prepareDefaultModelWrite } from "./default-model-write";

const config = {
  agents: {
    defaults: {
      model: { primary: "qwen/old", fallbacks: ["minimax/backup"] },
      models: { "qwen/old": { alias: "keep" } },
    },
    entries: { main: {}, writer: { model: "qwen/old" } },
  },
  models: {
    providers: {
      qwen: {
        apiKey: "private-fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{ id: "old", name: "old", maxTokens: 123 }],
      },
      minimax: { apiKey: { source: "env", id: "MINIMAX_KEY" }, models: [] },
    },
  },
  plugins: { allow: ["keep"] },
  gateway: { auth: { token: "private-gateway-token" } },
};
const gateway = { serverVersion: "2026.10.10", methods: ["config.set", "config.patch"] };
const patch = { agents: { defaults: { model: { primary: "qwen/new" } } } };
const build = (options = {}) =>
  prepareDefaultModelWrite({
    gateway,
    originalConfig: config,
    modelRef: "qwen/new",
    baseHash: "before",
    patch,
    ...options,
  });

describe("default model write", () => {
  it("keeps credentials, fallback models, agent overrides and unrelated settings intact", () => {
    const before = structuredClone(config);
    const result = build();
    expect(result.method).toBe("config.set");
    expect(result.params.baseHash).toBe("before");
    expect(JSON.parse(result.params.raw)).toEqual({
      ...config,
      agents: {
        ...config.agents,
        defaults: {
          ...config.agents.defaults,
          model: { ...config.agents.defaults.model, primary: "qwen/new" },
        },
      },
    });
    expect(config).toEqual(before);
  });

  it("registers the verified new model without replacing existing definitions or provider credentials", () => {
    const models = [
      ...config.models.providers.qwen.models,
      { id: "new", name: "new", input: ["text"] },
    ];
    const result = build({ patch: { ...patch, models: { providers: { qwen: { models } } } } });
    expect(result.method).toBe("config.set");
    const target = JSON.parse(result.params.raw);
    expect(target.models.providers.qwen).toEqual({ ...config.models.providers.qwen, models });
    expect(target.models.providers.minimax).toEqual(config.models.providers.minimax);
  });

  it("merges the local model allowlist entry while retaining its aliases and fallback", () => {
    const result = build({
      modelRef: "llama-cpp/local",
      patch: {
        agents: {
          defaults: {
            model: { primary: "llama-cpp/local" },
            models: { "llama-cpp/local": {} },
          },
        },
      },
    });
    const target = JSON.parse(result.params.raw);
    expect(result.method).toBe("config.set");
    expect(target.agents.defaults.models).toEqual({
      ...config.agents.defaults.models,
      "llama-cpp/local": {},
    });
    expect(target.agents.defaults.model.fallbacks).toEqual(config.agents.defaults.model.fallbacks);
  });

  it.each([
    { gateway: { ...gateway, serverVersion: "2026.10.5" } },
    { gateway: { ...gateway, methods: ["config.patch"] } },
    { originalConfig: { ...config, gateway: { reload: { mode: "off" } } } },
    { patch: { ...patch, tools: { profile: "minimal" } } },
    { patch: { agents: { ...patch.agents, entries: { writer: null } } } },
    { patch: { ...patch, models: { providers: { qwen: { models: [{ id: "new" }] } } } } },
    { patch: { ...patch, models: null } },
  ])("retains patch semantics for unsupported writes: %j", (options) => {
    expect(build(options).method).toBe("config.patch");
  });
});
