import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import { useSessionStore } from "./sessions";
import { redactPii } from "@/utils/pii-scanner";
import { hydratePrivacyControls, privacyControlsToScanOptions } from "@/utils/privacy-settings";
import { canonicalAgentId } from "../../../src/agent-catalog";
import { ChatRunTracker } from "./chat-run-tracker";
import type { WindowsNodeMxcApprovalActivity } from "../../../src/windows-node-mxc";

/**
 * Chat store — mirrors the webchat gateway protocol.
 *
 * Key differences from the old HTTP/SSE approach:
 * - Server (gateway) keeps the full conversation history per sessionKey.
 * - We only send the message text, not the full history.
 * - Streaming arrives as `chat` events (delta / final / aborted / error).
 * - `loadHistory` fetches persisted messages from the server.
 */

export interface ChatMessage {
  role: string;
  content: unknown; // string or content-block array
  timestamp?: number;
  text?: string;
  attachments?: ChatAttachment[];
  originalText?: string;
  stopReason?: string;
}

/**
 * Structured chat error.  `code` is a stable identifier the UI can translate
 * into a friendly message; `raw` preserves the original error text for
 * debugging / "show details".
 */
export interface ChatErrorInfo {
  code:
    | "not_found" // 404 — likely wrong Base URL / endpoint path
    | "copilot_auth" // GitHub login could not be exchanged for a Copilot API token
    | "missing_provider_auth" // current model provider has no usable credentials
    | "unauthorized" // 401 / invalid api key
    | "provider_access" // 403 or upstream-normalized authentication/authorization rejection
    | "unsupported_model"
    | "request_rejected"
    | "rate_limited" // 429
    | "model_not_found" // model name typo
    | "network" // ECONNREFUSED / ENOTFOUND / timeout
    | "response_delayed" // UI inactivity estimate, not a reported model/network failure
    | "empty_response" // server responded but message was blank (often bad key/model)
    | "server_error" // 5xx
    | "aborted"
    | "generic";
  raw?: string;
  /** HTTP status code when discernible from the raw error string. */
  status?: number;
  source?: "watchdog";
}

function isInferredWaitError(error: ChatErrorInfo | null): boolean {
  return (
    error?.source === "watchdog" ||
    (error?.code === "network" && error.raw === undefined && error.status === undefined)
  );
}

/**
 * Classify a raw error string (from gateway / model provider) into a stable
 * code that the UI can translate.  The heuristics are intentionally generous
 * because different providers format errors differently.
 */
