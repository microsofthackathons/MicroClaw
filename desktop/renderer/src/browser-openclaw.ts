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
      getFolders: async () => ({ rw: [], ro: [] }),
      setFolderPolicy: async () => {
        throw new Error("Unavailable in browser development");
      },
      stageFolder: async ({ draft }) => ({
        ok: false,
        canceled: true,
        reason: "browser-dev",
        dirs: draft,
      }),
      getStatus: async () => ({
        requestedMode: "off" as const,
        effectiveStrength: "off" as const,
        effectiveTier: null,
        desiredEnabled: false,
        effectiveEnabled: false,
        hooks: {
          requestedExternalEnabled: false,
          requestedInternalEnabled: false,
          effectiveExternalEnabled: false,
          effectiveInternalEnabled: false,
          pausedByMxc: false,
        },
        canvas: {
          state: "off" as const,
          commandCount: 8 as const,
          nativeA2uiOnly: true as const,
          localFilesAllowed: false as const,
        },
        lifecycleState: {
          phase: "idle" as const,
          detail: null,
          updatedAt: new Date(0).toISOString(),
        },
        folderPolicyRecovery: null,
        durableApprovals: { records: [], invalidRecords: 0, warning: null },
        selectedNodeId: "",
        settingsPath: "",
        companionPath: "",
        companionInstalled: false,
        settingsLoaded: false,
        settingsFingerprint: null,
        strictFallbackEffective: false,
        allowWindowsUiEffective: false,
        folders: [],
        nodes: [],
        selectedNode: null,
        helperRevision: undefined,
        mxcRuntimeVersion: undefined,
        cwdPolicyContract: undefined,
        cwdAttestationReady: false,
        activationLeaseContract: undefined,
        gatewayGeneration: "",
        activationLeaseMode: null,
        activationLeaseExpiresAt: null,
        gatewayPolicyState: "drift" as const,
        gatewayPolicyReady: false,
        effectiveToolsReady: false,
        effectiveToolsState: "unverified" as const,
        durableApprovalsPresent: null,
        probe: {
          outcome: "error" as const,
          tier: null,
          needsDaclAugmentation: false,
          degraded: false,
          warnings: [],
          probes: {
            baseContainerApiPresent: null,
            bfscfgPresent: null,
            bfsCompiledIn: null,
          },
          reason: "Unavailable in browser development",
        },
        fullAvailability: {
          available: false,
          summary: "Unavailable in browser development",
          blockers: ["Unavailable in browser development"],
          remediation: [],
        },
        limitedAvailability: {
          available: false,
          summary: "Unavailable in browser development",
          blockers: ["Unavailable in browser development"],
          remediation: [],
        },
        ambientAccess: null,
        smoke: null,
        blockers: ["Unavailable in browser development"],
        warnings: [],
        remediation: [],
      }),
      setEnabled: async () => {
        throw new Error("Unavailable in browser development");
      },
      validateFolderPolicy: async (draft) => draft,
      applyFolderPolicy: async () => {
        throw new Error("Unavailable in browser development");
      },
      listDurableApprovals: async () => [],
      revokeDurableApproval: async () => [],
      revokeAllDurableApprovals: async () => [],
      getPendingApproval: async () => null,
      respondApproval: async () => {
        throw new Error("Unavailable in browser development");
      },
      onApprovalRequest: noopSub,
      onApprovalResolved: noopSub,
      onLifecycleState: noopSub,
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
      observeSession: async () => {},
      onSessionUpdate: () => () => {},
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
      applyConfig: async () => {
        throw new Error("Model configuration requires the desktop application");
      },
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
        getHardware: async () => ({
          ok: false,
          error: "Hardware detection requires the desktop application",
        }),
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
          accountCount: 0,
          invariantState: "none",
          currentAccount: null,
          loginInProgress: false,
          connected: false,
          connecting: false,
          runtimeKnown: false,
          ready: false,
          qrSession: { state: "idle", message: "" },
          mutationLocked: false,
          mutationLockRevision: 0,
        }),
        setEnabled: async () => ({ ok: true }),
        login: async () => ({ ok: false, error: "Unavailable in browser development" }),
        cancelLogin: noopAsync,
        loginQrStart: async () => ({
          ok: false,
          message: "Unavailable in browser development",
          canFallback: false,
        }),
        loginQrWait: async () => ({
          connected: false,
          message: "Unavailable in browser development",
        }),
        disconnect: async () => ({ ok: true }),
        onLoginOutput: noopSub,
        onLoginDone: noopSub,
        onMutationLock: noopSub,
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
