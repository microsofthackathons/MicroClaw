import { contextBridge, ipcRenderer } from "electron";
import type { GatewayRestartOptions } from "./gateway-restart-reason";
import type { ModelConfigUpdate } from "./model-config-application";
// Sandboxed preloads cannot require local modules; keep runtime IPC adapters self-contained.
import type {
  ChatAttachment,
  ClipboardImageInput,
  PrepareChatAttachmentsResult,
} from "./chat-attachments";
import type { OpenAttachmentRequest } from "./attachment-open";
import type { LocalModelAPI, LocalModelOperation } from "./local-model-types";
import type { SessionModelAPI } from "./session-model-types";

contextBridge.exposeInMainWorld("openclaw", {
  features: {
    githubCopilot: process.argv.includes("--microclaw-internal-github-copilot"),
  },
  // --- Gateway lifecycle ---
  gateway: {
    getPort: () => ipcRenderer.invoke("gateway:get-port"),
    getStatus: () => ipcRenderer.invoke("gateway:get-status"),
    isServiceReady: () => ipcRenderer.invoke("gateway:is-service-ready"),
    restart: (options?: GatewayRestartOptions) => ipcRenderer.invoke("gateway:restart", options),
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
    onServiceReady: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on("gateway:service-ready", handler);
      return () => ipcRenderer.removeListener("gateway:service-ready", handler);
    },
  },

  // --- Configuration ---
  config: {
    getStateDir: () => ipcRenderer.invoke("config:get-state-dir"),
    isConfigured: () => ipcRenderer.invoke("config:is-configured"),
    needsSetup: () => ipcRenderer.invoke("config:needs-setup"),
    read: () => ipcRenderer.invoke("config:read"),
    readEnv: () => ipcRenderer.invoke("config:read-env"),
    write: (config: any, expectedConfig?: unknown) =>
      ipcRenderer.invoke("config:write", config, expectedConfig),
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
    observeSession: (sessionKey: string | null) =>
      ipcRenderer.invoke("chat:observe-session", { sessionKey }),
    onSessionUpdate: (callback: (payload: { sessionKey: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { sessionKey: string }) =>
        callback(payload);
      ipcRenderer.on("chat:session-update", handler);
      return () => {
        ipcRenderer.removeListener("chat:session-update", handler);
      };
    },

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
      getStatus: () =>
        ipcRenderer.invoke("plugin:weixin:get-status") as Promise<{
          enabled: boolean;
          requestedEnabled: boolean;
          effectiveEnabled: boolean;
          pausedByMxc: boolean;
          installed: boolean;
          loggedIn: boolean;
          accountCount: number;
          invariantState: "none" | "single" | "multiple" | "invalid";
          currentAccount: {
            accountId: string;
            userId?: string;
          } | null;
          loginInProgress: boolean;
          loginRequiresRestart?: boolean;
          connected?: boolean;
          connecting?: boolean;
          runtimeKnown?: boolean;
          ready?: boolean;
          qrSession?: import("./weixin-connection").WeixinQrSnapshot;
          mutationLocked: boolean;
          mutationLockRevision: number;
        }>,
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
      onMutationLock: (callback: (status: { locked: boolean; revision: number }) => void) => {
        const handler = (
          _event: Electron.IpcRendererEvent,
          status: { locked: boolean; revision: number },
        ) => callback(status);
        ipcRenderer.on("plugin:weixin:mutation-lock", handler);
        return () => ipcRenderer.removeListener("plugin:weixin:mutation-lock", handler);
      },
    },
  },

  // --- Model testing ---
  model: {
    selectDefault: (params: import("./default-model-selection").DefaultModelSelection) =>
      ipcRenderer.invoke("model:select-default", params),
    session: {
      get: (sessionKey) => ipcRenderer.invoke("model:session:get", sessionKey),
      select: (params) => ipcRenderer.invoke("model:session:select", params),
      getRecovery: () => ipcRenderer.invoke("model:session:get-recovery"),
      recover: (params) => ipcRenderer.invoke("model:session:recover", params),
      onRecoveryChanged: (callback) => {
        const listener = () => callback();
        ipcRenderer.on("model:session:recovery-changed", listener);
        return () => ipcRenderer.removeListener("model:session:recovery-changed", listener);
      },
    } satisfies SessionModelAPI,
    local: {
      getSnapshot: () => ipcRenderer.invoke("model:local:get-snapshot"),
      getHardware: () => ipcRenderer.invoke("model:local:get-hardware"),
      getCapabilities: () => ipcRenderer.invoke("model:local:get-capabilities"),
      detect: (options) => ipcRenderer.invoke("model:local:detect", options),
      inspectProvider: () => ipcRenderer.invoke("model:local:inspect-provider"),
      installProvider: (params) => ipcRenderer.invoke("model:local:install-provider", params),
      prepare: (params) => ipcRenderer.invoke("model:local:prepare", params),
      activate: (params) => ipcRenderer.invoke("model:local:activate", params),
      answer: (params) => ipcRenderer.invoke("model:local:answer", params),
      cancel: (operationId) => ipcRenderer.invoke("model:local:cancel", operationId),
      getOperation: () => ipcRenderer.invoke("model:local:get-operation"),
      resume: () => ipcRenderer.invoke("model:local:resume"),
      onEvent: (callback) => {
        const listener = (_event: Electron.IpcRendererEvent, operation: LocalModelOperation) =>
          callback(operation);
        ipcRenderer.on("model:local:event", listener);
        return () => ipcRenderer.removeListener("model:local:event", listener);
      },
    } satisfies LocalModelAPI,
    discoverModels: (params: import("./provider-model-catalog").ProviderCatalogInput) =>
      ipcRenderer.invoke("model:discover-models", params) as Promise<
        import("./provider-model-catalog").ProviderCatalogResult
      >,
    registerCatalogModel: (
      params: import("./provider-model-registration").ProviderCatalogSelection,
    ) => ipcRenderer.invoke("model:register-catalog-model", params) as Promise<void>,
    testConnection: (params: {
      baseUrl: string;
      apiKey: string;
      apiFormat: string;
      modelName: string;
      reasoningEffort?: string;
    }) => ipcRenderer.invoke("model:test-connection", params),
    applyConfig: (input: ModelConfigUpdate) => ipcRenderer.invoke("model:apply-config", input),
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

  windowsNodeMxc: {
    getStatus: () => ipcRenderer.invoke("windows-node-mxc:get-status"),
    getFolders: () =>
      ipcRenderer.invoke("windows-node-mxc:get-folders") as Promise<{ rw: string[]; ro: string[] }>,
    setFolderPolicy: (draft: { rw: string[]; ro: string[] }) =>
      ipcRenderer.invoke("windows-node-mxc:set-folder-policy", draft) as Promise<{
        rw: string[];
        ro: string[];
      }>,
    stageFolder: (params: { access: "rw" | "ro"; draft: { rw: string[]; ro: string[] } }) =>
      ipcRenderer.invoke("windows-node-mxc:stage-folder", params) as Promise<{
        ok: boolean;
        canceled?: boolean;
        reason?: string;
        parentDir?: string;
        parentAccess?: string;
        removedChildren?: string[];
        dirs: { rw: string[]; ro: string[] };
      }>,
    setEnabled: (params: { enabled: boolean }) =>
      ipcRenderer.invoke("windows-node-mxc:set-enabled", params),
    validateFolderPolicy: (draft: { rw: string[]; ro: string[] }) =>
      ipcRenderer.invoke("windows-node-mxc:validate-folder-policy", draft),
    applyFolderPolicy: (draft: { rw: string[]; ro: string[] }) =>
      ipcRenderer.invoke("windows-node-mxc:apply-folder-policy", draft),
    listDurableApprovals: () => ipcRenderer.invoke("windows-node-mxc:durable-approvals:list"),
    revokeDurableApproval: (id: string) =>
      ipcRenderer.invoke("windows-node-mxc:durable-approvals:revoke", id),
    revokeAllDurableApprovals: () =>
      ipcRenderer.invoke("windows-node-mxc:durable-approvals:revoke-all"),
    getPendingApproval: () =>
      ipcRenderer.invoke("windows-node-mxc:approval-current") as Promise<
        import("./windows-node-mxc").WindowsNodeMxcRendererApproval | null
      >,
    respondApproval: (params: {
      requestId: string;
      decision: "deny" | "allow-once" | "allow-always";
      origin?: "desktop" | "timeout";
    }) => ipcRenderer.invoke("windows-node-mxc:approval-respond", params),
    onApprovalRequest: (
      callback: (
        request: import("./windows-node-mxc").WindowsNodeMxcRendererApproval | null,
      ) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        request: import("./windows-node-mxc").WindowsNodeMxcRendererApproval | null,
      ) => callback(request);
      ipcRenderer.on("windows-node-mxc:approval-request", handler);
      return () => ipcRenderer.removeListener("windows-node-mxc:approval-request", handler);
    },
    onApprovalResolved: (callback: (result: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, result: unknown) => callback(result);
      ipcRenderer.on("windows-node-mxc:approval-resolved", handler);
      return () => ipcRenderer.removeListener("windows-node-mxc:approval-resolved", handler);
    },
    onLifecycleState: (callback: (state: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
      ipcRenderer.on("windows-node-mxc:lifecycle-state", handler);
      return () => ipcRenderer.removeListener("windows-node-mxc:lifecycle-state", handler);
    },
  },
});
