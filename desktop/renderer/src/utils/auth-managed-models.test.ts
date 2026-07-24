import { describe, expect, it } from "vitest";
import { mergeGitHubCopilotModelEntries } from "./auth-managed-models";

describe("mergeGitHubCopilotModelEntries", () => {
  it("adds the authenticated catalog without replacing config-managed models", () => {
    const result = mergeGitHubCopilotModelEntries(
      [
        {
          providerKey: "custom",
          id: "gpt-5.4",
          name: "Custom GPT",
          source: "config-managed" as const,
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
      "custom/gpt-5.4",
      "github-copilot/gpt-5.4",
      "github-copilot/claude-sonnet-4.6",
      "github-copilot/old-model",
    ]);
    expect(result.filter((model) => model.source === "auth-managed")).toHaveLength(3);
  });
});
