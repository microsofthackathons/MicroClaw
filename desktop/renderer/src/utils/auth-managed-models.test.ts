import { describe, expect, it } from "vitest";
import {
  mergeGitHubCopilotModelEntries,
  removeGitHubCopilotModelReferences,
} from "./auth-managed-models";

describe("mergeGitHubCopilotModelEntries", () => {
  it("adds authenticated models without replacing managed or custom models", () => {
    const result = mergeGitHubCopilotModelEntries(
      [
        {
          providerKey: "qwen",
          id: "qwen3.7-plus",
          name: "Qwen",
          source: "managed" as const,
        },
        {
          providerKey: "custom",
          id: "gpt-5.4",
          name: "Custom GPT",
          source: "custom" as const,
        },
        {
          providerKey: "github-copilot",
          id: "old-model",
          name: "Current Copilot model",
          source: "auth-managed" as const,
        },
      ],
      [
        { id: "github-copilot/gpt-5.4", name: "GPT-5.4" },
        { id: "github-copilot/claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
      ],
    );

    expect(result.map((model) => `${model.providerKey}/${model.id}`)).toEqual([
      "qwen/qwen3.7-plus",
      "custom/gpt-5.4",
      "github-copilot/gpt-5.4",
      "github-copilot/claude-sonnet-4.6",
      "github-copilot/old-model",
    ]);
  });
});

describe("removeGitHubCopilotModelReferences", () => {
  it("removes only default Copilot references and promotes a safe fallback", () => {
    const config = {
      models: {
        providers: {
          custom: { models: [{ id: "model-a" }] },
          "github-copilot": { extension: "preserve" },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "github-copilot/claude-sonnet-4.6",
            fallbacks: ["github-copilot/gpt-5.4", "custom/model-a"],
          },
          models: {
            "github-copilot/claude-sonnet-4.6": {},
            "custom/model-a": { alias: "local" },
          },
        },
        list: [{ id: "worker", model: "github-copilot/gpt-5.4" }],
      },
      channels: {
        modelByChannel: { slack: { default: "github-copilot/gpt-5.4" } },
      },
      hooks: {
        mappings: [{ model: "github-copilot/gpt-5.4" }],
      },
    };

    expect(removeGitHubCopilotModelReferences(config, "custom/model-a")).toEqual({
      models: config.models,
      agents: {
        defaults: {
          model: {
            primary: "custom/model-a",
            fallbacks: ["github-copilot/gpt-5.4", "custom/model-a"],
          },
          models: {
            "custom/model-a": { alias: "local" },
          },
        },
        list: [{ id: "worker", model: "github-copilot/gpt-5.4" }],
      },
      channels: config.channels,
      hooks: config.hooks,
    });
    expect(config.agents.defaults.model.primary).toBe("github-copilot/claude-sonnet-4.6");
  });

  it("leaves unrelated configuration unchanged when defaults are absent", () => {
    const config = {
      channels: { modelByChannel: { telegram: { user: "github-copilot/gpt-5.4" } } },
      hooks: { mappings: [{ model: "github-copilot/gpt-5.4" }] },
    };
    expect(removeGitHubCopilotModelReferences(config)).toEqual(config);
  });
});
