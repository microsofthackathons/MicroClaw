import { describe, expect, it } from "vitest";
import {
  assertGitHubCopilotEnabled,
  assertModelProviderEnabled,
  readInternalFeatures,
} from "./internal-features";

describe("internal GitHub Copilot feature", () => {
  it.each([undefined, "", "0", "false", "true", "yes", " 1 "])("defaults off for %j", (value) => {
    const features = readInternalFeatures({ MICROCLAW_INTERNAL_GITHUB_COPILOT: value });
    expect(features.githubCopilot).toBe(false);
    expect(Object.isFrozen(features)).toBe(true);
    expect(() => assertGitHubCopilotEnabled(features.githubCopilot)).toThrow(
      "GitHub Copilot is disabled",
    );
  });

  it("requires the exact internal opt-in flag", () => {
    expect(readInternalFeatures({})).toEqual({ githubCopilot: false });
    expect(readInternalFeatures({ NODE_ENV: "development" }).githubCopilot).toBe(false);
    const features = readInternalFeatures({ MICROCLAW_INTERNAL_GITHUB_COPILOT: "1" });
    expect(features.githubCopilot).toBe(true);
    expect(() =>
      assertModelProviderEnabled("github-copilot/gpt-5", features.githubCopilot),
    ).not.toThrow();
  });

  it("rejects disabled models while preserving cloud/local choices and empty selections", () => {
    expect(() => assertGitHubCopilotEnabled()).toThrow("GitHub Copilot is disabled");
    expect(() => assertModelProviderEnabled("github-copilot/gpt-5")).toThrow(
      "GitHub Copilot is disabled",
    );
    for (const modelRef of [undefined, null, "", "qwen/qwen", "llama-cpp/qwen", "custom/model"]) {
      expect(() => assertModelProviderEnabled(modelRef)).not.toThrow();
    }
  });
});
