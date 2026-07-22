import { describe, expect, it } from "vitest";
import { buildSettingsModelConfig, type SettingsModelEntry } from "./model-settings-config";

const siblings: SettingsModelEntry[] = [
  {
    providerKey: "custom",
    id: "model-a",
    name: "Model A",
    baseUrl: "https://example.com/v1",
    apiKey: "${MODEL_API_KEY}",
    apiFormat: "openai-chat",
    reasoningEffort: "off",
    input: ["text"],
  },
  {
    providerKey: "custom",
    id: "model-b",
    name: "Model B",
    baseUrl: "https://example.com/v1",
    apiKey: "${MODEL_API_KEY}",
    apiFormat: "openai-chat",
    reasoningEffort: "low",
    input: ["text", "image"],
  },
];

describe("buildSettingsModelConfig", () => {
  it("groups sibling models under one provider", () => {
    const result = buildSettingsModelConfig(siblings, {}, {});

    expect(result.providers).toEqual({
      custom: {
        baseUrl: "https://example.com/v1",
        apiKey: "${MODEL_API_KEY}",
        api: "openai-completions",
        models: [
          { id: "model-a", name: "Model A", input: ["text"] },
          {
            id: "model-b",
            name: "Model B",
            reasoning: true,
            input: ["text", "image"],
          },
        ],
      },
    });
  });

  it("preserves unrelated params while updating only thinking", () => {
    const result = buildSettingsModelConfig(
      siblings,
      { custom: {} },
      {
        "custom/model-a": {
          params: { temperature: 0.2, thinking: "high" },
          alias: "fast",
        },
        "custom/model-b": {
          params: { temperature: 0.4 },
        },
        "unmanaged/model": {
          params: { temperature: 0.6 },
        },
      },
    );

    expect(result.modelDefaults).toEqual({
      "custom/model-a": {
        params: { temperature: 0.2 },
        alias: "fast",
      },
      "custom/model-b": {
        params: { temperature: 0.4, thinking: "low" },
      },
      "unmanaged/model": {
        params: { temperature: 0.6 },
      },
    });
  });

  it("drops defaults only for models removed from a managed provider", () => {
    const result = buildSettingsModelConfig(
      [siblings[0]],
      { custom: {} },
      {
        "custom/model-a": { params: { temperature: 0.2 } },
        "custom/model-b": { params: { temperature: 0.4 } },
      },
    );

    expect(result.modelDefaults).toEqual({
      "custom/model-a": { params: { temperature: 0.2 } },
    });
  });

  it("preserves provider and model extensions while updating managed fields", () => {
    const result = buildSettingsModelConfig(
      siblings,
      {
        custom: {
          headers: { "X-Custom": "value" },
          models: [
            {
              id: "model-a",
              name: "Old Model A",
              input: ["text"],
              contextWindow: 128_000,
            },
          ],
        },
      },
      {},
    );

    expect(result.providers.custom).toMatchObject({
      headers: { "X-Custom": "value" },
      models: [
        {
          id: "model-a",
          name: "Model A",
          input: ["text"],
          contextWindow: 128_000,
        },
        {
          id: "model-b",
          name: "Model B",
          input: ["text", "image"],
        },
      ],
    });
  });
});
