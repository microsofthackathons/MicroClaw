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
  if (!enabled)
    throw new Error("GitHub Copilot setup is disabled. Enable the internal feature to sign in.");
}
