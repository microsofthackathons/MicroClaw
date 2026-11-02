import { describe, expect, it } from "vitest";
import {
  ensureGitHubCopilotProviderPlugin,
  ensureSelectedModelProviderPlugins,
} from "./model-provider-plugins";

describe("ensureSelectedModelProviderPlugins", () => {
  it.each([
    { defaults: { model: "github-copilot/gpt-6.1-sol" } },
    { defaults: { model: { primary: "github-copilot/gpt-6.1-sol" } } },
    {
      defaults: {
        model: { primary: "qwen/qwen3.7-plus", fallbacks: ["github-copilot/gpt-6.1-sol"] },
      },
    },
    { list: [{ id: "main", model: "github-copilot/gpt-6.1-sol" }] },
    { entries: { main: { model: { primary: "github-copilot/gpt-6.1-sol" } } } },
  ])(
    "prepares Copilot for configured default, fallback, and agent model references: %j",
    (agents) => {
      const config = { agents };

      expect(ensureSelectedModelProviderPlugins(config)).toBe(true);
      expect(config).toMatchObject({
        plugins: {
          allow: ["github-copilot"],
          entries: { "github-copilot": { enabled: true } },
        },
      });
      expect(ensureSelectedModelProviderPlugins(config)).toBe(false);
    },
  );

  it("enables the bundled GitHub Copilot plugin for a selected Copilot model", () => {
    const config = {
      agents: { defaults: { model: { primary: "github-copilot/gpt-5.4" } } },
      plugins: {
        allow: ["memory-core"],
        deny: ["github-copilot", "other-plugin"],
        entries: { "other-plugin": { enabled: true } },
      },
    };

    expect(ensureSelectedModelProviderPlugins(config)).toBe(true);
    expect(config.plugins).toEqual({
      allow: ["memory-core", "github-copilot"],
      deny: ["other-plugin"],
      entries: {
        "other-plugin": { enabled: true },
        "github-copilot": { enabled: true },
      },
    });
    expect(ensureSelectedModelProviderPlugins(config)).toBe(false);
  });

  it("does not change plugins for models that do not need one", () => {
    const config = {
      agents: { defaults: { model: "qwen/qwen3.7-plus" } },
    };

    expect(ensureSelectedModelProviderPlugins(config)).toBe(false);
    expect(config).not.toHaveProperty("plugins");
  });

  it("can explicitly prepare Copilot before it becomes the selected model", () => {
    const config = { agents: { defaults: { model: "qwen/qwen3.7-plus" } } };
    expect(ensureGitHubCopilotProviderPlugin(config)).toBe(true);
    expect(config).toMatchObject({
      plugins: {
        allow: ["github-copilot"],
        entries: { "github-copilot": { enabled: true } },
      },
    });
  });
});
