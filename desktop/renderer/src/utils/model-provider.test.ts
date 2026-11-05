import { describe, expect, it } from "vitest";
import {
  getCredentialReferenceName,
  getDefaultAgentModelOverride,
  isValidHttpUrl,
  mergeModelProviderConfig,
  mergeModelProviderConnectionConfig,
  normalizeModelInput,
  removeModelProviderConfig,
  removeProviderConnectionConfig,
  resolveApiValue,
  selectPrimaryModelConfig,
  updateModelProviderConfig,
  validateModelProviderInput,
  validateModelProviderConnectionInput,
  type ModelProviderInput,
} from "./model-provider";

const validInput: ModelProviderInput = {
  providerKey: "azure-openai",
  baseUrl: "https://example.openai.azure.com/v1/",
  apiKey: "${AZURE_OPENAI_API_KEY}",
  apiFormat: "openai-chat",
  modelName: "gpt-4o",
};

describe("default-agent model override notice", () => {
  it("uses the explicitly marked default agent without changing entries", () => {
    const config = {
      agents: {
        list: [
          { id: "first", model: "cloud/first" },
          { id: "default", default: true, model: { primary: "llama-cpp/overridden" } },
        ],
      },
    };
    const original = structuredClone(config);
    expect(getDefaultAgentModelOverride(config)).toEqual({
      agentId: "default",
      modelRef: "llama-cpp/overridden",
    });
    expect(config).toEqual(original);
  });

  it("uses the first configured agent when no explicit default is marked", () => {
    expect(
      getDefaultAgentModelOverride({
        agents: {
          list: [
            { id: "first", model: "cloud/first" },
            { id: "other", model: "cloud/other" },
          ],
        },
      }),
    ).toEqual({ agentId: "first", modelRef: "cloud/first" });
  });

  it("does not invent a primary override from global defaults or a fallback-only agent setting", () => {
    expect(getDefaultAgentModelOverride(null)).toBeNull();
    expect(
      getDefaultAgentModelOverride({
        agents: {
          defaults: { model: "cloud/global" },
          list: [{ id: "main", model: { fallbacks: ["cloud/other"] } }],
        },
      }),
    ).toBeNull();
  });
});

describe("model provider validation", () => {
  it("accepts an HTTP endpoint and credential reference", () => {
    expect(validateModelProviderInput(validInput)).toBeNull();
    expect(getCredentialReferenceName(validInput.apiKey)).toBe("AZURE_OPENAI_API_KEY");
  });

  it("allows a blank API key for explicitly keyless providers", () => {
    expect(
      validateModelProviderInput({ ...validInput, apiKey: "" }, { requireApiKey: false }),
    ).toBeNull();
  });

  it.each([
    [{ ...validInput, providerKey: "" }, "providerKeyRequired"],
    [{ ...validInput, providerKey: "bad/provider" }, "invalidProviderKey"],
    [{ ...validInput, modelName: "" }, "modelNameRequired"],
    [{ ...validInput, baseUrl: "" }, "baseUrlRequired"],
    [{ ...validInput, baseUrl: "file:///tmp/model" }, "invalidBaseUrl"],
    [{ ...validInput, apiKey: "" }, "apiKeyRequired"],
    [{ ...validInput, apiKey: "${BAD REF}" }, "invalidCredentialReference"],
  ] as const)("returns %s for invalid input", (input, expected) => {
    expect(validateModelProviderInput(input)).toBe(expected);
  });

  it("rejects URLs containing embedded credentials", () => {
    expect(isValidHttpUrl("https://user:password@example.com/v1")).toBe(false);
  });
});

