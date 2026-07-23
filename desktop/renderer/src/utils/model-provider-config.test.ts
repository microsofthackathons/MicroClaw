import { describe, expect, it } from "vitest";
import { buildManagedProviderConfigs, mergeProviderModelConfig } from "./model-provider-config";

describe("mergeProviderModelConfig", () => {
  it("preserves provider options and unrelated models when updating a model", () => {
    const existingProvider = {
      baseUrl: "https://old.example/v1",
      apiKey: "old-key",
      api: "openai-completions",
      headers: { "X-Custom": "value" },
      timeout: 30_000,
      models: [
        {
          id: "qwen3.7-plus",
          name: "Qwen Plus",
          input: ["text"],
          contextWindow: 128_000,
        },
        {
          id: "qwen3-32b",
          name: "Qwen 32B",
          input: ["text", "image"],
        },
      ],
    };

    const result = mergeProviderModelConfig(existingProvider, {
      baseUrl: "https://new.example/v1",
      apiKey: "new-key",
      api: "openai-completions",
      modelName: "qwen3.7-plus",
    });

    expect(result).toEqual({
      ...existingProvider,
      baseUrl: "https://new.example/v1",
      apiKey: "new-key",
      models: existingProvider.models,
    });
    expect(result.models).not.toBe(existingProvider.models);
  });

  it("adds the selected model without changing existing model entries", () => {
    const existingModel = { id: "MiniMax-M1", name: "MiniMax M1", input: ["text"] };

    const result = mergeProviderModelConfig(
      {
        customOption: true,
        models: [existingModel],
      },
      {
        baseUrl: "https://api.minimaxi.com/v1",
        apiKey: "new-key",
        api: "openai-completions",
        modelName: "MiniMax-M3",
      },
    );

    expect(result.customOption).toBe(true);
    expect(result.models).toEqual([
      existingModel,
      {
        id: "MiniMax-M3",
        name: "MiniMax-M3",
        input: ["text", "image"],
      },
    ]);
  });
});

describe("buildManagedProviderConfigs", () => {
  it("groups models while preserving provider and model extensions", () => {
    const existingProviders = {
      qwen: {
        baseUrl: "https://old.example/v1",
        apiKey: "old-key",
        api: "openai-completions",
        headers: { "X-Custom": "value" },
        timeout: 30_000,
        models: [
          {
            id: "qwen3.7-plus",
            name: "Old Plus",
            input: ["text"],
            reasoning: true,
            contextWindow: 128_000,
          },
          {
            id: "qwen3-32b",
            name: "Old 32B",
            input: ["text"],
            contextWindow: 32_000,
          },
        ],
      },
    };

    const result = buildManagedProviderConfigs(existingProviders, [
      {
        providerKey: "qwen",
        baseUrl: "https://new.example/v1",
        apiKey: "new-key",
        api: "openai-completions",
        id: "qwen3.7-plus",
        name: "Qwen Plus",
        reasoning: false,
        input: ["text", "image"],
      },
      {
        providerKey: "qwen",
        baseUrl: "https://new.example/v1",
        apiKey: "new-key",
        api: "openai-completions",
        id: "qwen3-32b",
        name: "Qwen 32B",
        reasoning: true,
        input: ["text", "image"],
      },
    ]);

    expect(result.qwen).toEqual({
      ...existingProviders.qwen,
      baseUrl: "https://new.example/v1",
      apiKey: "new-key",
      models: [
        {
          id: "qwen3.7-plus",
          name: "Qwen Plus",
          input: ["text", "image"],
          contextWindow: 128_000,
        },
        {
          id: "qwen3-32b",
          name: "Qwen 32B",
          input: ["text", "image"],
          reasoning: true,
          contextWindow: 32_000,
        },
      ],
    });
  });

  it("removes models and providers no longer managed by settings", () => {
    const result = buildManagedProviderConfigs(
      {
        qwen: {
          customOption: true,
          models: [{ id: "qwen3.7-plus" }, { id: "qwen3-32b" }],
        },
        removed: {
          models: [{ id: "removed-model" }],
        },
      },
      [
        {
          providerKey: "qwen",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          apiKey: "key",
          api: "openai-completions",
          id: "qwen3.7-plus",
          name: "Qwen Plus",
          reasoning: false,
          input: ["text", "image"],
        },
      ],
    );

    expect(Object.keys(result)).toEqual(["qwen"]);
    expect(result.qwen.customOption).toBe(true);
    expect(result.qwen.models).toEqual([
      {
        id: "qwen3.7-plus",
        name: "Qwen Plus",
        input: ["text", "image"],
      },
    ]);
  });
});
