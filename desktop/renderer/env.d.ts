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
  errorMessage?: string;
}

interface AppSettings {
  language: string;
  autoStart: boolean;
  startMinimized: boolean;
  themeMode: string;
  accentColor: string;
  privacyLevel: string;
}

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
    set(key: string, value: any): Promise<void>;
  };
  updates: {
    check(): Promise<UpdateCheckResult>;
  };
  skills: {
    list(): Promise<{ builtin: SkillEntry[]; custom: SkillEntry[]; managed: SkillEntry[] }>;
    refresh(): Promise<{ builtin: SkillEntry[]; custom: SkillEntry[]; managed: SkillEntry[] }>;
    updateAllowlist(allowBundled: string[]): Promise<void>;
    updateManagedEntries(entries: Record<string, { enabled: boolean }>): Promise<void>;
    integrityCheck(): Promise<IntegrityResult>;
    pendingIntegrityResult(): Promise<IntegrityResult | null>;
    acceptIntegrityChanges(): Promise<void>;
    generateSnapshot(): Promise<void>;
    onIntegrityAlert(callback: (result: IntegrityResult) => void): () => void;
  };
  chat: {
    isConnected(): Promise<boolean>;
    sendMessage(sessionKey: string, message: string): Promise<void>;
    loadHistory(sessionKey: string): Promise<{ messages?: unknown[]; thinkingLevel?: string }>;
    abort(sessionKey: string): Promise<void>;
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
    }): Promise<{ ok: boolean; message: string }>;
  };
  studio: {
    start(): Promise<number>;
    stop(): Promise<void>;
    getStatus(): Promise<string>;
    getPort(): Promise<number>;
    onStatus(callback: (status: string) => void): () => void;
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
  };
}

interface Window {
  openclaw: OpenClawAPI;
}
