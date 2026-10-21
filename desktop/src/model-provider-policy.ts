export function isModelProviderSupported(providerId: string): boolean {
  return providerId !== "github-copilot";
}

export function assertModelProviderSupported(modelRef: unknown): void {
  if (typeof modelRef === "string" && !isModelProviderSupported(modelRef.trim().split("/", 1)[0])) {
    throw new Error("GitHub Copilot is not supported. Choose another model provider.");
  }
}
