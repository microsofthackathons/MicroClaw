import type { ChatEventPayload } from "./gateway-client";

export interface ChatSessionRuntime {
  key: string;
  hasActiveRun: boolean;
  activeRunIds: string[];
  status?: string;
  lastRunId?: string;
  lastRunError?: string;
  startedAt?: number;
}

export function agentRunLifecycleEvent(value: unknown): ChatEventPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    !("stream" in value) ||
    value.stream !== "lifecycle" ||
    !("runId" in value) ||
    typeof value.runId !== "string" ||
    !value.runId ||
    !("sessionKey" in value) ||
    typeof value.sessionKey !== "string" ||
    !value.sessionKey ||
    !("data" in value) ||
    !value.data ||
    typeof value.data !== "object"
  )
    return null;
  const data = value.data;
  if (
    !("phase" in data) ||
    (data.phase !== "start" && data.phase !== "end" && data.phase !== "error")
  )
    return null;
  return {
    sessionKey: value.sessionKey,
    runId: value.runId,
    state: "status",
    lifecyclePhase: data.phase,
    ...(data.phase === "error" && "error" in data && typeof data.error === "string"
      ? { errorMessage: data.error }
      : {}),
  };
}
