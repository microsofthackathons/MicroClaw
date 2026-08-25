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
      getStatus: async () => ({
        desiredEnabled: false,
        effectiveEnabled: false,
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
          reason: "Unavailable in browser development",
        },
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
      setEnabled: async () => ({ ok: true }),
      getExternalApps: async () => [],
      setExternalApps: async (apps) => ({ ok: true, apps }),
      applyExternalApps: async () => ({ ok: true, restarted: false }),
      getCapabilities: async () => [],
      setCapabilities: async (caps) => ({ ok: true, caps, needsRestart: false }),
      provision: async () => true,
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
      onExecCommand: noopSub,
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
