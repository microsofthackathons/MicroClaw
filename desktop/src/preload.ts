import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("openclaw", {
  // --- Gateway lifecycle ---
  gateway: {
    getPort: () => ipcRenderer.invoke("gateway:get-port"),
    getStatus: () => ipcRenderer.invoke("gateway:get-status"),
    restart: (options?: { hard?: boolean }) => ipcRenderer.invoke("gateway:restart", options),
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
    sendMessage: (sessionKey: string, message: string) =>
      ipcRenderer.invoke("chat:send-message", { sessionKey, message }),

    /** Load chat history for a session. */
    loadHistory: (sessionKey: string) => ipcRenderer.invoke("chat:load-history", { sessionKey }),

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

    /**
     * Subscribe to actual shell command notifications from sandbox-preload.
     * Fired when the sandbox executes a shell command, providing the real command payload.
     */
    onExecCommand: (callback: (data: { shell: string; command: string }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on("sandbox:exec-command", handler);
      return () => ipcRenderer.removeListener("sandbox:exec-command", handler);
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

  // --- Studio Backend ---
  studio: {
    start: () => ipcRenderer.invoke("studio:start"),
    stop: () => ipcRenderer.invoke("studio:stop"),
    getStatus: () => ipcRenderer.invoke("studio:get-status"),
    getPort: () => ipcRenderer.invoke("studio:get-port"),
    onStatus: (callback: (status: string) => void) => {
      const handler = (_event: any, status: string) => callback(status);
      ipcRenderer.on("studio:status", handler);
      return () => ipcRenderer.removeListener("studio:status", handler);
    },
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

  // --- Tool Sandbox ---
  sandbox: {
    getStatus: () => ipcRenderer.invoke("sandbox:get-status"),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke("sandbox:set-enabled", enabled),
    execShell: (params: { command: string; cwd?: string; timeout?: number }) =>
      ipcRenderer.invoke("sandbox:exec-shell", params),
    execNode: (params: { code: string; cwd?: string; timeout?: number }) =>
      ipcRenderer.invoke("sandbox:exec-node", params),
    provision: () => ipcRenderer.invoke("sandbox:provision"),
    getExternalApps: () => ipcRenderer.invoke("sandbox:get-external-apps") as Promise<string[]>,
    setExternalApps: (apps: string[]) => ipcRenderer.invoke("sandbox:set-external-apps", apps),
    applyExternalApps: () =>
      ipcRenderer.invoke("sandbox:apply-external-apps") as Promise<{
        ok: boolean;
        restarted: boolean;
      }>,
    getCapabilities: () => ipcRenderer.invoke("sandbox:get-capabilities") as Promise<string[]>,
    setCapabilities: (caps: string[]) =>
      ipcRenderer.invoke("sandbox:set-capabilities", caps) as Promise<{
        ok: boolean;
        caps: string[];
        needsRestart: boolean;
      }>,
    getUserDirs: () =>
      ipcRenderer.invoke("sandbox:get-user-dirs") as Promise<{ rw: string[]; ro: string[] }>,
    addUserDir: (params: { access: "rw" | "ro" }) =>
      ipcRenderer.invoke("sandbox:add-user-dir", params) as Promise<{
        ok: boolean;
        reason?: string;
        parentDir?: string;
        parentAccess?: string;
        removedChildren?: string[];
        dirs: { rw: string[]; ro: string[] };
      }>,
    removeUserDir: (params: { dir: string; access: "rw" | "ro" }) =>
      ipcRenderer.invoke("sandbox:remove-user-dir", params) as Promise<{
        ok: boolean;
        dirs: { rw: string[]; ro: string[] };
      }>,
    onPermissionRequest: (
      callback: (data: {
        requestId: string;
        type: "file" | "shell" | "shell-async" | "app-approval";
        targetPath: string;
        dirPath: string;
        command?: string;
        callerStack?: string;
        accessNeeded?: string;
      }) => void,
    ) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on("sandbox:permission-request", handler);
      return () => ipcRenderer.removeListener("sandbox:permission-request", handler);
    },
    respondPermission: (requestId: string, decision: string) =>
      ipcRenderer.invoke("sandbox:permission-respond", requestId, decision),
    onAclTimeout: (callback: (data: { dir: string; access: string }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on("sandbox:acl-timeout", handler);
      return () => ipcRenderer.removeListener("sandbox:acl-timeout", handler);
    },
    onAclIneffective: (
      callback: (data: { dir: string; deniedPath: string; access: string }) => void,
    ) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on("sandbox:acl-ineffective", handler);
      return () => ipcRenderer.removeListener("sandbox:acl-ineffective", handler);
    },
    onPermissionCompleted: (
      callback: (data: {
        requestId: string;
        result: "verified" | "verify-timeout" | "failed";
        dir: string;
        access: string;
      }) => void,
    ) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on("sandbox:permission-completed", handler);
      return () => ipcRenderer.removeListener("sandbox:permission-completed", handler);
    },
    verifyAcls: () =>
      ipcRenderer.invoke("sandbox:verify-acl") as Promise<{
        missing: Array<{ dir: string; access: string; reason: string }>;
        stale: Array<{ dir: string; rights: string }>;
        ok: Array<{ dir: string; access: string }>;
        errors: Array<{ dir: string; error: string }>;
      }>,
    repairAcl: (params: { dir: string; access: "rw" | "ro" }) =>
      ipcRenderer.invoke("sandbox:repair-acl", params) as Promise<{ ok: boolean }>,
    revokeStaleAcl: (dir: string) =>
      ipcRenderer.invoke("sandbox:revoke-stale-acl", dir) as Promise<{ ok: boolean }>,
  },
});