describe("model provider config", () => {
  it("validates and saves a connection without selecting or registering a model", () => {
    const { modelName: _modelName, ...connection } = validInput;
    expect(validateModelProviderConnectionInput(connection)).toBeNull();
    expect(validateModelProviderConnectionInput({ ...connection, apiKey: "" })).toBe(
      "apiKeyRequired",
    );
    expect(validateModelProviderConnectionInput({ ...connection, baseUrl: "file:///model" })).toBe(
      "invalidBaseUrl",
    );
    const config = mergeModelProviderConnectionConfig({}, connection);
    expect(config.models).toEqual({
      mode: "merge",
      providers: {
        "azure-openai": {
          baseUrl: "https://example.openai.azure.com/v1",
          apiKey: connection.apiKey,
          api: "openai-completions",
          models: [],
        },
      },
    });
    expect(config).not.toHaveProperty("agents");
  });

  it("preserves model definitions, agent policies and sessions when updating only a connection", () => {
    const existing = {
      models: {
        mode: "replace",
        providers: {
          "azure-openai": {
            baseUrl: "https://old.example/v1",
            apiKey: "old-key",
            headers: { "X-Custom": "keep" },
            models: [
              { id: "model", name: "Custom", input: ["text", "image"], contextWindow: 12345 },
            ],
          },
          other: { models: [{ id: "other" }] },
        },
      },
      agents: {
        defaults: { model: "other/other", modelPolicy: { allow: ["other/other"] } },
        list: [{ id: "main", model: "azure-openai/model" }],
      },
      sessions: { keep: true },
    };
    const original = structuredClone(existing);
    const config = mergeModelProviderConnectionConfig(existing, validInput);
    expect(config.agents).toEqual(original.agents);
    expect(config.sessions).toEqual(original.sessions);
    expect(config.models).toEqual({
      ...original.models,
      providers: {
        ...original.models.providers,
        "azure-openai": {
          ...original.models.providers["azure-openai"],
          baseUrl: "https://example.openai.azure.com/v1",
          apiKey: validInput.apiKey,
          api: "openai-completions",
        },
      },
    });
    expect(existing).toEqual(original);
  });

  it("defaults unknown capabilities to text-only", () => {
    expect(normalizeModelInput(undefined)).toEqual(["text"]);
    expect(normalizeModelInput(["image", "audio", "text"])).toEqual(["image", "text"]);
  });

  it("merges a provider without dropping existing config", () => {
    const config = mergeModelProviderConfig(
      {
        gateway: { port: 18789 },
        models: {
          providers: {
            existing: { apiKey: "keep-me" },
          },
        },
        agents: {
          defaults: {
            model: { fallbacks: ["existing/model"] },
          },
        },
      },
      validInput,
    );

    expect(config.gateway).toEqual({ port: 18789 });
    expect(config.models).toMatchObject({
      mode: "merge",
      providers: {
        existing: { apiKey: "keep-me" },
        "azure-openai": {
          baseUrl: "https://example.openai.azure.com/v1",
          apiKey: "${AZURE_OPENAI_API_KEY}",
          api: "openai-completions",
          models: [
            {
              id: "gpt-4o",
              name: "gpt-4o",
              input: ["text"],
            },
          ],
        },
      },
    });
    expect(config.agents).toMatchObject({
      defaults: {
        model: {
          primary: "azure-openai/gpt-4o",
          fallbacks: ["existing/model"],
        },
      },
    });
  });

  it("uses conservative capabilities and maps Anthropic API values", () => {
    const responses = mergeModelProviderConfig(
      {},
      { ...validInput, apiFormat: "openai-responses" },
    );
    expect(responses.models).toMatchObject({
      providers: {
        "azure-openai": {
          models: [{ id: "gpt-4o", input: ["text"] }],
        },
      },
    });

    const anthropic = mergeModelProviderConfig(
      {},
      {
        ...validInput,
        providerKey: "anthropic",
        apiFormat: "anthropic",
        modelName: "claude-sonnet",
      },
    );
    expect(resolveApiValue("anthropic")).toBe("anthropic-messages");
    expect(anthropic.models).toMatchObject({
      providers: {
        anthropic: {
          api: "anthropic-messages",
          models: [{ id: "claude-sonnet", name: "claude-sonnet" }],
        },
      },
    });
    const models = (
      anthropic.models as {
        providers: { anthropic: { models: Array<Record<string, unknown>> } };
      }
    ).providers.anthropic.models;
    expect(models[0]).not.toHaveProperty("input");
  });

  it("preserves guided-provider image capability when explicitly supplied", () => {
    const config = mergeModelProviderConfig(
      {},
      { ...validInput, providerKey: "qwen", input: ["text", "image"] },
    );
    expect(config.models).toMatchObject({
      providers: {
        qwen: {
          models: [{ id: "gpt-4o", input: ["text", "image"] }],
        },
      },
    });
  });

  it("preserves provider extensions and unrelated models when updating a model", () => {
    const existingModels = [
      {
        id: "gpt-4o",
        name: "GPT-4o",
        input: ["text"],
        contextWindow: 128_000,
      },
      {
        id: "gpt-4o-mini",
        name: "GPT-4o mini",
        input: ["text", "image"],
      },
    ];
    const config = mergeModelProviderConfig(
      {
        models: {
          providers: {
            "azure-openai": {
              baseUrl: "https://old.example/v1",
              apiKey: "old-key",
              api: "openai-completions",
              headers: { "X-Custom": "value" },
              models: existingModels,
            },
          },
        },
      },
      validInput,
    );

    expect(config.models).toMatchObject({
      providers: {
        "azure-openai": {
          baseUrl: "https://example.openai.azure.com/v1",
          apiKey: "${AZURE_OPENAI_API_KEY}",
          headers: { "X-Custom": "value" },
          models: [
            {
              id: "gpt-4o",
              name: "gpt-4o",
              input: ["text"],
              contextWindow: 128_000,
            },
            existingModels[1],
          ],
        },
      },
    });
  });

  it("switches only the primary model and optionally adds an allowlist entry", () => {
    const existing = {
      models: {
        providers: {
          custom: {
            headers: { "X-Custom": "value" },
            models: [{ id: "model-a" }, { id: "model-b" }],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "custom/model-a", fallbacks: ["external/model"] },
          models: { "external/model": { alias: "external" } },
        },
      },
      hooks: { enabled: true },
    };

    const selected = selectPrimaryModelConfig(existing, "custom/model-b");
    expect(selected.models).toBe(existing.models);
    expect(selected.hooks).toBe(existing.hooks);
    expect(selected.agents).toEqual({
      defaults: {
        model: { primary: "custom/model-b", fallbacks: ["external/model"] },
        models: { "external/model": { alias: "external" } },
      },
    });

    const copilot = selectPrimaryModelConfig(existing, "github-copilot/gpt-5.4", {
      ensureAllowed: true,
    });
    expect(copilot.agents).toMatchObject({
      defaults: {
        models: {
          "external/model": { alias: "external" },
          "github-copilot/gpt-5.4": {},
        },
      },
    });
  });

  it("updates one configured model without rebuilding providers", () => {
    const existing = {
      models: {
        providers: {
          custom: {
            headers: { "X-Custom": "value" },
            models: [
              { id: "old-model", name: "Old", contextWindow: 128_000 },
              { id: "sibling", name: "Sibling" },
            ],
          },
          untouched: { models: [{ id: "keep" }], extension: true },
        },
      },
      agents: {
        defaults: {
          model: { primary: "custom/old-model", fallbacks: ["untouched/keep"] },
          models: {
            "custom/old-model": { alias: "old", params: { temperature: 0.2 } },
            "untouched/keep": { alias: "keep" },
          },
        },
      },
      channels: { modelByChannel: { slack: { default: "custom/old-model" } } },
    };

    const updated = updateModelProviderConfig(existing, {
      providerKey: "custom",
      originalModelName: "old-model",
      modelName: "new-model",
      displayName: "New Model",
      baseUrl: "https://example.com/v1",
      apiKey: "${MODEL_API_KEY}",
      apiFormat: "openai-chat",
      input: ["text", "image"],
      reasoningEffort: "high",
    });

    expect(updated).toMatchObject({
      models: {
        providers: {
          custom: {
            headers: { "X-Custom": "value" },
            models: [
              {
                id: "new-model",
                name: "New Model",
                contextWindow: 128_000,
                input: ["text", "image"],
                reasoning: true,
              },
              { id: "sibling", name: "Sibling" },
            ],
          },
          untouched: { models: [{ id: "keep" }], extension: true },
        },
      },
      agents: {
        defaults: {
          model: { primary: "custom/new-model", fallbacks: ["untouched/keep"] },
          models: {
            "custom/new-model": {
              alias: "old",
              params: { temperature: 0.2, thinking: "high" },
            },
            "untouched/keep": { alias: "keep" },
          },
        },
      },
      channels: { modelByChannel: { slack: { default: "custom/old-model" } } },
    });
  });

  it("removes only the requested model and MicroClaw-owned defaults", () => {
    const existing = {
      models: {
        providers: {
          custom: {
            headers: { "X-Custom": "value" },
            models: [{ id: "model-a" }, { id: "model-b" }],
          },
          untouched: { models: [{ id: "keep" }] },
        },
      },
      agents: {
        defaults: {
          model: { primary: "custom/model-a", fallbacks: ["custom/model-a", "untouched/keep"] },
          models: {
            "custom/model-a": { alias: "remove" },
            "untouched/keep": { alias: "keep" },
          },
        },
      },
      hooks: { mappings: [{ model: "custom/model-a" }] },
    };

    const result = removeModelProviderConfig(existing, "custom", "model-a", "custom/model-b");
    expect(result).toMatchObject({
      models: {
        providers: {
          custom: {
            headers: { "X-Custom": "value" },
            models: [{ id: "model-b" }],
          },
          untouched: { models: [{ id: "keep" }] },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "custom/model-b",
            fallbacks: ["custom/model-a", "untouched/keep"],
          },
          models: { "untouched/keep": { alias: "keep" } },
        },
      },
      hooks: { mappings: [{ model: "custom/model-a" }] },
    });
  });
});

