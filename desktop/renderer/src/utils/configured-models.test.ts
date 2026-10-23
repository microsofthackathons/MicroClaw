import { describe, expect, it } from "vitest";
import { getModelRef, readConfiguredModels } from "./configured-models";

describe("readConfiguredModels", () => {
  it("shares exact configured model references and preserves editable custom metadata", () => {
    const result = readConfiguredModels({
      models: {
        providers: {
          private: {
            api: "openai-responses",
            baseUrl: "http://127.0.0.1:1234/v1",
            models: [{ id: "vendor/model", name: "Local API", input: ["text", "image"] }],
          },
        },
      },
      agents: {
        defaults: {
          model: "private/vendor/model",
          models: { "github-copilot/gpt": { alias: "My Copilot" } },
        },
      },
    });
    expect(result.primary).toBe("private/vendor/model");
    expect(getModelRef(result.models[0])).toBe("private/vendor/model");
    expect(result.models[0]).toMatchObject({
      apiFormat: "openai-responses",
      reasoningEffort: "low",
      input: ["text", "image"],
    });
    expect(result.models[1]).toMatchObject({
      id: "gpt",
      name: "My Copilot",
      source: "auth-managed",
    });
  });
  it("never invents a first default or rows for malformed model IDs", () => {
    const result = readConfiguredModels({
      models: { providers: { cloud: { models: [{}, { id: 123 }, { id: "real" }] } } },
    });
    expect(result.primary).toBe("");
    expect(result.models).toHaveLength(1);
    expect(readConfiguredModels(null).models).toEqual([]);
  });
});
