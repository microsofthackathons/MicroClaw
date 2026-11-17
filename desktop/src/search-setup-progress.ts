export type SearchSetupStage = "preparing" | "fetching" | "installing" | "activating" | "verifying";

export interface SearchSetupProgress {
  requestId: string;
  stage: SearchSetupStage;
}

export interface SearchSettingsWriteIntent {
  kind: "search-settings";
  requestId?: string;
}

// Only report observed activities; completion of one activity does not start the next.
export function searchInstallStage(payload: unknown): SearchSetupStage | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const event = payload as Record<string, unknown>;
  if (event.status !== "started") return;
  switch (event.stage) {
    case "resolve":
      return "fetching";
    case "files":
    case "dependencies":
    case "scan":
      return "installing";
    case "runtime":
      return "activating";
  }
}
