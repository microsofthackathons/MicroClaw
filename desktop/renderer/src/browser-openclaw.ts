function rejectExcludedNativeBackend(): Promise<never> {
  return Promise.reject(
    new Error(
      "This branch requires the mandatory Docker backend; native MXC controls are unavailable",
    ),
  );
}

export function createBrowserOpenClawMock(): OpenClawAPI {
  const noop = () => {};
  const noopAsync = async () => {};
  const noopSub = () => noop;
  const emptyFiles = { attachments: [], rejections: [] };
  const emptySkills = { builtin: [], custom: [], managed: [] };
  const browserAgentRoster = [
    { id: "main", name: "Assistant" },
    { id: "master-archive", name: "Master Archive" },
    { id: "office-artisan", name: "Office Artisan" },
    { id: "dr-pulse", name: "Dr. Pulse" },
    { id: "intel-analyst", name: "Intel Analyst" },
    { id: "market-sentinel", name: "Market Sentinel" },
  ];
  const browserAgentsSnapshot = () => ({
    agents: browserAgentRoster.map((agent) => ({ ...agent })),
  });
  const browserGatewayLogs = [
    "[info] Browser development Gateway started",
    "[info] Mock Agent roster loaded",
  ];
  const readyState: DockerSandboxState = { status: "ready", reason: "ready" };
  const browserDockerReadiness = (): DockerSandboxReadiness => ({
    checkedAt: new Date().toISOString(),
    ready: true,
    reasons: [],
    windows: readyState,
    wslCommand: readyState,
    wsl2: readyState,
    dockerCli: readyState,
    dockerDaemon: readyState,
    linuxContainers: readyState,
    image: readyState,
  });

  return {
    features: { githubCopilot: false },
    gateway: {
      getStatus: async () => "running",
      getPort: async () => 18789,
      isServiceReady: async () => true,
      warmUpAgent: async () => ({ outcome: "skipped", transcriptDeleted: true }),
      restart: noopAsync,
      onStatus: noopSub,
      onLog: (callback) => {
        queueMicrotask(() => browserGatewayLogs.forEach(callback));
        return noop;
      },
      onWsConnected: noopSub,
      onWsDisconnected: noopSub,
      onServiceReady: noopSub,
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
    windowsNodeMxc: {
      getStatus: rejectExcludedNativeBackend,
      getPendingApproval: rejectExcludedNativeBackend,
      preflight: rejectExcludedNativeBackend,
      setEnabled: rejectExcludedNativeBackend,
      validateFolderPolicy: rejectExcludedNativeBackend,
      applyFolderPolicy: rejectExcludedNativeBackend,
      listDurableApprovals: rejectExcludedNativeBackend,
      revokeDurableApproval: rejectExcludedNativeBackend,
      revokeAllDurableApprovals: rejectExcludedNativeBackend,
      respondApproval: rejectExcludedNativeBackend,
      onApprovalRequest: noopSub,
      onLifecycleState: noopSub,
    },
    sandbox: {
      getStatus: async () => ({
        available: true,
        enabled: true,
        launcherPath: null,
        containerName: "browser-dev",
        capabilities: [],
        sandboxDirsRW: [],
        sandboxDirsRO: [],
        externalApps: [],
      }),
      setEnabled: noopAsync,
      getExternalApps: async () => [],
      setExternalApps: noopAsync,
      applyExternalApps: noopAsync,
      getCapabilities: async () => [],
      setCapabilities: noopAsync,
      getUserDirs: async () => ({ rw: [], ro: [] }),
      addUserDir: async () => ({ ok: false, reason: "browser-dev", dirs: { rw: [], ro: [] } }),
      stageUserDir: async ({ draft }) => ({
        ok: false,
        reason: "browser-dev",
        dirs: draft,
      }),
      removeUserDir: async () => ({ ok: true, dirs: { rw: [], ro: [] } }),
      setUserDirAccess: async () => ({ ok: true, dirs: { rw: [], ro: [] } }),
      onPermissionRequest: noopSub,
      respondPermission: noopAsync,
      onAclTimeout: noopSub,
      onAclIneffective: noopSub,
      onPermissionCompleted: noopSub,
      verifyAcls: async () => ({ missing: [], stale: [], ok: [], errors: [] }),
      repairAcl: async () => ({ ok: true }),
      revokeStaleAcl: async () => ({ ok: true }),
    },
    dockerSandbox: {
      check: async () => browserDockerReadiness(),
      getStatus: async () => browserDockerReadiness(),
      buildImage: async () => browserDockerReadiness(),
      getBindings: async () => ({
        agents: [{ id: "main", name: "Main", bindings: [] }],
        statuses: {},
      }),
      addBinding: async () => ({
        agents: [{ id: "main", name: "Main", bindings: [] }],
        statuses: {},
      }),
      removeBinding: async () => ({
        agents: [{ id: "main", name: "Main", bindings: [] }],
        statuses: {},
      }),
      retryBindings: async () => ({
        agents: [{ id: "main", name: "Main", bindings: [] }],
        statuses: {},
      }),
      onStatus: noopSub,
      onBuildProgress: noopSub,
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
    cron: { list: async () => ({ jobs: [], pausedByMxc: false, requestedMode: "off" as const }) },
    channels: { list: async () => ({ channels: [] }) },
    model: {
      selectDefault: async () => {
        throw new Error("Default model selection requires the desktop application");
      },
      session: {
        get: async (sessionKey) => ({ sessionKey, modelRef: null, overridden: false }),
        select: async () => {
          throw new Error("Session model selection requires the desktop application");
        },
        getRecovery: async () => null,
        recover: async () => {
          throw new Error("Session model recovery requires the desktop application");
        },
        onRecoveryChanged: noopSub,
      },
      local: {
        getSnapshot: async () => ({ ok: true, value: { models: [] } }),
        getCapabilities: async () => ({
          ok: false,
          error: "Local models unavailable in browser development",
        }),
        detect: async () => ({
          ok: false,
          error: "Local models unavailable in browser development",
        }),
        inspectProvider: async () => ({
          ok: false,
          error: "Local models unavailable in browser development",
        }),
        installProvider: async () => ({
          ok: false,
          error: "Local models unavailable in browser development",
        }),
        prepare: async () => ({
          ok: false,
          error: "Local models unavailable in browser development",
        }),
        activate: async () => ({
          ok: false,
          error: "Local models unavailable in browser development",
        }),
        answer: async () => ({
          ok: false,
          error: "Local models unavailable in browser development",
        }),
        cancel: async () => ({
          ok: false,
          error: "Local models unavailable in browser development",
        }),
        getOperation: async () => ({ ok: true, value: null }),
        resume: async () => ({
          ok: false,
          error: "Local models unavailable in browser development",
        }),
        onEvent: noopSub,
      },
      discoverModels: async () => ({ ok: false, error: "unavailable" }),
      registerCatalogModel: async () => {
        throw new Error("Model registration requires the desktop Gateway");
      },
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
          requestedEnabled: false,
          effectiveEnabled: false,
          pausedByMxc: false,
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
        getRemoteApprovalStatus: rejectExcludedNativeBackend,
        setRemoteApprovalEnabled: rejectExcludedNativeBackend,
        revokeRemoteApproval: rejectExcludedNativeBackend,
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
