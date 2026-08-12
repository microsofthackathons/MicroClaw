export function createBrowserOpenClawMock(): OpenClawAPI {
  const noop = () => {};
  const noopAsync = async () => {};
  const noopSub = () => noop;
  const emptyFiles = { attachments: [], rejections: [] };
  const emptySkills = { builtin: [], custom: [], managed: [] };
  const browserAgentRoster = [
    { id: "main", name: "Assistant" },
    { id: "master-archive", name: "Master Archive" },
    { id: "painter", name: "Van Gogh" },
    { id: "growth-hacker", name: "Growth Hacker" },
  ];
  const browserAgentsSnapshot = () => ({
    agents: browserAgentRoster.map((agent) => ({ ...agent })),
  });
  const browserMxcStatus = (): MxcStatus => ({
    ready: false,
    packageReady: false,
    hashReady: false,
    osSupported: true,
    policyReady: false,
    workerReady: false,
    sdkVersion: "0.7.0",
    policyVersion: "0.7.0-alpha",
    upstreamCommit: "34d7fe2b4b3226bd4d11dc4a32419b7ec198a88b",
    architecture: "browser",
    binaryHash: null,
    isolationTier: null,
    isolationWarnings: [],
    requiresHostPreparation: false,
    lastError: "MXC is unavailable in browser development mode.",
    agents: browserAgentRoster.map((agent) => ({
      ...agent,
      desired: { readonlyPaths: [], readwritePaths: [] },
      effective: { readonlyPaths: [], readwritePaths: [], workspace: null },
    })),
  });
  const browserGatewayLogs = [
    "[info] Browser development Gateway started",
    "[info] Mock Agent roster loaded",
  ];

  return {
    gateway: {
      getStatus: async () => "running",
      getPort: async () => 18789,
      warmUpAgent: async () => ({ outcome: "skipped", transcriptDeleted: true }),
      restart: noopAsync,
      onStatus: noopSub,
      onLog: (callback) => {
        queueMicrotask(() => browserGatewayLogs.forEach(callback));
        return noop;
      },
      onWsConnected: noopSub,
      onWsDisconnected: noopSub,
    },
    config: {
      getStateDir: async () => "",
      read: async () => ({}),
      readEnv: async () => ({}),
      write: noopAsync,
      isConfigured: async () => true,
      needsSetup: async () => false,
    },
    skills: {
      list: async () => emptySkills,
      refresh: async () => emptySkills,
      updateAllowlist: noopAsync,
      updateManagedEntries: noopAsync,
      setAgentSkills: async (agentId, skillIds) => ({ agentId, skills: skillIds }),
      getStatus: async () => ({
        ok: true,
        summary: { total: 0, modelVisible: 0 },
        skills: [],
      }),
      setGlobalEnabled: async (skillKey, enabled) => ({ skillKey, enabled }),
      applyAgentConfig: async (agentId, skillIds, globalChanges) => ({
        agentId,
        skills: skillIds,
        globalChanges,
      }),
      integrityCheck: async () => ({
        valid: true,
        signatureValid: true,
        snapshotExists: true,
        changes: [],
      }),
      pendingIntegrityResult: async () => null,
      acceptIntegrityChanges: noopAsync,
      generateSnapshot: noopAsync,
      onIntegrityAlert: noopSub,
    },
    mxc: {
      getStatus: async () => browserMxcStatus(),
      chooseFolder: async () => browserMxcStatus(),
      removeFolder: async () => browserMxcStatus(),
      retry: async () => browserMxcStatus(),
      cleanup: async () => browserMxcStatus(),
    },
    settings: {
      get: async () => ({
        language: "en-US",
        autoStart: false,
        minimizeToTray: false,
        themeMode: "light",
        accentColor: "#1e1f25",
        privacyLevel: "basic",
      }),
      set: noopAsync,
    },
    agents: {
      list: async () => browserAgentsSnapshot(),
      add: async (agentId) => {
        if (!browserAgentRoster.some((agent) => agent.id === agentId)) {
          browserAgentRoster.push({ id: agentId, name: agentId });
        }
        return browserAgentsSnapshot();
      },
      remove: async (agentId) => {
        const index = browserAgentRoster.findIndex(
          (agent) => agent.id === agentId && agent.id !== "main",
        );
        if (index >= 0) browserAgentRoster.splice(index, 1);
        return browserAgentsSnapshot();
      },
    },
    updates: {
      check: async () => ({
        status: "up-to-date",
        currentVersion: "1.0.0",
        latestVersion: "1.0.0",
      }),
    },
    chat: {
      isConnected: async () => true,
      loadHistory: async () => ({ messages: [] }),
      listSessionTitles: async () => ({ titles: {} }),
      generateSessionTitle: async () => null,
      sendMessage: noopAsync,
      abort: noopAsync,
      deleteSession: noopAsync,
      clearHistory: async () => ({ cleared: 0 }),
      onEvent: noopSub,
      onToolEvent: noopSub,
    },
    cron: { list: async () => ({ jobs: [] }) },
    channels: { list: async () => ({ channels: [] }) },
    model: {
      testConnection: async () => ({ ok: true, message: "Connection successful" }),
      prepareGitHubCopilot: async () => ({ restartRequired: false }),
      startGitHubCopilotLogin: async () => ({ sessionId: "browser-dev" }),
      cancelGitHubCopilotLogin: async () => ({ cancelled: true }),
      disconnectGitHubCopilot: async () => ({ disconnected: true, removedProfiles: 0 }),
      getGitHubCopilotStatus: async () => ({ authenticated: false }),
      listGitHubCopilotModels: async () => [],
      onGitHubCopilotLoginEvent: noopSub,
    },
    plugin: {
      weixin: {
        getStatus: async () => ({
          enabled: false,
          installed: false,
          loggedIn: false,
          loginInProgress: false,
        }),
        setEnabled: async () => ({ ok: true }),
        login: async () => ({ ok: false, error: "Unavailable in browser development" }),
        cancelLogin: noopAsync,
        loginQrStart: async () => ({ ok: false, message: "Unavailable in browser development" }),
        loginQrWait: async () => ({
          connected: false,
          message: "Unavailable in browser development",
        }),
        disconnect: async () => ({ ok: true }),
        onLoginOutput: noopSub,
        onLoginDone: noopSub,
      },
    },
    usage: {
      getStats: async () => ({ totalSpend: 0, totalTokens: 0 }),
      getDetailedStats: async () => ({}),
      getExchangeRate: async () => ({
        rate: 7.2,
        currency: "CNY",
        isFallback: true,
        fetchedAt: Date.now(),
      }),
    },
    window: {
      expandToFull: noopAsync,
      resizeToSetup: noopAsync,
      minimize: noopAsync,
      maximize: noopAsync,
      close: noopAsync,
      isMaximized: async () => false,
      onMaximizeChange: noopSub,
    },
    shell: { openExternal: noopAsync },
    attachment: {
      open: async () => ({ ok: false, error: "Unavailable in browser development" }),
      importClipboardImages: async () => emptyFiles,
    },
    dialog: { openFiles: async () => emptyFiles },
    logs: {
      exportGateway: async () => ({
        canceled: false,
        filePath: "browser-dev/microclaw-gateway-logs.log",
      }),
    },
  };
}
