/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

interface ChatEventPayload {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  deltaText?: string;
  replace?: boolean;
  errorMessage?: string;
}

interface AppSettings {
  language: string;
  autoStart: boolean;
  minimizeToTray: boolean;
  themeMode: string;
  accentColor: string;
  privacyLevel: "basic" | "strict";
  privacyControls?: {
    phone: boolean;
    idCard: boolean;
    bankCard: boolean;
    email: boolean;
    apiKey: boolean;
  };
}

interface ChatAttachment {
  type: "image" | "file";
  mimeType: string;
  fileName: string;
  size: number;
  content: string;
  mediaPath?: string;
}

type AttachmentRejectionReason = "file_too_large" | "total_too_large" | "read_failed";

interface AttachmentRejection {
  fileName: string;
  reason: AttachmentRejectionReason;
  size?: number;
  limit?: number;
}

interface OpenFilesResult {
  attachments: ChatAttachment[];
  rejections: AttachmentRejection[];
}

interface ClipboardImageInput {
  mimeType: string;
  fileName: string;
  data: ArrayBuffer;
}

type GitHubCopilotLoginEvent =
  | {
      sessionId: string;
      status: "code";
      verificationUrl: string;
      userCode: string;
      expiresInMs: number;
    }
  | { sessionId: string; status: "success"; defaultModel?: string }
  | { sessionId: string; status: "cancelled" }
  | { sessionId: string; status: "error"; message: string };

interface SkillEntry {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "custom" | "managed";
  platform: string[];
  enabled: boolean;
  installed: boolean;
  /** CLI binaries this skill needs on PATH to run (from SKILL.md requires.bins). */
  requiredBins: string[];
  /** Subset of requiredBins that were NOT found on PATH. */
  missingBins: string[];
  /** requires.anyBins list, present only when NONE of the alternatives are on PATH. */
  missingAnyBins: string[];
  /** requires.env vars that are not set (checked incl. skill env/apiKey overrides). */
  missingEnv: string[];
  /** requires.config dotted paths that are not truthy in the gateway config. */
  missingConfig: string[];
  /** metadata.os list this skill is restricted to (empty = any platform). */
  osRequired: string[];
  /** True when osRequired is non-empty and excludes the current platform. */
  osMismatch: boolean;
  /** True when ALL requirement types (bins/anyBins/env/config/os) are satisfied. */
  eligible: boolean;
}

interface SkillStatusRecord {
  skillKey: string;
  name: string;
  source: string;
  bundled: boolean;
  eligible: boolean;
  disabled: boolean;
  modelVisible: boolean;
  commandVisible: boolean;
  blockedByAllowlist: boolean;
  blockedByAgentFilter: boolean;
  missing: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
}

interface SkillsStatus {
  ok: boolean;
  error?: string;
  summary: { total: number; modelVisible: number };
  skills: SkillStatusRecord[];
}

interface IntegrityChange {
  skill: string;
  source: string;
  file: string;
  type: "modified" | "added" | "removed";
  expected?: string;
  actual?: string;
}

interface IntegrityResult {
  valid: boolean;
  signatureValid: boolean;
  snapshotExists: boolean;
  changes: IntegrityChange[];
}

type UpdateCheckResult =
  | {
      status: "managed-by-store";
      currentVersion: string;
    }
  | {
      status: "update-available";
      currentVersion: string;
      latestVersion: string;
      downloadUrl: string;
      releasedAt?: string;
      sha256?: string;
      openclawVersion?: string;
      releaseNotes: string[];
    }
  | {
      status: "up-to-date";
      currentVersion: string;
      latestVersion: string;
    }
  | {
      status: "error";
      currentVersion: string;
      message: string;
    };

