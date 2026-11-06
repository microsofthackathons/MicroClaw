import { describe, expect, it } from "vitest";
import { assertGitHubCopilotEnabled, readInternalFeatures } from "./internal-features";

describe("internal GitHub Copilot feature", () => {
  it.each([undefined, "", "0", "false", "true", "yes", " 1 "])("defaults off for %j", (value) => {
    const features = readInternalFeatures({ MICROCLAW_INTERNAL_GITHUB_COPILOT: value });
    expect(features.githubCopilot).toBe(false);
    expect(Object.isFrozen(features)).toBe(true);
    expect(() => assertGitHubCopilotEnabled(features.githubCopilot)).toThrow(
      "GitHub Copilot setup is disabled",
    );
  });

  it("requires the exact internal opt-in flag", () => {
    expect(readInternalFeatures({})).toEqual({ githubCopilot: false });
    expect(readInternalFeatures({ NODE_ENV: "development" }).githubCopilot).toBe(false);
    const features = readInternalFeatures({ MICROCLAW_INTERNAL_GITHUB_COPILOT: "1" });
    expect(features.githubCopilot).toBe(true);
    expect(() => assertGitHubCopilotEnabled(features.githubCopilot)).not.toThrow();
  });

  it("requires explicit opt-in for the desktop sign-in entry point", () => {
    expect(() => assertGitHubCopilotEnabled()).toThrow("GitHub Copilot setup is disabled");
  });
});