export function classifyChatError(raw: string | null | undefined): ChatErrorInfo {
  const text = (raw ?? "").toString();
  const lower = text.toLowerCase();
  const statusMatch = text.match(/\b(4\d{2}|5\d{2})\b\s*(status\s*code|status|error)?/i);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;

  if (/missing-provider-auth/i.test(text) || /no api key found for provider/i.test(text)) {
    return { code: "missing_provider_auth", raw: text, status };
  }
  if (/copilot token exchange failed/i.test(text)) {
    return { code: "copilot_auth", raw: text, status };
  }
  if (/UNSUPPORTED_CHAT_MODEL/.test(text)) return { code: "unsupported_model", raw: text, status };
  if (
    status === 403 ||
    /forbidden|access[_ .-]*denied|couldn['’]t sign in to the ai service/i.test(text)
  )
    return { code: "provider_access", raw: text, status };
  if (status === 404 || /\b404\b/.test(text) || /not\s*found/i.test(text)) {
    if (/model/i.test(text)) return { code: "model_not_found", raw: text, status };
    return { code: "not_found", raw: text, status };
  }
  if (
    status === 401 ||
    /\b401\b/.test(text) ||
    /unauthorized|invalid[_\s-]*api[_\s-]*key|incorrect api key|authentication/i.test(lower)
  ) {
    return { code: "unauthorized", raw: text, status };
  }
  if (status === 400 || status === 422 || /ai service couldn['’]t accept this request/i.test(text))
    return { code: "request_rejected", raw: text, status };
  if (
    status === 429 ||
    /\b429\b/.test(text) ||
    /rate[_\s-]*limit|too many requests|quota/i.test(lower)
  ) {
    return { code: "rate_limited", raw: text, status };
  }
  if (
    /econnrefused|enotfound|eai_again|etimedout|network|fetch failed|socket hang up|getaddrinfo/i.test(
      lower,
    )
  ) {
    return { code: "network", raw: text, status };
  }
  if (
    (status && status >= 500 && status < 600) ||
    /\b5\d{2}\b|internal server error|bad gateway|service unavailable/i.test(lower)
  ) {
    return { code: "server_error", raw: text, status };
  }
  if (/aborted|cancell?ed/i.test(lower)) {
    return { code: "aborted", raw: text, status };
  }
  return { code: "generic", raw: text, status };
}

export function requiresModelAuthRecovery(error: ChatErrorInfo | null): boolean {
  return error?.code === "missing_provider_auth" || error?.code === "copilot_auth";
}

export function modelAuthRecoveryInitialFamily(
  error: ChatErrorInfo | null,
): "github-copilot" | undefined {
  return error?.code === "copilot_auth" ? "github-copilot" : undefined;
}

export function applyChatDelta(
  current: string,
  payload: ChatEventPayload,
  legacyText: string | null = null,
): string {
  if (typeof payload.deltaText === "string") {
    return payload.replace ? payload.deltaText : current + payload.deltaText;
  }
  if (typeof legacyText === "string" && (!current || legacyText.length >= current.length)) {
    return legacyText;
  }
  return current;
}

export const useChatStore = defineStore("chat", () => {
  // ── State ──
  const sessionKey = ref("main");
  /** The resolved session key returned by the gateway (may differ from what we send). */
  const resolvedSessionKey = ref<string | null>(null);
  const messages = ref<ChatMessage[]>([]);
  const loading = ref(false);
  const sending = ref(false);
  const streaming = ref(false);
  const sessionTitleRefreshRevision = ref(0);
  const streamText = ref("");
  const streamToolCalls = ref<
    {
      id: string;
      name: string;
      input?: string;
      done: boolean;
      waitingPermission?: boolean;
      kind?: "approval";
      actualCommand?: string;
      result?: string;
      isError?: boolean;
    }[]
  >([]);
  /**
   * Offset into streamText where the model's own reply begins.
   * Everything before this offset is tool-call context (system prompt echo,
   * tool inputs/outputs) and should be hidden from the chat bubble.
   * Reset to 0 when a new message cycle starts.
   */
  const streamTextOffset = ref(0);
  /** Whether we are currently in a tool-execution phase (at least one tool started, not all done yet). */
  const _toolPhaseActive = ref(false);
  /**
   * Completed tool calls keyed by assistant response count.
   * Key = number of assistant messages at time of completion.
   * Survives loadHistory since it's independent of messages[].
   */
  const completedToolCallsMap = ref<
    Record<
      number,
      {
        id: string;
        name: string;
        input?: string;
        actualCommand?: string;
        result?: string;
        isError?: boolean;
      }[]
    >
  >({});
  const streamStartedAt = ref<number | null>(null);
  const chatRunId = ref<string | null>(null);
  const lastError = ref<ChatErrorInfo | null>(null);
  const wsConnected = ref(false);
  const mainSessionKey = ref<string | null>(null);
  /** Timestamp of the last streaming event (delta, tool, final). Used for stale-stream detection. */
  const lastStreamEventAt = ref<number | null>(null);

  /** Prompt text to pre-fill in the chat input after navigation. */
  const pendingPrompt = ref<string | null>(null);
  const pendingSessionAgentId = ref<string | undefined>(undefined);

  /**
   * The agent bound to the currently-active session.
   * New sessions encode their agent as `agent:<id>:...`; legacy bare keys
   * fall back to the pending agent or the default (main) agent.
   */
  const currentSessionAgentId = computed(() => {
    const match = /^agent:([^:]+):/.exec(sessionKey.value);
    if (match) return canonicalAgentId(match[1]);
    return pendingSessionAgentId.value || "main";
  });

  /** Per-agent last message preview text */
  const lastMessageMap = ref<Record<string, string>>({});

  // ── Per-session streaming state cache ──
  // When switching away from a session that is still streaming,
  // we save its streaming state here so it can be restored later.
  interface SessionStreamState {
    streaming: boolean;
    streamText: string;
    streamToolCalls: {
      id: string;
      name: string;
      input?: string;
      done: boolean;
      waitingPermission?: boolean;
      kind?: "approval";
      actualCommand?: string;
      result?: string;
      isError?: boolean;
    }[];
    completedToolCallsMap: Record<
      number,
      {
        id: string;
        name: string;
        input?: string;
        actualCommand?: string;
        result?: string;
        isError?: boolean;
      }[]
    >;
    streamStartedAt: number | null;
    chatRunId: string | null;
    lastStreamEventAt: number | null;
    resolvedSessionKey: string | null;
    messages: ChatMessage[];
    sending: boolean;
  }
  const sessionStateCache = new Map<string, SessionStreamState>();
  const serverRuns = new ChatRunTracker();
  const gatewayGeneration = ref<string | null>(null);
  const runtimeUiRevision = ref(0);
  const approvalActivities = ref<
    Record<
      string,
      WindowsNodeMxcApprovalActivity & {
        expiresAtUnixMs?: number;
        label: string;
        pending: boolean;
      }
    >
  >({});
  const approvalToolId = (id: string) => `mxc-approval:gateway:${id}`;

  function currentRunActivities() {
    const key = resolvedSessionKey.value || sessionKey.value;
    return Object.entries(approvalActivities.value).filter(
      ([, activity]) =>
        activity.gatewayGeneration === gatewayGeneration.value &&
        activity.sessionKey === key &&
        !serverRuns.isClosed(key, activity.runId) &&
        (!chatRunId.value ||
          serverRuns.isClosed(key, chatRunId.value) ||
          chatRunId.value === activity.runId),
    );
  }

  const activityStatus = computed<
    "waiting-approval" | "running-tool" | "working" | "connection-unknown" | null
  >(() => {
    void runtimeUiRevision.value;
    const activities = currentRunActivities();
    const waitingApproval = activities.some(
      ([, activity]) =>
        activity.pending &&
        (activity.expiresAtUnixMs === undefined || activity.expiresAtUnixMs > Date.now()),
    );
    if (!wsConnected.value && (activities.length || streaming.value)) return "connection-unknown";
    if (waitingApproval) return "waiting-approval";
    if (!streaming.value && !activities.length) return null;
    return streaming.value &&
      streamToolCalls.value.some((tool) => !tool.done && tool.kind !== "approval")
      ? "running-tool"
      : "working";
  });

  function synchronizeApprovalRows() {
    for (const [id, activity] of Object.entries(approvalActivities.value)) {
      if (serverRuns.isClosed(activity.sessionKey, activity.runId)) retireApprovalActivity(id);
    }
    const approvals = currentRunActivities().filter(
      ([, activity]) =>
        activity.pending &&
        (activity.expiresAtUnixMs === undefined || activity.expiresAtUnixMs > Date.now()),
    );
    const pendingIds = new Set(approvals.map(([id]) => approvalToolId(id)));
    const visible = streamToolCalls.value.filter(
      (tool) => tool.kind !== "approval" || tool.done || pendingIds.has(tool.id),
    );
    if (visible.length !== streamToolCalls.value.length) streamToolCalls.value = visible;
    if (!streaming.value) return;
    for (const [id, activity] of approvals) {
      const rowId = approvalToolId(id);
      if (!streamToolCalls.value.some((tool) => tool.id === rowId && tool.kind === "approval")) {
        streamToolCalls.value = [
          ...streamToolCalls.value,
          {
            id: rowId,
            name: activity.label,
            kind: "approval",
            done: false,
            waitingPermission: true,
          },
        ];
      }
    }
  }

  function trackApprovalActivity(
    id: string,
    activity: WindowsNodeMxcApprovalActivity,
    label: string,
    expiresAtUnixMs?: number,
  ) {
    if (
      activity.gatewayGeneration !== gatewayGeneration.value ||
      serverRuns.isClosed(activity.sessionKey, activity.runId) ||
      (expiresAtUnixMs !== undefined && expiresAtUnixMs <= Date.now()) ||
      approvalActivities.value[id]
    )
      return;
    approvalActivities.value = {
      ...approvalActivities.value,
      [id]: { ...activity, expiresAtUnixMs, label, pending: true },
    };
    // Reject pre-approval snapshots without inventing a run-start event or timestamp.
    serverRuns.invalidateSnapshot(activity.sessionKey);
    synchronizeApprovalRows();
  }

  function settleApprovalActivity(id: string, result?: string, isError?: boolean) {
    const activity = approvalActivities.value[id];
    // A decision ends the approval wait, not the originating run.
    if (activity)
      approvalActivities.value = {
        ...approvalActivities.value,
        [id]: { ...activity, pending: false },
      };
    const rowId = approvalToolId(id);
    completeToolCall(rowId, result, isError);
    const cached = activity && sessionStateCache.get(activity.sessionKey);
    if (cached) {
      cached.streamToolCalls = cached.streamToolCalls.map((tool) =>
        tool.id === rowId && tool.kind === "approval"
          ? {
              ...tool,
              done: true,
              waitingPermission: false,
              result: result ?? tool.result,
              isError: isError ?? tool.isError,
            }
          : tool,
      );
    }
  }

  function retireApprovalActivity(id: string) {
    settleApprovalActivity(id);
    const remaining = { ...approvalActivities.value };
    delete remaining[id];
    approvalActivities.value = remaining;
  }

  function clearApprovalActivities() {
    approvalActivities.value = {};
    const visible = streamToolCalls.value.filter((tool) => tool.kind !== "approval" || tool.done);
    if (visible.length !== streamToolCalls.value.length) streamToolCalls.value = visible;
    for (const state of sessionStateCache.values()) {
      const visibleCached = state.streamToolCalls.filter(
        (tool) => tool.kind !== "approval" || tool.done,
      );
      if (visibleCached.length !== state.streamToolCalls.length)
        state.streamToolCalls = visibleCached;
    }
  }

  function setGatewayGeneration(generation: string | null) {
    if (generation === gatewayGeneration.value) return;
    gatewayGeneration.value = generation;
    clearApprovalActivities();
    invalidateHistoryObservation();
  }

  function synchronizeServerRun(preferred?: string, authoritativeIdle = false) {
    runtimeUiRevision.value++;
    const key = resolvedSessionKey.value || sessionKey.value;
    const active = serverRuns.active(key, preferred || chatRunId.value);
    if (active) {
      if (!streaming.value || (chatRunId.value !== null && chatRunId.value !== active.id)) {
        streamText.value = "";
        streamTextOffset.value = 0;
        _toolPhaseActive.value = false;
        streamToolCalls.value = [];
      }
      chatRunId.value = active.id;
      streaming.value = true;
      streamStartedAt.value = active.startedAt;
      lastStreamEventAt.value = Date.now();
    } else if (
      authoritativeIdle ||
      (chatRunId.value && serverRuns.isClosed(key, chatRunId.value))
    ) {
      streaming.value = false;
      sending.value = false;
      streamStartedAt.value = null;
      lastStreamEventAt.value = null;
      if (authoritativeIdle) streamToolCalls.value = [];
    }
    synchronizeApprovalRows();
  }

  /** Move all renderer-owned state from a local alias to its Gateway key. */
  function _canonicalizeSessionKey(aliasKey: string, canonicalKey: string) {
    if (!aliasKey || aliasKey === canonicalKey) {
      if (sessionKey.value === canonicalKey) resolvedSessionKey.value = canonicalKey;
      return;
    }

    const aliasCache = sessionStateCache.get(aliasKey);
    if (aliasCache && !sessionStateCache.has(canonicalKey)) {
      sessionStateCache.set(canonicalKey, {
        ...aliasCache,
        resolvedSessionKey: canonicalKey,
      });
    }
    sessionStateCache.delete(aliasKey);

    if (lastMessageMap.value[aliasKey] && !lastMessageMap.value[canonicalKey]) {
      lastMessageMap.value[canonicalKey] = lastMessageMap.value[aliasKey];
    }
    delete lastMessageMap.value[aliasKey];

    useSessionStore().canonicalizeSession(aliasKey, canonicalKey);

    if (sessionKey.value === aliasKey) {
      sessionKey.value = canonicalKey;
      resolvedSessionKey.value = canonicalKey;
    }
  }

  /** Record and apply the canonical main-session identity from Gateway hello. */
  function setMainSessionKey(key: string) {
    mainSessionKey.value = key;
    _canonicalizeSessionKey("main", key);
    useSessionStore().reconcileEmptySessions(key, "main");
  }

  /** Save current session's volatile state into the cache. */
  function _saveCurrentState() {
    const key = sessionKey.value;
    if (!key) return;
    const hasCompletedTools = Object.keys(completedToolCallsMap.value).length > 0;
    const pendingTerminalOutput =
      chatRunId.value &&
      serverRuns.isClosed(resolvedSessionKey.value || key, chatRunId.value) &&
      !serverRuns.outputCommitted(resolvedSessionKey.value || key, chatRunId.value);
    if (streaming.value || sending.value || hasCompletedTools || pendingTerminalOutput) {
      sessionStateCache.set(key, {
        streaming: streaming.value,
        streamText: streamText.value,
        streamToolCalls: [...streamToolCalls.value],
        completedToolCallsMap: { ...completedToolCallsMap.value },
        streamStartedAt: streamStartedAt.value,
        chatRunId: chatRunId.value,
        lastStreamEventAt: lastStreamEventAt.value,
        resolvedSessionKey: resolvedSessionKey.value,
        messages: [...messages.value],
        sending: sending.value,
      });
    } else {
      sessionStateCache.delete(key);
    }
  }

  /** Restore a session's volatile state from the cache (returns true if restored). */
  function _restoreState(key: string): boolean {
    const cached = sessionStateCache.get(key);
    if (!cached) return false;
    streaming.value = cached.streaming;
    streamText.value = cached.streamText;
    streamToolCalls.value = cached.streamToolCalls ? [...cached.streamToolCalls] : [];
    completedToolCallsMap.value = cached.completedToolCallsMap
      ? { ...cached.completedToolCallsMap }
      : {};
    streamStartedAt.value = cached.streamStartedAt;
    chatRunId.value = cached.chatRunId;
    lastStreamEventAt.value = cached.lastStreamEventAt;
    resolvedSessionKey.value = cached.resolvedSessionKey;
    messages.value = cached.messages;
    sending.value = cached.sending;
    return true;
  }

  // ── Load-history sequence counter (discard stale results) ──
  let _loadSeq = 0;

  // ── Helpers ──

  /** Check if a message is a gateway system message (restart confirmations, doctor prompts). */
  function isGatewaySystemMessage(msg: unknown): boolean {
    const text = extractText(msg);
    if (!text) return false;
    return (
      /^System:/m.test(text) && /(gateway[.\s]restart|openclaw doctor|Gateway restart)/i.test(text)
    );
  }

  /**
   * Strip System: lines (gateway restart confirmations, doctor prompts) that
   * were injected into a user message by the gateway.  Returns the cleaned
   * text, or null if nothing remains after stripping.
   */
  function stripSystemLines(msg: unknown): unknown {
    const m = msg as Record<string, unknown>;
    const text = extractText(msg);
    if (!text) return msg;
    if (
      !/^System:/m.test(text) ||
      !/(gateway[.\s]restart|openclaw doctor|Gateway restart)/i.test(text)
    ) {
      return msg;
    }
    const cleaned = text
      .split(/\r?\n/)
      .filter(
        (line) =>
          !(
            /^System:/.test(line) &&
            /(gateway[.\s]restart|openclaw doctor|Gateway restart)/i.test(line)
          ),
      )
      .join("\n")
      .trim();
    if (!cleaned) return null; // entire message was system lines
    // Return a shallow copy with updated content
    if (typeof m.content === "string") {
      return { ...m, content: cleaned };
    }
    return { ...m, content: [{ type: "text", text: cleaned }] };
  }

  /** Wrap a string in a JSON code fence if it looks like a JSON object/array. */
  function wrapJsonIfNeeded(text: string): string {
    const trimmed = text.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        return "```json\n" + JSON.stringify(parsed, null, 2) + "\n```";
      } catch {
        /* not valid JSON, return as-is */
      }
    }
    return text;
  }

  function sanitizeUserAttachmentText(text: string): string {
    return text
      .replace(/^(?:\[media attached:[^\r\n]*\]\r?\n?)+/i, "")
      .replace(/<file\b[^>]*>[\s\S]*?<\/file>/gi, "")
      .trim();
  }

  function hasAttachmentEvidence(message: unknown): boolean {
    const m = message as Record<string, unknown>;
    if (
      (Array.isArray(m.attachments) && m.attachments.length > 0) ||
      (Array.isArray(m.MediaPaths) && m.MediaPaths.length > 0) ||
      typeof m.MediaPath === "string"
    ) {
      return true;
    }
    if (
      Array.isArray(m.content) &&
      m.content.some((candidate) => {
        if (!candidate || typeof candidate !== "object") return false;
        const block = candidate as Record<string, unknown>;
        return block.type === "image" || block.type === "file";
      })
    ) {
      return true;
    }
    const rawText =
      typeof m.content === "string"
        ? m.content
        : typeof m.text === "string"
          ? m.text
          : Array.isArray(m.content)
            ? m.content
                .filter(
                  (block): block is Record<string, unknown> => !!block && typeof block === "object",
                )
                .map((block) =>
                  block.type === "text" && typeof block.text === "string" ? block.text : "",
                )
                .join("\n")
            : "";
    return /^\[media attached:[^\r\n]*\]/i.test(rawText);
  }

  function extractText(message: unknown): string | null {
    const m = message as Record<string, unknown>;
    const isUserMessage = typeof m.role === "string" && m.role.toLowerCase() === "user";
    const shouldSanitize = isUserMessage && hasAttachmentEvidence(message);
    if (isUserMessage && typeof m.originalText === "string") return m.originalText;
    if (typeof m.content === "string") {
      return shouldSanitize ? sanitizeUserAttachmentText(m.content) : m.content;
    }
    if (typeof m.text === "string") {
      return shouldSanitize ? sanitizeUserAttachmentText(m.text) : m.text;
    }
    if (Array.isArray(m.content)) {
      const parts: string[] = [];
      for (const block of m.content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        } else if (block.type === "tool_use") {
          const name = typeof block.name === "string" ? block.name : "tool";
          let inputStr = "";
          if (block.input && typeof block.input === "object") {
            try {
              inputStr = JSON.stringify(block.input, null, 2);
            } catch {
              /* ignore */
            }
          }
          parts.push(`🔧 **${name}**${inputStr ? `\n\`\`\`json\n${inputStr}\n\`\`\`` : ""}`);
        } else if (block.type === "tool_result") {
          const content = block.content;
          if (typeof content === "string") {
            parts.push(wrapJsonIfNeeded(content));
          } else if (Array.isArray(content)) {
            for (const sub of content as Array<Record<string, unknown>>) {
              if (sub.type === "text" && typeof sub.text === "string") {
                parts.push(wrapJsonIfNeeded(sub.text));
              }
            }
          }
        }
      }
      if (parts.length === 0) return null;
      const text = parts.join("\n\n");
      return shouldSanitize ? sanitizeUserAttachmentText(text) : text;
    }
    return null;
  }

  function getMessageAttachments(message: unknown): ChatAttachment[] {
    const m = message as Record<string, unknown>;
    const mediaPaths = [
      ...(Array.isArray(m.MediaPaths) ? m.MediaPaths : []),
      ...(typeof m.MediaPath === "string" ? [m.MediaPath] : []),
    ];
    const mediaTypes = [
      ...(Array.isArray(m.MediaTypes) ? m.MediaTypes : []),
      ...(typeof m.MediaType === "string" ? [m.MediaType] : []),
    ];
    const optimisticAttachments = Array.isArray(m.attachments) ? m.attachments : [];
    const candidates =
      optimisticAttachments.length > 0
        ? optimisticAttachments
        : mediaPaths.length > 0
          ? mediaPaths.map((mediaPath, index) => {
              const mimeType =
                typeof mediaTypes[index] === "string"
                  ? (mediaTypes[index] as string)
                  : "application/octet-stream";
              const rawName =
                typeof mediaPath === "string"
                  ? mediaPath
                      .replace(/^media:\/\/inbound\//i, "")
                      .split(/[\\/]/)
                      .at(-1) || ""
                  : "";
              const extensionIndex = rawName.lastIndexOf(".");
              const nameWithoutExtension =
                extensionIndex > 0 ? rawName.slice(0, extensionIndex) : rawName;
              const isBareUuid =
                mimeType.startsWith("image/") &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                  nameWithoutExtension,
                );
              const displayName = mimeType.startsWith("image/")
                ? rawName
                : rawName.replace(
                    /---[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\.[^.]+$)/i,
                    "",
                  );
              return {
                type: mimeType.startsWith("image/") ? "image" : "file",
                mimeType,
                fileName: isBareUuid ? "" : displayName,
                size: 0,
                content: "",
                mediaPath: typeof mediaPath === "string" ? mediaPath : undefined,
              };
            })
          : Array.isArray(m.content)
            ? m.content
            : [];
    const attachments: ChatAttachment[] = [];

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const block = candidate as Record<string, unknown>;
      const source =
        block.source && typeof block.source === "object"
          ? (block.source as Record<string, unknown>)
          : undefined;
      const mimeType =
        (typeof block.mimeType === "string" && block.mimeType) ||
        (typeof block.media_type === "string" && block.media_type) ||
        (typeof source?.media_type === "string" && source.media_type) ||
        "";
      const blockType = typeof block.type === "string" ? block.type : "";
      if (!mimeType && blockType !== "image" && blockType !== "file") continue;
      const content =
        (typeof block.content === "string" && block.content) ||
        (typeof block.data === "string" && block.data) ||
        (typeof source?.data === "string" && source.data) ||
        "";
      attachments.push({
        type: mimeType.startsWith("image/") || blockType === "image" ? "image" : "file",
        mimeType: mimeType || "application/octet-stream",
        fileName:
          (typeof block.fileName === "string" && block.fileName) ||
          (typeof block.name === "string" && block.name) ||
          "",
        size: typeof block.size === "number" ? block.size : 0,
        content,
        mediaPath: typeof block.mediaPath === "string" ? block.mediaPath : undefined,
      });
    }

    return attachments.filter(
      (attachment, index) =>
        attachments.findIndex(
          (item) =>
            item.fileName === attachment.fileName &&
            item.mimeType === attachment.mimeType &&
            item.content === attachment.content &&
            item.mediaPath === attachment.mediaPath,
        ) === index,
    );
  }

  function preserveOptimisticAttachmentMetadata(
    currentMessages: ChatMessage[],
    historyMessages: ChatMessage[],
  ): ChatMessage[] {
    const currentAttachmentMessages = currentMessages.filter(
      (message) =>
        message.role.toLowerCase() === "user" && getMessageAttachments(message).length > 0,
    );
    const optimisticMessages = currentAttachmentMessages
      .map((message, attachmentOrdinal) => ({ message, attachmentOrdinal }))
      .filter(
        (
          item,
        ): item is {
          message: ChatMessage & { originalText: string; attachments: ChatAttachment[] };
          attachmentOrdinal: number;
        } => typeof item.message.originalText === "string" && !!item.message.attachments?.length,
      );
    if (optimisticMessages.length === 0) return historyMessages;

    const reconciled = [...historyMessages];
    const historyAttachmentIndexes = reconciled
      .map((message, index) => ({ message, index }))
      .filter(
        ({ message }) =>
          message.role.toLowerCase() === "user" && getMessageAttachments(message).length > 0,
      )
      .map(({ index }) => index);
    const unmatchedOptimistic: ChatMessage[] = [];
    for (const { message: optimisticMessage, attachmentOrdinal } of optimisticMessages) {
      const historyIndex = historyAttachmentIndexes[attachmentOrdinal];
      const historyMessage = historyIndex === undefined ? undefined : reconciled[historyIndex];
      if (historyMessage && extractText(historyMessage) === optimisticMessage.originalText) {
        reconciled[historyIndex] = {
          ...historyMessage,
          originalText: optimisticMessage.originalText,
          attachments: optimisticMessage.attachments,
        };
      } else {
        unmatchedOptimistic.push(optimisticMessage);
      }
    }
    reconciled.push(...unmatchedOptimistic);
    return reconciled;
  }

  /**
   * Extract only the text content from a message, excluding tool_use,
   * tool_result, and thinking blocks.  Used for rendering the main chat bubble.
   */
  function extractTextOnly(message: unknown): string | null {
    if (!message || typeof message !== "object")
      return typeof message === "string" ? message : null;
    const m = message as Record<string, unknown>;
    if (typeof m.content === "string") return m.content;
    if (typeof m.text === "string") return m.text;
    if (Array.isArray(m.content)) {
      const parts: string[] = [];
      for (const block of m.content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
      return parts.length > 0 ? parts.join("\n\n") : null;
    }
    return null;
  }

  /**
   * Extract thinking/reasoning content blocks from a message.
   * Models like Claude return { type: "thinking", thinking: "..." } blocks.
   */
  function extractThinking(message: unknown): string | null {
    const m = message as Record<string, unknown>;
    if (!Array.isArray(m.content)) return null;
    const parts: string[] = [];
    for (const block of m.content as Array<Record<string, unknown>>) {
      if (block.type === "thinking" && typeof block.thinking === "string") {
        parts.push(block.thinking);
      } else if (block.type === "reasoning" && typeof block.reasoning === "string") {
        parts.push(block.reasoning);
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  /**
   * Extract tool_use blocks from a message as structured data for display
   * in execution step panels.
   */
  function extractToolUseBlocks(
    message: unknown,
  ): { name: string; input?: string; result?: string }[] {
    const m = message as Record<string, unknown>;
    if (!Array.isArray(m.content)) return [];
    const blocks = m.content as Array<Record<string, unknown>>;
    const tools: { name: string; input?: string; result?: string }[] = [];

    // Build a map of tool_use id → index for matching results
    const toolById = new Map<string, number>();

    for (const block of blocks) {
      if (block.type === "tool_use") {
        const name = typeof block.name === "string" ? block.name : "tool";
        const input = block.input as Record<string, unknown> | undefined;
        let displayName = name;
        let argsLabel: string | undefined;
        if (input) {
          if (name === "exec" && typeof input.command === "string") {
            argsLabel = input.command;
          } else if (
            (name === "read" || name === "edit" || name === "write") &&
            typeof input.path === "string"
          ) {
            displayName = `${name}("${input.path}")`;
          } else {
            const firstVal = Object.values(input).find((v) => typeof v === "string");
            if (typeof firstVal === "string") displayName = `${name}("${firstVal}")`;
          }
        }
        const idx = tools.length;
        tools.push({ name: displayName, input: argsLabel });
        if (typeof block.id === "string") {
          toolById.set(block.id, idx);
        }
      } else if (block.type === "tool_result") {
        // Try to match to a tool_use by tool_use_id
        const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
        let resultText: string | undefined;
        const content = block.content;
        if (typeof content === "string") {
          resultText = content.slice(0, 1000);
        } else if (Array.isArray(content)) {
          const textParts: string[] = [];
          for (const sub of content as Array<Record<string, unknown>>) {
            if (sub.type === "text" && typeof sub.text === "string") {
              textParts.push(sub.text);
            }
          }
          if (textParts.length > 0) resultText = textParts.join(" ").slice(0, 1000);
        }
        if (toolUseId && toolById.has(toolUseId)) {
          const idx = toolById.get(toolUseId)!;
          tools[idx] = { ...tools[idx], result: resultText };
        } else if (tools.length > 0) {
          // No matching id — attach to the last tool
          tools[tools.length - 1] = { ...tools[tools.length - 1], result: resultText };
        }
      }
    }
    return tools;
  }

  // ── Actions ──

  /** Fast shallow comparison: same length, role, text, and attachment identity. */
  function _messagesEqual(a: ChatMessage[], b: ChatMessage[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].role !== b[i].role) return false;
      const ta = extractText(a[i]);
      const tb = extractText(b[i]);
      if (ta !== tb) return false;
      const aa = getMessageAttachments(a[i])
        .map((attachment) => `${attachment.fileName}:${attachment.mimeType}:${attachment.size}`)
        .join("|");
      const ab = getMessageAttachments(b[i])
        .map((attachment) => `${attachment.fileName}:${attachment.mimeType}:${attachment.size}`)
        .join("|");
      if (aa !== ab) return false;
    }
    return true;
  }

  /** Switch to a different session. */
  async function switchSession(key: string) {
    const targetKey = key === "main" ? mainSessionKey.value || key : key;
    // Save the current session's volatile state (including streaming)
    _syncToSessionStore();
    _saveCurrentState();

    sessionKey.value = targetKey;
    const sessionStore = useSessionStore();
    sessionStore.ensureSession(targetKey);

    // Try to restore cached state (streaming session we switched away from)
    if (_restoreState(targetKey)) {
      synchronizeServerRun();
      await loadHistory({ showLoading: false });
      return;
    }

    // Reset all volatile state for a clean session switch
    loading.value = true;
    resolvedSessionKey.value = null;
    streaming.value = false;
    streamText.value = "";
    sending.value = false;
    chatRunId.value = null;
    streamStartedAt.value = null;
    lastStreamEventAt.value = null;
    lastError.value = null;
    messages.value = [];
    completedToolCallsMap.value = {};
    await loadHistory();
  }

  type HistoryResult = Awaited<ReturnType<typeof window.openclaw.chat.loadHistory>>;
  let historyEpoch = 0;
  let historyFlight: {
    sessionKey: string;
    key: string;
    epoch: number;
    refreshAgain: boolean;
    promise: Promise<HistoryResult | undefined>;
  } | null = null;
  function invalidateHistoryObservation() {
    historyEpoch++;
    _loadSeq++;
    loading.value = false;
  }
  watch(wsConnected, invalidateHistoryObservation, { flush: "sync" });

  /** Coalesce event, reconnect and poll reads of the same selected session. */
  function loadHistory(
    options: { showLoading?: boolean; passive?: boolean } = {},
  ): Promise<HistoryResult | undefined> {
    runtimeUiRevision.value++;
    synchronizeApprovalRows();
    const owner = sessionKey.value;
    const key = resolvedSessionKey.value || owner;
    if (
      historyFlight?.sessionKey === owner &&
      historyFlight.key === key &&
      historyFlight.epoch === historyEpoch
    ) {
      if (!options.passive) historyFlight.refreshAgain = true;
      return historyFlight.promise;
    }
    const flight = {
      sessionKey: owner,
      key,
      epoch: historyEpoch,
      refreshAgain: false,
      promise: Promise.resolve<HistoryResult | undefined>(undefined),
    };
    historyFlight = flight;
    flight.promise = loadHistoryNow(options).finally(async () => {
      if (historyFlight === flight) historyFlight = null;
      if (flight.refreshAgain && flight.epoch === historyEpoch && sessionKey.value === owner) {
        await loadHistory({ showLoading: false });
      }
    });
    return flight.promise;
  }

  /** Fetch history from the gateway for the current session. */
  async function loadHistoryNow(
    options: { showLoading?: boolean } = {},
  ): Promise<HistoryResult | undefined> {
    const seq = ++_loadSeq;
    const epoch = historyEpoch;
    // Capture the session key at call time — if the user switches sessions
    // while we await, we must not write stale data into the new session.
    const callerSessionKey = sessionKey.value;
    let acceptedSessionKey = callerSessionKey;
    const callerResolvedKey = resolvedSessionKey.value;
    const runtimeRevision = serverRuns.revision(callerResolvedKey || callerSessionKey);
    // Only show loading spinner on initial load (no existing messages),
    // not during background refresh polls — avoids full-screen flicker.
    const isInitialLoad = messages.value.length === 0;
    const shouldShowLoading = options.showLoading ?? isInitialLoad;
    if (shouldShowLoading) loading.value = true;
    // Polling must preserve reported provider errors. Only an inferred waiting
    // notice can be retired when a completed reply is present.
    try {
      const key = callerResolvedKey || callerSessionKey;
      const res = await window.openclaw.chat.loadHistory(key);
      // Discard stale result — a newer loadHistory() was called, or
      // the user switched to a different session while we awaited.
      if (seq !== _loadSeq) return;
      if (epoch !== historyEpoch) return;
      if (sessionKey.value !== callerSessionKey) return;
      const canonicalKey = typeof res.sessionKey === "string" ? res.sessionKey : key;
      _canonicalizeSessionKey(callerSessionKey, canonicalKey);
      acceptedSessionKey = sessionKey.value;
      const runtimeAccepted = serverRuns.snapshot(
        canonicalKey,
        res.sessionInfo,
        canonicalKey === key ? runtimeRevision : 0,
      );
      if (runtimeAccepted && res.sessionInfo?.hasActiveRun === false) {
        for (const [id, activity] of Object.entries(approvalActivities.value)) {
          if (activity.sessionKey === canonicalKey) {
            serverRuns.finish(canonicalKey, activity.runId);
            retireApprovalActivity(id);
          }
        }
      }
      synchronizeServerRun(undefined, runtimeAccepted && res.sessionInfo?.hasActiveRun === false);
      const raw = Array.isArray(res.messages) ? res.messages : [];
      const filtered = raw
        .map((m) => stripSystemLines(m))
        .filter((m): m is ChatMessage => m != null && !isGatewaySystemMessage(m));
      const reconciled = preserveOptimisticAttachmentMetadata(messages.value, filtered);
      if (isInferredWaitError(lastError.value) && hasCompletedReply(reconciled)) {
        lastError.value = null;
      }
      // Only replace messages if content actually changed — avoids
      // unnecessary Vue reactivity triggers and DOM re-renders.
      const changed = !_messagesEqual(messages.value, reconciled);
      if (changed) {
        messages.value = reconciled;
        // Update last message preview only when content changed
        _updateLastPreview();
      }
      if (
        runtimeAccepted &&
        !res.sessionInfo?.hasActiveRun &&
        chatRunId.value &&
        serverRuns.isClosed(canonicalKey, chatRunId.value)
      ) {
        serverRuns.commitOutput(canonicalKey, chatRunId.value);
        streamToolCalls.value = [];
      }
      // Only clear streaming state if we're not actively streaming
      // (a new stream may have started while loadHistory was in flight)
      const pendingTerminalOutput =
        chatRunId.value &&
        serverRuns.isClosed(canonicalKey, chatRunId.value) &&
        !serverRuns.outputCommitted(canonicalKey, chatRunId.value);
      if (!streaming.value && !pendingTerminalOutput) {
        streamText.value = "";
        chatRunId.value = null;
        streamStartedAt.value = null;
      }
      // Remove from cache since we now have authoritative data
      if (changed) sessionStateCache.delete(sessionKey.value);
      return res;
    } catch (err) {
      if (seq !== _loadSeq) return;
      if (sessionKey.value !== acceptedSessionKey) return;
      lastError.value = classifyChatError(String(err));
    } finally {
      if (seq === _loadSeq && sessionKey.value === acceptedSessionKey) loading.value = false;
    }
  }

  /** Send a message to the current session. */
  async function sendMessage(text: string, attachments: ChatAttachment[] = []): Promise<boolean> {
    const msg = text.trim();
    if (
      (!msg && attachments.length === 0) ||
      sending.value ||
      streaming.value ||
      currentRunActivities().length > 0
    )
      return false;

    sending.value = true;
    lastError.value = null;
    let optimisticTimestamp: number | undefined;
    try {
      // Strict privacy mode redacts PII before sending.
      let finalMsg = msg;
      const privacySettings = await window.openclaw.settings.get();
      const privacyLevel = privacySettings?.privacyLevel ?? "basic";
      if (privacyLevel === "strict") {
        const controls = hydratePrivacyControls("strict", privacySettings.privacyControls);
        finalMsg = redactPii(msg, privacyControlsToScanOptions(controls));
      }

      // Optimistic: add user message locally
      optimisticTimestamp = Date.now();
      const optimisticMessage: ChatMessage = {
        role: "user",
        content: finalMsg ? [{ type: "text", text: finalMsg }] : [],
        timestamp: optimisticTimestamp,
        attachments: attachments.map((attachment) => ({ ...attachment })),
        originalText: finalMsg,
      };
      messages.value = [...messages.value, optimisticMessage];
      _updateLastPreview();

      streamText.value = "";
      streamTextOffset.value = 0;
      _toolPhaseActive.value = false;
      streamToolCalls.value = [];
      streamStartedAt.value = Date.now();
      lastStreamEventAt.value = Date.now();
      lastWaitingNoticeKey = null;
      lastRecoveryProbeAt = 0;
      streaming.value = true;

      await window.openclaw.chat.sendMessage(
        resolvedSessionKey.value || sessionKey.value,
        finalMsg,
        attachments.length ? attachments : undefined,
      );
      return true;
    } catch (err) {
      const error = String(err);
      lastError.value = classifyChatError(error);
      streaming.value = false;
      streamStartedAt.value = null;
      lastStreamEventAt.value = null;
      if (optimisticTimestamp !== undefined) {
        messages.value = messages.value.filter(
          (message) => message.role !== "user" || message.timestamp !== optimisticTimestamp,
        );
        _updateLastPreview();
      }
      return false;
    } finally {
      sending.value = false;
    }
  }

  /** Handle an incoming chat event from the gateway. */
  function handleChatEvent(payload: ChatEventPayload) {
    // The gateway normalizes session keys (e.g. "default" → "agent:main:default").
    const incoming = payload.sessionKey;
    if (payload.state === "final" && serverRuns.outputCommitted(incoming, payload.runId)) {
      if (incoming === sessionKey.value || incoming === resolvedSessionKey.value)
        void loadHistory({ showLoading: false });
      return;
    }
    const terminal =
      payload.state === "final" ||
      payload.state === "aborted" ||
      payload.state === "error" ||
      payload.lifecyclePhase === "end" ||
      payload.lifecyclePhase === "error";
    if (terminal) serverRuns.finish(incoming, payload.runId);
    else if (payload.state === "status" || payload.state === "delta") {
      if (!serverRuns.begin(incoming, payload.runId) && payload.runId) return;
    }

    // Check if this event belongs to the current active session
    const isActive = incoming === sessionKey.value || incoming === resolvedSessionKey.value;

    // Check if this event belongs to a background (cached) session
    if (!isActive) {
      // Try to match against cached sessions' resolved keys
      for (const [cachedKey, cached] of sessionStateCache) {
        if (incoming === cachedKey || incoming === cached.resolvedSessionKey) {
          if (terminal && cached.chatRunId && cached.chatRunId !== payload.runId) return;
          const active = serverRuns.active(incoming, cached.chatRunId);
          if (!terminal && active && !cached.streaming) {
            cached.streaming = true;
            cached.chatRunId = active.id;
            cached.streamStartedAt = active.startedAt;
            cached.streamText = "";
            cached.streamToolCalls = [];
          }
          if (payload.state === "status") {
            cached.streaming = active !== null;
            cached.chatRunId = active?.id ?? cached.chatRunId;
            cached.streamStartedAt = active?.startedAt ?? null;
            return;
          }
          _handleBackgroundEvent(cachedKey, cached, payload);
          return;
        }
      }
      // First event for active session — learn the resolved key.
      // Only accept it if we are streaming AND the base session key
      // (before gateway normalisation) is a suffix of the incoming key,
      // preventing a late event from a *different* session from poisoning
      // the current session's resolvedSessionKey.
      if (streaming.value && incoming.endsWith(sessionKey.value)) {
        _canonicalizeSessionKey(sessionKey.value, incoming);
      } else {
        return;
      }
    }

    // Update activity timestamp only for events matching the active session
    lastStreamEventAt.value = Date.now();
    if (terminal && chatRunId.value && chatRunId.value !== payload.runId) return;
    if (payload.state === "status") {
      synchronizeServerRun(payload.lifecyclePhase === "start" ? payload.runId : undefined);
      if (payload.lifecyclePhase === "error")
        lastError.value = classifyChatError(payload.errorMessage ?? "chat error");
      if (payload.lifecyclePhase) void loadHistory({ showLoading: false });
      return;
    }

    if (payload.state === "delta") {
      synchronizeServerRun();
      if (chatRunId.value && chatRunId.value !== payload.runId) return;
      const legacyText =
        typeof payload.deltaText === "string" ? null : extractText(payload.message);
      streamText.value = applyChatDelta(streamText.value, payload, legacyText);
      if (streamText.value.trim() && isInferredWaitError(lastError.value)) lastError.value = null;
    } else if (payload.state === "final") {
      // Track whether the model actually produced any observable output.
      // A silent "final" with no text + no tool calls usually indicates a
      // provider-side problem (e.g. invalid API key returning an empty
      // stream) — we surface that as a chat error so the user isn't left
      // staring at a blank bubble.
      // NOTE: only look at *this turn's* tool calls (streamToolCalls),
      // not the accumulated completedToolCallsMap — that would make every
      // turn after the first appear to "have activity" even when empty.
      const hadToolActivity = streamToolCalls.value.length > 0;
      const hadStreamText = streamText.value.trim().length > 0;
      const finalMsgText = extractTextOnly(payload.message) ?? "";
      const hadFinalText = finalMsgText.trim().length > 0;
      if (
        (hadStreamText || hadFinalText || hadToolActivity) &&
        isInferredWaitError(lastError.value)
      ) {
        lastError.value = null;
      }
      // Save tool calls to the completed map, keyed by assistant group index.
      // Count existing assistant groups in messages to align with the grouping
      // logic in ChatView (which maps groupIndex → assistantIdx).
      if (streamToolCalls.value.length > 0) {
        let assistantGroupCount = 0;
        let prevRole = "";
        for (const m of messages.value) {
          const role = (typeof m.role === "string" ? m.role : "assistant").toLowerCase();
          const normalized = role === "user" ? "user" : "assistant";
          if (normalized === "assistant" && normalized !== prevRole) {
            assistantGroupCount++;
          }
          prevRole = normalized;
        }
        completedToolCallsMap.value = {
          ...completedToolCallsMap.value,
          [assistantGroupCount]: streamToolCalls.value.map((t) => ({
            id: t.id,
            name: t.name,
            input: t.input,
            actualCommand: t.actualCommand,
            result: t.result,
            isError: t.isError,
          })),
        };
        streamToolCalls.value = [];
      }
      const rawMsg = payload.message as ChatMessage | undefined;
      const msg = rawMsg ? (stripSystemLines(rawMsg) as ChatMessage | null) : null;
      if (msg && !isGatewaySystemMessage(msg)) {
        // If the final message content is a plain string and we have a valid offset,
        // trim the tool-context prefix so only the model's reply is stored.
        const m = msg as unknown as Record<string, unknown>;
        if (
          typeof m.content === "string" &&
          streamTextOffset.value > 0 &&
          streamTextOffset.value < m.content.length
        ) {
          const modelReply = (m.content as string).slice(streamTextOffset.value).trim();
          if (modelReply) {
            messages.value = [...messages.value, { ...msg, content: modelReply }];
          }
        } else {
          messages.value = [...messages.value, msg];
        }
      } else if (!msg && streamText.value.trim()) {
        // No structured message — derive from streamText, using offset to strip tool context
        const modelReply =
          streamTextOffset.value > 0 && streamTextOffset.value < streamText.value.length
            ? streamText.value.slice(streamTextOffset.value).trim()
            : streamText.value.trim();
        if (modelReply) {
          messages.value = [
            ...messages.value,
            {
              role: "assistant",
              content: [{ type: "text", text: modelReply }],
              timestamp: Date.now(),
            },
          ];
        }
      }
      _updateLastPreview();
      // Detect silent empty response: no streamed text, no final-message
      // text, and no tool activity. This is the "blank bubble" symptom
      // users hit when their model endpoint accepts the request but
      // returns nothing (classic invalid API key / wrong model name).
      if (!hadStreamText && !hadFinalText && !hadToolActivity) {
        lastError.value = { code: "empty_response" };
      }
      streamText.value = "";
      streamTextOffset.value = 0;
      _toolPhaseActive.value = false;
      streaming.value = false;
      sessionTitleRefreshRevision.value++;
      void window.openclaw.chat.generateSessionTitle(payload.sessionKey).then(
        () => sessionTitleRefreshRevision.value++,
        () => undefined,
      );
      chatRunId.value = null;
      streamStartedAt.value = null;
      lastStreamEventAt.value = null;
      // Reload history to get the authoritative server-side version (like webchat)
      loadHistory();
    } else if (payload.state === "aborted") {
      if (isInferredWaitError(lastError.value)) lastError.value = null;
      const msg = payload.message as ChatMessage | undefined;
      if (msg) {
        messages.value = [...messages.value, msg];
      } else if (streamText.value.trim()) {
        messages.value = [
          ...messages.value,
          {
            role: "assistant",
            content: [{ type: "text", text: streamText.value }],
            timestamp: Date.now(),
          },
        ];
      }
      _updateLastPreview();
      streamText.value = "";
      streaming.value = false;
      chatRunId.value = null;
      streamStartedAt.value = null;
      lastStreamEventAt.value = null;
    } else if (payload.state === "error") {
      lastError.value = classifyChatError(payload.errorMessage ?? "chat error");
      streamText.value = "";
      streamToolCalls.value = [];
      streaming.value = false;
      sending.value = false;
      chatRunId.value = null;
      streamStartedAt.value = null;
      lastStreamEventAt.value = null;
    }
    if (terminal) {
      serverRuns.commitOutput(incoming, payload.runId);
      synchronizeServerRun();
    }
  }

  /** Handle an incoming agent tool event from the gateway. */
  function handleToolEvent(payload: {
    runId: string;
    sessionKey: string;
    stream: "tool";
    data: {
      phase: "start" | "result";
      name: string;
      toolCallId: string;
      meta?: string;
      isError?: boolean;
    };
  }) {
    // Match tool events to the active session.
    // The gateway normalizes keys (e.g. "session-xxx" → "agent:main:session-xxx"),
    // so tool events may arrive before resolvedSessionKey is learned from chat deltas.
    const incoming = payload.sessionKey;
    const isActive =
      incoming === sessionKey.value ||
      incoming === resolvedSessionKey.value ||
      (streaming.value && incoming.endsWith(sessionKey.value));
    if (!isActive) return;
    if (serverRuns.isClosed(incoming, payload.runId)) return;
    if (payload.data.phase === "start") {
      serverRuns.begin(incoming, payload.runId);
      synchronizeServerRun();
    }
    if (chatRunId.value && chatRunId.value !== payload.runId) return;

    lastStreamEventAt.value = Date.now();

    // Learn the resolved key early from tool events (before first chat delta)
    if (streaming.value && !resolvedSessionKey.value && incoming !== sessionKey.value) {
      _canonicalizeSessionKey(sessionKey.value, incoming);
    }

    const { phase, name, toolCallId, meta } = payload.data;
    const args = (payload.data as Record<string, unknown>).args as
      | Record<string, unknown>
      | undefined;
    if (phase === "start") {
      // Build a descriptive display name combining tool name + primary argument
      let displayName = name;
      let argsLabel: string | undefined;
      if (args) {
        if (name === "exec" && typeof args.command === "string") {
          argsLabel = args.command;
        } else if (
          (name === "read" || name === "edit" || name === "write") &&
          typeof args.path === "string"
        ) {
          displayName = `${name}("${args.path}")`;
        } else {
          // Generic: show first string-valued arg
          const firstVal = Object.values(args).find((v) => typeof v === "string");
          if (typeof firstVal === "string") displayName = `${name}("${firstVal}")`;
        }
      }
      // Add a new in-progress tool call
      _toolPhaseActive.value = true;
      streamToolCalls.value = [
        ...streamToolCalls.value,
        { id: toolCallId, name: displayName, done: false, input: argsLabel },
      ];
    } else if (phase === "result") {
      const isError = !!(payload.data as Record<string, unknown>).isError;
      // Mark the tool call as completed
      const idx = streamToolCalls.value.findIndex(
        (t) => t.id === toolCallId && t.kind !== "approval",
      );
      if (idx >= 0) {
        const updated = [...streamToolCalls.value];
        // Keep existing input (from args) if meta is shorter or redundant
        const existing = updated[idx];
        const newInput =
          meta && (!existing.input || meta.length > existing.input.length) ? meta : existing.input;
        updated[idx] = {
          ...existing,
          done: true,
          input: newInput,
          result: meta || undefined,
          isError,
        };
        streamToolCalls.value = updated;
      } else {
        // Tool result arrived without a start (edge case) — add as completed
        let displayName = name;
        if (meta) displayName = `${name}  ${meta}`;
        streamToolCalls.value = [
          ...streamToolCalls.value,
          {
            id: toolCallId,
            name: displayName,
            done: true,
            input: undefined,
            result: meta || undefined,
            isError,
          },
        ];
      }

      // When ALL tool calls are done, snapshot the current streamText length.
      // Everything accumulated so far is tool context; the model's reply comes after.
      if (
        _toolPhaseActive.value &&
        streamToolCalls.value.every((t) => t.kind === "approval" || t.done)
      ) {
        _toolPhaseActive.value = false;
        // Use a small delay so the next delta (which may still carry tool output) lands first
        setTimeout(() => {
          streamTextOffset.value = streamText.value.length;
        }, 200);
      }
    }
  }

  /** Add a pending tool call entry (e.g. from sandbox permission request). */
  function addPendingToolCall(id: string, name: string, waitingPermission?: boolean) {
    // Don't add duplicates
    if (streamToolCalls.value.some((t) => t.id === id)) return;
    streamToolCalls.value = [
      ...streamToolCalls.value,
      { id, name, kind: "approval", done: false, waitingPermission: waitingPermission ?? true },
    ];
  }

  /** Mark a pending tool call as completed (e.g. after permission dialog response). */
  function completeToolCall(id: string, result?: string, isError?: boolean) {
    const idx = streamToolCalls.value.findIndex((t) => t.id === id && t.kind === "approval");
    if (idx >= 0) {
      const updated = [...streamToolCalls.value];
      updated[idx] = {
        ...updated[idx],
        done: true,
        waitingPermission: false,
        result: result || updated[idx].result,
        isError: isError ?? updated[idx].isError,
      };
      streamToolCalls.value = updated;
    }
  }

  /**
   * Attach the actual shell command (from sandbox-preload) to the most recent
   * in-progress "exec" tool call. The preload fires this IPC right before
   * executing, so there's always at most one pending exec at that moment.
   */
  function updateLatestExecCommand(command: string) {
    // Find the last in-progress exec tool call (not yet done)
    for (let i = streamToolCalls.value.length - 1; i >= 0; i--) {
      const t = streamToolCalls.value[i];
      if (t.name === "exec" && !t.done && !t.actualCommand) {
        const updated = [...streamToolCalls.value];
        updated[i] = { ...t, actualCommand: command };
        streamToolCalls.value = updated;
        return;
      }
    }
  }

  // ── Stale stream recovery ──
  // If the WebSocket briefly disconnects and reconnects, fire-and-forget
  // gateway events (especially "final") can be lost, leaving streaming=true
  // indefinitely. Silence requests reconciliation; it is not a terminal event.
  const STALE_STREAM_TIMEOUT_MS = 90_000;

  // When a tool call is in progress (tool:start received, waiting for
  // tool:result), the command may legitimately run for a long time with no
  // events (e.g. large file copy, build, database migration).  Use a much
  // longer threshold before showing an inactivity notice.
  const STALE_STREAM_ACTIVE_TOOL_TIMEOUT_MS = 600_000; // 10 minutes
  let lastWaitingNoticeKey: string | null = null;
  let lastRecoveryProbeAt = 0;
  let recoveryProbePending = false;

  function hasCompletedReply(history: ChatMessage[]): boolean {
    const last = history.at(-1);
    if (!last || last.role !== "assistant" || !history.some((message) => message.role === "user"))
      return false;
    if (
      last.stopReason === "toolUse" ||
      last.stopReason === "error" ||
      last.stopReason === "aborted"
    )
      return false;
    if (
      Array.isArray(last.content) &&
      last.content.some(
        (block) =>
          block &&
          typeof block === "object" &&
          (block.type === "toolCall" || block.type === "tool_use"),
      )
    )
      return false;
    return Boolean(extractTextOnly(last)?.trim());
  }

  /**
   * Check whether the current streaming session has gone stale (no events
   * for longer than `timeoutMs`). Refresh authoritative runtime state without
   * treating a timer, completed tool, or persisted reply as whole-run completion.
   *
   * @param timeoutMs  Override the default inactivity threshold (e.g. use a
   *                   shorter value right after a WebSocket reconnect).
   */
  function checkStaleStream(timeoutMs: number = STALE_STREAM_TIMEOUT_MS) {
    if (!streaming.value) return;

    // If any tool call is still in progress, the agent is likely waiting for
    // a long-running command.  Extend the timeout to avoid false positives.
    const hasActiveTool = streamToolCalls.value.some((t) => !t.done);
    const effectiveTimeout = hasActiveTool
      ? Math.max(timeoutMs, STALE_STREAM_ACTIVE_TOOL_TIMEOUT_MS)
      : timeoutMs;

    const lastEvent = lastStreamEventAt.value ?? streamStartedAt.value;
    if (!lastEvent) return;

    // Check an entirely silent request earlier, but silence alone is not
    // evidence of an authentication or network failure.
    const neverGotAnyEvent = lastStreamEventAt.value === null;
    const INITIAL_SILENCE_TIMEOUT_MS = 30_000;
    const threshold =
      neverGotAnyEvent && !hasActiveTool
        ? Math.min(effectiveTimeout, INITIAL_SILENCE_TIMEOUT_MS)
        : effectiveTimeout;

    if (Date.now() - lastEvent < threshold) return;

    const noticeKey = `${resolvedSessionKey.value || sessionKey.value}:${streamStartedAt.value}`;
    if (lastWaitingNoticeKey !== noticeKey) {
      lastWaitingNoticeKey = noticeKey;
      if (!streamText.value.trim() && !streamToolCalls.value.length && !lastError.value)
        lastError.value = { code: "response_delayed", source: "watchdog" };
    }
    if (wsConnected.value && !recoveryProbePending && Date.now() - lastRecoveryProbeAt >= 30_000) {
      recoveryProbePending = true;
      lastRecoveryProbeAt = Date.now();
      void loadHistory({ showLoading: false, passive: true }).finally(() => {
        recoveryProbePending = false;
      });
    }
  }

  /** Reconnect uses the same fenced runtime read as event updates and polling. */
  async function recoverAfterReconnect() {
    if (!streaming.value) return;
    await loadHistory({ showLoading: false });
  }

  /** Abort current generation. */
  async function abort() {
    const key = resolvedSessionKey.value || sessionKey.value;
    const runId = chatRunId.value;
    try {
      await window.openclaw.chat.abort(key);
      if (runId) serverRuns.finish(key, runId);
      if ((resolvedSessionKey.value || sessionKey.value) !== key) return;
      synchronizeServerRun();
    } catch (error) {
      if ((resolvedSessionKey.value || sessionKey.value) === key) {
        lastError.value = classifyChatError(String(error));
      } else {
        console.warn("[chat] Background cancellation failed", {
          errorClass: error instanceof Error ? error.name : "unknown",
        });
      }
      return;
    }
    if (!serverRuns.active(resolvedSessionKey.value || sessionKey.value)) streaming.value = false;
  }

  /** Start a new session (preserves the old one). */
  function newSession(agentId: string) {
    // Save the current session before switching
    _syncToSessionStore();
    _saveCurrentState();

    const suffix = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Multi-agent Gateways require an explicit owner, including for main-agent drafts.
    const key = `agent:${agentId}:${suffix}`;
    pendingSessionAgentId.value = agentId;
    sessionKey.value = key;
    resolvedSessionKey.value = null;
    messages.value = [];
    streamText.value = "";
    streamToolCalls.value = [];
    completedToolCallsMap.value = {};
    streaming.value = false;
    chatRunId.value = null;
    streamStartedAt.value = null;
    lastStreamEventAt.value = null;
    lastError.value = null;
  }

  function switchToMainSession() {
    return switchSession(mainSessionKey.value || "main");
  }

  /** Update last message preview for current session key. */
  function _updateLastPreview() {
    const key = sessionKey.value;
    const last = [...messages.value]
      .reverse()
      .find((m) => m.role === "assistant" || m.role === "user");
    if (last) {
      const text = extractText(last) || "";
      lastMessageMap.value[key] = text.replace(/\n/g, " ").slice(0, 80);
    }
    _syncToSessionStore();
  }

  /** Sync current session state to the sessions store. */
  function _syncToSessionStore() {
    const key = sessionKey.value;
    if (!key) return;
    const firstUser = messages.value.find((m) => m.role === "user");
    const last = [...messages.value]
      .reverse()
      .find((m) => m.role === "assistant" || m.role === "user");
    if (!firstUser && !last) return;

    const sessionStore = useSessionStore();
    sessionStore.ensureSession(key, pendingSessionAgentId.value);
    pendingSessionAgentId.value = undefined;
    // Auto-title from first user message
    if (firstUser) {
      sessionStore.autoTitle(key, extractText(firstUser) || "");
    }
    // Update preview
    if (last) {
      sessionStore.updateSession(key, {
        preview: (extractText(last) || "").replace(/\n/g, " ").slice(0, 80),
      });
    }
  }

  /** Handle a chat event for a background (non-active) session stored in the cache. */
  function _handleBackgroundEvent(
    cachedKey: string,
    cached: SessionStreamState,
    payload: ChatEventPayload,
  ) {
    if (payload.state === "delta") {
      const legacyText =
        typeof payload.deltaText === "string" ? null : extractText(payload.message);
      cached.streamText = applyChatDelta(cached.streamText, payload, legacyText);
    } else if (payload.state === "final") {
      // Save tool calls to completedToolCallsMap keyed by assistant group index
      if (cached.streamToolCalls && cached.streamToolCalls.length > 0) {
        let assistantGroupCount = 0;
        let prevRole = "";
        for (const m of cached.messages) {
          const role = (typeof m.role === "string" ? m.role : "assistant").toLowerCase();
          const normalized = role === "user" ? "user" : "assistant";
          if (normalized === "assistant" && normalized !== prevRole) {
            assistantGroupCount++;
          }
          prevRole = normalized;
        }
        cached.completedToolCallsMap = {
          ...(cached.completedToolCallsMap || {}),
          [assistantGroupCount]: cached.streamToolCalls.map((t) => ({
            id: t.id,
            name: t.name,
            input: t.input,
          })),
        };
        cached.streamToolCalls = [];
      }
      const msg = payload.message as ChatMessage | undefined;
      if (msg) {
        cached.messages = [...cached.messages, msg];
      } else if (cached.streamText.trim()) {
        cached.messages = [
          ...cached.messages,
          {
            role: "assistant",
            content: [{ type: "text", text: cached.streamText }],
            timestamp: Date.now(),
          },
        ];
      }
      cached.streaming = false;
      sessionTitleRefreshRevision.value++;
      void window.openclaw.chat.generateSessionTitle(payload.sessionKey).then(
        () => sessionTitleRefreshRevision.value++,
        () => undefined,
      );
      cached.streamText = "";
      cached.chatRunId = null;
      cached.streamStartedAt = null;
      cached.sending = false;
      // Keep in cache so switching back restores final messages
      sessionStateCache.set(cachedKey, cached);
    } else if (payload.state === "aborted") {
      const msg = payload.message as ChatMessage | undefined;
      if (msg) {
        cached.messages = [...cached.messages, msg];
      } else if (cached.streamText.trim()) {
        cached.messages = [
          ...cached.messages,
          {
            role: "assistant",
            content: [{ type: "text", text: cached.streamText }],
            timestamp: Date.now(),
          },
        ];
      }
      cached.streaming = false;
      cached.streamText = "";
      cached.chatRunId = null;
      cached.streamStartedAt = null;
      cached.sending = false;
      sessionStateCache.set(cachedKey, cached);
    } else if (payload.state === "error") {
      cached.streaming = false;
      cached.streamText = "";
      cached.chatRunId = null;
      cached.streamStartedAt = null;
      cached.sending = false;
      sessionStateCache.set(cachedKey, cached);
    }
    if (payload.state === "final" || payload.state === "aborted" || payload.state === "error") {
      serverRuns.commitOutput(payload.sessionKey, payload.runId);
    }
  }

  /**
   * Delete a session from the Gateway source of truth, then remove its local
   * state and switch away without re-adding it.
   */
  async function deleteSession(key: string) {
    const cached = sessionStateCache.get(key);
    const gatewayKey =
      key === sessionKey.value
        ? resolvedSessionKey.value || key
        : cached?.resolvedSessionKey || key;

    await window.openclaw.chat.deleteSession(gatewayKey);

    // Clean up cached streaming state
    sessionStateCache.delete(key);
    delete lastMessageMap.value[key];

    const sessionStore = useSessionStore();
    sessionStore.removeSession(key);

    // If deleting the active session, switch away WITHOUT syncing old state
    if (sessionKey.value === key) {
      if (sessionStore.sortedSessions.length > 0) {
        // Jump to the most recent remaining session (skip _syncToSessionStore)
        const target = sessionStore.sortedSessions[0].key;
        sessionKey.value = target;
        resolvedSessionKey.value = null;
        sessionStore.ensureSession(target);
        if (!_restoreState(target)) {
          messages.value = [];
          streamText.value = "";
          streamToolCalls.value = [];
          streaming.value = false;
          chatRunId.value = null;
          streamStartedAt.value = null;
          lastStreamEventAt.value = null;
          lastError.value = null;
          loadHistory();
        }
      } else {
        // The Gateway main session is reset rather than deleted, so reuse it.
        // Without a canonical key, keep the generated draft in memory until
        // its first message instead of persisting an empty sidebar entry.
        const newKey =
          mainSessionKey.value ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        pendingSessionAgentId.value = mainSessionKey.value ? "main" : undefined;
        sessionKey.value = newKey;
        resolvedSessionKey.value = mainSessionKey.value ? newKey : null;
        messages.value = [];
        streamText.value = "";
        streamToolCalls.value = [];
        streaming.value = false;
        chatRunId.value = null;
        streamStartedAt.value = null;
        lastStreamEventAt.value = null;
        lastError.value = null;
        if (mainSessionKey.value) sessionStore.ensureSession(newKey, "main");
      }
    }
  }

  /**
   * Clear ALL chat history: wipe the persisted gateway transcripts, drop the
   * renderer sidebar list + cached streaming state, and drop into a fresh,
   * empty session. Throws if the gateway sweep fails so the caller can surface
   * the error instead of showing a false success.
   */
  async function clearAllHistory() {
    // 1. Wipe persisted transcripts on the gateway (source of truth).
    await window.openclaw.chat.clearHistory();

    // 2. Drop cached per-session streaming state.
    sessionStateCache.clear();
    lastMessageMap.value = {};
    completedToolCallsMap.value = {};

    // 3. Clear the sidebar session list.
    const sessionStore = useSessionStore();
    sessionStore.clearAll();

    // 4. Return to the reset main session. If its canonical key is not known,
    // keep a generated draft in memory until the first message.
    const newKey =
      mainSessionKey.value ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingSessionAgentId.value = undefined;
    sessionKey.value = newKey;
    resolvedSessionKey.value = mainSessionKey.value ? newKey : null;
    messages.value = [];
    streamText.value = "";
    streamToolCalls.value = [];
    streaming.value = false;
    chatRunId.value = null;
    streamStartedAt.value = null;
    lastStreamEventAt.value = null;
    lastError.value = null;
    if (mainSessionKey.value) sessionStore.ensureSession(newKey, "main");
  }

  return {
    activityStatus,
    setGatewayGeneration,
    trackApprovalActivity,
    settleApprovalActivity,
    clearApprovalActivities,
    sessionKey,
    resolvedSessionKey,
    currentSessionAgentId,
    messages,
    loading,
    sending,
    streaming,
    sessionTitleRefreshRevision,
    streamText,
    streamTextOffset,
    streamToolCalls,
    completedToolCallsMap,
    streamStartedAt,
    chatRunId,
    lastError,
    wsConnected,
    mainSessionKey,
    lastMessageMap,
    lastStreamEventAt,
    pendingPrompt,
    extractText,
    extractTextOnly,
    getMessageAttachments,
    extractThinking,
    extractToolUseBlocks,
    switchSession,
    switchToMainSession,
    setMainSessionKey,
    loadHistory,
    sendMessage,
    handleChatEvent,
    handleToolEvent,
    addPendingToolCall,
    completeToolCall,
    updateLatestExecCommand,
    checkStaleStream,
    recoverAfterReconnect,
    abort,
    newSession,
    deleteSession,
    clearAllHistory,
  };
});
