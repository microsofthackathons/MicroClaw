import { describe, expect, it } from "vitest";
import {
  getCredentialReferenceName,
  isValidHttpUrl,
  mergeModelProviderConfig,
  normalizeModelInput,
  resolveApiValue,
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
          models: existingModels,
        },
      },
    });
  });
});
