import { describe, expect, it } from "vitest";
import { hasConfiguredModel } from "./model-setup";

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
      hasConfiguredModel({
        agents: { defaults: { model: { primary: "github-copilot/claude-opus-4.8" } } },
      }),
    ).toBe(true);
    expect(
      hasConfiguredModel({
        agents: { defaults: { model: "github-copilot/gpt-5.4" } },
      }),
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
});
