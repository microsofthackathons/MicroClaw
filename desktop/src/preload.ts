import { contextBridge, ipcRenderer } from "electron";
import type {
  ChatAttachment,
  ClipboardImageInput,
  PrepareChatAttachmentsResult,
} from "./chat-attachments";
import type { OpenAttachmentRequest } from "./attachment-open";

contextBridge.exposeInMainWorld("openclaw", {
  // --- Gateway lifecycle ---
  gateway: {
    getPort: () => ipcRenderer.invoke("gateway:get-port"),
    getStatus: () => ipcRenderer.invoke("gateway:get-status"),
    restart: (options?: { hard?: boolean }) => ipcRenderer.invoke("gateway:restart", options),
    warmUpAgent: () => ipcRenderer.invoke("gateway:warm-up-agent"),
    onStatus: (callback: (status: string) => void) => {
      const handler = (_event: any, status: string) => callback(status);
      ipcRenderer.on("gateway:status", handler);
      return () => ipcRenderer.removeListener("gateway:status", handler);
    },
    onLog: (callback: (msg: string) => void) => {
      const handler = (_event: any, msg: string) => callback(msg);
      ipcRenderer.on("gateway:log", handler);
      return () => ipcRenderer.removeListener("gateway:log", handler);
    },
    onWsConnected: (callback: (mainSessionKey: string | null) => void) => {
      const handler = (_event: any, key: string | null) => callback(key);
      ipcRenderer.on("gateway:ws-connected", handler);
      return () => ipcRenderer.removeListener("gateway:ws-connected", handler);
    },
    onWsDisconnected: (callback: (reason: string) => void) => {
      const handler = (_event: any, reason: string) => callback(reason);
      ipcRenderer.on("gateway:ws-disconnected", handler);
      return () => ipcRenderer.removeListener("gateway:ws-disconnected", handler);
    },
  },

  // --- Configuration ---
  config: {
    getStateDir: () => ipcRenderer.invoke("config:get-state-dir"),
    isConfigured: () => ipcRenderer.invoke("config:is-configured"),
    needsSetup: () => ipcRenderer.invoke("config:needs-setup"),
    read: () => ipcRenderer.invoke("config:read"),
    readEnv: () => ipcRenderer.invoke("config:read-env"),
    write: (config: any) => ipcRenderer.invoke("config:write", config),
  },

  // --- Settings ---
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (key: string, value: any) => ipcRenderer.invoke("settings:set", key, value),
  },

  // --- Updates ---
  updates: {
    check: () => ipcRenderer.invoke("updates:check"),
  },

  // --- Skills ---
  skills: {
    list: () => ipcRenderer.invoke("skills:list"),
    refresh: () => ipcRenderer.invoke("skills:refresh"),
    updateAllowlist: (allowBundled: string[]) =>
      ipcRenderer.invoke("skills:update-allowlist", allowBundled),
    updateManagedEntries: (entries: Record<string, { enabled: boolean }>) =>
      ipcRenderer.invoke("skills:update-managed-entries", entries),
    setAgentSkills: (agentId: string, skillIds: string[]) =>
      ipcRenderer.invoke("skills:set-agent-skills", agentId, skillIds) as Promise<{
        agentId: string;
        skills: string[];
      }>,
    getStatus: (agentId: string) => ipcRenderer.invoke("skills:get-status", agentId),
    setGlobalEnabled: (skillKey: string, enabled: boolean) =>
      ipcRenderer.invoke("skills:set-global-enabled", { skillKey, enabled }) as Promise<{
        skillKey: string;
        enabled: boolean;
      }>,
    applyAgentConfig: (
      agentId: string,
      skillIds: string[],
      globalChanges: { skillKey: string; enabled: boolean }[],
    ) =>
      ipcRenderer.invoke("skills:apply-agent-config", {
        agentId,
        skillIds,
        globalChanges,
      }) as Promise<{
        agentId: string;
        skills: string[];
        globalChanges: { skillKey: string; enabled: boolean }[];
      }>,
    integrityCheck: () => ipcRenderer.invoke("skills:integrity-check"),
    pendingIntegrityResult: () => ipcRenderer.invoke("skills:pending-integrity-result"),
    acceptIntegrityChanges: () => ipcRenderer.invoke("skills:accept-integrity-changes"),
    generateSnapshot: () => ipcRenderer.invoke("skills:generate-snapshot"),
    onIntegrityAlert: (callback: (result: any) => void) => {
      const handler = (_event: any, result: any) => callback(result);
      ipcRenderer.on("skills:integrity-alert", handler);
      return () => ipcRenderer.removeListener("skills:integrity-alert", handler);
    },
  },

  // --- Chat (session-based via WebSocket gateway protocol) ---
  chat: {
    /** Check if the WS gateway connection is alive. */
    isConnected: () => ipcRenderer.invoke("chat:is-connected"),

    /** Send a message to a session. Server maintains history. */
    sendMessage: (sessionKey: string, message: string, attachments?: ChatAttachment[]) =>
      ipcRenderer.invoke("chat:send-message", { sessionKey, message, attachments }),

    /** Load chat history for a session. */
    loadHistory: (sessionKey: string) => ipcRenderer.invoke("chat:load-history", { sessionKey }),

    /** Load titles derived by OpenClaw from session transcripts. */
    listSessionTitles: (keys: string[]) => ipcRenderer.invoke("chat:list-session-titles", { keys }),

    /** Generate a summary title and persist it on the Gateway session. */
    generateSessionTitle: (sessionKey: string) =>
      ipcRenderer.invoke("chat:generate-session-title", { sessionKey }),

    /** Abort the current run on a session. */
    abort: (sessionKey: string) => ipcRenderer.invoke("chat:abort", { sessionKey }),

    /** Delete one persisted session and its transcript. */
    deleteSession: (sessionKey: string) =>
      ipcRenderer.invoke("chat:delete-session", { sessionKey }),

    /** Clear ALL persisted chat history on the gateway. */
    clearHistory: () => ipcRenderer.invoke("chat:clear-history"),

    /**
     * Subscribe to chat events (delta, final, aborted, error).
     * Returns an unsubscribe function.
     */
    onEvent: (
      callback: (payload: {
        runId: string;
        sessionKey: string;
        state: "delta" | "final" | "aborted" | "error";
        message?: unknown;
        errorMessage?: string;
      }) => void,
    ) => {
      const handler = (_event: any, payload: any) => callback(payload);
      ipcRenderer.on("chat:event", handler);
      return () => ipcRenderer.removeListener("chat:event", handler);
    },

    /**
     * Subscribe to agent tool events (start, result).
     * Returns an unsubscribe function.
     */
    onToolEvent: (
      callback: (payload: {
        runId: string;
        sessionKey: string;
        stream: "tool";
        data: {
          phase: "start" | "result";
          name: string;
          toolCallId: string;
          args?: Record<string, unknown>;
          meta?: string;
          isError?: boolean;
        };
      }) => void,
    ) => {
      const handler = (_event: any, payload: any) => callback(payload);
      ipcRenderer.on("agent:tool-event", handler);
      return () => ipcRenderer.removeListener("agent:tool-event", handler);
    },
  },

  // --- Cron / Scheduled Tasks ---
  cron: {
    list: () => ipcRenderer.invoke("cron:list"),
  },

  // --- Agents ---
  agents: {
    list: () => ipcRenderer.invoke("agents:list"),
    add: (agentId: string) => ipcRenderer.invoke("agents:add", agentId),
    remove: (agentId: string) => ipcRenderer.invoke("agents:remove", agentId),
  },

  // --- Channels ---
  channels: {
    list: () => ipcRenderer.invoke("channels:list"),
  },

  // --- WeChat Plugin ---
  plugin: {
    weixin: {
      getStatus: () => ipcRenderer.invoke("plugin:weixin:get-status"),
      setEnabled: (enabled: boolean) => ipcRenderer.invoke("plugin:weixin:set-enabled", enabled),
      login: () => ipcRenderer.invoke("plugin:weixin:login"),
      cancelLogin: () => ipcRenderer.invoke("plugin:weixin:cancel-login"),
      loginQrStart: (params?: { accountId?: string; force?: boolean }) =>
        ipcRenderer.invoke("plugin:weixin:login-qr-start", params),
      loginQrWait: (params: { sessionKey?: string; accountId?: string; timeoutMs?: number }) =>
        ipcRenderer.invoke("plugin:weixin:login-qr-wait", params),
      disconnect: (params?: { accountId?: string }) =>
        ipcRenderer.invoke("plugin:weixin:disconnect", params),
      onLoginOutput: (callback: (text: string) => void) => {
        const handler = (_event: any, text: string) => callback(text);
        ipcRenderer.on("plugin:weixin:login-output", handler);
        return () => ipcRenderer.removeListener("plugin:weixin:login-output", handler);
      },
      onLoginDone: (callback: (result: { code: number | null }) => void) => {
        const handler = (_event: any, result: any) => callback(result);
        ipcRenderer.on("plugin:weixin:login-done", handler);
        return () => ipcRenderer.removeListener("plugin:weixin:login-done", handler);
      },
    },
  },

  // --- Model testing ---
  model: {
    testConnection: (params: {
      baseUrl: string;
      apiKey: string;
      apiFormat: string;
      modelName: string;
      reasoningEffort?: string;
    }) => ipcRenderer.invoke("model:test-connection", params),
    prepareGitHubCopilot: () => ipcRenderer.invoke("model:github-copilot:prepare"),
    startGitHubCopilotLogin: () => ipcRenderer.invoke("model:github-copilot:start-login"),
    cancelGitHubCopilotLogin: (sessionId?: string) =>
      ipcRenderer.invoke("model:github-copilot:cancel-login", sessionId),
    disconnectGitHubCopilot: () => ipcRenderer.invoke("model:github-copilot:disconnect"),
    getGitHubCopilotStatus: () => ipcRenderer.invoke("model:github-copilot:status"),
    listGitHubCopilotModels: () => ipcRenderer.invoke("model:github-copilot:list-models"),
    onGitHubCopilotLoginEvent: (callback: (event: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
      ipcRenderer.on("model:github-copilot:login-event", listener);
      return () => ipcRenderer.removeListener("model:github-copilot:login-event", listener);
    },
  },

  // --- Usage ---
  usage: {
    getStats: () => ipcRenderer.invoke("usage:get-stats"),
    getDetailedStats: (params: { startDate?: string; endDate?: string; filter?: string }) =>
      ipcRenderer.invoke("usage:get-detailed-stats", params),
    getExchangeRate: () => ipcRenderer.invoke("usage:get-exchange-rate"),
  },

  // --- Window ---
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    close: () => ipcRenderer.invoke("window:close"),
    resizeToSetup: () => ipcRenderer.invoke("window:resize-to-setup"),
    expandToFull: () => ipcRenderer.invoke("window:expand-to-full"),
    onMaximizeChange: (callback: (maximized: boolean) => void) => {
      const handler = (_event: any, maximized: boolean) => callback(maximized);
      ipcRenderer.on("window:maximize-change", handler);
      return () => ipcRenderer.removeListener("window:maximize-change", handler);
    },
  },

  // --- Shell ---
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url),
  },

  attachment: {
    open: (attachment: OpenAttachmentRequest) =>
      ipcRenderer.invoke("attachment:open", attachment) as Promise<{
        ok: boolean;
        error?: string;
      }>,
    importClipboardImages: (images: ClipboardImageInput[], currentTotalBytes = 0) =>
      ipcRenderer.invoke("attachment:import-clipboard-images", {
        images,
        currentTotalBytes,
      }) as Promise<PrepareChatAttachmentsResult>,
  },

  // --- Native dialogs ---
  dialog: {
    openFiles: (currentTotalBytes = 0) =>
      ipcRenderer.invoke("dialog:open-files", {
        currentTotalBytes,
      }) as Promise<PrepareChatAttachmentsResult>,
  },

  logs: {
    exportGateway: (lines: string[]) =>
      ipcRenderer.invoke("logs:export-gateway", lines) as Promise<{
        canceled: boolean;
        filePath?: string;
      }>,
  },

  // --- Microsoft MXC experimental sandbox ---
  mxc: {
    getStatus: () => ipcRenderer.invoke("mxc:get-status"),
    chooseFolder: (agentId: string, access: "ro" | "rw") =>
      ipcRenderer.invoke("mxc:choose-folder", { agentId, access }),
    removeFolder: (agentId: string, access: "ro" | "rw", folderPath: string) =>
      ipcRenderer.invoke("mxc:remove-folder", { agentId, access, path: folderPath }),
    retry: () => ipcRenderer.invoke("mxc:retry"),
    cleanup: () => ipcRenderer.invoke("mxc:cleanup"),
  },
});
