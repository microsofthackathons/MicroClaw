import { describe, expect, it } from "vitest";
import {
  getCredentialReferenceName,
  getDefaultAgentModelOverride,
  isValidHttpUrl,
  mergeModelProviderConfig,
  normalizeModelInput,
  removeModelProviderConfig,
  resolveApiValue,
  selectPrimaryModelConfig,
  updateModelProviderConfig,
  validateModelProviderInput,
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
    [{ ...validInput, providerKey: "github-copilot" }, "invalidProviderKey"],
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

    const allowed = selectPrimaryModelConfig(existing, "custom/model-b", {
      ensureAllowed: true,
    });
    expect(allowed.agents).toMatchObject({
      defaults: {
        models: {
          "external/model": { alias: "external" },
          "custom/model-b": {},
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

  it("preserves legacy profiles and providers when switching to a supported model", () => {
    const existing = {
      auth: { profiles: { "github-copilot:github": { provider: "github-copilot" } } },
      models: {
        mode: "merge",
        providers: { custom: { models: [{ id: "model-a" }] } },
      },
      agents: { defaults: { model: { primary: "github-copilot/gpt-5.4" } } },
    };

    const result = selectPrimaryModelConfig(existing, "custom/model-a", {
      ensureAllowed: true,
    });
    expect(result.models).toBe(existing.models);
    expect(result.auth).toBe(existing.auth);
  });
});