describe("removing a provider connection", () => {
  it("disconnects local models and disables only their plugin without deleting install metadata", () => {
    const existing = {
      models: {
        providers: {
          "llama-cpp": { models: [{ id: "local" }], localService: { command: "llama-server" } },
          qwen: { apiKey: "keep", models: [{ id: "remote" }] },
        },
      },
      agents: {
        defaults: {
          model: { primary: "qwen/remote", fallbacks: ["llama-cpp/local", "qwen/backup"] },
          models: { "llama-cpp/local": {}, "qwen/remote": {} },
        },
        list: [{ id: "local-agent", model: "llama-cpp/local", workspace: "keep" }],
        entries: { worker: { model: { primary: "llama-cpp/local" } } },
      },
      plugins: {
        allow: ["llama-cpp", "other"],
        entries: {
          "llama-cpp": { enabled: true, config: { keep: true } },
          other: { enabled: true },
        },
        installs: { "llama-cpp": { installPath: "keep-plugin-files" } },
      },
      memory: { provider: "keep" },
    };
    const original = structuredClone(existing);
    const result = removeProviderConnectionConfig(existing, "llama-cpp");
    expect(result.models).toEqual({ providers: { qwen: existing.models.providers.qwen } });
    expect(result.agents).toEqual({
      defaults: {
        model: { primary: "qwen/remote", fallbacks: ["qwen/backup"] },
        models: { "qwen/remote": {} },
      },
      list: [{ id: "local-agent", workspace: "keep" }],
      entries: { worker: {} },
    });
    expect(result.plugins).toEqual({
      ...existing.plugins,
      entries: {
        ...existing.plugins.entries,
        "llama-cpp": { enabled: false, config: { keep: true } },
      },
    });
    expect(result.memory).toEqual(existing.memory);
    expect(existing).toEqual(original);
  });

  it("can disable the local plugin before any model connection has been prepared", () => {
    const existing = {
      plugins: { entries: { "llama-cpp": { enabled: true } } },
      agents: { defaults: { model: "llama-cpp/stale" } },
    };
    const original = structuredClone(existing);
    const result = removeProviderConnectionConfig(existing, "llama-cpp");
    expect(result.models).toEqual({ providers: {} });
    expect(result.agents).toEqual({ defaults: {} });
    expect(result.plugins).toEqual({ entries: { "llama-cpp": { enabled: false } } });
    expect(existing).toEqual(original);
  });

  it("removes the last provider and clears its default without choosing a replacement", () => {
    const existing = {
      models: {
        mode: "merge",
        providers: {
          qwen: { apiKey: "saved-key", models: [{ id: "one" }, { id: "two" }] },
        },
      },
      agents: {
        defaults: {
          model: { primary: "qwen/one", fallbacks: ["qwen/two"] },
          models: { "qwen/one": {}, "qwen/two": {} },
          workspace: "keep",
        },
      },
      memory: { provider: "keep" },
    };
    const original = structuredClone(existing);
    const result = removeProviderConnectionConfig(existing, "qwen");
    expect(result).toEqual({
      models: { mode: "merge", providers: {} },
      agents: { defaults: { workspace: "keep" } },
      memory: { provider: "keep" },
    });
    expect(existing).toEqual(original);
  });

  it("clears only the provider's model references in both agent layouts", () => {
    const policy = { allow: ["qwen/one", "other/keep"] };
    const existing = {
      models: {
        providers: {
          qwen: { apiKey: "${QWEN_API_KEY}", models: [{ id: "one" }] },
          "qwen-extra": { apiKey: "keep", models: [{ id: "keep" }] },
        },
      },
      agents: {
        defaults: {
          model: { primary: "qwen-extra/keep", fallbacks: ["qwen/one", "other/keep"] },
          models: { "qwen/one": {}, "qwen-extra/keep": { alias: "keep" } },
          modelPolicy: policy,
        },
        list: [
          { id: "first", model: "qwen/one" },
          { id: "second", model: "other/keep" },
        ],
        entries: {
          main: { model: { primary: "qwen/one", fallbacks: ["other/keep"] } },
          other: { model: "other/keep" },
        },
      },
      auth: { profiles: { external: { provider: "qwen", mode: "api_key" } } },
      hooks: { mappings: [{ model: "qwen/one" }] },
    };
    const result = removeProviderConnectionConfig(existing, "qwen");
    expect(result).toEqual({
      ...existing,
      models: { providers: { "qwen-extra": existing.models.providers["qwen-extra"] } },
      agents: {
        defaults: {
          model: { primary: "qwen-extra/keep", fallbacks: ["other/keep"] },
          models: { "qwen-extra/keep": { alias: "keep" } },
          modelPolicy: policy,
        },
        list: [{ id: "first" }, { id: "second", model: "other/keep" }],
        entries: {
          main: { model: { fallbacks: ["other/keep"] } },
          other: { model: "other/keep" },
        },
      },
    });
  });

  it("removes credentials even if no models have been saved", () => {
    const result = removeProviderConnectionConfig(
      { models: { providers: { qwen: { apiKey: "saved-key", models: [] } } } },
      "qwen",
    );
    expect(result.models).toEqual({ providers: {} });
  });

  it("rejects removal of a provider that is no longer configured", () => {
    expect(() => removeProviderConnectionConfig({}, "qwen")).toThrow(
      'Provider "qwen" is not configured',
    );
  });
});

describe("provider retention when selecting a default", () => {
  it("keeps all providers and changes only the default", () => {
    const existing = {
      models: {
        mode: "merge",
        providers: {
          custom: { models: [{ id: "model-a" }] },
          stale: { models: [{ id: "old" }] },
        },
      },
      agents: { defaults: { model: { primary: "custom/model-a" } } },
    };

    const result = selectPrimaryModelConfig(existing, "stale/old");
    expect(result.models).toBe(existing.models);
    expect(result.agents).toEqual({ defaults: { model: { primary: "stale/old" } } });
  });

  it("preserves providers and profiles when switching to an auth-managed model", () => {
    const existing = {
      auth: { profiles: { "github-copilot:github": { provider: "github-copilot" } } },
      models: {
        mode: "merge",
        providers: { custom: { models: [{ id: "model-a" }] } },
      },
      agents: { defaults: { model: { primary: "github-copilot/gpt-5.4" } } },
    };

    const result = selectPrimaryModelConfig(existing, "github-copilot/gpt-5.4", {
      ensureAllowed: true,
    });
    expect(result.models).toBe(existing.models);
    expect(result.auth).toBe(existing.auth);
  });
});
