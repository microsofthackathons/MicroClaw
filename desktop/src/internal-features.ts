export interface InternalFeatures {
  readonly githubCopilot: boolean;
}

export const INTERNAL_GITHUB_COPILOT_ARGUMENT = "--microclaw-internal-github-copilot";

export function readInternalFeatures(
  environment: Record<string, string | undefined>,
): InternalFeatures {
  return Object.freeze({ githubCopilot: environment.MICROCLAW_INTERNAL_GITHUB_COPILOT === "1" });
}

export function assertGitHubCopilotEnabled(enabled = false): void {
  if (!enabled) throw new Error("GitHub Copilot is disabled. Choose another model provider.");
}

export function assertModelProviderEnabled(modelRef: unknown, githubCopilotEnabled = false): void {
  if (typeof modelRef === "string" && modelRef.trim().startsWith("github-copilot/")) {
    assertGitHubCopilotEnabled(githubCopilotEnabled);
  }
}