interface OpenClawAPI {
  gateway: {
    getPort(): Promise<number>;
    getStatus(): Promise<string>;
    restart(): Promise<void>;
    warmUpAgent(): Promise<{
      outcome: "skipped" | "delta" | "terminal" | "timeout" | "error" | "disconnected";
      transcriptDeleted: boolean;
    }>;
    onStatus(callback: (status: string) => void): () => void;
    onLog(callback: (msg: string) => void): () => void;
    onWsConnected(callback: (mainSessionKey: string | null) => void): () => void;
    onWsDisconnected(callback: (reason: string) => void): () => void;
  };
  config: {
    getStateDir(): Promise<string>;
    isConfigured(): Promise<boolean>;
    needsSetup(): Promise<boolean>;
    read(): Promise<any>;
    readEnv(): Promise<Record<string, string>>;
    write(config: any): Promise<void>;
  };
  settings: {
    get(): Promise<AppSettings>;
    set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void>;
  };
  updates: {
    check(): Promise<UpdateCheckResult>;
  };
  skills: {
    list(): Promise<{ builtin: SkillEntry[]; custom: SkillEntry[]; managed: SkillEntry[] }>;
    refresh(): Promise<{ builtin: SkillEntry[]; custom: SkillEntry[]; managed: SkillEntry[] }>;
    updateAllowlist(allowBundled: string[]): Promise<void>;
    updateManagedEntries(entries: Record<string, { enabled: boolean }>): Promise<void>;
    setAgentSkills(
      agentId: string,
      skillIds: string[],
    ): Promise<{ agentId: string; skills: string[] }>;
    getStatus(agentId: string): Promise<SkillsStatus>;
    setGlobalEnabled(
      skillKey: string,
      enabled: boolean,
    ): Promise<{ skillKey: string; enabled: boolean }>;
    applyAgentConfig(
      agentId: string,
      skillIds: string[],
      globalChanges: { skillKey: string; enabled: boolean }[],
    ): Promise<{
      agentId: string;
      skills: string[];
      globalChanges: { skillKey: string; enabled: boolean }[];
    }>;
    integrityCheck(): Promise<IntegrityResult>;
    pendingIntegrityResult(): Promise<IntegrityResult | null>;
    acceptIntegrityChanges(): Promise<void>;
    generateSnapshot(): Promise<void>;
    onIntegrityAlert(callback: (result: IntegrityResult) => void): () => void;
  };
  chat: {
    isConnected(): Promise<boolean>;
    sendMessage(sessionKey: string, message: string, attachments?: ChatAttachment[]): Promise<void>;
    loadHistory(sessionKey: string): Promise<{ messages?: unknown[]; thinkingLevel?: string }>;
    listSessionTitles(keys: string[]): Promise<{ titles: Record<string, string> }>;
    generateSessionTitle(sessionKey: string): Promise<string | null>;
    abort(sessionKey: string): Promise<void>;
    deleteSession(sessionKey: string): Promise<void>;
    clearHistory(): Promise<{ cleared: number }>;
    onEvent(callback: (payload: ChatEventPayload) => void): () => void;
    onToolEvent(
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
    ): () => void;
    onExecCommand?(callback: (data: { shell: string; command: string }) => void): () => void;
  };
  cron: {
    list(): Promise<{ jobs?: unknown[] }>;
  };
  agents: {
    list(): Promise<{ agents?: { id: string; name: string; description?: string }[] }>;
    add(agentId: string): Promise<{
      agents: { id: string; name: string; description?: string }[];
    }>;
    remove(agentId: string): Promise<{
      agents: { id: string; name: string; description?: string }[];
    }>;
  };
  channels: {
    list(): Promise<{
      channels?: { id: string; name: string; icon: string; type: string; connected: boolean }[];
    }>;
  };
  plugin: {
    weixin: {
      getStatus(): Promise<{
        enabled: boolean;
        installed: boolean;
        loggedIn: boolean;
        loginInProgress: boolean;
      }>;
      setEnabled(enabled: boolean): Promise<{ ok: boolean }>;
      login(): Promise<{ ok: boolean; error?: string }>;
      cancelLogin(): Promise<void>;
      loginQrStart(params?: { accountId?: string; force?: boolean }): Promise<{
        ok: boolean;
        qrDataUrl?: string;
        message: string;
        sessionKey?: string;
        error?: string;
      }>;
      loginQrWait(params: {
        sessionKey?: string;
        accountId?: string;
        timeoutMs?: number;
      }): Promise<{ connected: boolean; message: string; accountId?: string }>;
      disconnect(params?: { accountId?: string }): Promise<{ ok: boolean; error?: string }>;
      onLoginOutput(callback: (text: string) => void): () => void;
      onLoginDone(callback: (result: { code: number | null }) => void): () => void;
    };
  };
  model: {
    testConnection(params: {
      baseUrl: string;
      apiKey: string;
      apiFormat: string;
      modelName: string;
      reasoningEffort?: string;
    }): Promise<{ ok: boolean; message: string; baseUrl?: string }>;
    prepareGitHubCopilot(): Promise<{ restartRequired: boolean }>;
    startGitHubCopilotLogin(): Promise<{ sessionId: string }>;
    cancelGitHubCopilotLogin(sessionId?: string): Promise<{ cancelled: boolean }>;
    disconnectGitHubCopilot(): Promise<{ disconnected: true; removedProfiles: number }>;
    getGitHubCopilotStatus(): Promise<{ authenticated: boolean }>;
    listGitHubCopilotModels(): Promise<Array<{ id: string; name: string }>>;
    onGitHubCopilotLoginEvent(callback: (event: GitHubCopilotLoginEvent) => void): () => void;
  };
  window: {
    minimize(): Promise<void>;
    maximize(): Promise<void>;
    isMaximized(): Promise<boolean>;
    close(): Promise<void>;
    resizeToSetup(): Promise<void>;
    expandToFull(): Promise<void>;
    onMaximizeChange(callback: (maximized: boolean) => void): () => void;
  };
  shell: {
    openExternal(url: string): Promise<void>;
  };
  attachment: {
    open(attachment: ChatAttachment): Promise<{ ok: boolean; error?: string }>;
    importClipboardImages(
      images: ClipboardImageInput[],
      currentTotalBytes?: number,
    ): Promise<OpenFilesResult>;
  };
  dialog: {
    openFiles(currentTotalBytes?: number): Promise<OpenFilesResult>;
  };
  logs: {
    exportGateway(lines: string[]): Promise<{ canceled: boolean; filePath?: string }>;
  };
  windowsNodeMxc: {
    getStatus(): Promise<{
      desiredEnabled: boolean;
      effectiveEnabled: boolean;
      selectedNodeId: string;
      settingsPath: string;
      companionPath: string;
      companionInstalled: boolean;
      settingsLoaded: boolean;
      settingsFingerprint: string | null;
      strictFallbackEffective: boolean;
      allowWindowsUiEffective: boolean;
      folders: Array<{ path: string; access: "ro" | "rw" }>;
      nodes: Array<{
        id: string;
        displayName: string;
        platform: string;
        connected: boolean;
        paired: boolean;
        remoteIp: string | null;
        commands: string[];
      }>;
      selectedNode: {
        id: string;
        displayName: string;
        platform: string;
        connected: boolean;
        paired: boolean;
        remoteIp: string | null;
        commands: string[];
      } | null;
      gatewayPolicyState: "active" | "locked" | "drift";
      gatewayPolicyReady: boolean;
      effectiveToolsReady: boolean;
      durableApprovalsPresent: boolean | null;
      probe: {
        outcome: "supported" | "unsupported" | "error";
        tier: string | null;
        needsDaclAugmentation: boolean;
        degraded: boolean;
        warnings: string[];
        reason: string | null;
      };
      smoke: {
        nodeId: string;
        settingsFingerprint: string;
        probeTier: string;
        checkedAt: string;
        hostname: { outcome: string; reason: string };
        powershell: { outcome: string; reason: string };
      } | null;
      blockers: string[];
      warnings: string[];
      remediation: string[];
    }>;
    setEnabled(params: {
      enabled: boolean;
      nodeId?: string;
    }): Promise<Awaited<ReturnType<OpenClawAPI["windowsNodeMxc"]["getStatus"]>>>;
    runSmoke(): Promise<{
      nodeId: string;
      settingsFingerprint: string;
      probeTier: string;
      checkedAt: string;
      hostname: { outcome: string; reason: string };
      powershell: { outcome: string; reason: string };
    }>;
  };
  sandbox: {
    getStatus(): Promise<{
      available: boolean;
      enabled: boolean;
      launcherPath: string | null;
      containerName: string;
      capabilities: string[];
      sandboxDirsRW: string[];
      sandboxDirsRO: string[];
      externalApps: string[];
    }>;
    setEnabled(enabled: boolean): Promise<{ ok: boolean }>;
    getExternalApps(): Promise<string[]>;
    setExternalApps(apps: string[]): Promise<{ ok: boolean; apps: string[] }>;
    applyExternalApps(): Promise<{ ok: boolean; restarted: boolean }>;
    getCapabilities(): Promise<string[]>;
    setCapabilities(
      caps: string[],
    ): Promise<{ ok: boolean; caps: string[]; needsRestart: boolean }>;
    provision(): Promise<boolean>;
    getUserDirs(): Promise<{ rw: string[]; ro: string[] }>;
    addUserDir(params: { access: "rw" | "ro" }): Promise<{
      ok: boolean;
      reason?: string;
      parentDir?: string;
      parentAccess?: string;
      removedChildren?: string[];
      dirs: { rw: string[]; ro: string[] };
    }>;
    removeUserDir(params: {
      dir: string;
      access: "rw" | "ro";
    }): Promise<{ ok: boolean; dirs: { rw: string[]; ro: string[] } }>;
    onPermissionRequest(
      callback: (data: {
        requestId: string;
        type: "file" | "shell" | "shell-async";
        targetPath: string;
        dirPath: string;
        command?: string;
      }) => void,
    ): () => void;
    respondPermission(requestId: string, decision: string): Promise<void>;
    onAclTimeout?(callback: (data: { dir: string; access: string }) => void): () => void;
    onAclIneffective?(
      callback: (data: {
        dir: string;
        deniedPath: string;
        access: string;
        command?: string;
      }) => void,
    ): () => void;
    onPermissionCompleted?(
      callback: (data: {
        requestId: string;
        result: "verified" | "verify-timeout" | "failed";
        dir: string;
        access: string;
      }) => void,
    ): () => void;
    verifyAcls(): Promise<{
      missing: Array<{ dir: string; access: string; reason: string }>;
      stale: Array<{ dir: string; rights: string }>;
      ok: Array<{ dir: string; access: string }>;
      errors: Array<{ dir: string; error: string }>;
    }>;
    repairAcl(params: { dir: string; access: "rw" | "ro" }): Promise<{ ok: boolean }>;
    revokeStaleAcl(dir: string): Promise<{ ok: boolean }>;
  };
  usage: {
    getStats(): Promise<any>;
    getDetailedStats(params: {
      startDate?: string;
      endDate?: string;
      filter?: string;
    }): Promise<any>;
    getExchangeRate(): Promise<{
      rate: number;
      currency: string;
      isFallback: boolean;
      fetchedAt: number;
    }>;
  };
}

interface Window {
  openclaw: OpenClawAPI;
}
