export function isGitHubCopilotEnabled(): boolean {
  return window.openclaw?.features?.githubCopilot === true;
}

export function isModelProviderEnabled(providerId: string): boolean {
  return providerId !== "github-copilot" || isGitHubCopilotEnabled();
}
