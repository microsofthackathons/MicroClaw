import type { ChatEventPayload } from "./gateway-client";

interface ChatSessionRuntimeBase {
  key: string;
  status?: string;
  lastRunId?: string;
  lastRunError?: string;
  startedAt?: number;
}

export type ChatSessionRuntime = ChatSessionRuntimeBase &
  (
    | { hasActiveRun: boolean; activeRunIds: string[] }
    | { hasActiveRun: true; activeRunIds?: never }
  );

export function isChatSessionRuntime(value: unknown, key: string): value is ChatSessionRuntime {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("key" in value) ||
    value.key !== key ||
    !("hasActiveRun" in value) ||
    typeof value.hasActiveRun !== "boolean"
  )
    return false;
  if (!Object.hasOwn(value, "activeRunIds")) return value.hasActiveRun;
  const ids = "activeRunIds" in value ? value.activeRunIds : undefined;
  return (
    Array.isArray(ids) &&
    ids.every((id: unknown) => typeof id === "string" && id.length > 0 && id.trim() === id) &&
    new Set(ids).size === ids.length &&
    value.hasActiveRun === ids.length > 0
  );
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
