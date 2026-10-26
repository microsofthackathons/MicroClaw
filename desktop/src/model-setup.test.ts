import { describe, expect, it } from "vitest";
import { assertModelConfigUnchanged, hasConfiguredModel } from "./model-setup";

describe("assertModelConfigUnchanged", () => {
  it("accepts first-run normalization and an unchanged existing configuration", () => {
    expect(() => assertModelConfigUnchanged({}, null)).not.toThrow();
    expect(() =>
      assertModelConfigUnchanged({ gateway: { port: 18789 } }, { gateway: { port: 18789 } }),
    ).not.toThrow();
  });

  it("rejects a stale snapshot after an official provider setup writes configuration", () => {
    expect(() =>
      assertModelConfigUnchanged(
        {},
        {
          models: { providers: { "llama-cpp": { localService: { command: "C:\\server.exe" } } } },
        },
      ),
    ).toThrow("changed while editing");
  });
});

describe("hasConfiguredModel", () => {
  it("recognizes an explicit custom provider", () => {
    expect(
      hasConfiguredModel({
        models: { providers: { minimax: { models: [{ id: "MiniMax-M1" }] } } },
      }),
    ).toBe(true);
  });

  it("recognizes GitHub Copilot selected with either supported primary shape", () => {
    expect(
      hasConfiguredModel(
        {
          agents: { defaults: { model: { primary: "github-copilot/claude-opus-4.8" } } },
        },
        true,
      ),
    ).toBe(true);
    expect(
      hasConfiguredModel(
        {
          agents: { defaults: { model: "github-copilot/gpt-5.4" } },
        },
        true,
      ),
    ).toBe(true);
  });

  it("does not treat an empty provider map or unrelated primary as configured", () => {
    expect(hasConfiguredModel({ models: { providers: {} } })).toBe(false);
    expect(
      hasConfiguredModel({
        agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      }),
    ).toBe(false);
  });

  it("does not treat disabled Copilot-only configuration as a usable model", () => {
    const config = {
      models: { providers: { "github-copilot": { models: [{ id: "gpt-5" }] } } },
      agents: { defaults: { model: "github-copilot/gpt-5" } },
    };
    expect(hasConfiguredModel(config)).toBe(false);
    expect(hasConfiguredModel(config, true)).toBe(true);
  });
});
