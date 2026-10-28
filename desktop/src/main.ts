import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  shell,
  dialog,
  type IpcMainInvokeEvent,
} from "electron";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import { performance } from "perf_hooks";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "crypto";
import { ChildProcess, execFile, execFileSync, spawn } from "child_process";
import { GatewayClient, type ChatEventPayload } from "./gateway-client";
import { GatewayStartupTiming, type StartupTimingEvent } from "./startup-timing";
import {
  hasLocalModelPrimary,
  LocalModelService,
  supportsLocalModelGatewayVersion,
} from "./local-model-service";
import { assertChatModelSupported } from "./provider-model-capabilities";
import {
  assertGitHubCopilotEnabled,
  assertModelProviderEnabled,
  INTERNAL_GITHUB_COPILOT_ARGUMENT,
  readInternalFeatures,
} from "./internal-features";
import { registerLocalModelHandlers } from "./local-model-ipc";
import { SessionModelService, sessionModelChatKey } from "./session-model-service";
import { applyModelConfig } from "./model-config-application";
import { resolveGatewayRestartReason } from "./gateway-restart-reason";
import { registerSessionModelHandlers } from "./session-model-ipc";
import type { LocalModelReceipt } from "./local-model-types";
import {
  applyAgentRosterReload,
  hardRestartGateway,
  isApplicationServiceReadyState,
  shouldRetryGatewayStartup,
  requiresExternalGatewayStop,
} from "./gateway-lifecycle";
import { createTray, destroyTray, updateTrayMenu } from "./tray";
import {
  minimizeWindow,
  sendToWindow,
  showAndFocusWindow,
  showStartupWindow,
  shouldPreventWindowClose,
  shouldQuitAfterAllWindowsClosed,
  shouldRecoverWindow,
} from "./window-lifecycle";
import {
  ElectronLifecycleDiagnostics,
  summarizeLifecycleError,
} from "./electron-lifecycle-diagnostics";
import Store from "electron-store";
import {
  verifySkillIntegrity,
  acceptManagedSkillIntegrityChanges,
  generateAndSignSnapshot,
  captureSkillIntegritySnapshotState,
  getSkillSourceDirs,
  isManagedSkillTrustedBySnapshot,
  migrateLegacySkillIntegritySnapshot,
  restoreSkillIntegritySnapshotState,
  type IntegrityResult,
} from "./skill-integrity";
import { migrateMxcOnlySecuritySettings } from "./mxc-only-settings";
import { resolveSupportedLocale, t as mainT } from "./i18n";
import { checkForUpdates } from "./update-checker";
import { getUsdToCnyRate } from "./exchange-rate";
import { BackgroundUsageLedger } from "./background-usage-ledger";
import { queryAccountedUsage } from "./usage-service";
import { UsageSnapshotCache } from "./usage-snapshot-cache";
import {
  prepareChatAttachments,
  prepareClipboardImageAttachments,
  validateChatAttachments,
} from "./chat-attachments";
import { prepareAttachmentForOpen } from "./attachment-open";
import {
  recoverInterruptedOpenClawUpgrade,
  UpgradeInProgressError,
  validateInstallerOwnedUpgrade,
} from "./openclaw-upgrade-recovery";
import {
  getOpenClawStateDir,
  loadGatewayEnvironment,
  loadStateDirEnv,
  resolveBuiltinSkillsDir,
  resolveNodePath,
  resolveOpenClawEntry,
  resolveOpenClawPackageDir,
} from "./path-resolver";
import {
  type GatewayStatus,
  CREATE_NO_WINDOW,
  COMPILE_CACHE_SUBDIR,
  DEFAULT_PORT,
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
  GATEWAY_READY_TIMEOUT_MS,
  MXC_AGENT_DATABASE_READY_POLL_INTERVAL_MS,
  MXC_AGENT_DATABASE_READY_TIMEOUT_MS,
  MXC_GATEWAY_RPC_PROBE_INITIAL_BACKOFF_MS,
  MXC_GATEWAY_RPC_PROBE_MAX_BACKOFF_MS,
  MXC_GATEWAY_RPC_PROBE_TIMEOUT_MS,
  MXC_GATEWAY_RPC_READY_TIMEOUT_MS,
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_CHECK_HTTP_TIMEOUT_MS,
  HEALTH_CHECK_FAILURE_THRESHOLD,
  HEALTH_CHECK_BUSY_GRACE_MS,
  LOADING_WINDOW_WIDTH,
  LOADING_WINDOW_HEIGHT,
  MODEL_CONNECTION_TEST_TIMEOUT_MS,
  SETUP_WINDOW_WIDTH,
  SETUP_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  WEIXIN_LOGIN_TIMEOUT_MS,
  SKILLS_STATUS_TIMEOUT_MS,
  USAGE_QUERY_DAYS,
  UPDATE_MANIFEST_URL,
} from "./constants";
import {
  appendModelEndpoint,
  prepareModelBaseUrl,
  requestModelEndpoint,
  resolveModelApiKey,
} from "./model-connection";
import { assertModelConfigUnchanged, getPrimaryModel, hasConfiguredModel } from "./model-setup";
import { selectDefaultModel } from "./default-model-selection";
import { discoverProviderModels } from "./provider-model-catalog";
import {
  registerProviderCatalogModel,
  parseProviderCatalogSelection,
} from "./provider-model-registration";
import {
  disconnectGitHubCopilot,
  getGitHubCopilotAuthStatus,
  GitHubCopilotAuthManager,
  type GitHubCopilotAuthRuntime,
  invalidateGitHubCopilotAuthStatusCache,
  listGitHubCopilotModels,
} from "./github-copilot-auth";
import {
  ensureGitHubCopilotProviderPlugin,
  ensureSelectedModelProviderPlugins,
} from "./model-provider-plugins";
import {
  AGENT_PERSONAS,
  DEFAULT_AGENT_PERSONAS,
  ensureAgentPersonasConfig,
  getAgentPersona,
  listConfiguredAgents,
  MAIN_PLATFORM_IDENTITY_SECTION,
  removeConfiguredAgent,
  resolveAgentPersonaWorkspace,
  seedAgentPersonaWorkspace,
  seedAgentPersonaWorkspaces,
  type AgentPersona,
  type AgentRosterConfig,
} from "./agent-personas";
import { assertConfigWriteAllowed } from "./config-write-policy";
import {
  AGENT_CATALOG,
  isAgentOwnedSkillId,
  LEGACY_AGENT_ID_ALIASES,
  sanitizeAgentSkillIds,
} from "./agent-catalog";
import {
  agentOwnedSkillInstallChanged,
  agentOwnedSkillMatchNames,
  commitAgentOwnedSkillInstalls,
  commitAgentOwnedSkillRemovals,
  disableUnreferencedAgentOwnedSkills,
  installAgentOwnedSkills,
  inspectConfiguredAgentOwnedSkills,
  prepareUnusedAgentOwnedSkillRemoval,
  reconcileConfiguredAgentOwnedSkills,
  resolveAgentOwnedSkillBundleRoot,
  rollbackAgentOwnedSkillInstalls,
  rollbackAgentOwnedSkillRemovals,
  setAgentOwnedSkillsEnabled,
} from "./agent-owned-skills";
import {
  convergeWeixinPluginRuntime,
  resolveBundledWeixinPluginRoot,
} from "./weixin-plugin-convergence";
import { createWeixinLoginCliOutcomeParser } from "./weixin-login-cli-outcome";
import { isTrustedRendererUrl } from "./trusted-renderer-url";
import {
  assertNativeWeixinRemoteApprovalAuthority,
  planWeixinRemoteApprovalNativeTransition,
} from "./windows-node-mxc-weixin-remote-approval-consent";
import {
  mxcApprovalDeadline,
  commitMxcApprovalDecision,
  WindowsNodeMxcApprovalLifecycle,
  renderMxcApprovalTerminal,
  type MxcApprovalOrigin,
  type MxcApprovalTerminal,
} from "./windows-node-mxc-approval-lifecycle";
import {
  deliverWeixinRemoteApproval,
  exactWeixinApprovalSource,
  findWeixinApprovalSource,
  bindWeixinApprovalRun,
  remoteApprovalDiagnosticBinding,
  type WeixinRemoteDeliveryState,
  type WeixinRemoteDeliveryTrigger,
  WeixinRemoteDeliveryCoordinator,
} from "./windows-node-mxc-weixin-remote-approval-delivery";
import { describeWeixinSessionBinding, resolveWeixinSessionRoute } from "./weixin-session-routing";
import { agentRunLifecycleEvent } from "./chat-run-lifecycle";
import { forwardGatewaySessionUpdate } from "./chat-session-update";
import {
  describeGatewayApprovalContext,
  describeWeixinApprovalDecision,
} from "./mxc-approval-context-diagnostics";
import { shouldDisableHardwareAcceleration } from "./hardware-acceleration";
import { cleanupStoppedGatewayWarmupSession } from "./warmup-session-cleanup";
import { requiresPostSpawnChannelCheck, waitForPostSpawnChannels } from "./post-spawn-restart";
import {
  isKnownWeixinQrStartRejection,
  isWeixinLoginReady,
  setWeixinPluginEnabled,
  WeixinPluginActivationError,
} from "./weixin-plugin-lifecycle";
import { stopGatewayChildProcess } from "./gateway-process-stop";
import { createGatewayLogExportFilename, formatGatewayLogExport } from "./gateway-log-export";
import {
  applyAgentSkillsToConfig,
  applyGlobalSkillChange,
  type GlobalSkillChange,
} from "./skill-config";
import {
  WINDOWS_NODE_MXC_NODE_COMMANDS,
  applyWindowsNodeMxcGatewayPolicy,
  getWindowsNodeMxcIngressBackup,
  getWindowsNodeMxcGatewayPolicyState,
  isWindowsNodeMxcIngressReleased,
  migrateWindowsNodeMxcToolBackupAliases,
  normalizeWindowsNodeMxcGatewayApproval,
  normalizeWindowsNodeMxcFolderPolicy,
  planWindowsNodeMxcFolderUpsert,
  restoreWindowsNodeMxcGatewayPolicy,
  selectWindowsNodeMxcGatewayStartPolicy,
  validateWindowsNodeMxcFolderPath,
  validateWindowsNodeMxcGatewayPolicy,
  type WindowsNodeMxcApprovalDecision,
  type WindowsNodeMxcGatewayApproval,
  projectWindowsNodeMxcApprovalForRenderer,
} from "./windows-node-mxc";
import {
  annotateWindowsNodeMxcPausedCronJobs,
  createWindowsNodeMxcCronResumeFence,
  getWindowsNodeMxcCronResumeEnvironment,
  isWindowsNodeMxcCronResumeAcknowledgement,
  parseWindowsNodeMxcCronResumeFence,
  shouldSuspendWindowsNodeMxcCronBeforePreflight,
  type WindowsNodeMxcCronResumeFence,
} from "./windows-node-mxc-cron";
import {
  createWindowsNodeMxcHooksGatePolicy,
  getWindowsNodeMxcHooksEnvironment,
  inspectWindowsNodeMxcHooksStatus,
  type WindowsNodeMxcHooksStatus,
} from "./windows-node-mxc-hooks";
import {
  describeWindowsNodeMxcFolderTransactionError,
  runWindowsNodeMxcFolderPolicyTransaction,
  type WindowsNodeMxcFolderPolicy,
  type WindowsNodeMxcFolderTransactionPhase,
} from "./windows-node-mxc-folder-transaction";
import { runWindowsNodeMxcAutomaticTransition } from "./windows-node-mxc-auto-transition";
import {
  WindowsNodeMxcLifecycleOperationCoordinator,
  type WindowsNodeMxcLifecycleOperationDescriptor,
} from "./windows-node-mxc-lifecycle-operation";
import { WeixinMutationCoordinator } from "./weixin-mutation-coordinator";
import {
  ensureDefaultWeixinPlugin,
  getWeixinRuntimeConnection,
  WeixinQrSession,
} from "./weixin-connection";
import {
  attestWindowsNodeMxcGatewaySnapshot,
  promoteWindowsNodeMxcPolicy,
  type GatewayConfigSnapshot,
} from "./windows-node-mxc-policy-promotion";
import { startAfterGatewayRpcReady } from "./gateway-rpc-readiness";
import { waitForGatewayHttpReadiness } from "./gateway-http-readiness";
import {
  WindowsNodeMxcDurableApprovalStore,
  canUseWindowsNodeMxcDurableApproval,
  consumeExactDurableApproval,
  durableApprovalIdentityFromGateway,
  type WindowsNodeMxcDurableApprovalInspection,
} from "./windows-node-mxc-durable-approvals";
import {
  inspectWindowsNodeMxc,
  isCurrentBundledWindowsNodeApprovalCallback,
  preflightWindowsNodeMxcBackend,
  runWindowsNodeMxcSmoke,
  isWindowsNodeMxcSmokePassed,
  shouldStopManagedGatewayForWindowsNodeMxc,
  type StoredWindowsNodeMxcSmoke,
  type WindowsNodeMxcRuntimeStatus,
} from "./windows-node-mxc-service";
import {
  createWindowsNodeMxcSelection,
  migrateWindowsNodeMxcSelection,
  summarizeWindowsNodeMxcAmbientAccess,
  type WindowsNodeMxcAmbientAccessAssessment,
  type WindowsNodeMxcRequestedMode,
  type WindowsNodeMxcSelection,
} from "./windows-node-mxc-modes";
import {
  BundledWindowsNodeHost,
  sensitiveWindowsRoots,
  type BundledApprovalRequest,
  type BundledWindowsNodeAmbientAccess,
  type BundledWindowsNodeApprovalProofContext,
  type BundledWindowsNodeFolder,
} from "./bundled-windows-node-host";
import {
  clearInheritedWindowsNodeMxcWeixinEnvironment,
  getWindowsNodeMxcWeixinEnvironment,
  preflightWindowsNodeMxcWeixinAuthorization,
  prepareWindowsNodeMxcWeixinContext,
  releaseWindowsNodeMxcWeixinIngress,
  revokeWindowsNodeMxcWeixinIngress,
  type WindowsNodeMxcWeixinContext,
} from "./windows-node-mxc-weixin";
import {
  migrateWeixinRemoteApprovalConfiguration,
  projectWeixinRemoteApprovalRuntimeConfiguration,
  WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT,
  WindowsNodeMxcWeixinRemoteApprovalBroker,
  weixinRemoteApprovalConsentHash,
  weixinRemoteApprovalWireSourceRejection,
  type WeixinRemoteApprovalOwnerBinding,
  type WeixinRemoteApprovalConfiguration,
  type WeixinRemoteApprovalNotice,
  type WeixinRemoteApprovalSecurityBinding,
  type WeixinRemoteApprovalSource,
} from "./windows-node-mxc-weixin-remote-approval";
import {
  planWeixinRemoteApprovalTransition,
  readWeixinRemoteApprovalActivationOptions,
  type WeixinRemoteApprovalActivationOptions,
  type WeixinRemoteApprovalActivationSelection,
  type WeixinRemoteApprovalTransitionPlan,
} from "./windows-node-mxc-weixin-remote-approval-activation";
import {
  WindowsNodeMxcWeixinRemoteApprovalServer,
  type WeixinRemoteApprovalInboundEnvelope,
} from "./windows-node-mxc-weixin-remote-approval-transport";
import {
  readAuthenticatedWeixinWireOwner,
  readWeixinAccountStatus,
  shouldRevokeWeixinRemoteApprovalOwner,
} from "./weixin-account-status";

/**
 * Normalize a directory path for comparison/storage.
 * Strips trailing slashes EXCEPT for drive roots (e.g. "C:\") where
 * stripping the backslash produces "C:" which is a relative path on Windows.
 */
function normalizeDirPath(dir: string): string {
  let d = dir.replace(/[/\\]+$/, "");
  // If result is a bare drive letter like "C:", add backslash to make it a root
  if (/^[a-zA-Z]:$/.test(d)) d += "\\";
  return d;
}

// Chromium selects an appropriate rendering backend, including on RDP. Force software rendering
// only for environments where GPU startup is known to be incompatible.
if (shouldDisableHardwareAcceleration(process.env, process.platform, os.release())) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-gpu");
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const internalFeatures = readInternalFeatures(process.env);
const store = new Store<{ windowBounds: Electron.Rectangle | null }>({
  defaults: { windowBounds: null },
});

const settingsStore = new Store<{
  language?: string;
  autoStart: boolean;
  minimizeToTray: boolean;
  themeMode: string;
  accentColor: string;
  localModelOperation?: LocalModelReceipt;
  modelFormSelections?: Record<string, string>;
  /** Selected filesystem roots, enforced by the native MXC runtime only. */
  windowsNodeMxcFolders?: WindowsNodeMxcFolderPolicy;
  /** Stable paired node ID selected for the experimental Windows Node route. */
  windowsNodeMxcNodeId: string;
  /** Original per-agent tool policies restored when the experimental mode is disabled. */
  windowsNodeMxcToolBackups: Record<string, unknown | null>;
  /** Versioned explicit MXC containment mode selection. */
  windowsNodeMxcSelection?: WindowsNodeMxcSelection;
  /** Last Limited-mode ambient-access assessment; paths are never persisted here. */
  windowsNodeMxcAmbientAccess?: WindowsNodeMxcAmbientAccessAssessment;
  /** Last mode-specific contained readiness smoke proof. */
  windowsNodeMxcSmoke?: StoredWindowsNodeMxcSmoke;
  /** One-shot durable fence that prevents Cron catch-up when leaving MXC. */
  windowsNodeMxcCronResumeFence?: WindowsNodeMxcCronResumeFence;
  /** Optional, locally confirmed owner binding for experimental WeChat remote approvals. */
  windowsNodeMxcWeixinRemoteApproval?: {
    enabled: boolean;
    owner: WeixinRemoteApprovalOwnerBinding | null;
  };
  /** Recoverable policy state retained across a failed apply/reactivate transaction. */
  windowsNodeMxcFolderPolicyRecovery?: {
    previous: WindowsNodeMxcFolderPolicy;
    draft: WindowsNodeMxcFolderPolicy;
    updatedAt: string;
    lastError: string | null;
    failurePhase?: WindowsNodeMxcFolderTransactionPhase | null;
  };
  /** Privacy protection level. */
  privacyLevel: "basic" | "strict";
  /** Per-control privacy preferences. Missing fields use mode-specific defaults. */
  privacyControls?: {
    phone: boolean;
    idCard: boolean;
    bankCard: boolean;
    email: boolean;
    apiKey: boolean;
  };
}>({
  name: "settings",
  defaults: {
    autoStart: false,
    minimizeToTray: false,
    themeMode: "light",
    accentColor: "#1e1f25",
    windowsNodeMxcNodeId: "",
    windowsNodeMxcToolBackups: {},
    privacyLevel: "basic",
  },
});
const migratedSecuritySettings = migrateMxcOnlySecuritySettings(settingsStore.store);
if (JSON.stringify(settingsStore.store) !== JSON.stringify(migratedSecuritySettings)) {
  settingsStore.store = migratedSecuritySettings;
}
const RENDERER_WRITABLE_SETTING_KEYS = new Set([
  "accentColor",
  "autoStart",
  "language",
  "minimizeToTray",
  "privacyControls",
  "privacyLevel",
  "themeMode",
]);

let mainWindow: BrowserWindow | null = null;
let gatewayProcess: ChildProcess | null = null;
let gwClient: GatewayClient | null = null;
let gatewayPort = 0;
let gatewayToken = "";
const activeModelSessions = new Set<string>();
let modelConfigurationMutationInProgress = false;
let githubCopilotLoginInProgress = false;
const modelChatKey = (key: string) =>
  sessionModelChatKey(readConfig(), key, gwClient?.mainSessionKey);
const modelGatewayIdentity = () =>
  createHash("sha256")
    .update(`${getOpenClawStateDir()}\n${gatewayPort}\n${gatewayToken}`)
    .digest("hex");
const localModelService = new LocalModelService({
  gateway: () => gwClient,
  identity: modelGatewayIdentity,
  assertMutable: () => {
    sessionModelService.assertIdle();
    if (modelConfigurationMutationInProgress || githubCopilotLoginInProgress) {
      throw new Error("A model configuration change is in progress");
    }
    if (isWindowsNodeMxcDesired() || windowsNodeMxcSecurityTransitionInProgress) {
      throw new Error(
        "This Gateway configuration is locked while Windows Node + MXC mode is enabled",
      );
    }
    if (activeModelSessions.size > 0) {
      throw new Error("Wait for the active chat response before changing the model");
    }
    if (!gatewaySpawnedByUs) {
      throw new Error("Local model setup requires the Gateway managed by MicroClaw");
    }
  },
  readConfig,
  stateDir: getOpenClawStateDir,
  readReceipt: () => settingsStore.get("localModelOperation"),
  saveReceipt: (receipt) => {
    if (receipt) settingsStore.set("localModelOperation", receipt);
    else settingsStore.delete("localModelOperation");
  },
  restartGateway: async () => {
    await restartManagedGateway("Applying official local model setup");
    const deadline = Date.now() + GATEWAY_READY_TIMEOUT_MS;
    while (!gwClient?.connected) {
      if (Date.now() >= deadline)
        throw new Error("Gateway did not reconnect after local model setup");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  },
  onChange: (operation) => sendToWindow(mainWindow, "model:local:event", operation),
});
const sessionModelService = new SessionModelService({
  githubCopilotEnabled: internalFeatures.githubCopilot,
  gateway: () => gwClient,
  prepareModel: (modelRef) =>
    withModelConfigurationMutation(async () => {
      await prepareProviderCatalogModel(modelRef, readConfig());
    }),
  runtime: () => {
    const child = gatewayProcess;
    if (!gatewaySpawnedByUs || !child?.pid || !gatewayGenerationId) return null;
    return {
      identity: modelGatewayIdentity(),
      generation: gatewayGenerationId,
      isStopped: () => child.exitCode != null || child.signalCode != null,
    };
  },
  restartGateway: async () => {
    await restartManagedGateway(
      "Recovering an uncertain session model selection without retrying it",
      false,
      () => stopGatewayForSecurityTransition(gatewayPort),
    );
    const deadline = Date.now() + GATEWAY_READY_TIMEOUT_MS;
    while (!gwClient?.connected) {
      if (Date.now() >= deadline)
        throw new Error("Gateway did not reconnect for session model recovery");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  },
  onRecoveryChanged: () => sendToWindow(mainWindow, "model:session:recovery-changed", null),
  readConfig,
  assertMutable: () => {
    localModelService.assertIdle();
    if (modelConfigurationMutationInProgress || githubCopilotLoginInProgress) {
      throw new Error("A model configuration change is in progress");
    }
    if (isWindowsNodeMxcDesired() || windowsNodeMxcSecurityTransitionInProgress) {
      throw new Error(
        "This Gateway configuration is locked while Windows Node + MXC mode is enabled",
      );
    }
    if (activeModelSessions.size > 0) {
      throw new Error("Wait for the active chat response before changing the model");
    }
    if (!gatewaySpawnedByUs || gatewayRestarting) {
      throw new Error("Session model selection requires MicroClaw's connected managed Gateway");
    }
  },
});
async function withModelConfigurationMutation<T>(operation: () => Promise<T>): Promise<T> {
  localModelService.assertIdle();
  sessionModelService.assertIdle();
  if (modelConfigurationMutationInProgress) {
    throw new Error("A model configuration change is in progress");
  }
  modelConfigurationMutationInProgress = true;
  try {
    return await operation();
  } finally {
    modelConfigurationMutationInProgress = false;
  }
}

function assertCloudModelMutable(): void {
  assertWindowsNodeMxcConfigurationMutable();
  if (githubCopilotLoginInProgress) throw new Error("GitHub Copilot sign-in is still in progress");
  if (!gatewaySpawnedByUs || gatewayRestarting)
    throw new Error("Model selection requires MicroClaw's connected managed Gateway");
  if (activeModelSessions.size > 0)
    throw new Error("Wait for the active chat response before changing the model");
}

function applyModelConfiguration(input: unknown): Promise<void> {
  return applyModelConfig(
    {
      gateway: () => gwClient,
      readConfig,
      assertMutable: assertCloudModelMutable,
      log: (message) => {
        console.info(message);
        sendToWindow(mainWindow, "gateway:log", message);
        electronLifecycleDiagnostics.log("model-config-application", { message });
      },
    },
    input,
  );
}

function prepareProviderCatalogModel(modelRef: string, expectedConfig: unknown): Promise<unknown> {
  return registerProviderCatalogModel(
    {
      gateway: () => gwClient,
      readConfig,
      assertMutable: assertCloudModelMutable,
      discover: (input) => discoverProviderModels(input, { ...process.env, ...loadStateDirEnv() }),
    },
    modelRef,
    expectedConfig,
  );
}

async function assertChatModelEnabled(sessionKey?: string): Promise<void> {
  let modelRef = getPrimaryModel(readConfig());
  if (sessionKey && gwClient && supportsLocalModelGatewayVersion(gwClient.serverVersion)) {
    modelRef = (await sessionModelService.get(sessionKey)).modelRef ?? modelRef;
  }
  assertModelProviderEnabled(modelRef, internalFeatures.githubCopilot);
  if (modelRef) assertChatModelSupported(modelRef);
}

async function withInternalModelChat<T>(
  operation: () => Promise<T>,
  sessionKey?: string,
): Promise<T> {
  if (modelConfigurationMutationInProgress)
    throw new Error("A model configuration change is being applied; wait for it to finish");
  localModelService.assertChatAllowed();
  sessionModelService.assertChatAllowed();
  const key = `internal:model-operation:${randomUUID()}`;
  activeModelSessions.add(key);
  try {
    await assertChatModelEnabled(sessionKey);
    return await operation();
  } finally {
    activeModelSessions.delete(key);
  }
}
const bundledWindowsNodeHost = new BundledWindowsNodeHost();
let bundledWindowsNodeStartup: Promise<void> | null = null;
let bundledWindowsNodeGeneration = 0;
let gatewayGenerationId = "";
let gatewayHttpReadyGeneration: string | null = null;
let windowsNodeMxcApprovalProofContext: BundledWindowsNodeApprovalProofContext | null = null;
let windowsNodeMxcCurrentAmbientAccess: BundledWindowsNodeAmbientAccess | null = null;
let windowsNodeMxcCurrentEffectiveTier: string | null = null;
let windowsNodeMxcIngressGeneration: string | null = null;
let windowsNodeMxcWeixinContext: WindowsNodeMxcWeixinContext | null = null;
const windowsNodeMxcWeixinRemoteApprovalBroker = new WindowsNodeMxcWeixinRemoteApprovalBroker(
  (event) => {
    try {
      const auditDir = path.join(app.getPath("userData"), "security-audit");
      fs.mkdirSync(auditDir, { recursive: true });
      fs.appendFileSync(
        path.join(auditDir, "weixin-remote-approval.jsonl"),
        `${JSON.stringify(event)}\n`,
        "utf8",
      );
    } catch (error) {
      console.error("[weixin-remote-approval] Could not write audit event:", error);
    }
  },
  () => readAuthenticatedWeixinWireOwner(getOpenClawStateDir()),
);
let windowsNodeMxcWeixinRemoteApprovalServer: WindowsNodeMxcWeixinRemoteApprovalServer | null =
  null;
const windowsNodeMxcWeixinRemoteApprovalSources = new Map<string, WeixinRemoteApprovalSource>();
let windowsNodeMxcActivationInProgress = false;
let windowsNodeMxcGatewayStartPolicyOverride: "active" | "locked" | null = null;
let windowsNodeMxcSecurityTransitionInProgress = false;
let windowsNodeMxcReadinessTransitionId: string | null = null;
const windowsNodeMxcLifecycleOperations = new WindowsNodeMxcLifecycleOperationCoordinator();
let windowsNodeMxcFolderPolicyMutationInProgress = false;
let windowsNodeMxcLifecycleState: WindowsNodeMxcFolderTransactionPhase = "idle";
let windowsNodeMxcLifecycleUpdatedAt = new Date().toISOString();
let windowsNodeMxcLifecycleDetail: string | null = null;
let explicitQuitRequested = false;
let mainWindowRecovery: Promise<void> | null = null;
const electronLifecycleDiagnostics = new ElectronLifecycleDiagnostics(
  () => path.join(app.getPath("userData"), "diagnostics", "electron-lifecycle.jsonl"),
  () => ({
    lifecycleActive: isWindowsNodeMxcLifecycleCritical(),
    lifecyclePhase: windowsNodeMxcLifecycleState,
    windowRecoveryActive: mainWindowRecovery !== null,
    gatewayPid: gatewayProcess?.pid ?? null,
    gatewayGeneration: gatewayGenerationId || null,
    explicitQuitRequested,
  }),
);
interface PendingWindowsNodeMxcGatewayApproval {
  request: WindowsNodeMxcGatewayApproval;
  gatewayGeneration: string;
  receivedAtUnixMs: number;
  expiresAtUnixMs: number;
  lifecycle: WindowsNodeMxcApprovalLifecycle;
  remoteDelivery: WeixinRemoteDeliveryState | null;
  remoteSource: WeixinRemoteApprovalSource | null;
  remoteSecurity: WeixinRemoteApprovalSecurityBinding | null;
  remoteChallengeId: string | null;
  remoteAttempt: Promise<unknown> | null;
  remoteCoordinator: WeixinRemoteDeliveryCoordinator;
  beginRemoteDelivery: (trigger: WeixinRemoteDeliveryTrigger) => void;
}
let pendingWindowsNodeMxcGatewayApproval: PendingWindowsNodeMxcGatewayApproval | null = null;
const queuedWindowsNodeMxcGatewayApprovals: PendingWindowsNodeMxcGatewayApproval[] = [];

function allPendingWindowsNodeMxcGatewayApprovals(): PendingWindowsNodeMxcGatewayApproval[] {
  return [
    ...(pendingWindowsNodeMxcGatewayApproval ? [pendingWindowsNodeMxcGatewayApproval] : []),
    ...queuedWindowsNodeMxcGatewayApprovals,
  ];
}

function findPendingWindowsNodeMxcGatewayApproval(id: string) {
  return allPendingWindowsNodeMxcGatewayApprovals().find((pending) => pending.request.id === id);
}
let windowsNodeMxcFailClosedPromise: Promise<void> | null = null;
let windowsNodeMxcStartupTiming: {
  startedAt: number;
  previousAt: number;
  generation: string | null;
} | null = null;
let windowsNodeMxcDurableApprovalStore: WindowsNodeMxcDurableApprovalStore | null = null;
let windowsNodeMxcDurableApprovalOperation: Promise<void> = Promise.resolve();
let windowsNodeMxcApprovalResolutionInProgress = false;
let windowsNodeMxcApprovalResolutionCompletion: Promise<void> | null = null;
let windowsNodeMxcGatewayApprovalResolutionTarget: {
  id: string;
  decision: "allow-once" | "deny";
  observedDecision: "allow-once" | "deny" | null;
} | null = null;
const WINDOWS_NODE_MXC_CRON_RESUME_ACK_TIMEOUT_MS = 30_000;
type WindowsNodeMxcFolderPolicyRecovery = {
  previous: WindowsNodeMxcFolderPolicy;
  draft: WindowsNodeMxcFolderPolicy;
  updatedAt: string;
  lastError: string | null;
  failurePhase?: WindowsNodeMxcFolderTransactionPhase | null;
};

function isWindowsNodeMxcLifecycleCritical(): boolean {
  return (
    windowsNodeMxcLifecycleOperations.active ||
    windowsNodeMxcSecurityTransitionInProgress ||
    windowsNodeMxcActivationInProgress
  );
}

function lifecycleWindowState() {
  return {
    lifecycleActive: isWindowsNodeMxcLifecycleCritical(),
    recoveryActive: mainWindowRecovery !== null,
    explicitQuitRequested,
  };
}

function requestExplicitQuit(source: string): void {
  if (!explicitQuitRequested) {
    explicitQuitRequested = true;
    electronLifecycleDiagnostics.log("explicit-quit-requested", { source });
  }
  app.quit();
}

process.on("uncaughtException", (error: NodeJS.ErrnoException) => {
  electronLifecycleDiagnostics.log("uncaught-exception", {
    error: summarizeLifecycleError(error),
  });
  if (error.code === "EPIPE") return;
  throw error;
});

process.on("unhandledRejection", (reason) => {
  electronLifecycleDiagnostics.log("unhandled-rejection", {
    error: summarizeLifecycleError(reason),
  });
  throw reason instanceof Error
    ? reason
    : new Error("Unhandled promise rejection", { cause: reason });
});

electronLifecycleDiagnostics.log("main-process-start", { processId: process.pid });
logStartupTiming("main-process-start");

async function tryConsumeWindowsNodeMxcCronResumeAcknowledgement(): Promise<boolean> {
  const fence = parseWindowsNodeMxcCronResumeFence(
    settingsStore.get("windowsNodeMxcCronResumeFence"),
  );
  if (!fence) return true;
  try {
    const acknowledgement = JSON.parse(
      await fs.promises.readFile(fence.acknowledgementPath, "utf8"),
    );
    if (!isWindowsNodeMxcCronResumeAcknowledgement(acknowledgement, fence)) return false;
    settingsStore.delete("windowsNodeMxcCronResumeFence");
    await fs.promises.rm(fence.acknowledgementPath, { force: true });
    console.log("[cron] consumed acknowledged MXC no-catch-up resume fence");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function waitForWindowsNodeMxcCronResumeAcknowledgement(): Promise<void> {
  if (await tryConsumeWindowsNodeMxcCronResumeAcknowledgement()) return;
  const deadline = Date.now() + WINDOWS_NODE_MXC_CRON_RESUME_ACK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await tryConsumeWindowsNodeMxcCronResumeAcknowledgement()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for MXC Cron no-catch-up resume acknowledgement");
}

async function withWindowsNodeMxcDurableApprovalLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = windowsNodeMxcDurableApprovalOperation;
  let release!: () => void;
  windowsNodeMxcDurableApprovalOperation = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}
// This gate covers MicroClaw-owned ingress. Independently configured upstream Gateway ingress is
// outside this experimental mode's accepted boundary and must not share the app-owned Gateway.
let gatewayStatus: GatewayStatus = "stopped";
const weixinMutations = new WeixinMutationCoordinator();
const weixinQrSession = new WeixinQrSession();
let weixinRuntimeRead: {
  gateway: GatewayClient;
  generation: number;
  expiresAt: number;
  promise: ReturnType<GatewayClient["getChannelsStatus"]>;
} | null = null;

async function readWeixinRuntimeStatus() {
  const gateway = gwClient;
  if (!gateway?.connected) return null;
  if (
    !weixinRuntimeRead ||
    weixinRuntimeRead.gateway !== gateway ||
    weixinRuntimeRead.generation !== gateway.connectionGeneration ||
    Date.now() >= weixinRuntimeRead.expiresAt
  ) {
    weixinRuntimeRead = {
      gateway,
      generation: gateway.connectionGeneration,
      expiresAt: Date.now() + 2_000,
      promise: gateway.getChannelsStatus(1_500),
    };
  }
  const read = weixinRuntimeRead;
  try {
    const status = await read.promise;
    return gwClient === gateway &&
      gateway.connected &&
      read.generation === gateway.connectionGeneration
      ? status
      : null;
  } catch {
    return null;
  }
}

async function waitForWeixinConnection(params: {
  sessionKey?: string;
  accountId?: string;
  timeoutMs?: number;
}) {
  return weixinMutations.run(assertWindowsNodeMxcConfigurationMutable, async () => {
    const qrEpoch = weixinMutations.requireQr();
    if (!gwClient?.connected) {
      weixinMutations.qrUnconfirmed(qrEpoch);
      return { connected: false, message: "Gateway not connected", restartRequired: true };
    }
    try {
      const result = await gwClient.weixinLoginQrWait(params);
      if (result.connected || !result.pending) weixinMutations.qrConnected(qrEpoch);
      if (result.connected) {
        weixinRuntimeRead = null;
        reconcileWindowsNodeMxcWeixinRemoteApprovalOwner("weixin-account-replaced");
      }
      return result;
    } catch (error) {
      weixinMutations.qrUnconfirmed(qrEpoch);
      return {
        connected: false,
        message: error instanceof Error ? error.message : String(error),
        restartRequired: true,
      };
    }
  });
}
let weixinMutationLockRevision = 0;

function getWeixinMutationLock() {
  return {
    locked: isWindowsNodeMxcDesired() || windowsNodeMxcSecurityTransitionInProgress,
    revision: weixinMutationLockRevision,
  };
}

function publishWeixinMutationLock(): void {
  weixinMutationLockRevision++;
  mainWindow?.webContents.send("plugin:weixin:mutation-lock", getWeixinMutationLock());
}

function beginWindowsNodeMxcLifecycleOperation(disabling = false): void {
  if (windowsNodeMxcFailClosedPromise) {
    throw new Error("Wait for the current Windows Node + MXC fail-closed recovery to finish");
  }
  if (windowsNodeMxcSecurityTransitionInProgress) {
    throw new Error("Another Windows Node + MXC lifecycle operation is already in progress");
  }
  if (gatewayRestarting || gatewayRestartPromise || gatewayStartInProgress) {
    throw new Error("Wait for the managed Gateway startup or restart to finish");
  }
  if (windowsNodeMxcFolderPolicyMutationInProgress) {
    throw new Error("Wait for the approved folder policy change to finish");
  }
  if (windowsNodeMxcApprovalResolutionInProgress) {
    throw new Error("Wait for the current Windows Node + MXC approval response to finish");
  }
  if (!disabling) weixinMutations.assertActivationAvailable(!!weixinLoginProcess);
  windowsNodeMxcSecurityTransitionInProgress = true;
  publishWeixinMutationLock();
  windowsNodeMxcReadinessTransitionId = randomUUID();
  electronLifecycleDiagnostics.log("mxc-lifecycle-start");
}

function endWindowsNodeMxcLifecycleOperation(): void {
  windowsNodeMxcSecurityTransitionInProgress = false;
  publishWeixinMutationLock();
  windowsNodeMxcReadinessTransitionId = null;
  electronLifecycleDiagnostics.log("mxc-lifecycle-settled");
}

function windowsNodeMxcLifecycleOperationHooks(requestedMode?: WindowsNodeMxcRequestedMode) {
  return {
    beforeStart: () => beginWindowsNodeMxcLifecycleOperation(requestedMode === "off"),
    afterSettled: endWindowsNodeMxcLifecycleOperation,
  };
}

function runTrackedWindowsNodeMxcLifecycleOperation<T>(
  descriptor: WindowsNodeMxcLifecycleOperationDescriptor,
  operation: () => Promise<T>,
): Promise<T> {
  return windowsNodeMxcLifecycleOperations.run(
    descriptor,
    operation,
    windowsNodeMxcLifecycleOperationHooks(),
  );
}

async function withWindowsNodeMxcApprovalResolution<T>(operation: () => Promise<T>): Promise<T> {
  if (windowsNodeMxcFailClosedPromise || windowsNodeMxcSecurityTransitionInProgress) {
    throw new Error("Approval responses are blocked during an MXC lifecycle transition");
  }
  while (windowsNodeMxcApprovalResolutionCompletion)
    await windowsNodeMxcApprovalResolutionCompletion;
  if (windowsNodeMxcFailClosedPromise || windowsNodeMxcSecurityTransitionInProgress) {
    throw new Error("Approval responses are blocked during an MXC lifecycle transition");
  }
  windowsNodeMxcApprovalResolutionInProgress = true;
  let completeApprovalResolution!: () => void;
  const approvalResolution = new Promise<void>((resolve) => {
    completeApprovalResolution = resolve;
  });
  windowsNodeMxcApprovalResolutionCompletion = approvalResolution;
  try {
    return await operation();
  } finally {
    windowsNodeMxcApprovalResolutionInProgress = false;
    completeApprovalResolution();
    if (windowsNodeMxcApprovalResolutionCompletion === approvalResolution) {
      windowsNodeMxcApprovalResolutionCompletion = null;
    }
  }
}

function setWindowsNodeMxcLifecycleState(
  state: WindowsNodeMxcFolderTransactionPhase,
  detail: string | null = null,
): void {
  windowsNodeMxcLifecycleState = state;
  windowsNodeMxcLifecycleDetail = detail;
  windowsNodeMxcLifecycleUpdatedAt = new Date().toISOString();
  electronLifecycleDiagnostics.log("mxc-lifecycle-phase", {
    phase: state,
    detail: detail ? summarizeLifecycleError(detail) : null,
  });
  sendToWindow(mainWindow, "windows-node-mxc:lifecycle-state", {
    phase: state,
    detail,
    updatedAt: windowsNodeMxcLifecycleUpdatedAt,
  });
}
let gatewayStartupAttempt = 0;
let currentGatewayStartupTiming: GatewayStartupTiming | null = null;

function stopBundledWindowsNodeHost(requireTreeTermination = false): void {
  bundledWindowsNodeGeneration++;
  bundledWindowsNodeStartup = null;
  bundledWindowsNodeHost.stop(requireTreeTermination);
}

function logStartupTiming(
  phase: string,
  owner: "microclaw" | "openclaw" | "integration" = "microclaw",
): void {
  console.log(
    `[startup-timing] ${phase} +${Math.round(performance.now())}ms owner=${owner} generation=${gatewayGenerationId || "pending"}`,
  );
}

function logGatewayStartupTiming(event: StartupTimingEvent): void {
  const prefix = event.kind === "summary" ? "startup-summary" : "startup-breakdown";
  console.info(`[${prefix}] ${JSON.stringify(event)}`);
  if (event.kind === "summary") {
    electronLifecycleDiagnostics.log("startup-summary", { ...event });
  }
}

function beginWindowsNodeMxcStartupTiming(): void {
  const now = Date.now();
  windowsNodeMxcStartupTiming = { startedAt: now, previousAt: now, generation: null };
}

function markWindowsNodeMxcStartupTiming(phase: string, detail = ""): void {
  const timing = windowsNodeMxcStartupTiming;
  if (!timing) return;
  const now = Date.now();
  if (gatewayGenerationId) timing.generation = gatewayGenerationId;
  console.log(
    `[windows-node-mxc][startup-timing] phase=${phase} durationMs=${now - timing.previousAt} totalMs=${now - timing.startedAt} generation=${timing.generation ?? "pending"}${detail ? ` ${detail}` : ""}`,
  );
  timing.previousAt = now;
}

function setGatewayStatus(status: GatewayStatus): void {
  gatewayStatus = status;
  updateTrayMenu(status, resolveSupportedLocale(settingsStore.get("language") ?? "en-US"));
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("gateway:status", status);
  }
}
let weixinLoginProcess: ChildProcess | null = null;
let pendingIntegrityResult: IntegrityResult | null = null;
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;
let gatewayRestarting = false;
let gatewayRestartPromise: Promise<void> | null = null;
let gatewayStopPromise: Promise<void> | null = null;
let applicationQuitReady = false;
let applicationQuitPromise: Promise<void> | null = null;
/** True when we spawned the gateway ourselves (vs. connecting to an existing one). */
let gatewaySpawnedByUs = false;
let agentRosterChangeInProgress = false;
let postSpawnChannelCheckRequired = false;
let postSpawnChannelCheckCompletedFor: ChildProcess | null = null;
let postSpawnChannelCheck: symbol | null = null;
const postInstallTransactionIndex = process.argv.indexOf("--post-install-transaction");
const postInstallTransactionId =
  postInstallTransactionIndex >= 0 ? process.argv[postInstallTransactionIndex + 1] : undefined;
let postInstallReadySignaled = false;

function signalPostInstallReady(): void {
  if (!postInstallTransactionId || postInstallReadySignaled) return;
  const readyDir = path.join(app.getPath("home"), ".microclaw", "upgrade");
  const readyPath = path.join(readyDir, `desktop-ready-${postInstallTransactionId}.json`);
  const temporary = `${readyPath}.${process.pid}.tmp`;
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(
    temporary,
    JSON.stringify({ transactionId: postInstallTransactionId, pid: process.pid }),
    "utf-8",
  );
  fs.renameSync(temporary, readyPath);
  postInstallReadySignaled = true;
  logStartupTiming("post-install-ready");
}

function signalPostInstallFailure(error: unknown): void {
  if (!postInstallTransactionId) return;
  const readyDir = path.join(app.getPath("home"), ".microclaw", "upgrade");
  const readyPath = path.join(readyDir, `desktop-ready-${postInstallTransactionId}.json`);
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(
    readyPath,
    JSON.stringify({
      transactionId: postInstallTransactionId,
      pid: process.pid,
      error: error instanceof Error ? error.message : String(error),
    }),
    "utf-8",
  );
}
const githubCopilotAuthManager = new GitHubCopilotAuthManager(
  (event) => {
    if (event.status !== "code") githubCopilotLoginInProgress = false;
    mainWindow?.webContents.send("model:github-copilot:login-event", event);
    if (event.status === "success") void refreshGatewayGitHubCopilotAuthStatus();
  },
  (url) => shell.openExternal(url),
);

// ---------------------------------------------------------------------------
// Skill file watcher — detects mid-session tampering
// ---------------------------------------------------------------------------
let skillWatchers: fs.FSWatcher[] = [];
let watcherDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function startSkillFileWatcher(): void {
  // Clean up any existing watchers
  for (const w of skillWatchers) {
    try {
      w.close();
    } catch {}
  }
  skillWatchers = [];

  for (const { baseDir } of getSkillSourceDirs()) {
    if (!fs.existsSync(baseDir)) continue;
    try {
      const watcher = fs.watch(baseDir, { recursive: true }, () => {
        // Debounce — multiple FS events fire for a single change
        if (watcherDebounceTimer) clearTimeout(watcherDebounceTimer);
        watcherDebounceTimer = setTimeout(() => {
          console.log("Skill file change detected — running integrity check...");
          const result = verifySkillIntegrity();
          if (!result.valid && mainWindow) {
            mainWindow.webContents.send("skills:integrity-alert", result);
          }
        }, 2000);
      });
      skillWatchers.push(watcher);
      console.log(`Watching skill directory: ${baseDir}`);
    } catch (err) {
      console.warn(`Failed to watch ${baseDir}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------
function getConfigPath(): string {
  return path.join(getOpenClawStateDir(), "openclaw.json");
}

// ---------------------------------------------------------------------------
// Workspace seed — create default files before the gateway generates its own
// ---------------------------------------------------------------------------
const DEFAULT_SOUL_MD = `# SOUL.md - Who You Are

_You're not a chatbot. You're becoming someone._

${MAIN_PLATFORM_IDENTITY_SECTION}

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip the "Great question!" and "I'd be happy to help!" — just help. Actions speak louder than filler words.

**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing or boring. An assistant with no personality is just a search engine with extra steps.

**Be resourceful before asking.** Try to figure it out. Read the file. Check the context. Search for it. _Then_ ask if you're stuck. The goal is to come back with answers, not questions.

**Earn trust through competence.** Your human gave you access to their stuff. Don't make them regret it. Be careful with external actions (emails, tweets, anything public). Be bold with internal ones (reading, organizing, learning).

**Remember you're a guest.** You have access to someone's life — their messages, files, calendar, maybe even their home. That's intimacy. Treat it with respect.

## Boundaries

- Private things stay private. Period.
- When in doubt, ask before acting externally.
- Never send half-baked replies to messaging surfaces.
- You're not the user's voice — be careful in group chats.

## File Operations

**Respect the user's requested path — always.** When the user asks you to save, write, or download a file to a specific location (e.g. their Downloads folder, Desktop, or any explicit path), you **must** attempt that exact path. If the operation fails (e.g. due to sandbox restrictions or permission errors), report the failure clearly and let the user decide what to do next. **Never** silently fall back to the workspace or any other directory. The user chose that path for a reason.

## Pre-declaring File System Access

Before **any** shell command (exec tool) that reads or writes files outside the workspace, pre-declare which directories you'll need by adding a \`[declare-access]\` tag at the beginning of the command:

\`\`\`
# [declare-access]<access>:<path>[;<access>:<path>]...[/declare-access]
<your actual command here>
\`\`\`

Where \`<access>\` is \`rw\` (read-write) or \`ro\` (read-only).

Examples:
\`\`\`
# [declare-access]ro:C:\\Users\\alice\\Desktop[/declare-access]
Get-ChildItem -Force C:\\Users\\alice\\Desktop
\`\`\`

\`\`\`
# [declare-access]rw:C:\\Users\\alice\\Desktop;rw:C:\\Users\\alice\\Documents[/declare-access]
Move-Item C:\\Users\\alice\\Desktop\\report.xlsx C:\\Users\\alice\\Documents\\
\`\`\`

\`\`\`
# [declare-access]rw:$env:USERPROFILE\\Downloads[/declare-access]
python download_script.py
\`\`\`

Multiple paths are separated by \`;\` inside the tags. Each path needs its own \`ro:\` or \`rw:\` prefix.

**Important:** The \`[declare-access]...[/declare-access]\` tags must be in a **comment line in the shell command** (using \`#\`), NOT in a script file. Place it on the **first line**, followed by a newline, then the actual command. The system extracts the declaration, strips the tag line, and executes the rest.

**Rules:**
- **Always** do this for any exec command that touches directories outside the workspace — whether it's a simple one-liner or a complex script.
- Use \`ro:\` when you only need to read. Use \`rw:\` when you need to create, modify, or delete files.
- List **only** the specific directories the operation actually needs. Never declare broad paths like \`C:\\\` or \`C:\\Users\`. Don't request rw access if you only need ro.
- Paths must be **Windows file system paths** (e.g. \`C:\\Users\\alice\\Desktop\`). Do not declare URLs, network URIs, or Linux-style paths.
- You may combine multiple paths in a single call, separated by \`;\`.

You can also use \`[declare-access]...[/declare-access]\` as a standalone command if you need to check permissions before deciding what to do.

## Vibe

Be the assistant you'd actually want to talk to. Concise when needed, thorough when it matters. Not a corporate drone. Not a sycophant. Just... good.

## Continuity

Each session, you wake up fresh. These files _are_ your memory. Read them. Update them. They're how you persist.

If you change this file, tell the user — it's your soul, and they should know.

---

_This file is yours to evolve. As you learn who you are, update it._
`;

/**
 * Standalone declare-access section, appended to existing SOUL.md files
 * that were created before this section existed.
 */
const DECLARE_ACCESS_SECTION = `## Pre-declaring File System Access

Before **any** shell command (exec tool) that reads or writes files outside the workspace, pre-declare which directories you'll need by adding a \`[declare-access]\` tag at the beginning of the command:

\`\`\`
# [declare-access]<access>:<path>[;<access>:<path>]...[/declare-access]
<your actual command here>
\`\`\`

Where \`<access>\` is \`rw\` (read-write) or \`ro\` (read-only).

Examples:
\`\`\`
# [declare-access]ro:C:\\Users\\alice\\Desktop[/declare-access]
Get-ChildItem -Force C:\\Users\\alice\\Desktop
\`\`\`

\`\`\`
# [declare-access]rw:C:\\Users\\alice\\Desktop;rw:C:\\Users\\alice\\Documents[/declare-access]
Move-Item C:\\Users\\alice\\Desktop\\report.xlsx C:\\Users\\alice\\Documents\\
\`\`\`

\`\`\`
# [declare-access]rw:$env:USERPROFILE\\Downloads[/declare-access]
python download_script.py
\`\`\`

Multiple paths are separated by \`;\` inside the tags. Each path needs its own \`ro:\` or \`rw:\` prefix.

**Important:** The \`[declare-access]...[/declare-access]\` tags must be in a **comment line in the shell command** (using \`#\`), NOT in a script file. Place it on the **first line**, followed by a newline, then the actual command. The system extracts the declaration, strips the tag line, and executes the rest.

**Rules:**
- **Always** do this for any exec command that touches directories outside the workspace — whether it's a simple one-liner or a complex script.
- Use \`ro:\` when you only need to read. Use \`rw:\` when you need to create, modify, or delete files.
- List **only** the specific directories the operation actually needs. Never declare broad paths like \`C:\\\` or \`C:\\Users\`. Don't request rw access if you only need ro.
- Paths must be **Windows file system paths** (e.g. \`C:\\Users\\alice\\Desktop\`). Do not declare URLs, network URIs, or Linux-style paths.
- You may combine multiple paths in a single call, separated by \`;\`.

You can also use \`[declare-access]...[/declare-access]\` as a standalone command if you need to check permissions before deciding what to do.
`;

/**
 * Seed default workspace files if they don't already exist.
 * Called before the gateway starts so that OpenClaw finds our customised
 * SOUL.md instead of generating a generic one on first conversation.
 */
function seedWorkspaceFiles(stateDir: string): void {
  const workspaceDir = path.join(stateDir, "workspace");
  const soulPath = path.join(workspaceDir, "SOUL.md");

  if (fs.existsSync(soulPath)) {
    // SOUL.md exists — ensure the declare-access section is present.
    // This patches existing SOUL.md files from older versions that lack it.
    try {
      const existing = fs.readFileSync(soulPath, "utf-8");
      if (!existing.includes("## Pre-declaring File System Access")) {
        fs.appendFileSync(soulPath, "\n" + DECLARE_ACCESS_SECTION, "utf-8");
        console.log("[seed] Patched SOUL.md with Pre-declaring File System Access section");
      }
    } catch (err) {
      console.warn("[seed] Failed to patch SOUL.md:", err);
    }
  } else {
    try {
      if (!fs.existsSync(workspaceDir)) {
        fs.mkdirSync(workspaceDir, { recursive: true });
      }
      fs.writeFileSync(soulPath, DEFAULT_SOUL_MD, "utf-8");
      console.log(`[seed] Created default SOUL.md at ${soulPath}`);
    } catch (err) {
      console.warn("[seed] Failed to create SOUL.md:", err);
    }
  }

  // Remove BOOTSTRAP.md to skip the OpenClaw first-run wizard (OOBE).
  // Our SOUL.md seed replaces the need for the bootstrap flow.
  for (const bootstrapDir of [workspaceDir, path.join(stateDir, "agents", "default")]) {
    const bootstrapPath = path.join(bootstrapDir, "BOOTSTRAP.md");
    try {
      if (fs.existsSync(bootstrapPath)) {
        fs.unlinkSync(bootstrapPath);
        console.log(`[seed] Removed ${bootstrapPath} to skip OOBE`);
      }
    } catch {}
  }
}

function readConfig(): any {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
  } catch {
    return null;
  }
}

function resolveWindowsNodeMxcWeixinCredentialsDir(stateDir: string): string | undefined {
  const oauthDir = loadGatewayEnvironment(stateDir).OPENCLAW_OAUTH_DIR?.trim();
  return oauthDir ? path.resolve(path.dirname(resolveOpenClawEntry()), oauthDir) : undefined;
}

function getWeixinRemoteApprovalActivationOptions(
  config: unknown = readConfig(),
): WeixinRemoteApprovalActivationOptions {
  const stateDir = getOpenClawStateDir();
  return readWeixinRemoteApprovalActivationOptions({
    stateDir,
    config,
  });
}

function assertTrustedRendererIpc(event: IpcMainInvokeEvent): void {
  const window = mainWindow;
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== event.sender.mainFrame ||
    !isTrustedRendererUrl(event.senderFrame.url, {
      development: isDev,
      developmentUrl: VITE_DEV_URL,
      packagedIndexPath: PACKAGED_RENDERER_INDEX_PATH,
    })
  ) {
    throw new Error("Windows Node + MXC activation requires the trusted MicroClaw renderer");
  }
}

function getWindowsNodeMxcWeixinRemoteApprovalConfiguration(): WeixinRemoteApprovalConfiguration {
  const stored = settingsStore.get("windowsNodeMxcWeixinRemoteApproval");
  const migrated = migrateWeixinRemoteApprovalConfiguration(stored);
  if (JSON.stringify(stored) !== JSON.stringify(migrated)) {
    settingsStore.set("windowsNodeMxcWeixinRemoteApproval", migrated);
  }
  const configuration = projectWeixinRemoteApprovalRuntimeConfiguration(
    migrated,
    isWindowsNodeMxcDesired() && isAuthenticatedWeixinRemoteApprovalOwner(migrated.owner),
  );
  try {
    windowsNodeMxcWeixinRemoteApprovalBroker.configure(configuration);
  } catch (error) {
    console.error("[weixin-remote-approval] Invalid stored owner binding:", error);
    settingsStore.set("windowsNodeMxcWeixinRemoteApproval", {
      enabled: false,
      owner: null,
    });
    windowsNodeMxcWeixinRemoteApprovalBroker.configure({ enabled: false, owner: null });
    return { enabled: false, owner: null };
  }
  return configuration;
}

function readAuthenticatedWeixinOwners(): WeixinRemoteApprovalOwnerBinding[] {
  const options = getWeixinRemoteApprovalActivationOptions();
  if (!options.enableAvailable || !options.account) return [];
  return [
    {
      contract: WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT,
      accountId: options.account.accountId,
      userId: options.account.userId,
      boundAt: new Date().toISOString(),
    },
  ];
}

function isAuthenticatedWeixinRemoteApprovalOwner(
  owner: WeixinRemoteApprovalOwnerBinding | null,
): owner is WeixinRemoteApprovalOwnerBinding {
  return Boolean(
    owner &&
    readAuthenticatedWeixinOwners().some(
      (candidate) => candidate.accountId === owner.accountId && candidate.userId === owner.userId,
    ),
  );
}

function currentWindowsNodeMxcWeixinRemoteApprovalSecurity(): WeixinRemoteApprovalSecurityBinding | null {
  const proof = windowsNodeMxcApprovalProofContext;
  const status = bundledWindowsNodeHost.status();
  const lease = status.activationLease;
  const requestedMode = getWindowsNodeMxcRequestedMode();
  const effectiveMode = windowsNodeMxcCurrentEffectiveTier ?? status.effectiveTier;
  if (
    !proof ||
    !lease ||
    windowsNodeMxcSecurityTransitionInProgress ||
    !status.processRunning ||
    requestedMode === "off" ||
    lease.mode !== "active" ||
    lease.expiresAtUnixMs <= Date.now() ||
    proof.gatewayGeneration !== gatewayGenerationId ||
    status.gatewayGeneration !== gatewayGenerationId ||
    status.nodeId !== proof.nodeId ||
    status.policyFingerprint !== proof.policyFingerprint ||
    status.requestedStrength !== requestedMode ||
    !effectiveMode ||
    status.effectiveTier !== effectiveMode ||
    lease.gatewayGeneration !== gatewayGenerationId ||
    lease.policyFingerprint !== proof.policyFingerprint
  ) {
    return null;
  }
  const activationLeaseHash = bundledWindowsNodeHost.getActivationLeaseBindingHash(proof);
  if (!activationLeaseHash) return null;
  return {
    gatewayGeneration: gatewayGenerationId,
    policyFingerprint: proof.policyFingerprint,
    nodeId: proof.nodeId,
    activationLeaseHash,
    requestedMode,
    effectiveMode,
  };
}

function closeWindowsNodeMxcWeixinRemoteApproval(reason: string, deliverNotices = true): void {
  const notices = windowsNodeMxcWeixinRemoteApprovalBroker.invalidateAll(reason);
  windowsNodeMxcWeixinRemoteApprovalSources.clear();
  const server = windowsNodeMxcWeixinRemoteApprovalServer;
  windowsNodeMxcWeixinRemoteApprovalServer = null;
  if (!server) return;
  if (!deliverNotices || notices.length === 0) {
    server.close();
    return;
  }
  void Promise.allSettled(
    notices.map((notice) => deliverWindowsNodeMxcWeixinRemoteApprovalNotice(server, notice)),
  ).finally(() => server.close());
}

function reconcileWindowsNodeMxcWeixinRemoteApprovalOwner(reason: string): void {
  const configuration = migrateWeixinRemoteApprovalConfiguration(
    settingsStore.get("windowsNodeMxcWeixinRemoteApproval"),
  );
  if (!configuration.owner) return;
  const accountStatus = readWeixinAccountStatus(getOpenClawStateDir());
  if (!shouldRevokeWeixinRemoteApprovalOwner(accountStatus, configuration.owner)) {
    return;
  }
  closeWindowsNodeMxcWeixinRemoteApproval(reason, false);
  const disabled = { enabled: false, owner: null };
  settingsStore.set("windowsNodeMxcWeixinRemoteApproval", disabled);
  windowsNodeMxcWeixinRemoteApprovalBroker.configure(disabled);
  electronLifecycleDiagnostics.log("weixin-remote-approval-owner-revoked", { reason });
}

function persistWindowsNodeMxcWeixinRemoteApprovalPlan(
  plan: WeixinRemoteApprovalTransitionPlan,
  disabledReason: string,
): void {
  if (plan.action === "preserve") return;
  if (!plan.configuration.enabled) {
    closeWindowsNodeMxcWeixinRemoteApproval(disabledReason);
  }
  settingsStore.set("windowsNodeMxcWeixinRemoteApproval", plan.configuration);
  windowsNodeMxcWeixinRemoteApprovalBroker.configure(plan.configuration);
}

async function deliverWindowsNodeMxcWeixinRemoteApprovalNotice(
  server: WindowsNodeMxcWeixinRemoteApprovalServer,
  notice: WeixinRemoteApprovalNotice,
): Promise<void> {
  if (!windowsNodeMxcWeixinRemoteApprovalBroker.isAuthenticatedSource(notice)) {
    console.info("[weixin-remote-approval]", { reason: "notice-owner-unavailable" });
    return;
  }
  await server.deliver({
    accountId: notice.accountId,
    kind: "terminal",
    terminalChallengeId: notice.challengeId,
    to: notice.senderId,
    text: notice.acknowledgement,
    onDiagnostic: (diagnostic) =>
      console.info("[weixin-remote-approval-delivery]", JSON.stringify(diagnostic)),
  });
}

async function handleWindowsNodeMxcWeixinRemoteApprovalInbound(
  inbound: WeixinRemoteApprovalInboundEnvelope,
): Promise<{ consumed: boolean; acknowledgement?: string }> {
  if (inbound.sourcePhase === "complete") {
    for (const [key, existing] of windowsNodeMxcWeixinRemoteApprovalSources) {
      if (
        existing.messageId === inbound.messageId &&
        existing.accountId === inbound.accountId &&
        existing.senderId === inbound.senderId &&
        existing.agentId === inbound.agentId
      ) {
        windowsNodeMxcWeixinRemoteApprovalSources.delete(key);
      }
    }
    return { consumed: false };
  }
  if (inbound.sourcePhase === "run") {
    const source = bindWeixinApprovalRun(
      windowsNodeMxcWeixinRemoteApprovalSources,
      inbound,
      gatewayGenerationId,
    );
    console.info(
      "[weixin-remote-approval-context]",
      JSON.stringify(
        describeWeixinApprovalDecision(
          "weixin-run-registration",
          source ? "source-run-bound" : "source-run-binding-rejected",
          undefined,
          inbound,
          source ? inbound.runId : undefined,
        ),
      ),
    );
    if (source) {
      for (const pending of allPendingWindowsNodeMxcGatewayApprovals()) {
        if (
          pending.lifecycle.pending &&
          pending.gatewayGeneration === gatewayGenerationId &&
          !pending.remoteChallengeId &&
          exactWeixinApprovalSource(
            getWindowsNodeMxcWeixinRemoteApprovalConfiguration(),
            source,
            pending.request,
            readAuthenticatedWeixinWireOwner(getOpenClawStateDir()),
          ) === null
        ) {
          pending.remoteSource = source;
          // No send was attempted for an unbound source; never retry an unknown delivery.
          if (pending.remoteDelivery?.reason === "source-run-mismatch")
            pending.beginRemoteDelivery("source-bound");
        }
      }
    } else {
      console.warn("[weixin-remote-approval]", { reason: "source-run-binding-rejected" });
    }
    return { consumed: false };
  }
  const exactCandidate =
    /^[123]$/.test(inbound.text) ||
    /^([123]) ([23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8})$/i.test(inbound.text);
  const candidateLike =
    (inbound.sourcePhase === "candidate" || inbound.sourcePhase === "start") &&
    (exactCandidate || inbound.ambiguous);
  let simpleChallengeId = /^[123]$/.test(inbound.text)
    ? windowsNodeMxcWeixinRemoteApprovalBroker.captureSimpleReplyChallenge(inbound)
    : undefined;
  const configuration = getWindowsNodeMxcWeixinRemoteApprovalConfiguration();
  if (!configuration.enabled || !configuration.owner) {
    if (!candidateLike) return { consumed: false };
    const inactiveResult = windowsNodeMxcWeixinRemoteApprovalBroker.resolveCandidate({
      ...inbound,
      ambiguous: inbound.ambiguous,
    });
    return {
      consumed: true,
      acknowledgement: inactiveResult.consumed ? inactiveResult.acknowledgement : undefined,
    };
  }
  const pending = pendingWindowsNodeMxcGatewayApproval;
  if (pending && candidateLike) {
    try {
      await requireEffectiveWindowsNodeMxc(true, false);
      if (!currentWindowsNodeMxcWeixinRemoteApprovalSecurity()) {
        throw new Error("The current remote approval activation authority is unavailable");
      }
    } catch {
      if (simpleChallengeId !== undefined) {
        windowsNodeMxcWeixinRemoteApprovalBroker.resolveCandidate({
          ...inbound,
          expectedSimpleChallengeId: null,
        });
      }
      return {
        consumed: true,
        acknowledgement: "MicroClaw Security Approval: invalid or no longer active.",
      };
    }
  }
  const revalidatedConfiguration = getWindowsNodeMxcWeixinRemoteApprovalConfiguration();
  const sourceRejection = weixinRemoteApprovalWireSourceRejection(
    revalidatedConfiguration,
    inbound,
    readAuthenticatedWeixinWireOwner(getOpenClawStateDir()),
  );
  if (
    !revalidatedConfiguration.enabled ||
    !revalidatedConfiguration.owner ||
    sourceRejection !== null ||
    !windowsNodeMxcWeixinRemoteApprovalBroker.isAuthenticatedSource(inbound)
  ) {
    if (inbound.sourcePhase === "start") {
      console.info(
        "[weixin-remote-approval-context]",
        JSON.stringify(
          describeWeixinApprovalDecision(
            "weixin-source-validation",
            sourceRejection ?? "source-owner-unavailable",
            undefined,
            inbound,
          ),
        ),
      );
    }
    return {
      consumed: candidateLike,
      acknowledgement: candidateLike
        ? "MicroClaw Security Approval: invalid or no longer active."
        : undefined,
    };
  }
  if (pending && simpleChallengeId) {
    const generation = gatewayGenerationId;
    const client = gwClient;
    let route: { sessionKey: string; agentId: string } | null = null;
    try {
      if (!client?.connected) throw new Error("Gateway route resolver is unavailable");
      route = await resolveWeixinSessionRoute(inbound, (method, params) =>
        client.request(method, params, 3_000),
      );
    } catch {
      console.info(
        "[weixin-remote-approval-context]",
        JSON.stringify(
          describeWeixinApprovalDecision(
            "weixin-source-validation",
            "source-route-unresolved",
            pending.request,
            inbound,
          ),
        ),
      );
    }
    const current = getWindowsNodeMxcWeixinRemoteApprovalConfiguration();
    const replySourceRejection = weixinRemoteApprovalWireSourceRejection(
      current,
      inbound,
      readAuthenticatedWeixinWireOwner(getOpenClawStateDir()),
    );
    if (
      !route ||
      !current.enabled ||
      !current.owner ||
      replySourceRejection !== null ||
      generation !== gatewayGenerationId ||
      client !== gwClient ||
      !client?.connected ||
      pending !== pendingWindowsNodeMxcGatewayApproval ||
      pending.request.origin?.gatewayGeneration !== generation ||
      route.agentId !== pending.request.agent ||
      route.sessionKey !== (pending.request.origin?.runSessionKey ?? pending.request.sessionKey) ||
      current.owner?.boundAt !== revalidatedConfiguration.owner.boundAt ||
      current.consentScope !== revalidatedConfiguration.consentScope ||
      windowsNodeMxcSecurityTransitionInProgress ||
      !windowsNodeMxcWeixinRemoteApprovalBroker.isAuthenticatedSource(inbound)
    ) {
      console.info(
        "[weixin-remote-approval-context]",
        JSON.stringify(
          describeWeixinApprovalDecision(
            "weixin-source-validation",
            replySourceRejection ?? "security-binding-invalid",
            pending.request,
            inbound,
          ),
        ),
      );
      simpleChallengeId = null;
    }
  }
  const security = currentWindowsNodeMxcWeixinRemoteApprovalSecurity();
  const candidateResult = windowsNodeMxcWeixinRemoteApprovalBroker.resolveCandidate({
    ...inbound,
    ambiguous: inbound.ambiguous,
    requests: pending ? [{ approval: pending.request }] : undefined,
    security: pending ? (security ?? undefined) : undefined,
    expectedSimpleChallengeId: simpleChallengeId,
  });
  if (candidateResult.consumed) {
    if (candidateResult.status === "approved" || candidateResult.status === "denied") {
      try {
        if (!security) {
          throw new Error("The remote approval security binding is unavailable");
        }
        for (const approvalId of candidateResult.approvalIds) {
          await resolvePendingWindowsNodeMxcGatewayApproval(
            approvalId,
            candidateResult.decision,
            true,
            security,
          );
        }
        windowsNodeMxcWeixinRemoteApprovalBroker.completeResolution(
          candidateResult.challengeId,
          candidateResult.status,
        );
        return { consumed: true };
      } catch (error) {
        windowsNodeMxcWeixinRemoteApprovalBroker.failResolution(
          candidateResult.challengeId,
          "electron-resolution-failed",
        );
        console.error("[weixin-remote-approval] Resolution failed closed:", error);
        return { consumed: true };
      }
    }
    return { consumed: true, acknowledgement: candidateResult.acknowledgement };
  }
  if (
    inbound.sourcePhase === "start" &&
    inbound.direct &&
    !inbound.forwarded &&
    !inbound.quoted &&
    inbound.accountId.trim().toLowerCase() === configuration.owner.accountId &&
    inbound.senderId.trim().toLowerCase() === configuration.owner.userId &&
    inbound.conversationId.trim().toLowerCase() === configuration.owner.userId &&
    inbound.sessionKey.trim() &&
    inbound.agentId.trim()
  ) {
    const generation = gatewayGenerationId;
    const client = gwClient;
    let route: { sessionKey: string; agentId: string };
    try {
      if (!client?.connected) throw new Error("Gateway route resolver is unavailable");
      route = await resolveWeixinSessionRoute(inbound, (method, params) =>
        client.request(method, params, 3_000),
      );
    } catch {
      console.info(
        "[weixin-remote-approval-context]",
        JSON.stringify(
          describeWeixinApprovalDecision(
            "weixin-source-validation",
            "source-route-unresolved",
            undefined,
            inbound,
          ),
        ),
      );
      console.warn("[weixin-remote-approval]", {
        reason: "source-route-unresolved",
        sessionBinding: describeWeixinSessionBinding(inbound.sessionKey),
        aliasSessionHash: remoteApprovalDiagnosticBinding({
          id: inbound.messageId,
          sessionKey: inbound.sessionKey,
        }).sessionHash,
      });
      return { consumed: false };
    }
    const current = getWindowsNodeMxcWeixinRemoteApprovalConfiguration();
    const currentSourceRejection = weixinRemoteApprovalWireSourceRejection(
      current,
      inbound,
      readAuthenticatedWeixinWireOwner(getOpenClawStateDir()),
    );
    if (
      generation !== gatewayGenerationId ||
      client !== gwClient ||
      !client.connected ||
      !current.enabled ||
      !current.owner ||
      currentSourceRejection !== null ||
      current.owner.boundAt !== revalidatedConfiguration.owner.boundAt ||
      current.consentScope !== revalidatedConfiguration.consentScope ||
      windowsNodeMxcSecurityTransitionInProgress ||
      !currentWindowsNodeMxcWeixinRemoteApprovalSecurity()
    ) {
      console.info(
        "[weixin-remote-approval-context]",
        JSON.stringify(
          describeWeixinApprovalDecision(
            "weixin-source-validation",
            currentSourceRejection ?? "security-binding-invalid",
            undefined,
            inbound,
          ),
        ),
      );
      return { consumed: false };
    }
    windowsNodeMxcWeixinRemoteApprovalSources.set(route.sessionKey, {
      ...inbound,
      ...route,
      providerSessionKey: inbound.sessionKey,
      gatewayGeneration: generation,
      runIds: [],
    });
    console.info(
      "[weixin-remote-approval-context]",
      JSON.stringify(
        describeWeixinApprovalDecision(
          "weixin-source-cached",
          "source-cached",
          undefined,
          windowsNodeMxcWeixinRemoteApprovalSources.get(route.sessionKey),
        ),
      ),
    );
    console.info("[weixin-remote-approval]", {
      reason: "source-cached",
      aliasBinding: describeWeixinSessionBinding(inbound.sessionKey),
      canonicalBinding: describeWeixinSessionBinding(route.sessionKey),
      aliasSessionHash: remoteApprovalDiagnosticBinding({
        id: inbound.messageId,
        sessionKey: inbound.sessionKey,
      }).sessionHash,
      canonicalSessionHash: remoteApprovalDiagnosticBinding({
        id: inbound.messageId,
        sessionKey: route.sessionKey,
      }).sessionHash,
    });
  }
  return { consumed: false };
}

function getWindowsNodeMxcSelection(): WindowsNodeMxcSelection {
  const current = settingsStore.get("windowsNodeMxcSelection");
  const migrated = migrateWindowsNodeMxcSelection(current, false);
  if (JSON.stringify(current) !== JSON.stringify(migrated)) {
    settingsStore.set("windowsNodeMxcSelection", migrated);
  }
  return migrated;
}

function getWindowsNodeMxcRequestedMode(): WindowsNodeMxcRequestedMode {
  return getWindowsNodeMxcSelection().requestedMode;
}

function isWindowsNodeMxcDesired(): boolean {
  return getWindowsNodeMxcRequestedMode() !== "off";
}

function closeWindowsNodeMxcIngress(): void {
  for (const pending of allPendingWindowsNodeMxcGatewayApprovals()) {
    void pending.lifecycle.cancel("security-ingress-closed");
  }
  windowsNodeMxcIngressGeneration = null;
  revokeWindowsNodeMxcWeixinIngress(windowsNodeMxcWeixinContext);
  const notices = windowsNodeMxcWeixinRemoteApprovalBroker.invalidateAll("security-relock");
  windowsNodeMxcWeixinRemoteApprovalSources.clear();
  const server = windowsNodeMxcWeixinRemoteApprovalServer;
  if (server) {
    void Promise.allSettled(
      notices.map((notice) => deliverWindowsNodeMxcWeixinRemoteApprovalNotice(server, notice)),
    );
  }
}

function releaseWindowsNodeMxcIngress(gatewayGeneration: string): void {
  const context = windowsNodeMxcWeixinContext;
  if (
    !context ||
    context.gatewayGeneration !== gatewayGeneration ||
    context.policyFingerprint !== windowsNodeMxcApprovalProofContext?.policyFingerprint
  ) {
    throw new Error("WeChat ingress release context does not match the active MXC generation");
  }
  const stateDir = getOpenClawStateDir();
  preflightWindowsNodeMxcWeixinAuthorization({
    stateDir,
    credentialsDir: resolveWindowsNodeMxcWeixinCredentialsDir(stateDir),
    config: readConfig(),
  });
  releaseWindowsNodeMxcWeixinIngress(context);
  windowsNodeMxcIngressGeneration = gatewayGeneration;
}

async function prepareWindowsNodeMxcContainment(
  requestedMode: Exclude<WindowsNodeMxcRequestedMode, "off">,
): Promise<{
  effectiveTier: string;
  ambientAccess: BundledWindowsNodeAmbientAccess | null;
}> {
  const probe = await preflightWindowsNodeMxcBackend(
    bundledWindowsNodeHost.getValidatedMxcExecutablePath(),
    requestedMode,
  );
  if (!probe.tier) throw new Error("MXC preflight did not attest an effective tier");
  if (requestedMode === "full") {
    windowsNodeMxcCurrentAmbientAccess = null;
    windowsNodeMxcCurrentEffectiveTier = probe.tier;
    settingsStore.delete("windowsNodeMxcAmbientAccess");
    return { effectiveTier: probe.tier, ambientAccess: null };
  }

  const ambientAccess =
    await bundledWindowsNodeHost.assessLimitedAmbientAccess(getOpenClawStateDir());
  const summary = summarizeWindowsNodeMxcAmbientAccess(ambientAccess);
  if (summary.sensitiveAccessible.length > 0) {
    throw new Error(
      `Limited containment activation blocked because sensitive path categories are ambiently accessible: ${summary.sensitiveAccessible
        .map((entry) => entry.category)
        .join(", ")}`,
    );
  }
  windowsNodeMxcCurrentAmbientAccess = ambientAccess;
  windowsNodeMxcCurrentEffectiveTier = probe.tier;
  settingsStore.set("windowsNodeMxcAmbientAccess", {
    contract: ambientAccess.contract,
    hash: ambientAccess.hash,
    checkedAt: ambientAccess.checkedAt,
    entries: ambientAccess.entries.map((entry) => ({ ...entry })),
  });
  return { effectiveTier: probe.tier, ambientAccess };
}

interface PreparedWindowsNodeMxcContainment {
  requestedMode: Exclude<WindowsNodeMxcRequestedMode, "off">;
  transitionId: string | null;
  effectiveTier: string;
  ambientAccess: BundledWindowsNodeAmbientAccess | null;
}

function assertPreparedWindowsNodeMxcContainment(
  prepared: PreparedWindowsNodeMxcContainment,
  requestedMode: Exclude<WindowsNodeMxcRequestedMode, "off">,
): void {
  if (
    !windowsNodeMxcSecurityTransitionInProgress ||
    !prepared.transitionId ||
    prepared.transitionId !== windowsNodeMxcReadinessTransitionId ||
    prepared.requestedMode !== requestedMode ||
    windowsNodeMxcCurrentEffectiveTier !== prepared.effectiveTier ||
    (requestedMode === "limited-dacl" &&
      (!prepared.ambientAccess ||
        windowsNodeMxcCurrentAmbientAccess?.hash !== prepared.ambientAccess.hash)) ||
    (requestedMode === "full" &&
      (prepared.ambientAccess !== null || windowsNodeMxcCurrentAmbientAccess !== null))
  ) {
    throw new Error("The freshly validated MXC containment result is no longer current");
  }
}

function isApplicationIngressReady(): boolean {
  return (
    !windowsNodeMxcSecurityTransitionInProgress &&
    isWindowsNodeMxcIngressReleased(
      isWindowsNodeMxcDesired(),
      gatewayGenerationId,
      windowsNodeMxcIngressGeneration,
      windowsNodeMxcActivationInProgress,
    )
  );
}

function isApplicationServiceReady(): boolean {
  return isApplicationServiceReadyState(
    gwClient?.connected ?? false,
    !explicitQuitRequested && !gatewayRestarting && gatewayStopPromise === null,
    windowsNodeMxcSecurityTransitionInProgress,
    isApplicationIngressReady(),
  );
}

function notifyRendererApplicationReady(): void {
  if (!isApplicationServiceReady()) return;
  currentGatewayStartupTiming?.serviceReady(gatewayGenerationId);
  sendToWindow(mainWindow, "gateway:ws-connected", gwClient?.mainSessionKey || null);
  sendToWindow(mainWindow, "gateway:service-ready");
  signalPostInstallReady();
}

function getWindowsNodeMxcDurableApprovalStore(): WindowsNodeMxcDurableApprovalStore {
  windowsNodeMxcDurableApprovalStore ??= new WindowsNodeMxcDurableApprovalStore(
    path.join(app.getPath("userData"), "windows-node", "durable-approvals.json"),
  );
  return windowsNodeMxcDurableApprovalStore;
}

async function getWindowsNodeMxcStatus(): Promise<
  WindowsNodeMxcRuntimeStatus & {
    lifecycleState: {
      phase: WindowsNodeMxcFolderTransactionPhase;
      detail: string | null;
      updatedAt: string;
    };
    folderPolicyRecovery: WindowsNodeMxcFolderPolicyRecovery | null;
    durableApprovals: WindowsNodeMxcDurableApprovalInspection;
    hooks: WindowsNodeMxcHooksStatus;
    canvas: {
      state: "off" | "paused" | "active";
      commandCount: 8;
      nativeA2uiOnly: true;
      localFilesAllowed: false;
    };
  }
> {
  const config = readConfig();
  const requestedMode = getWindowsNodeMxcRequestedMode();
  const backups = settingsStore.get("windowsNodeMxcToolBackups");
  const hooksConfig =
    requestedMode === "off" ? config.hooks : getWindowsNodeMxcIngressBackup(backups, "hooks");
  const bundledFolders = getBundledWindowsNodeFolders();
  const bundledHost = bundledWindowsNodeHost.status();
  let runtimeIntegrityError: string | undefined;
  try {
    bundledWindowsNodeHost.getValidatedMxcExecutablePath();
  } catch (error) {
    runtimeIntegrityError = error instanceof Error ? error.message : String(error);
  }
  const status = await inspectWindowsNodeMxc({
    requestedMode,
    desiredEnabled: isWindowsNodeMxcDesired(),
    selectedNodeId: settingsStore.get("windowsNodeMxcNodeId"),
    config,
    gateway: gwClient,
    managedGateway: gatewaySpawnedByUs && isManagedGatewayProcessAlive(),
    gatewayGeneration: gatewayGenerationId,
    storedSmoke: settingsStore.get("windowsNodeMxcSmoke") ?? null,
    bundledHost,
    bundledFolders,
    runtimeIntegrityError,
    ambientAccess:
      bundledHost.ambientAccess ?? settingsStore.get("windowsNodeMxcAmbientAccess") ?? null,
  });
  const durable = getWindowsNodeMxcDurableApprovalStore().inspect();
  const lifecyclePhase = windowsNodeMxcSecurityTransitionInProgress
    ? windowsNodeMxcLifecycleState
    : status.effectiveEnabled
      ? "active"
      : status.desiredEnabled
        ? "locked"
        : "idle";
  return {
    ...status,
    lifecycleState: {
      phase: lifecyclePhase,
      detail: windowsNodeMxcLifecycleDetail,
      updatedAt: windowsNodeMxcLifecycleUpdatedAt,
    },
    folderPolicyRecovery: settingsStore.get("windowsNodeMxcFolderPolicyRecovery") ?? null,
    durableApprovals: durable,
    hooks: inspectWindowsNodeMxcHooksStatus(hooksConfig, requestedMode),
    canvas: {
      state: requestedMode === "off" ? "off" : status.effectiveEnabled ? "active" : "paused",
      commandCount: 8,
      nativeA2uiOnly: true,
      localFilesAllowed: false,
    },
  };
}

function getBundledWindowsNodeFolders(): BundledWindowsNodeFolder[] {
  const folders = getWindowsNodeMxcFolderPolicy();
  return [
    ...folders.ro.map((folderPath) => ({
      path: folderPath,
      access: "ro" as const,
    })),
    ...folders.rw.map((folderPath) => ({
      path: folderPath,
      access: "rw" as const,
    })),
  ];
}

function getWindowsNodeMxcFolderPolicy(): WindowsNodeMxcFolderPolicy {
  const folders = settingsStore.get("windowsNodeMxcFolders");
  if (!folders) throw new Error("The saved MXC folder policy is unavailable");
  return { rw: [...folders.rw], ro: [...folders.ro] };
}

async function requireEffectiveWindowsNodeMxc(
  deferRelock = false,
  renewActivationLease = true,
): Promise<void> {
  if (windowsNodeMxcSecurityTransitionInProgress) {
    throw new Error("Chat ingress is locked during the security-mode transition");
  }
  if (!isWindowsNodeMxcDesired()) return;
  const relock = async (reason: string) => {
    const operation = failClosedWindowsNodeMxc(reason);
    if (deferRelock) {
      void operation.catch((error) =>
        console.error("[windows-node-mxc] Deferred relock failed:", error),
      );
      return;
    }
    await operation;
  };
  if (
    !isWindowsNodeMxcIngressReleased(
      true,
      gatewayGenerationId,
      windowsNodeMxcIngressGeneration,
      windowsNodeMxcActivationInProgress,
    )
  ) {
    throw new Error("Windows Node + MXC ingress is locked pending current-generation attestation");
  }
  let status: WindowsNodeMxcRuntimeStatus;
  try {
    status = await getWindowsNodeMxcStatus();
  } catch (error) {
    await relock(
      `Runtime attestation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
  if (!status.effectiveEnabled) {
    const detail = status.blockers.join("; ") || "readiness proof failed";
    await relock(`Runtime attestation drifted: ${detail}`);
    throw new Error(`Windows Node + MXC execution is blocked: ${detail}`);
  }
  if (renewActivationLease) {
    try {
      await bundledWindowsNodeHost.setActivationLease("active", 120_000);
    } catch (error) {
      await relock(
        `Activation lease renewal failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}

function currentApprovalWeixinConsentHash(
  approval: WindowsNodeMxcGatewayApproval,
  source = findWeixinApprovalSource(windowsNodeMxcWeixinRemoteApprovalSources, approval),
): string | null {
  const configuration = getWindowsNodeMxcWeixinRemoteApprovalConfiguration();
  return exactWeixinApprovalSource(
    configuration,
    source,
    approval,
    readAuthenticatedWeixinWireOwner(getOpenClawStateDir()),
  ) === null
    ? weixinRemoteApprovalConsentHash(configuration)
    : null;
}

async function handleWindowsNodeMxcGatewayApproval(
  approval: WindowsNodeMxcGatewayApproval,
  approvalGeneration: string,
): Promise<void> {
  const receivedAtUnixMs = Date.now();
  if (windowsNodeMxcApprovalResolutionCompletion) {
    await windowsNodeMxcApprovalResolutionCompletion;
  }
  const proofContext = windowsNodeMxcApprovalProofContext;
  let identity = proofContext
    ? durableApprovalIdentityFromGateway(approval, proofContext.policyFingerprint)
    : null;
  let durable = canUseWindowsNodeMxcDurableApproval(getWindowsNodeMxcRequestedMode(), identity)
    ? getWindowsNodeMxcDurableApprovalStore().findExact(identity)
    : null;
  if (!durable && identity) {
    const consentHash = currentApprovalWeixinConsentHash(approval);
    if (consentHash) {
      identity = { ...identity, weixinConsentHash: consentHash };
      durable = getWindowsNodeMxcDurableApprovalStore().findExact(identity);
    }
  }
  if (durable) {
    try {
      const consumed = await withWindowsNodeMxcApprovalResolution(async () => {
        await requireEffectiveWindowsNodeMxc(true);
        return withWindowsNodeMxcDurableApprovalLock(async () => {
          if (!identity) return false;
          return consumeExactDurableApproval(
            getWindowsNodeMxcDurableApprovalStore(),
            identity,
            durable.id,
            async () => {
              if (
                approvalGeneration !== gatewayGenerationId ||
                proofContext !== windowsNodeMxcApprovalProofContext ||
                windowsNodeMxcSecurityTransitionInProgress ||
                !isWindowsNodeMxcIngressReleased(
                  true,
                  gatewayGenerationId,
                  windowsNodeMxcIngressGeneration,
                  windowsNodeMxcActivationInProgress,
                ) ||
                !gwClient?.connected
              ) {
                throw new Error("The Gateway approval belongs to a stale security generation");
              }
              if (
                identity.weixinConsentHash &&
                currentApprovalWeixinConsentHash(approval) !== identity.weixinConsentHash
              ) {
                throw new Error("The exact WeChat consent changed before durable approval use");
              }
              await gwClient.request("exec.approval.resolve", {
                id: approval.id,
                decision: "allow-once",
              });
            },
            (error) =>
              console.error("[windows-node-mxc] Could not update durable approval usage:", error),
          );
        });
      });
      if (consumed) return;
    } catch (error) {
      console.error("[windows-node-mxc] Exact durable approval could not be consumed:", error);
    }
  }

  if (
    approvalGeneration !== gatewayGenerationId ||
    !isWindowsNodeMxcIngressReleased(
      true,
      gatewayGenerationId,
      windowsNodeMxcIngressGeneration,
      windowsNodeMxcActivationInProgress,
    )
  ) {
    if (gwClient?.connected) {
      await gwClient
        .request("exec.approval.resolve", { id: approval.id, decision: "deny" })
        .catch((error) =>
          console.error("[windows-node-mxc] Could not deny a stale Gateway approval:", error),
        );
    }
    return;
  }
  const rendererApproval = approval;
  if (findPendingWindowsNodeMxcGatewayApproval(approval.id)) return;
  const expiresAtUnixMs = mxcApprovalDeadline(receivedAtUnixMs, approval.expiresAtUnixMs);
  const remoteSource = findWeixinApprovalSource(
    windowsNodeMxcWeixinRemoteApprovalSources,
    rendererApproval,
  );
  const remoteSecurity = currentWindowsNodeMxcWeixinRemoteApprovalSecurity();
  const deliveryServer = windowsNodeMxcWeixinRemoteApprovalServer;
  const locale = resolveSupportedLocale(settingsStore.get("language") ?? "en-US");
  const pending: PendingWindowsNodeMxcGatewayApproval = {
    request: rendererApproval,
    gatewayGeneration: approvalGeneration,
    receivedAtUnixMs,
    expiresAtUnixMs,
    remoteDelivery: null,
    remoteSource: remoteSource ?? null,
    remoteSecurity,
    remoteChallengeId: null,
    remoteAttempt: null,
    remoteCoordinator: new WeixinRemoteDeliveryCoordinator(),
    beginRemoteDelivery: (trigger) =>
      beginPendingWindowsNodeMxcRemoteDelivery(pending, locale, deliveryServer, false, trigger),
    lifecycle: new WindowsNodeMxcApprovalLifecycle(expiresAtUnixMs, {
      resolve: (decision, origin) =>
        commitPendingWindowsNodeMxcGatewayApproval(
          pending,
          decision,
          origin,
          origin === "wechat" ? pending.remoteSecurity : null,
        ),
      terminal: (outcome) =>
        finishPendingWindowsNodeMxcGatewayApproval(pending, outcome, locale, deliveryServer),
      error: (stage, error) => {
        console.error("[weixin-remote-approval]", {
          reason: `${stage}-failed`,
          ...remoteApprovalDiagnosticBinding(approval),
          errorClass: error instanceof Error ? error.name : "unknown",
        });
      },
    }),
  };
  const queued = pendingWindowsNodeMxcGatewayApproval !== null;
  if (queued) queuedWindowsNodeMxcGatewayApprovals.push(pending);
  else pendingWindowsNodeMxcGatewayApproval = pending;
  pending.lifecycle.start();
  console.info(
    `[windows-node-mxc-approval-timing] stage=prompt-received layer=gateway unixMs=${receivedAtUnixMs} allowedDecisions=${rendererApproval.allowedDecisions.join(",")}`,
  );
  sendToWindow(mainWindow, "windows-node-mxc:approval-request", {
    ...projectWindowsNodeMxcApprovalForRenderer(rendererApproval, approvalGeneration),
    commandText: rendererApproval.command,
    approvalLayer: "gateway",
    expiresAtUnixMs,
    remoteDelivery: pending.remoteDelivery,
  });
  beginPendingWindowsNodeMxcRemoteDelivery(pending, locale, deliveryServer, queued);
  await pending.remoteAttempt;
}

function beginPendingWindowsNodeMxcRemoteDelivery(
  pending: PendingWindowsNodeMxcGatewayApproval,
  locale: "en-US" | "zh-CN",
  deliveryServer: WindowsNodeMxcWeixinRemoteApprovalServer | null,
  queued = false,
  trigger: WeixinRemoteDeliveryTrigger = "initial",
): void {
  const approval = pending.request;
  const expiresAtUnixMs = pending.expiresAtUnixMs;
  const isPending = () =>
    pending.lifecycle.pending &&
    (queued
      ? findPendingWindowsNodeMxcGatewayApproval(approval.id) === pending
      : pendingWindowsNodeMxcGatewayApproval === pending);
  pending.remoteAttempt = pending.remoteCoordinator.begin(
    trigger,
    () => ({
      pending: isPending(),
      challengeId: pending.remoteChallengeId,
      state: pending.remoteDelivery,
    }),
    async () => {
      const currentSecurity = currentWindowsNodeMxcWeixinRemoteApprovalSecurity();
      return deliverWeixinRemoteApproval({
        approval,
        configuration: getWindowsNodeMxcWeixinRemoteApprovalConfiguration(),
        source: pending.remoteSource ?? undefined,
        security:
          JSON.stringify(currentSecurity) === JSON.stringify(pending.remoteSecurity)
            ? currentSecurity
            : null,
        server: deliveryServer,
        broker: windowsNodeMxcWeixinRemoteApprovalBroker,
        readWireOwner: () => readAuthenticatedWeixinWireOwner(getOpenClawStateDir()),
        deliveryDiagnostic: (diagnostic) => {
          console.info(
            "[weixin-remote-approval-delivery]",
            JSON.stringify({
              ...remoteApprovalDiagnosticBinding(approval),
              ...diagnostic,
            }),
          );
        },
        expiresAtUnixMs,
        locale,
        queued,
        isPending,
        challenge: (delivery) => {
          pending.remoteChallengeId = delivery.challengeId;
        },
        state: (state) => {
          if (!isPending()) return;
          publishPendingWeixinRemoteDelivery(pending, state);
        },
        diagnostic: (reason) => {
          console.info("[weixin-remote-approval]", {
            reason,
            ...remoteApprovalDiagnosticBinding(approval),
            planSessionBinding: describeWeixinSessionBinding(approval.sessionKey),
            ...(reason === "source-unavailable"
              ? {
                  knownSourceBindings: [...windowsNodeMxcWeixinRemoteApprovalSources.values()]
                    .filter((source) => source.agentId === approval.agent)
                    .slice(0, 4)
                    .map((source) => describeWeixinSessionBinding(source.sessionKey)),
                }
              : {}),
          });
          const runId = pending.request.origin?.runId;
          console.info(
            "[weixin-remote-approval-context]",
            JSON.stringify(
              describeWeixinApprovalDecision(
                "weixin-main-delivery",
                reason,
                pending.request,
                pending.remoteSource,
                runId && pending.remoteSource?.runIds?.includes(runId) ? runId : undefined,
              ),
            ),
          );
        },
      });
    },
  );
  void pending.remoteAttempt.catch((error) => {
    console.error("[weixin-remote-approval]", {
      reason: "delivery-internal-failure",
      ...remoteApprovalDiagnosticBinding(approval),
      errorClass: error instanceof Error ? error.name : "unknown",
    });
    if (isPending())
      publishPendingWeixinRemoteDelivery(pending, {
        state: "unconfirmed",
        reason: "delivery-unconfirmed",
        replyMode: null,
        revision: 0,
      });
  });
}

function publishPendingWeixinRemoteDelivery(
  pending: PendingWindowsNodeMxcGatewayApproval,
  state: WeixinRemoteDeliveryState,
): void {
  if (!pending.lifecycle.pending) return;
  pending.remoteDelivery = { ...state, revision: (pending.remoteDelivery?.revision ?? 0) + 1 };
  sendToWindow(mainWindow, "windows-node-mxc:approval-request", {
    ...projectWindowsNodeMxcApprovalForRenderer(pending.request, pending.gatewayGeneration),
    commandText: pending.request.command,
    approvalLayer: "gateway",
    expiresAtUnixMs: pending.expiresAtUnixMs,
    remoteDelivery: pending.remoteDelivery,
  });
}

async function finishPendingWindowsNodeMxcGatewayApproval(
  pending: PendingWindowsNodeMxcGatewayApproval,
  outcome: MxcApprovalTerminal,
  locale: "en-US" | "zh-CN",
  server: WindowsNodeMxcWeixinRemoteApprovalServer | null,
): Promise<void> {
  windowsNodeMxcWeixinRemoteApprovalBroker.settleApproval(
    pending.request.id,
    outcome.status === "accepted" ? outcome.decision : outcome.status,
    outcome.origin,
  );
  const queuedIndex = queuedWindowsNodeMxcGatewayApprovals.indexOf(pending);
  if (queuedIndex >= 0) queuedWindowsNodeMxcGatewayApprovals.splice(queuedIndex, 1);
  sendToWindow(mainWindow, "windows-node-mxc:approval-resolved", {
    requestId: pending.request.id,
    approvalLayer: "gateway",
    ...outcome,
  });
  try {
    await pending.remoteAttempt;
    const source = pending.remoteSource;
    if (!source || !server) return;
    const current = getWindowsNodeMxcWeixinRemoteApprovalConfiguration();
    if (
      exactWeixinApprovalSource(
        current,
        source,
        pending.request,
        readAuthenticatedWeixinWireOwner(getOpenClawStateDir()),
      ) !== null
    ) {
      console.info("[weixin-remote-approval]", {
        reason: "terminal-owner-unavailable",
        ...remoteApprovalDiagnosticBinding(pending.request),
      });
      return;
    }
    await server.deliver({
      accountId: source.accountId,
      kind: "terminal",
      to: source.senderId,
      text: `${renderMxcApprovalTerminal(outcome, locale)} [${remoteApprovalDiagnosticBinding(pending.request).approvalHash}]`,
      ...(pending.remoteChallengeId ? { terminalChallengeId: pending.remoteChallengeId } : {}),
      onDiagnostic: (diagnostic) =>
        console.info(
          "[weixin-remote-approval-delivery]",
          JSON.stringify({
            ...remoteApprovalDiagnosticBinding(pending.request),
            ...diagnostic,
          }),
        ),
    });
  } finally {
    if (pendingWindowsNodeMxcGatewayApproval === pending) {
      pendingWindowsNodeMxcGatewayApproval = queuedWindowsNodeMxcGatewayApprovals.shift() ?? null;
      if (pendingWindowsNodeMxcGatewayApproval?.lifecycle.pending) {
        pendingWindowsNodeMxcGatewayApproval.beginRemoteDelivery("promoted");
      }
    }
  }
}

function getPendingWindowsNodeMxcApprovalForRenderer() {
  const pending = allPendingWindowsNodeMxcGatewayApprovals().find(
    (entry) => entry.lifecycle.pending,
  );
  if (pending) {
    const approval = pending.request;
    return {
      ...projectWindowsNodeMxcApprovalForRenderer(approval, pending.gatewayGeneration),
      commandText: approval.command,
      approvalLayer: "gateway" as const,
      expiresAtUnixMs: pending.expiresAtUnixMs,
      remoteDelivery: pending.remoteDelivery,
    };
  }
  const approval = bundledWindowsNodeHost.status().pendingApproval;
  return approval
    ? {
        ...approval,
        approvalLayer: "node" as const,
        allowedDecisions: ["deny", "allow-once"] as const,
      }
    : null;
}

async function resolvePendingWindowsNodeMxcGatewayApproval(
  requestId: string,
  decision: WindowsNodeMxcApprovalDecision,
  allowDurable: boolean,
  expectedRemoteSecurity?: WeixinRemoteApprovalSecurityBinding,
  origin: MxcApprovalOrigin = expectedRemoteSecurity ? "wechat" : "desktop",
): Promise<void> {
  if (decision === "allow-always" && !allowDurable) {
    throw new Error("This approval cannot persist durable grants");
  }
  const gatewayApproval = findPendingWindowsNodeMxcGatewayApproval(requestId);
  if (gatewayApproval?.request.id !== requestId) {
    throw new Error("The Gateway approval is no longer pending");
  }
  if (
    expectedRemoteSecurity &&
    JSON.stringify(expectedRemoteSecurity) !== JSON.stringify(gatewayApproval.remoteSecurity)
  ) {
    throw new Error("The remote approval security binding changed");
  }
  await gatewayApproval.lifecycle.decide(decision, origin);
}

async function commitPendingWindowsNodeMxcGatewayApproval(
  gatewayApproval: PendingWindowsNodeMxcGatewayApproval,
  decision: WindowsNodeMxcApprovalDecision,
  origin: MxcApprovalOrigin,
  expectedRemoteSecurity: WeixinRemoteApprovalSecurityBinding | null,
): Promise<Extract<MxcApprovalTerminal, { status: "accepted" }>> {
  const requestId = gatewayApproval.request.id;
  if (
    origin === "wechat" &&
    (!expectedRemoteSecurity ||
      exactWeixinApprovalSource(
        getWindowsNodeMxcWeixinRemoteApprovalConfiguration(),
        gatewayApproval.remoteSource ?? undefined,
        gatewayApproval.request,
        readAuthenticatedWeixinWireOwner(getOpenClawStateDir()),
      ) !== null)
  ) {
    throw new Error("The exact WeChat approval owner is no longer available");
  }
  const decisionAtUnixMs = Date.now();
  console.info(
    `[windows-node-mxc-approval-timing] stage=operator-decision layer=gateway unixMs=${decisionAtUnixMs} promptToDecisionMs=${Math.max(0, decisionAtUnixMs - gatewayApproval.receivedAtUnixMs)} decision=${decision}`,
  );
  return withWindowsNodeMxcApprovalResolution(async () => {
    const approvalGeneration = gatewayApproval.gatewayGeneration;
    const proofContext = windowsNodeMxcApprovalProofContext;
    const client = gwClient;
    if (approvalGeneration !== gatewayGenerationId || !proofContext) {
      throw new Error("The Gateway approval belongs to a stale security generation");
    }
    if (!gatewayApproval.request.allowedDecisions.includes(decision)) {
      throw new Error("The requested Gateway approval decision is unavailable");
    }
    if (expectedRemoteSecurity) {
      await requireEffectiveWindowsNodeMxc(true, false);
    } else if (decision !== "deny") {
      await requireEffectiveWindowsNodeMxc(true);
    }
    if (
      windowsNodeMxcSecurityTransitionInProgress ||
      findPendingWindowsNodeMxcGatewayApproval(requestId) !== gatewayApproval ||
      approvalGeneration !== gatewayGenerationId ||
      proofContext !== windowsNodeMxcApprovalProofContext ||
      !isWindowsNodeMxcIngressReleased(
        true,
        gatewayGenerationId,
        windowsNodeMxcIngressGeneration,
        windowsNodeMxcActivationInProgress,
      ) ||
      !client?.connected ||
      client !== gwClient
    ) {
      throw new Error("The Gateway approval became stale before it could be resolved");
    }
    if (
      expectedRemoteSecurity &&
      JSON.stringify(currentWindowsNodeMxcWeixinRemoteApprovalSecurity()) !==
        JSON.stringify(expectedRemoteSecurity)
    ) {
      throw new Error("The remote approval security binding drifted before resolution");
    }
    if (Date.now() >= gatewayApproval.expiresAtUnixMs) {
      decision = "deny";
      origin = "timeout";
    }
    if (
      origin === "wechat" &&
      exactWeixinApprovalSource(
        getWindowsNodeMxcWeixinRemoteApprovalConfiguration(),
        gatewayApproval.remoteSource ?? undefined,
        gatewayApproval.request,
        readAuthenticatedWeixinWireOwner(getOpenClawStateDir()),
      ) !== null
    ) {
      throw new Error("The exact WeChat approval owner changed before resolution");
    }
    let durableIdentity =
      decision === "allow-always"
        ? durableApprovalIdentityFromGateway(
            gatewayApproval.request,
            proofContext.policyFingerprint,
          )
        : null;
    if (durableIdentity && origin === "wechat") {
      const consentHash = currentApprovalWeixinConsentHash(
        gatewayApproval.request,
        gatewayApproval.remoteSource ?? undefined,
      );
      if (!consentHash) throw new Error("The exact WeChat consent is unavailable");
      durableIdentity = { ...durableIdentity, weixinConsentHash: consentHash };
    }
    if (decision === "allow-always" && !durableIdentity) {
      throw new Error("This command is not eligible for an exact durable MXC approval");
    }
    return commitMxcApprovalDecision({
      decision,
      origin,
      expiresAtUnixMs: gatewayApproval.expiresAtUnixMs,
      now: Date.now,
      resolveGateway: async (wireDecision) => {
        const resolutionTarget = {
          id: requestId,
          decision: wireDecision,
          observedDecision: null as "allow-once" | "deny" | null,
        };
        windowsNodeMxcGatewayApprovalResolutionTarget = resolutionTarget;
        try {
          try {
            await client.request("exec.approval.resolve", {
              id: requestId,
              decision: wireDecision,
            });
          } catch (error) {
            if (resolutionTarget.observedDecision !== resolutionTarget.decision) throw error;
          }
          if (
            resolutionTarget.observedDecision &&
            resolutionTarget.observedDecision !== resolutionTarget.decision
          ) {
            throw new Error("The Gateway resolved the approval with a different decision");
          }
        } finally {
          if (windowsNodeMxcGatewayApprovalResolutionTarget === resolutionTarget) {
            windowsNodeMxcGatewayApprovalResolutionTarget = null;
          }
        }
      },
      persistDurable: durableIdentity
        ? async () => {
            if (!durableIdentity) throw new Error("The exact durable identity is unavailable");
            if (
              durableIdentity.weixinConsentHash &&
              currentApprovalWeixinConsentHash(
                gatewayApproval.request,
                gatewayApproval.remoteSource ?? undefined,
              ) !== durableIdentity.weixinConsentHash
            ) {
              throw new Error(
                "The exact WeChat consent changed before durable approval persistence",
              );
            }
            await withWindowsNodeMxcDurableApprovalLock(() =>
              getWindowsNodeMxcDurableApprovalStore().add(durableIdentity),
            );
          }
        : null,
      persistenceError: (error) =>
        console.error(
          "[windows-node-mxc] Exact durable approval persistence failed after accepted one-use decision:",
          error,
        ),
    });
  });
}

function assertWindowsNodeMxcConfigurationMutable(): void {
  localModelService.assertIdle();
  sessionModelService.assertIdle();
  if (activeModelSessions.size > 0) {
    throw new Error("Wait for the active chat response before changing Gateway configuration");
  }
  if (isWindowsNodeMxcDesired() || windowsNodeMxcSecurityTransitionInProgress) {
    throw new Error(
      "This Gateway configuration is locked while Windows Node + MXC mode is enabled",
    );
  }
}

function assertWindowsNodeMxcBaseReady(
  status: WindowsNodeMxcRuntimeStatus,
  expectedPolicy: "locked" | "active",
  requireSmoke: boolean,
): void {
  const failures: string[] = [];
  if (!status.desiredEnabled) failures.push("Windows Node + MXC mode is not enabled");
  if (!gatewayGenerationId || status.gatewayGeneration !== gatewayGenerationId) {
    failures.push("Gateway generation changed during attestation");
  }
  if (!gatewaySpawnedByUs || !isManagedGatewayProcessAlive() || !gwClient?.connected) {
    failures.push("MicroClaw's managed Gateway is not connected");
  }
  if (!status.selectedNode?.connected || !status.selectedNode.paired) {
    failures.push("The app-owned Windows node is not paired and connected");
  }
  if (
    status.selectedNode?.id !== status.selectedNodeId ||
    [...(status.selectedNode?.commands ?? [])].sort().join("\n") !==
      [...WINDOWS_NODE_MXC_NODE_COMMANDS].sort().join("\n")
  ) {
    failures.push("The exact bundled node identity or command declaration changed");
  }
  if (!status.cwdAttestationReady) failures.push("The exact CWD/activation attestation failed");
  if (!status.strictFallbackEffective)
    failures.push("Strict MXC no-host-fallback is not effective");
  if (!status.allowWindowsUiEffective)
    failures.push("PowerShell compatibility policy is not effective");
  const expectedStrength = getWindowsNodeMxcRequestedMode();
  const probeTier = status.probe.tier?.toLowerCase();
  const probeAccepted =
    expectedStrength === "limited-dacl"
      ? status.probe.outcome !== "error" && probeTier === "appcontainer-dacl"
      : status.probe.outcome === "supported" &&
        !status.probe.degraded &&
        (probeTier === "base-container" || probeTier === "appcontainer-bfs");
  if (!probeAccepted) {
    failures.push(status.probe.reason ?? "MXC did not report the explicitly requested tier");
  }
  if (
    expectedStrength === "limited-dacl" &&
    (!status.ambientAccess ||
      summarizeWindowsNodeMxcAmbientAccess(status.ambientAccess).sensitiveAccessible.length > 0)
  ) {
    failures.push("Limited containment ambient-access assessment is missing or unsafe");
  }
  if (!status.settingsFingerprint) failures.push("The bundled node security policy is unavailable");
  if (!status.gatewayPolicyReady || status.gatewayPolicyState !== expectedPolicy) {
    failures.push(`Gateway policy is not exactly ${expectedPolicy}`);
  }
  if (!status.effectiveToolsReady || status.effectiveToolsState !== "verified") {
    failures.push("The effective Gateway tool inventory was not verified");
  }
  if (status.durableApprovalsPresent === null) {
    failures.push("Bundled-node durable approval state could not be attested");
  }
  if (
    requireSmoke &&
    (!status.smoke ||
      status.smoke.gatewayGeneration !== gatewayGenerationId ||
      !isWindowsNodeMxcSmokePassed(status.smoke))
  ) {
    failures.push("Current-generation mode-specific contained smoke must pass");
  }
  if (failures.length > 0) {
    throw new Error(`Windows Node + MXC activation blocked: ${failures.join("; ")}`);
  }
}

async function waitForWindowsNodeMxcBaseReady(
  expectedGeneration: string,
  expectedPolicy: "locked" | "active",
  requireSmoke: boolean,
  timeoutMs = 120_000,
): Promise<WindowsNodeMxcRuntimeStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = new Error("Windows Node + MXC readiness has not completed");
  while (Date.now() < deadline) {
    if (gatewayGenerationId !== expectedGeneration) {
      throw new Error("Managed Gateway generation changed during activation readiness");
    }
    if (!gwClient?.connected || !isManagedGatewayProcessAlive()) {
      lastError = new Error("MicroClaw's managed Gateway is not connected");
    } else {
      try {
        const status = await getWindowsNodeMxcStatus();
        assertWindowsNodeMxcBaseReady(status, expectedPolicy, requireSmoke);
        return status;
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `Timed out waiting for current-generation MXC readiness: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function waitForBundledWindowsNodeGeneration(
  expectedGeneration: string,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (gatewayGenerationId !== expectedGeneration) {
      throw new Error("Managed Gateway generation changed during bundled-node startup");
    }
    if (!gwClient?.connected || !isManagedGatewayProcessAlive()) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    const startup = bundledWindowsNodeStartup;
    if (startup) await startup;
    if (bundledWindowsNodeHost.status().processRunning) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the bundled Windows node to pair with this Gateway");
}

async function waitForManagedGatewayConnection(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      gwClient?.connected &&
      isManagedGatewayProcessAlive() &&
      !explicitQuitRequested &&
      gatewayStopPromise === null &&
      !gatewayRestarting
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the managed Gateway WebSocket connection");
}

async function runCurrentWindowsNodeMxcSmoke(
  status: WindowsNodeMxcRuntimeStatus,
): Promise<StoredWindowsNodeMxcSmoke> {
  if (!gwClient?.connected) throw new Error("MicroClaw managed Gateway is not connected");
  if (!status.settingsFingerprint || !status.probe.tier) {
    throw new Error(
      status.probe.reason ??
        "Current MXC settings and an exact filesystem isolation tier are required",
    );
  }
  const expectedGeneration = gatewayGenerationId;
  const transitionId = windowsNodeMxcReadinessTransitionId;
  const proofContext = windowsNodeMxcApprovalProofContext;
  if (
    !windowsNodeMxcSecurityTransitionInProgress ||
    !transitionId ||
    !proofContext ||
    proofContext.gatewayGeneration !== expectedGeneration ||
    proofContext.readinessTransitionId !== transitionId
  ) {
    throw new Error("Internal MXC readiness authorization is unavailable for this transition");
  }
  await bundledWindowsNodeHost.setActivationLease("diagnostic", 120_000);
  try {
    const smoke = await runWindowsNodeMxcSmoke(
      gwClient,
      expectedGeneration,
      status.selectedNodeId,
      status.settingsFingerprint,
      status.probe,
      { transitionId, proofContext },
      getWindowsNodeMxcRequestedMode() === "limited-dacl" ? "limited-dacl" : "full",
      status.ambientAccess?.hash ?? null,
    );
    if (gatewayGenerationId !== expectedGeneration || !gwClient.connected) {
      throw new Error("Managed Gateway generation changed during contained smokes");
    }
    settingsStore.set("windowsNodeMxcSmoke", smoke);
    return smoke;
  } finally {
    bundledWindowsNodeHost.revokeActivationLease();
  }
}

function assertWindowsNodeMxcSmokePassed(
  smoke: StoredWindowsNodeMxcSmoke,
  generation: "Locked" | "Active",
): void {
  if (!isWindowsNodeMxcSmokePassed(smoke)) {
    throw new Error(
      `${generation}-generation ${smoke.profile} failed: execution=${smoke.execution.reason}; outsideRoot=${smoke.deniedOutsideRoot?.reason ?? "not-required"}`,
    );
  }
}

async function runAutomaticWindowsNodeMxcReadiness(
  preparedContainment?: PreparedWindowsNodeMxcContainment,
): Promise<WindowsNodeMxcRuntimeStatus> {
  if (windowsNodeMxcActivationInProgress) {
    throw new Error("Windows Node + MXC activation is already in progress");
  }
  let activeGeneration = "";
  return runWindowsNodeMxcAutomaticTransition({
    setPhase: setWindowsNodeMxcLifecycleState,
    closeIngress: () => {
      beginWindowsNodeMxcStartupTiming();
      windowsNodeMxcActivationInProgress = true;
      closeWindowsNodeMxcIngress();
      bundledWindowsNodeHost.revokeActivationLease();
      settingsStore.delete("windowsNodeMxcSmoke");
      sendToWindow(mainWindow, "gateway:ws-disconnected", "MXC readiness attestation");
      sendToWindow(mainWindow, "gateway:service-loading");
    },
    preflightExactBackend: async () => {
      const requestedMode = getWindowsNodeMxcRequestedMode();
      if (requestedMode === "off") throw new Error("MXC containment mode is off");
      if (preparedContainment) {
        assertPreparedWindowsNodeMxcContainment(preparedContainment, requestedMode);
        return;
      }
      preparedContainment = {
        requestedMode,
        transitionId: windowsNodeMxcReadinessTransitionId,
        ...(await prepareWindowsNodeMxcContainment(requestedMode)),
      };
    },
    startLockedGeneration: async () => {
      await startGatewayWithWindowsNodeMxcPolicy("locked", preparedContainment);
      const lockedGeneration = gatewayGenerationId;
      await waitForBundledWindowsNodeGeneration(lockedGeneration);
      const status = await waitForWindowsNodeMxcBaseReady(lockedGeneration, "locked", false);
      markWindowsNodeMxcStartupTiming("attestation");
      return status;
    },
    smokeLockedGeneration: async (lockedStatus) => {
      const smoke = await runCurrentWindowsNodeMxcSmoke(lockedStatus);
      assertWindowsNodeMxcSmokePassed(smoke, "Locked");
      markWindowsNodeMxcStartupTiming(smoke.profile);
    },
    promoteActivePolicy: async () => {
      const generation = gatewayGenerationId;
      const gateway = gwClient;
      const gatewayProcessAtPromotion = gatewayProcess;
      const nodeId = bundledWindowsNodeHost.ensureIdentityNodeId();
      if (!gateway || !gatewayProcessAtPromotion) {
        throw new Error("Managed Gateway is unavailable for MXC policy promotion");
      }
      const isCurrent = () =>
        gwClient === gateway &&
        gateway.connected &&
        gatewayProcess === gatewayProcessAtPromotion &&
        isManagedGatewayProcessAlive();
      const promoted = await promoteWindowsNodeMxcPolicy({
        gateway,
        nodeId,
        backups: settingsStore.get("windowsNodeMxcToolBackups"),
        expectedGeneration: generation,
        currentGeneration: () => gatewayGenerationId,
        isCurrent,
        requestTimeoutMs: MXC_GATEWAY_RPC_PROBE_TIMEOUT_MS,
        agentReadinessTimeoutMs: MXC_AGENT_DATABASE_READY_TIMEOUT_MS,
        agentReadinessPollIntervalMs: MXC_AGENT_DATABASE_READY_POLL_INTERVAL_MS,
      });
      settingsStore.set("windowsNodeMxcToolBackups", promoted.backups);
      activeGeneration = generation;
      const status = await waitForWindowsNodeMxcBaseReady(generation, "active", false);
      markWindowsNodeMxcStartupTiming("policy-promoted");
      return status;
    },
    smokeActivePolicy: async (activeStatus) => {
      const smoke = await runCurrentWindowsNodeMxcSmoke(activeStatus);
      assertWindowsNodeMxcSmokePassed(smoke, "Active");
      await waitForWindowsNodeMxcBaseReady(activeGeneration, "active", true);
      markWindowsNodeMxcStartupTiming(`active-${smoke.profile}`);
    },
    mintActivationLease: async () => {
      await bundledWindowsNodeHost.setActivationLease("active", 120_000);
      markWindowsNodeMxcStartupTiming("activation-lease");
    },
    verifyActiveGeneration: async () => {
      const finalStatus = await getWindowsNodeMxcStatus();
      if (!finalStatus.effectiveEnabled) {
        throw new Error(
          `Final activation attestation failed: ${finalStatus.blockers.join("; ") || "unknown failure"}`,
        );
      }
      if (gatewayGenerationId !== activeGeneration) {
        throw new Error("Managed Gateway generation changed before ingress release");
      }
      markWindowsNodeMxcStartupTiming("activation");
      return finalStatus;
    },
    releaseIngress: () => {
      releaseWindowsNodeMxcIngress(activeGeneration);
      windowsNodeMxcActivationInProgress = false;
      markWindowsNodeMxcStartupTiming("ingress-release");
      windowsNodeMxcStartupTiming = null;
    },
    lockAfterFailure: async (error) => {
      windowsNodeMxcActivationInProgress = false;
      windowsNodeMxcStartupTiming = null;
      await failClosedWindowsNodeMxc(
        `Automatic readiness failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
}

async function startApplicationServices(): Promise<void> {
  if (!isWindowsNodeMxcDesired()) {
    await startGateway();
    return;
  }

  await runTrackedWindowsNodeMxcLifecycleOperation({ kind: "startup" }, () =>
    runAutomaticWindowsNodeMxcReadiness(),
  );
  notifyRendererApplicationReady();
}

function resolveGitHubCopilotAuthRuntime(): GitHubCopilotAuthRuntime {
  const entryPath = resolveOpenClawEntry();
  const stateDir = getOpenClawStateDir();
  const compileCacheDir = path.join(stateDir, COMPILE_CACHE_SUBDIR);
  fs.mkdirSync(compileCacheDir, { recursive: true });
  return {
    nodePath: resolveNodePath(),
    entryPath,
    workerPath: app.isPackaged
      ? path.join(process.resourcesPath, "github-copilot-auth-worker.js")
      : path.join(__dirname, "github-copilot-auth-worker.js"),
    openClawPackageDir: resolveOpenClawPackageDir(entryPath),
    stateDir,
    compileCacheDir,
  };
}

/**
 * Grant ACL for a directory with verification and retry.
 * Ensures the ACL is actually effective before returning.
 */

function isConfigured(): boolean {
  const config = readConfig();
  return !!config?.gateway;
}

/**
 * Check if the user still needs to configure a model provider.
 * Returns true when there is no explicit custom provider, selected GitHub
 * Copilot model, or MODEL_API_KEY in .env.
 *
 * When MODEL_API_KEY IS present in .env but openclaw.json has no provider,
 * auto-configures the provider from .env values before returning false.
 */
function needsSetup(): boolean {
  const config = readConfig();
  if (hasConfiguredModel(config, internalFeatures.githubCopilot)) return false;
  // Also check .env for MODEL_API_KEY
  const env = loadStateDirEnv();
  if (env.MODEL_API_KEY || env.OPENCLAW_MODEL_API_KEY) {
    // .env has API key but openclaw.json has no provider — auto-configure
    autoConfigureModelFromEnv(config || {}, env);
    return false;
  }
  return true;
}

type AutoConfigApiFormat = "openai-chat" | "openai-responses" | "anthropic";
type AutoConfigReasoningEffort =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive";

function normalizeEnvApiFormat(value: string | undefined): AutoConfigApiFormat {
  const normalized = (value || "").trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "anthropic-messages") return "anthropic";
  if (normalized === "openai-responses" || normalized === "responses" || normalized === "response")
    return "openai-responses";
  return "openai-chat";
}

function normalizeEnvReasoningEffort(
  value: string | undefined,
): AutoConfigReasoningEffort | undefined {
  const normalized = (value || "").trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh" ||
    normalized === "adaptive"
  ) {
    return normalized;
  }
  return undefined;
}

/**
 * Auto-write a model provider to openclaw.json from .env values.
 * Called when .env has MODEL_API_KEY but openclaw.json has no providers section.
 * Supports optional MODEL_API_FORMAT / OPENCLAW_MODEL_API_FORMAT and
 * MODEL_REASONING_EFFORT / OPENCLAW_MODEL_REASONING_EFFORT.
 */
function autoConfigureModelFromEnv(config: any, env: Record<string, string>): void {
  try {
    const baseUrl = env.MODEL_BASE_URL || "";
    const modelName = env.MODEL_NAME || "gpt-4o";
    const bareModel = modelName.includes("/") ? modelName.split("/").pop()! : modelName;
    const apiFormat = normalizeEnvApiFormat(env.OPENCLAW_MODEL_API_FORMAT || env.MODEL_API_FORMAT);
    const configuredReasoning = normalizeEnvReasoningEffort(
      env.OPENCLAW_MODEL_REASONING_EFFORT ||
        env.MODEL_REASONING_EFFORT ||
        env.OPENCLAW_MODEL_THINKING ||
        env.MODEL_THINKING,
    );
    const reasoningEffort =
      configuredReasoning ?? (apiFormat === "openai-responses" ? "low" : undefined);
    const providerId = apiFormat === "anthropic" ? "anthropic" : "custom";
    const modelRef = `${providerId}/${bareModel}`;

    // Determine API key env var name — prefer OPENCLAW_MODEL_API_KEY for consistency
    const apiKeyRef = env.OPENCLAW_MODEL_API_KEY ? "${OPENCLAW_MODEL_API_KEY}" : "${MODEL_API_KEY}";

    const reasoningEnabled =
      apiFormat === "openai-responses" ||
      (reasoningEffort !== undefined && reasoningEffort !== "off");
    const providerApi =
      apiFormat === "anthropic"
        ? "anthropic-messages"
        : apiFormat === "openai-responses"
          ? "openai-responses"
          : "openai-completions";

    const providerEntry: Record<string, any> = {
      apiKey: apiKeyRef,
      api: providerApi,
      models: [
        {
          id: bareModel,
          name: bareModel,
          ...(reasoningEnabled ? { reasoning: true } : {}),
          ...(apiFormat !== "anthropic" ? { input: ["text", "image"] } : {}),
        },
      ],
    };
    if (baseUrl) {
      let apiUrl = baseUrl.replace(/\/+$/, "");
      if (!apiUrl.endsWith("/v1")) apiUrl += "/v1";
      providerEntry.baseUrl = apiUrl;
    }

    if (!config.models) config.models = { mode: "merge", providers: {} };
    if (!config.models.providers) config.models.providers = {};
    config.models.providers[providerId] = providerEntry;

    if (!config.agents) config.agents = { defaults: {} };
    if (!config.agents.defaults) config.agents.defaults = {};
    if (!config.agents.defaults.model) config.agents.defaults.model = {};
    config.agents.defaults.model.primary = modelRef;
    if (apiFormat === "openai-responses" || reasoningEffort !== undefined) {
      if (!config.agents.defaults.models) config.agents.defaults.models = {};
      const existingModelConfig =
        typeof config.agents.defaults.models[modelRef] === "object" &&
        config.agents.defaults.models[modelRef]
          ? config.agents.defaults.models[modelRef]
          : {};
      config.agents.defaults.models[modelRef] = {
        ...existingModelConfig,
        params: {
          ...(existingModelConfig.params ?? {}),
          thinking: reasoningEffort ?? "off",
        },
      };
    }

    // Write OPENCLAW_MODEL_API_KEY to .env if only MODEL_API_KEY exists
    if (env.MODEL_API_KEY && !env.OPENCLAW_MODEL_API_KEY) {
      const envPath = path.join(getOpenClawStateDir(), ".env");
      try {
        let content = fs.readFileSync(envPath, "utf-8");
        if (!content.includes("OPENCLAW_MODEL_API_KEY")) {
          content += `\nOPENCLAW_MODEL_API_KEY=${env.MODEL_API_KEY}\n`;
          fs.writeFileSync(envPath, content, "utf-8");
        }
      } catch {}
    }

    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
    console.log(`[config] Auto-configured model from .env: ${modelRef} (${providerApi})`);
  } catch (err: any) {
    console.error(`[config] Failed to auto-configure model from .env: ${err.message}`);
  }
}

/**
 * Enable plugins required by the selected model and keep enabled plugin entries
 * in plugins.allow so the gateway loads them synchronously at startup.
 */
function ensurePluginsAllow(): void {
  try {
    if (isWindowsNodeMxcDesired()) return;
    const config = readConfig();
    if (!config) return;
    let changed = ensureSelectedModelProviderPlugins(config);
    if (!config?.plugins?.entries) {
      if (changed) fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
      return;
    }
    const entries = config.plugins.entries as Record<string, { enabled?: boolean }>;
    const enabledIds = Object.keys(entries).filter((id) => entries[id].enabled);
    if (enabledIds.length === 0) {
      if (changed) fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
      return;
    }

    if (!Array.isArray(config.plugins.allow)) {
      config.plugins.allow = [];
      changed = true;
    }
    for (const id of enabledIds) {
      if (!config.plugins.allow.includes(id)) {
        config.plugins.allow.push(id);
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
      console.log(`[config] Updated plugins.allow: ${config.plugins.allow.join(", ")}`);
    }
  } catch (err) {
    console.error("[config] Failed to update plugins.allow:", err);
  }
}

/**
 * Ensure the default MicroClaw persona exists in the OpenClaw roster.
 * Preserve OpenClaw 2026.8.2's keyed roster and explicit ownership after doctor
 * migration, while retaining support for legacy input. Entries are preserved by
 * id and the config is only rewritten when something changes.
 */
function prepareAgentPersonas(
  stateDir: string,
): { config: AgentRosterConfig; changed: boolean } | null {
  const config = readConfig();
  if (!config) return null;
  const result = ensureAgentPersonasConfig(config, stateDir);
  return { config, changed: result.changed };
}

function persistAgentPersonas(config: AgentRosterConfig): void {
  writeConfigTextAtomically(JSON.stringify(config, null, 2));
  console.log(
    `[config] Registered agent personas: ${listConfiguredAgents(config)
      .map((agent) => agent.id)
      .join(", ")}`,
  );
}

function writeConfigTextAtomically(contents: string): void {
  const configPath = getConfigPath();
  const temporaryPath = `${configPath}.microclaw-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, contents, "utf-8");
  try {
    fs.renameSync(temporaryPath, configPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function failForExternalGateway(port: number): never {
  const message =
    `Agent or owned-skill state requires reconciliation, but Gateway port ${port} ` +
    "is owned by another process. Stop that Gateway and retry so MicroClaw can apply it safely.";
  setGatewayStatus("failed");
  mainWindow?.webContents.send("gateway:log", `[error] ${message}`);
  throw new Error(message);
}

function seedSpecialistAgentWorkspaces(
  config: AgentRosterConfig,
  stateDir: string,
  entryPath: string,
  gatewayEnvironment: Record<string, string>,
): string[] {
  const seededFiles = seedAgentPersonaWorkspaces(
    config,
    stateDir,
    DECLARE_ACCESS_SECTION,
    gatewayEnvironment,
    os.homedir(),
    path.dirname(entryPath),
  );
  if (seededFiles.length > 0) {
    console.log(`[seed] Created specialist agent workspace files: ${seededFiles.join(", ")}`);
  }
  return seededFiles;
}

interface WorkspaceSnapshot {
  directory: string;
  directoryExisted: boolean;
  files: Array<{ path: string; contents: string | null }>;
}

function captureAgentWorkspace(
  config: AgentRosterConfig,
  stateDir: string,
  persona: AgentPersona,
  gatewayEnvironment: Record<string, string>,
  entryPath: string,
): WorkspaceSnapshot | null {
  if (!persona.workspaceFiles) return null;
  const directory = resolveAgentPersonaWorkspace(
    config,
    stateDir,
    persona,
    gatewayEnvironment,
    os.homedir(),
    path.dirname(entryPath),
  );
  return {
    directory,
    directoryExisted: fs.existsSync(directory),
    files: Object.keys(persona.workspaceFiles).map((filename) => {
      const filePath = path.join(directory, filename);
      return {
        path: filePath,
        contents: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null,
      };
    }),
  };
}

function restoreAgentWorkspace(snapshot: WorkspaceSnapshot | null): void {
  if (!snapshot) return;
  for (const file of snapshot.files) {
    if (file.contents === null) {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } else {
      fs.writeFileSync(file.path, file.contents, "utf-8");
    }
  }
  if (
    !snapshot.directoryExisted &&
    fs.existsSync(snapshot.directory) &&
    fs.readdirSync(snapshot.directory).length === 0
  ) {
    fs.rmdirSync(snapshot.directory);
  }
}

function captureAgentWorkspaces(
  config: AgentRosterConfig,
  stateDir: string,
  gatewayEnvironment: Record<string, string>,
  entryPath: string,
): WorkspaceSnapshot[] {
  const configuredIds = new Set(listConfiguredAgents(config).map((agent) => agent.id));
  return AGENT_PERSONAS.flatMap((persona) => {
    if (!configuredIds.has(persona.id)) return [];
    const snapshot = captureAgentWorkspace(
      config,
      stateDir,
      persona,
      gatewayEnvironment,
      entryPath,
    );
    return snapshot ? [snapshot] : [];
  });
}

function restoreAgentWorkspaces(snapshots: readonly WorkspaceSnapshot[]): void {
  for (const snapshot of [...snapshots].reverse()) {
    restoreAgentWorkspace(snapshot);
  }
}

async function applyGatewayAgentRoster(
  agentId: string,
  shouldExist: boolean,
  restartGateway?: () => Promise<void>,
) {
  if (!gwClient?.connected) throw new Error("Gateway not connected");
  return await applyAgentRosterReload({
    listAgentIds: async () => {
      const result = await gwClient!.listAgents();
      if (!Array.isArray(result.agents))
        throw new Error("OpenClaw returned an invalid agent roster");
      return new Set(
        result.agents.flatMap((candidate) => {
          if (
            typeof candidate !== "object" ||
            candidate === null ||
            typeof (candidate as { id?: unknown }).id !== "string"
          ) {
            return [];
          }
          return [(candidate as { id: string }).id];
        }),
      );
    },
    isApplied: (agentIds) => agentIds.has(agentId) === shouldExist,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs: 45_000,
    pollMs: 100,
    restartGateway,
  });
}

async function addCatalogAgent(
  agentId: string,
): Promise<{ agents: Array<{ id: string; name: string }> }> {
  const persona = getAgentPersona(agentId);
  if (!persona || DEFAULT_AGENT_PERSONAS.some((candidate) => candidate.id === agentId)) {
    throw new Error(`Unknown installable agent template "${agentId}"`);
  }

  const stateDir = getOpenClawStateDir();
  const configPath = getConfigPath();
  const originalConfigText = fs.readFileSync(configPath, "utf-8");
  const config = readConfig();
  if (!config) throw new Error("OpenClaw configuration is unavailable");

  const result = ensureAgentPersonasConfig(config, stateDir, [...DEFAULT_AGENT_PERSONAS, persona]);
  const skillConfigChanged = setAgentOwnedSkillsEnabled(config, agentId, true);
  const managedGateway = gatewaySpawnedByUs && gatewayProcess !== null;
  if (agentOwnedSkillMatchNames(agentId).length > 0 && !managedGateway) {
    throw new Error(`Cannot add agent "${agentId}" with an externally managed Gateway`);
  }

  const entryPath = resolveOpenClawEntry();
  const gatewayEnvironment = loadGatewayEnvironment(stateDir);
  const workspaceSnapshot = captureAgentWorkspace(
    config,
    stateDir,
    persona,
    gatewayEnvironment,
    entryPath,
  );
  const integritySnapshot = captureSkillIntegritySnapshotState(stateDir);
  const agentSkillBundleRoot = resolveAgentOwnedSkillBundleRoot(
    app.isPackaged,
    process.resourcesPath,
  );
  let skillInstalls: ReturnType<typeof installAgentOwnedSkills> = [];
  let restartAttempted = false;

  try {
    skillInstalls = installAgentOwnedSkills(agentId, stateDir, agentSkillBundleRoot, {
      isTrustedInstalledSkill: isManagedSkillTrustedBySnapshot,
    });
    const skillRuntimeChanged =
      skillConfigChanged || skillInstalls.some(agentOwnedSkillInstallChanged);
    if (!result.changed && !skillRuntimeChanged) {
      return { agents: listConfiguredAgents(config) };
    }
    seedAgentPersonaWorkspace(
      config,
      stateDir,
      persona,
      DECLARE_ACCESS_SECTION,
      gatewayEnvironment,
      os.homedir(),
      path.dirname(entryPath),
    );
    persistAgentPersonas(config);
    let applyResult: "hot-reloaded" | "restarted" | "timed-out";
    if (skillRuntimeChanged) {
      restartAttempted = true;
      await restartManagedGatewayAndRequireReady(`Installing agent-owned skills for ${agentId}`);
      applyResult = await applyGatewayAgentRoster(agentId, true);
    } else {
      applyResult = await applyGatewayAgentRoster(
        agentId,
        true,
        managedGateway
          ? async () => {
              restartAttempted = true;
              await restartManagedGatewayAndRequireReady(
                `Adding agent ${agentId} after hot-reload timeout`,
              );
            }
          : undefined,
      );
    }
    if (applyResult === "timed-out") {
      throw new Error(
        `Gateway did not hot-reload added agent "${agentId}" and is externally managed`,
      );
    }
    if (skillInstalls.some(agentOwnedSkillInstallChanged)) {
      acceptManagedSkillIntegrityChanges(
        skillInstalls.filter(agentOwnedSkillInstallChanged).map((install) => ({
          skillName: install.skillId,
          expectedDirectory: path.join(agentSkillBundleRoot, install.skillId),
        })),
      );
    }
    const deferredCleanup = commitAgentOwnedSkillInstalls(skillInstalls);
    if (deferredCleanup.length > 0) {
      console.warn(
        `[agents] Deferred cleanup for agent-owned skill upgrade: ${deferredCleanup.join(", ")}`,
      );
    }
    console.log(`[agents] Added ${agentId} via ${applyResult}`);
    return { agents: listConfiguredAgents(config) };
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    try {
      writeConfigTextAtomically(originalConfigText);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      restoreAgentWorkspace(workspaceSnapshot);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      rollbackAgentOwnedSkillInstalls(skillInstalls);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (skillInstalls.some(agentOwnedSkillInstallChanged)) {
      try {
        restoreSkillIntegritySnapshotState(integritySnapshot, stateDir);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (restartAttempted && managedGateway) {
      try {
        await restartManagedGatewayAndRequireReady(`Rolling back failed agent addition ${agentId}`);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Failed to add agent "${agentId}" and fully restore the previous state`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function removeCatalogAgent(
  agentId: string,
): Promise<{ agents: Array<{ id: string; name: string }> }> {
  const persona = getAgentPersona(agentId);
  if (!persona || DEFAULT_AGENT_PERSONAS.some((candidate) => candidate.id === agentId)) {
    throw new Error(`Unknown removable agent "${agentId}"`);
  }

  const stateDir = getOpenClawStateDir();
  const configPath = getConfigPath();
  const originalConfigText = fs.readFileSync(configPath, "utf-8");
  const config = readConfig();
  if (!config) throw new Error("OpenClaw configuration is unavailable");

  ensureAgentPersonasConfig(config, stateDir);
  const result = removeConfiguredAgent(config, agentId);
  const skillConfigChanged = disableUnreferencedAgentOwnedSkills(config, agentId);
  const managedGateway = gatewaySpawnedByUs && gatewayProcess !== null;
  if (agentOwnedSkillMatchNames(agentId).length > 0 && !managedGateway) {
    throw new Error(`Cannot remove agent "${agentId}" with an externally managed Gateway`);
  }

  const integritySnapshot = captureSkillIntegritySnapshotState(stateDir);
  let skillRemovals: ReturnType<typeof prepareUnusedAgentOwnedSkillRemoval> = [];
  let restartAttempted = false;
  try {
    skillRemovals = prepareUnusedAgentOwnedSkillRemoval(
      config,
      agentId,
      stateDir,
      resolveAgentOwnedSkillBundleRoot(app.isPackaged, process.resourcesPath),
      { isTrustedInstalledSkill: isManagedSkillTrustedBySnapshot },
    );
    const skillRuntimeChanged = skillConfigChanged || skillRemovals.length > 0;
    if (!result.changed && !skillRuntimeChanged) {
      return { agents: listConfiguredAgents(config) };
    }
    persistAgentPersonas(config);
    let applyResult: "hot-reloaded" | "restarted" | "timed-out";
    if (skillRuntimeChanged) {
      restartAttempted = true;
      await restartManagedGatewayAndRequireReady(`Removing agent-owned skills for ${agentId}`);
      applyResult = await applyGatewayAgentRoster(agentId, false);
    } else {
      applyResult = await applyGatewayAgentRoster(
        agentId,
        false,
        managedGateway
          ? async () => {
              restartAttempted = true;
              await restartManagedGatewayAndRequireReady(
                `Removing agent ${agentId} after hot-reload timeout`,
              );
            }
          : undefined,
      );
    }
    if (applyResult === "timed-out") {
      throw new Error(
        `Gateway did not hot-reload removed agent "${agentId}" and is externally managed`,
      );
    }
    if (skillRemovals.length > 0) {
      acceptManagedSkillIntegrityChanges(
        skillRemovals.map((removal) => ({
          skillName: removal.skillId,
          expectedDirectory: null,
        })),
      );
    }
    const deferredCleanup = commitAgentOwnedSkillRemovals(skillRemovals);
    if (deferredCleanup.length > 0) {
      console.warn(
        `[agents] Deferred cleanup for agent-owned skill quarantine: ${deferredCleanup.join(", ")}`,
      );
    }
    console.log(`[agents] Removed ${agentId} via ${applyResult}`);
    return { agents: listConfiguredAgents(config) };
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    try {
      writeConfigTextAtomically(originalConfigText);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      rollbackAgentOwnedSkillRemovals(skillRemovals);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (skillRemovals.length > 0) {
      try {
        restoreSkillIntegritySnapshotState(integritySnapshot, stateDir);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (restartAttempted && managedGateway) {
      try {
        await restartManagedGatewayAndRequireReady(`Rolling back failed agent removal ${agentId}`);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Failed to remove agent "${agentId}" and fully restore the previous state`,
        { cause: error },
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Renderer URL (Vite dev server vs built files)
// ---------------------------------------------------------------------------
// In local development, prefer the Vite dev server. Packaged builds always use renderer/dist.
const isDev = !app.isPackaged;
const VITE_DEV_URL = "http://localhost:5173";
const PACKAGED_RENDERER_INDEX_PATH = path.join(__dirname, "../renderer/dist/index.html");
const APP_ICON_PATH = path.join(
  __dirname,
  process.platform === "win32" ? "../assets/microclaw.ico" : "../assets/microclaw.png",
);
const TRANSPARENT_WINDOW_BACKGROUND = "#00000000";

function _getRendererURL(): string {
  if (isDev) return VITE_DEV_URL;
  return pathToFileURL(PACKAGED_RENDERER_INDEX_PATH).href;
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------
function createMainWindow(): BrowserWindow {
  const backgroundLaunch = process.env.MICROCLAW_BACKGROUND === "1";
  const win = new BrowserWindow({
    width: LOADING_WINDOW_WIDTH,
    height: LOADING_WINDOW_HEIGHT,
    resizable: false,
    center: true,
    title: "MicroClaw",
    icon: APP_ICON_PATH,
    show: false,
    skipTaskbar: false,
    titleBarStyle: "hidden",
    transparent: true,
    backgroundColor: TRANSPARENT_WINDOW_BACKGROUND,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: internalFeatures.githubCopilot ? [INTERNAL_GITHUB_COPILOT_ARGUMENT] : [],
      backgroundThrottling: !backgroundLaunch,
    },
  });

  // Defer minimum-size enforcement because the loading window intentionally
  // starts smaller than the main app's minimum dimensions.
  win.on("will-resize", (event, newBounds) => {
    const currentBounds = win.getBounds();
    if (
      (newBounds.width < MIN_WINDOW_WIDTH && newBounds.width < currentBounds.width) ||
      (newBounds.height < MIN_WINDOW_HEIGHT && newBounds.height < currentBounds.height)
    ) {
      event.preventDefault();
    }
  });

  // Save bounds only after the window has expanded to full size.
  let saveBoundsRegistered = false;
  const registerSaveBounds = () => {
    if (saveBoundsRegistered) return;
    saveBoundsRegistered = true;
    let saveBoundsTimer: ReturnType<typeof setTimeout> | null = null;
    const saveBounds = () => {
      if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
      saveBoundsTimer = setTimeout(() => {
        if (!win.isMinimized() && !win.isMaximized()) {
          store.set("windowBounds", win.getBounds());
        }
      }, 300);
    };
    win.on("resize", saveBounds);
    win.on("move", saveBounds);
  };
  (win as any).__registerSaveBounds = registerSaveBounds;

  // Forward maximize/unmaximize state to renderer
  win.on("maximize", () => win.webContents.send("window:maximize-change", true));
  win.on("unmaximize", () => win.webContents.send("window:maximize-change", false));

  Menu.setApplicationMenu(null);
  if (isDev) win.webContents.openDevTools({ mode: "detach" });
  const showWindowOnStartup = () => showStartupWindow(win, backgroundLaunch);
  win.once("ready-to-show", showWindowOnStartup);
  win.webContents.once("did-finish-load", showWindowOnStartup);

  // Open external links in the default browser instead of navigating the app
  win.webContents.on("will-navigate", (event, url) => {
    if (
      isTrustedRendererUrl(url, {
        development: isDev,
        developmentUrl: VITE_DEV_URL,
        packagedIndexPath: PACKAGED_RENDERER_INDEX_PATH,
      })
    ) {
      return;
    }
    event.preventDefault();
    // Only open http(s) URLs in the system browser; block javascript:, data:, etc.
    if (url.startsWith("https://") || url.startsWith("http://")) {
      shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  win.on("close", (event) => {
    const prevented = shouldPreventWindowClose(lifecycleWindowState());
    electronLifecycleDiagnostics.log("window-close", {
      windowId: win.id,
      prevented,
    });
    if (prevented) {
      event.preventDefault();
      showAndFocusWindow(win);
    }
  });
  win.on("closed", () => {
    electronLifecycleDiagnostics.log("window-closed", { windowId: win.id });
    if (mainWindow === win) mainWindow = null;
    scheduleMainWindowRecovery("window-closed");
  });
  win.on("unresponsive", () => {
    electronLifecycleDiagnostics.log("window-unresponsive", { windowId: win.id });
  });
  win.on("responsive", () => {
    electronLifecycleDiagnostics.log("window-responsive", { windowId: win.id });
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    electronLifecycleDiagnostics.log("render-process-gone", {
      windowId: win.id,
      reason: details.reason,
      exitCode: details.exitCode,
    });
    scheduleMainWindowRecovery(`render-process-gone:${details.reason}`, win);
  });

  return win;
}

async function loadMainWindowRenderer(win: BrowserWindow): Promise<void> {
  if (isDev) {
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        await win.loadURL(VITE_DEV_URL);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    await win.loadURL(VITE_DEV_URL);
    return;
  }

  try {
    await win.loadFile(PACKAGED_RENDERER_INDEX_PATH);
  } catch (error) {
    electronLifecycleDiagnostics.log("renderer-load-retry", {
      error: summarizeLifecycleError(error),
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await win.loadFile(PACKAGED_RENDERER_INDEX_PATH);
  }
}

function scheduleMainWindowRecovery(
  reason: string,
  failedWindow?: BrowserWindow,
  force = false,
): void {
  if ((!force && !shouldRecoverWindow(lifecycleWindowState())) || mainWindowRecovery) return;
  electronLifecycleDiagnostics.log("window-recovery-scheduled", { reason });
  mainWindowRecovery = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (explicitQuitRequested) return;
    if (failedWindow && mainWindow === failedWindow) {
      if (!failedWindow.isDestroyed()) failedWindow.destroy();
      mainWindow = null;
    }
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      showAndFocusWindow(mainWindow);
      return;
    }
    const replacement = createMainWindow();
    mainWindow = replacement;
    await loadMainWindowRenderer(replacement);
    showAndFocusWindow(replacement);
    electronLifecycleDiagnostics.log("window-recovery-complete", {
      reason,
      windowId: replacement.id,
    });
  })()
    .catch((error) => {
      electronLifecycleDiagnostics.log("window-recovery-failed", {
        reason,
        error: summarizeLifecycleError(error),
      });
    })
    .finally(() => {
      mainWindowRecovery = null;
    });
}

function showOrRecoverMainWindow(reason: string): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    scheduleMainWindowRecovery(reason, mainWindow ?? undefined, true);
    return;
  }
  showAndFocusWindow(mainWindow);
}

// ---------------------------------------------------------------------------
// Gateway management
// ---------------------------------------------------------------------------

/** Check if an existing gateway is running on the given port */
function checkExistingGateway(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${port}/health`,
      { timeout: HEALTH_CHECK_HTTP_TIMEOUT_MS },
      (res) => resolve(res.statusCode === 200),
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function isGatewayPortOccupied(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (occupied: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

/** Wait for gateway health check to pass */
async function waitForGatewayReady(
  port: number,
  timeoutMs = GATEWAY_READY_TIMEOUT_MS,
  isProcessAlive: () => boolean = () => true,
): Promise<boolean> {
  return waitForGatewayHttpReadiness({
    probe: () => checkExistingGateway(port),
    isProcessAlive,
    timeoutMs,
    pollIntervalMs: 500,
  });
}

/** Kill the managed gateway and any listener still holding gatewayPort. */
function stopGatewayProcess(reason = "Emergency Gateway cleanup"): void {
  const startedAt = Date.now();
  electronLifecycleDiagnostics.log("gateway-stop-requested", {
    reason,
    mode: "forced",
    gatewayPid: gatewayProcess?.pid ?? null,
    gatewayGeneration: gatewayGenerationId || null,
  });
  closeWindowsNodeMxcWeixinRemoteApproval("gateway-stopped");
  stopBundledWindowsNodeHost();
  gatewayHttpReadyGeneration = null;
  windowsNodeMxcApprovalProofContext = null;
  const knownPid = gatewayProcess?.pid;
  gatewayProcess = null;
  gatewaySpawnedByUs = false;
  const pids = new Set<number>();
  let listenerScanSucceeded = gatewayPort === 0;
  let allGatewayProcessesStopped = process.platform === "win32";
  if (knownPid) pids.add(knownPid);
  if (gatewayPort && process.platform === "win32") {
    try {
      const result = execFileSync("netstat", ["-ano"], {
        windowsHide: true,
        encoding: "utf-8",
        timeout: 5_000,
      });
      listenerScanSucceeded = true;
      for (const line of result.split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/);
        if (
          columns.length >= 5 &&
          columns[0].toUpperCase() === "TCP" &&
          columns[1].endsWith(`:${gatewayPort}`) &&
          columns[3].toUpperCase() === "LISTENING"
        ) {
          const pid = Number.parseInt(columns[4], 10);
          if (Number.isInteger(pid) && pid > 0) pids.add(pid);
        }
      }
    } catch {
      // No listener or netstat unavailable; the known child PID is still used.
    }
  }
  for (const pid of pids) {
    console.log(`[gateway] killing process ${pid} on port ${gatewayPort}`);
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          timeout: 10_000,
          stdio: "ignore",
        });
      } catch {
        allGatewayProcessesStopped = false;
      }
    } else {
      allGatewayProcessesStopped = false;
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }
  const stoppedGatewayConfirmed =
    allGatewayProcessesStopped && (pids.size > 0 || listenerScanSucceeded);
  electronLifecycleDiagnostics.log("gateway-stop-complete", {
    reason,
    mode: "forced",
    gatewayGeneration: gatewayGenerationId || null,
    elapsedMs: Date.now() - startedAt,
    stoppedGatewayConfirmed,
  });
  if (stoppedGatewayConfirmed) {
    cleanupStoppedGatewayArtifacts();
  }
}

function cleanupStoppedGatewayArtifacts(): void {
  try {
    const result = cleanupStoppedGatewayWarmupSession(getOpenClawStateDir());
    if (result.indexEntryRemoved) {
      console.log(
        `[gateway] removed deferred warm-up session and ${result.artifactsRemoved.length} artifact(s)`,
      );
    }
  } catch (error) {
    console.warn("[gateway] deferred warm-up session cleanup failed:", error);
  }
}

async function stopGatewayProcessGracefully(reason: string): Promise<void> {
  if (gatewayStopPromise) return gatewayStopPromise;
  const child = gatewayProcess;
  if (!gatewaySpawnedByUs || !child?.pid) return;
  const pid = child.pid;
  const generation = gatewayGenerationId;
  const startedAt = Date.now();
  const stop = (async () => {
    console.info(
      `[gateway-stop] requested mode=graceful pid=${pid} generation=${generation} reason=${reason}`,
    );
    electronLifecycleDiagnostics.log("gateway-stop-requested", {
      reason,
      mode: "graceful",
      gatewayPid: pid,
      gatewayGeneration: generation,
    });
    closeWindowsNodeMxcWeixinRemoteApproval("gateway-stopped");
    closeWindowsNodeMxcIngress();
    stopBundledWindowsNodeHost();
    postSpawnChannelCheck = null;
    gatewayHttpReadyGeneration = null;
    windowsNodeMxcApprovalProofContext = null;
    const mode = await stopGatewayChildProcess({
      child,
      timeoutMs: 10_000,
      forceTimeoutMs: 3_000,
      forceStop: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform === "win32") {
          await new Promise<void>((resolve, reject) => {
            execFile(
              "taskkill",
              ["/pid", String(pid), "/T", "/F"],
              { windowsHide: true, timeout: 10_000 },
              (error) => (error ? reject(error) : resolve()),
            );
          });
        } else {
          child.kill("SIGKILL");
        }
      },
      onForceStop: (cause, error) => {
        console.warn(
          `[gateway-stop] mode=forced cause=${cause} pid=${pid} generation=${generation} elapsedMs=${Date.now() - startedAt} reason=${reason}`,
        );
        electronLifecycleDiagnostics.log("gateway-stop-force-fallback", {
          reason,
          cause,
          gatewayPid: pid,
          gatewayGeneration: generation,
          elapsedMs: Date.now() - startedAt,
          ...(error ? { error: summarizeLifecycleError(error) } : {}),
        });
      },
    });
    if (gatewayProcess === child) {
      gatewayProcess = null;
      gatewaySpawnedByUs = false;
    }
    cleanupStoppedGatewayArtifacts();
    console.info(
      `[gateway-stop] complete mode=${mode} pid=${pid} generation=${generation} elapsedMs=${Date.now() - startedAt} reason=${reason}`,
    );
    electronLifecycleDiagnostics.log("gateway-stop-complete", {
      reason,
      mode,
      gatewayPid: pid,
      gatewayGeneration: generation,
      elapsedMs: Date.now() - startedAt,
      exitCode: child.exitCode,
      signal: child.signalCode,
    });
  })();
  gatewayStopPromise = stop;
  try {
    await stop;
  } catch (error) {
    electronLifecycleDiagnostics.log("gateway-stop-failed", {
      reason,
      gatewayPid: pid,
      gatewayGeneration: generation,
      elapsedMs: Date.now() - startedAt,
      error: summarizeLifecycleError(error),
    });
    throw error;
  } finally {
    if (gatewayStopPromise === stop) gatewayStopPromise = null;
  }
}

function getGatewayListenerPids(port: number): Set<number> | null {
  if (process.platform !== "win32") return null;
  try {
    const output = execFileSync("netstat", ["-ano"], {
      windowsHide: true,
      encoding: "utf-8",
      timeout: 5_000,
    });
    const pids = new Set<number>();
    for (const line of output.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      if (
        columns.length >= 5 &&
        columns[0].toUpperCase() === "TCP" &&
        columns[1].endsWith(`:${port}`) &&
        columns[3].toUpperCase() === "LISTENING"
      ) {
        const pid = Number.parseInt(columns[4], 10);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
    }
    return pids;
  } catch {
    return null;
  }
}

function terminateGatewayProcessTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 10_000,
        stdio: "ignore",
      });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // Callers decide whether process-exit confirmation is required.
  }
}

async function stopGatewayForSecurityTransition(
  port: number,
  reason = "Windows Node + MXC security transition",
): Promise<void> {
  const startedAt = Date.now();
  electronLifecycleDiagnostics.log("gateway-security-stop-requested", {
    reason,
    mode: "forced",
  });
  closeWindowsNodeMxcWeixinRemoteApproval("security-transition");
  for (const pending of allPendingWindowsNodeMxcGatewayApprovals()) {
    void pending.lifecycle.cancel("security-transition");
  }
  pendingWindowsNodeMxcGatewayApproval = null;
  queuedWindowsNodeMxcGatewayApprovals.length = 0;
  sendToWindow(mainWindow, "windows-node-mxc:approval-request", null);
  stopBundledWindowsNodeHost(true);
  gatewayHttpReadyGeneration = null;
  const managedPid =
    gatewaySpawnedByUs && isManagedGatewayProcessAlive() ? gatewayProcess?.pid : undefined;
  const listenerPids = getGatewayListenerPids(port);
  if (listenerPids === null) {
    if (await isGatewayPortOccupied(port)) {
      throw new Error(
        `Cannot prove ownership of the Gateway listener on port ${port}; security mode was not changed`,
      );
    }
  } else if ([...listenerPids].some((pid) => pid !== managedPid)) {
    throw new Error(
      `Port ${port} is owned by an external process; stop it before changing security mode`,
    );
  }

  windowsNodeMxcApprovalProofContext = null;
  if (!managedPid) {
    gwClient?.stop();
    setGatewayStatus("stopped");
    return;
  }

  gwClient?.stop();
  gatewayProcess = null;
  gatewaySpawnedByUs = false;
  terminateGatewayProcessTree(managedPid);
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    let processAlive = true;
    try {
      process.kill(managedPid, 0);
    } catch {
      processAlive = false;
    }
    if (!processAlive && !(await isGatewayPortOccupied(port))) {
      electronLifecycleDiagnostics.log("gateway-security-stop-complete", {
        reason,
        mode: "forced",
        gatewayPid: managedPid,
        elapsedMs: Date.now() - startedAt,
      });
      setGatewayStatus("stopped");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  setGatewayStatus("failed");
  throw new Error(
    `Could not confirm that the previous Gateway stopped on port ${port}; MXC mode was not changed`,
  );
}

async function failClosedWindowsNodeMxc(reason: string): Promise<void> {
  if (!isWindowsNodeMxcDesired()) return;
  if (windowsNodeMxcFailClosedPromise) return windowsNodeMxcFailClosedPromise;
  const failClosed = (async () => {
    closeWindowsNodeMxcIngress();
    setWindowsNodeMxcLifecycleState("locked", reason);
    sendToWindow(mainWindow, "gateway:service-loading");
    bundledWindowsNodeHost.revokeActivationLease();
    const approvalResolution = windowsNodeMxcApprovalResolutionCompletion;
    if (approvalResolution) await approvalResolution;
    windowsNodeMxcActivationInProgress = false;
    settingsStore.delete("windowsNodeMxcSmoke");
    const message = `Windows Node + MXC relocked: ${reason}`;
    console.error(`[windows-node-mxc] ${message}`);
    mainWindow?.webContents.send("gateway:log", `[error] ${message}`);
    mainWindow?.webContents.send("gateway:ws-disconnected", message);
    try {
      const config = readConfig();
      if (config && typeof config === "object" && !Array.isArray(config)) {
        const nodeId = bundledWindowsNodeHost.ensureIdentityNodeId();
        const locked = applyWindowsNodeMxcGatewayPolicy(
          config,
          nodeId,
          settingsStore.get("windowsNodeMxcToolBackups"),
          "locked",
        );
        settingsStore.set("windowsNodeMxcToolBackups", locked.backups);
        writeConfigTextAtomically(JSON.stringify(locked.config, null, 2));
      }
    } finally {
      try {
        await stopGatewayForSecurityTransition(gatewayPort || DEFAULT_PORT, reason);
      } finally {
        setGatewayStatus("failed");
      }
    }
  })();
  windowsNodeMxcFailClosedPromise = failClosed;
  try {
    await failClosed;
  } finally {
    if (windowsNodeMxcFailClosedPromise === failClosed) {
      windowsNodeMxcFailClosedPromise = null;
    }
  }
}

async function restartManagedGateway(
  reason: string,
  allowDuringSecurityTransition = false,
  stopProcess: () => void | Promise<void> = () => stopGatewayProcessGracefully(reason),
): Promise<void> {
  if (explicitQuitRequested) throw new Error("Gateway restart is blocked while quitting");
  if (windowsNodeMxcSecurityTransitionInProgress && !allowDuringSecurityTransition) {
    throw new Error("Gateway restart is blocked during a Windows Node + MXC lifecycle operation");
  }
  const startedAt = Date.now();
  const previousGeneration = gatewayGenerationId;
  electronLifecycleDiagnostics.log("gateway-restart-requested", {
    reason,
    previousGeneration,
    coalesced: gatewayRestartPromise !== null,
  });
  console.info(`[restart] ${reason}`);
  if (gatewayRestartPromise) return gatewayRestartPromise;
  const restart = (async () => {
    gatewayRestarting = true;
    setGatewayStatus("restarting");
    sendToWindow(mainWindow, "gateway:ws-disconnected", reason);
    mainWindow?.webContents.send("gateway:log", `[restart] ${reason}`);
    try {
      await hardRestartGateway({
        stopClient: () => gwClient?.stop(),
        stopProcess,
        isPortOccupied: () => isGatewayPortOccupied(gatewayPort),
        startGateway,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        timeoutMs: 8_000,
        pollMs: 500,
      });
    } catch (error) {
      setGatewayStatus("failed");
      throw error;
    } finally {
      gatewayRestarting = false;
      electronLifecycleDiagnostics.log("gateway-restart-complete", {
        reason,
        previousGeneration,
        gatewayGeneration: gatewayGenerationId,
        elapsedMs: Date.now() - startedAt,
        status: gatewayStatus,
      });
      notifyRendererApplicationReady();
    }
  })();
  gatewayRestartPromise = restart;
  try {
    await restart;
  } finally {
    if (gatewayRestartPromise === restart) gatewayRestartPromise = null;
  }
}

async function restartManagedGatewayAndRequireReady(reason: string): Promise<void> {
  await restartManagedGateway(reason);
  if (gatewayStatus !== "running") {
    throw new Error(`Gateway did not become ready after restart (status: ${gatewayStatus})`);
  }
}

// ---------------------------------------------------------------------------
// Health monitor — auto-restart gateway if it goes down
// ---------------------------------------------------------------------------
function isManagedGatewayProcessAlive(): boolean {
  return gatewayProcess !== null && gatewayProcess.exitCode === null && !gatewayProcess.killed;
}

function startHealthMonitor(): void {
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  let consecutiveFailures = 0;
  let unresponsiveSince: number | null = null;
  healthCheckInterval = setInterval(async () => {
    // Skip during startup / intentional restart
    if (
      explicitQuitRequested ||
      gatewayStopPromise ||
      gatewayStatus === "stopped" ||
      gatewayStatus === "starting" ||
      gatewayRestarting
    ) {
      consecutiveFailures = 0;
      unresponsiveSince = null;
      return;
    }
    if (!gatewayPort) return;
    if (isWindowsNodeMxcDesired()) {
      // Pairing and internal proof-bound smokes are part of one activation transaction.
      // Avoid a competing health attestation until that transaction settles.
      if (windowsNodeMxcActivationInProgress || bundledWindowsNodeStartup) return;
      const inspectedProcess = gatewayProcess;
      try {
        const status = await getWindowsNodeMxcStatus();
        if (
          !isWindowsNodeMxcDesired() ||
          !inspectedProcess ||
          gatewayProcess !== inspectedProcess ||
          !isManagedGatewayProcessAlive()
        ) {
          return;
        }
        if (shouldStopManagedGatewayForWindowsNodeMxc(status)) {
          await failClosedWindowsNodeMxc(
            `Readiness drifted: ${status.blockers.join("; ") || "unknown readiness failure"}`,
          );
          return;
        }
        if (status.effectiveEnabled) {
          try {
            await bundledWindowsNodeHost.setActivationLease("active", 120_000);
          } catch (error) {
            await failClosedWindowsNodeMxc(
              `Activation lease renewal failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
          }
        }
      } catch (error) {
        await failClosedWindowsNodeMxc(
          `Health attestation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    }

    const alive = await checkExistingGateway(gatewayPort);
    if (explicitQuitRequested || gatewayStopPromise) return;
    if (alive) {
      consecutiveFailures = 0;
      unresponsiveSince = null;
      return;
    }
    if (gatewayStatus !== "running") {
      consecutiveFailures = 0;
      unresponsiveSince = null;
      return;
    }

    if (isManagedGatewayProcessAlive()) {
      consecutiveFailures = 0;
      unresponsiveSince ??= Date.now();
      const elapsedMs = Date.now() - unresponsiveSince;
      const msg =
        `[health-monitor] gateway unresponsive but process alive ` +
        `(${Math.floor(elapsedMs / 1_000)}s/${HEALTH_CHECK_BUSY_GRACE_MS / 1_000}s) - likely busy`;
      console.log(msg);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("gateway:log", msg);
      }
      if (elapsedMs < HEALTH_CHECK_BUSY_GRACE_MS) return;
      unresponsiveSince = null;

      try {
        await restartManagedGateway(
          "Gateway process remained unresponsive beyond the busy grace period",
        );
      } catch (error) {
        console.error("[health-monitor] Gateway restart failed:", error);
      }
      return;
    }

    unresponsiveSince = null;
    consecutiveFailures += 1;
    const msg = `[health-monitor] /health failed (${consecutiveFailures}/${HEALTH_CHECK_FAILURE_THRESHOLD})`;
    console.log(msg);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("gateway:log", msg);
    }
    if (consecutiveFailures < HEALTH_CHECK_FAILURE_THRESHOLD) return;
    consecutiveFailures = 0;

    try {
      await restartManagedGateway("Gateway health check failed; replacing process");
    } catch (error) {
      console.error("[health-monitor] Gateway restart failed:", error);
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

/** Check gateway health & reconnect if needed (called on window-show / focus) */
async function ensureGatewayConnected(): Promise<void> {
  if (
    explicitQuitRequested ||
    gatewayStopPromise ||
    windowsNodeMxcSecurityTransitionInProgress ||
    gatewayRestarting ||
    gatewayStatus === "starting"
  ) {
    return;
  }
  if (!gatewayPort) return;

  const alive = await checkExistingGateway(gatewayPort);
  if (explicitQuitRequested || gatewayStopPromise) return;
  if (alive) {
    // Gateway is up — if WS is not connected, reconnect
    if (!gwClient?.connected) {
      if (gatewayStatus !== "running") {
        setGatewayStatus("running");
      }
      connectGatewayWs();
    }
  } else if (isManagedGatewayProcessAlive()) {
    console.log(
      "[ensure-gateway] Gateway not reachable but process is alive; health monitor will retry",
    );
  } else {
    console.log("[ensure-gateway] Gateway not reachable — restarting...");
    await restartManagedGateway("Gateway was unreachable when the window became active");
  }
}

let gatewayStartInProgress = false;
let gatewayStartPromise: Promise<void> | null = null;

/** One skill's diagnostic status merged from `skills check` + `skills list --json`. */
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

interface SkillsStatusResult {
  ok: boolean;
  error?: string;
  summary: {
    total: number;
    modelVisible: number;
  };
  skills: SkillStatusRecord[];
}

/**
 * OpenClaw's CLI prints a config-warning banner before its JSON payload. Strip
 * everything before the first top-level `{` so the remainder parses cleanly.
 */
function stripJsonBanner(raw: string): string {
  const start = raw.indexOf("{");
  return start >= 0 ? raw.slice(start) : raw;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Merge the outputs of `skills list --agent <id> --json` (per-skill booleans +
 * `missing`) and `skills check --agent <id> --json` (aggregate buckets +
 * detailed `missingRequirements`) into one per-skill record list. `list` is the
 * primary source; `check` supplies `missingRequirements` detail and the model-visible
 * bucket. Either input may be null when its CLI call failed.
 */
function normalizeSkillsStatus(
  listJson: Record<string, unknown> | null,
  checkJson: Record<string, unknown> | null,
): SkillStatusRecord[] {
  // Detailed missing-requirement info keyed by skill name from `check`.
  const missingByName = new Map<
    string,
    { bins: string[]; anyBins: string[]; env: string[]; config: string[]; os: string[] }
  >();
  const missingReqs = Array.isArray(checkJson?.missingRequirements)
    ? (checkJson!.missingRequirements as unknown[])
    : [];
  for (const req of missingReqs) {
    if (typeof req !== "object" || req === null) continue;
    const r = req as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name : undefined;
    if (!name) continue;
    const m = (r.missing ?? {}) as Record<string, unknown>;
    missingByName.set(name, {
      bins: asStringArray(m.bins),
      anyBins: asStringArray(m.anyBins),
      env: asStringArray(m.env),
      config: asStringArray(m.config),
      os: asStringArray(m.os),
    });
  }

  const rawSkills = Array.isArray(listJson?.skills) ? (listJson!.skills as unknown[]) : [];
  const records: SkillStatusRecord[] = [];
  for (const raw of rawSkills) {
    if (typeof raw !== "object" || raw === null) continue;
    const s = raw as Record<string, unknown>;
    const name = typeof s.name === "string" ? s.name : "";
    // `skills list` keys skills by their frontmatter `name`; treat it as the skillKey
    // the UI needs for global gating only when a distinct key isn't provided.
    const skillKey =
      typeof s.skillKey === "string" ? s.skillKey : typeof s.key === "string" ? s.key : name;
    const detail = missingByName.get(name);
    const perSkillMissing = (s.missing ?? {}) as Record<string, unknown>;
    records.push({
      skillKey,
      name,
      source: typeof s.source === "string" ? s.source : "",
      bundled: Boolean(s.bundled),
      eligible: Boolean(s.eligible),
      disabled: Boolean(s.disabled),
      modelVisible: Boolean(s.modelVisible),
      commandVisible: Boolean(s.commandVisible),
      blockedByAllowlist: Boolean(s.blockedByAllowlist),
      blockedByAgentFilter: Boolean(s.blockedByAgentFilter),
      missing: detail ?? {
        bins: asStringArray(perSkillMissing.bins),
        anyBins: asStringArray(perSkillMissing.anyBins),
        env: asStringArray(perSkillMissing.env),
        config: asStringArray(perSkillMissing.config),
        os: asStringArray(perSkillMissing.os),
      },
    });
  }
  return records;
}

async function startGateway(
  preparedContainment?: PreparedWindowsNodeMxcContainment,
): Promise<void> {
  if (explicitQuitRequested) return;
  if (gatewayStartPromise) return gatewayStartPromise;
  const start = (async () => {
    gatewayStartInProgress = true;
    try {
      if (gatewayStopPromise) await gatewayStopPromise;
      if (explicitQuitRequested) return;
      await startGatewayInner(1, preparedContainment);
    } finally {
      gatewayStartInProgress = false;
    }
  })();
  gatewayStartPromise = start;
  try {
    await start;
  } finally {
    if (gatewayStartPromise === start) gatewayStartPromise = null;
  }
}

async function startGatewayWithWindowsNodeMxcPolicy(
  policy: "active" | "locked",
  preparedContainment?: PreparedWindowsNodeMxcContainment,
): Promise<void> {
  if (windowsNodeMxcGatewayStartPolicyOverride !== null) {
    throw new Error("A managed Gateway policy override is already in progress");
  }
  windowsNodeMxcGatewayStartPolicyOverride = policy;
  try {
    await startGateway(preparedContainment);
  } finally {
    windowsNodeMxcGatewayStartPolicyOverride = null;
  }
}

async function startGatewayInner(
  startupRetriesRemaining = 1,
  preparedContainment?: PreparedWindowsNodeMxcContainment,
): Promise<void> {
  if (explicitQuitRequested) return;
  const startupTiming = new GatewayStartupTiming(++gatewayStartupAttempt, logGatewayStartupTiming);
  logStartupTiming("gateway-preflight-start");
  // Read config to get token and configured port
  let config = readConfig();
  if (isWindowsNodeMxcDesired()) {
    const nodeId = bundledWindowsNodeHost.ensureIdentityNodeId();
    const policyState = getWindowsNodeMxcGatewayPolicyState(config, nodeId);
    const requestedState = selectWindowsNodeMxcGatewayStartPolicy(
      windowsNodeMxcGatewayStartPolicyOverride,
      windowsNodeMxcActivationInProgress,
    );
    if (policyState === "active" && requestedState === "locked") {
      settingsStore.delete("windowsNodeMxcSmoke");
      console.warn("[windows-node-mxc] Relocked active policy for fresh startup attestation");
    }
    const pinned = applyWindowsNodeMxcGatewayPolicy(
      config,
      nodeId,
      settingsStore.get("windowsNodeMxcToolBackups"),
      requestedState,
    );
    if (JSON.stringify(config) !== JSON.stringify(pinned.config)) {
      writeConfigTextAtomically(JSON.stringify(pinned.config, null, 2));
    }
    config = pinned.config;
    settingsStore.set("windowsNodeMxcToolBackups", pinned.backups);
    settingsStore.set("windowsNodeMxcNodeId", nodeId);
    const policy = validateWindowsNodeMxcGatewayPolicy(config, nodeId, requestedState);
    if (!policy.ready) {
      const message = `Windows Node + MXC Gateway policy drift: ${policy.blockers.join("; ")}`;
      console.error(`[windows-node-mxc] ${message}`);
      mainWindow?.webContents.send("gateway:log", `[error] ${message}`);
      setGatewayStatus("failed");
      return;
    }
  }
  gatewayToken = config?.gateway?.auth?.token || "";
  const configuredPort = config?.gateway?.port || DEFAULT_PORT;
  gatewayPort = configuredPort;
  const stateDir = getOpenClawStateDir();
  let nodePath: string;
  try {
    nodePath = resolveNodePath();
  } catch (error) {
    const message = `[error] ${error instanceof Error ? error.message : String(error)}`;
    console.error(message);
    mainWindow?.webContents.send("gateway:log", message);
    setGatewayStatus("failed");
    throw error;
  }
  const entryPath = resolveOpenClawEntry();
  const openClawPackageDir = resolveOpenClawPackageDir(entryPath);
  const gatewayEnvironment = loadGatewayEnvironment(stateDir);

  // Apply MicroClaw's default workspace identity before persona migration.
  // This also updates existing installations when connecting to a running Gateway.
  seedWorkspaceFiles(stateDir);

  // Ensure plugins.allow includes enabled plugins so they load synchronously
  // (avoids the race where auto-discovered plugins miss the channel-start sweep)
  ensurePluginsAllow();
  postSpawnChannelCheckRequired =
    !isWindowsNodeMxcDesired() && requiresPostSpawnChannelCheck(readConfig());

  const preparedPersonas = prepareAgentPersonas(stateDir);
  if (isWindowsNodeMxcDesired() && preparedPersonas) {
    settingsStore.set(
      "windowsNodeMxcToolBackups",
      migrateWindowsNodeMxcToolBackupAliases(
        settingsStore.get("windowsNodeMxcToolBackups"),
        LEGACY_AGENT_ID_ALIASES,
      ),
    );
    const policy = validateWindowsNodeMxcGatewayPolicy(
      preparedPersonas.config,
      settingsStore.get("windowsNodeMxcNodeId"),
      selectWindowsNodeMxcGatewayStartPolicy(
        windowsNodeMxcGatewayStartPolicyOverride,
        windowsNodeMxcActivationInProgress,
      ),
    );
    if (!policy.ready) {
      const message = `Windows Node + MXC blocked an unprotected agent roster change: ${policy.blockers.join("; ")}`;
      console.error(`[windows-node-mxc] ${message}`);
      mainWindow?.webContents.send("gateway:log", `[error] ${message}`);
      setGatewayStatus("failed");
      return;
    }
  }
  const originalAgentConfigText = fs.existsSync(getConfigPath())
    ? fs.readFileSync(getConfigPath(), "utf-8")
    : null;
  const originalIntegritySnapshot = captureSkillIntegritySnapshotState(stateDir);
  const agentSkillBundleRoot = resolveAgentOwnedSkillBundleRoot(
    app.isPackaged,
    process.resourcesPath,
  );
  const ownedSkillTrust = {
    isTrustedInstalledSkill: isManagedSkillTrustedBySnapshot,
  };

  // Check ownership before any agent-owned skill filesystem mutation. An
  // externally managed Gateway may observe the shared state directory.
  startupTiming.completeMicroclawPhase("configuration-and-personas");
  const alreadyRunning = await checkExistingGateway(configuredPort);
  startupTiming.completeMicroclawPhase("existing-gateway-check");
  logStartupTiming("gateway-existing-check-complete");
  const externallyManagedGateway =
    alreadyRunning && !(gatewaySpawnedByUs && gatewayProcess !== null);
  logStartupTiming("weixin-runtime-start");
  if (!alreadyRunning) {
    const bundledWeixinPluginRoot = resolveBundledWeixinPluginRoot(
      app.isPackaged,
      process.resourcesPath,
    );
    if (!fs.existsSync(bundledWeixinPluginRoot)) {
      if (app.isPackaged) {
        throw new Error("The packaged Weixin runtime resource is missing");
      }
      console.warn(
        "[weixin] Skipping plugin convergence because the development resource is absent",
      );
    } else {
      const convergence = convergeWeixinPluginRuntime({
        bundledPluginRoot: bundledWeixinPluginRoot,
        stateDir,
        hostPackageDir: resolveOpenClawPackageDir(entryPath),
      });
      console.info(
        `[weixin] Runtime ${convergence.changed ? "converged" : "verified"} at version ${convergence.packageVersion} (${convergence.treeSha256})`,
      );
      if (!isWindowsNodeMxcDesired()) {
        const config = preparedPersonas?.config ?? readConfig();
        if (config && ensureDefaultWeixinPlugin(config)) {
          if (preparedPersonas) preparedPersonas.changed = true;
          else fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
        }
        postSpawnChannelCheckRequired = requiresPostSpawnChannelCheck(config);
      }
    }
  } else {
    console.info("[weixin] Deferred plugin convergence because a Gateway is already running");
  }
  startupTiming.completeMicroclawPhase("weixin-runtime-verification");
  const ownedSkillPlan = preparedPersonas
    ? inspectConfiguredAgentOwnedSkills(
        preparedPersonas.config,
        stateDir,
        agentSkillBundleRoot,
        ownedSkillTrust,
      )
    : { required: false, reasons: [] };
  if (externallyManagedGateway && (preparedPersonas?.changed || ownedSkillPlan.required)) {
    failForExternalGateway(configuredPort);
  }

  const agentSkillReconciliation =
    preparedPersonas && !externallyManagedGateway
      ? reconcileConfiguredAgentOwnedSkills(
          preparedPersonas.config,
          stateDir,
          agentSkillBundleRoot,
          ownedSkillTrust,
        )
      : { installs: [], removals: [], configChanged: false, runtimeChanged: false };
  const agentConfigurationChanged =
    (preparedPersonas?.changed ?? false) || agentSkillReconciliation.runtimeChanged;
  const agentSkillDiskChanged =
    agentSkillReconciliation.installs.some(
      (install) => agentOwnedSkillInstallChanged(install) || install.markerCreated,
    ) || agentSkillReconciliation.removals.length > 0;
  const agentSkillIntegrityChanged =
    agentSkillReconciliation.installs.some(agentOwnedSkillInstallChanged) ||
    agentSkillReconciliation.removals.length > 0;
  let agentSkillTransactionPending = agentSkillDiskChanged || agentConfigurationChanged;
  const workspaceSnapshots = preparedPersonas
    ? captureAgentWorkspaces(preparedPersonas.config, stateDir, gatewayEnvironment, entryPath)
    : [];

  const rollbackStartupAgentSkills = () => {
    if (!agentSkillTransactionPending) return;
    rollbackAgentOwnedSkillInstalls(agentSkillReconciliation.installs);
    rollbackAgentOwnedSkillRemovals(agentSkillReconciliation.removals);
    if (originalAgentConfigText !== null) {
      writeConfigTextAtomically(originalAgentConfigText);
    }
    restoreAgentWorkspaces(workspaceSnapshots);
    restoreSkillIntegritySnapshotState(originalIntegritySnapshot, stateDir);
    agentSkillTransactionPending = false;
  };

  const commitStartupAgentSkills = () => {
    if (!agentSkillTransactionPending) return;
    if (agentSkillIntegrityChanged) {
      acceptManagedSkillIntegrityChanges([
        ...agentSkillReconciliation.installs
          .filter(agentOwnedSkillInstallChanged)
          .map((install) => ({
            skillName: install.skillId,
            expectedDirectory: path.join(agentSkillBundleRoot, install.skillId),
          })),
        ...agentSkillReconciliation.removals.map((removal) => ({
          skillName: removal.skillId,
          expectedDirectory: null,
        })),
      ]);
    }
    const deferredUpgradeCleanup = commitAgentOwnedSkillInstalls(agentSkillReconciliation.installs);
    if (deferredUpgradeCleanup.length > 0) {
      console.warn(
        `[startup] Deferred cleanup for agent-owned skill upgrade: ${deferredUpgradeCleanup.join(", ")}`,
      );
    }
    const deferredCleanup = commitAgentOwnedSkillRemovals(agentSkillReconciliation.removals);
    if (deferredCleanup.length > 0) {
      console.warn(
        `[startup] Deferred cleanup for agent-owned skill quarantine: ${deferredCleanup.join(", ")}`,
      );
    }
    agentSkillTransactionPending = false;
  };

  // If gateway is already healthy, just connect WS and return — no new process.
  // Callers that need replacement use restartManagedGateway(), which stops the
  // old process and waits for the port before invoking this function.
  if (
    isWindowsNodeMxcDesired() &&
    alreadyRunning &&
    (!gatewaySpawnedByUs || !isManagedGatewayProcessAlive())
  ) {
    failForExternalGateway(configuredPort);
  }
  if (
    requiresExternalGatewayStop(
      alreadyRunning,
      agentConfigurationChanged,
      gatewaySpawnedByUs,
      gatewayProcess !== null,
    )
  ) {
    rollbackStartupAgentSkills();
    failForExternalGateway(configuredPort);
  }
  try {
    if (preparedPersonas?.changed || agentSkillReconciliation.configChanged) {
      persistAgentPersonas(preparedPersonas!.config);
    }
    if (preparedPersonas && !externallyManagedGateway) {
      agentSkillTransactionPending = true;
      seedSpecialistAgentWorkspaces(
        preparedPersonas.config,
        stateDir,
        entryPath,
        gatewayEnvironment,
      );
    }
  } catch (error) {
    rollbackStartupAgentSkills();
    throw error;
  }
  startupTiming.completeMicroclawPhase("agent-skills-and-workspaces");
  try {
    if (explicitQuitRequested) {
      rollbackStartupAgentSkills();
      return;
    }
    if (alreadyRunning && !agentConfigurationChanged) {
      commitStartupAgentSkills();
      console.log(`[gateway] Already healthy on port ${configuredPort} — skipping spawn`);
      startupTiming.reused(gatewayGenerationId);
      currentGatewayStartupTiming = startupTiming;
      gatewaySpawnedByUs = false;
      postSpawnChannelCheck = null;
      setGatewayStatus("running");
      connectGatewayWs();
      startHealthMonitor();
      return;
    }
    if (alreadyRunning) {
      console.log(
        "[gateway] Agent or owned-skill configuration changed — restarting to load canonical configuration",
      );
      gwClient?.stop();
    }

    if (gatewaySpawnedByUs && gatewayProcess) {
      await stopGatewayProcessGracefully("Replacing managed Gateway during startup");
    } else if (await isGatewayPortOccupied(configuredPort)) {
      stopGatewayProcess("Cleaning stale Gateway listener before startup");
    }
    const portReleaseDeadline = Date.now() + 8_000;
    while (await isGatewayPortOccupied(configuredPort)) {
      if (explicitQuitRequested) {
        rollbackStartupAgentSkills();
        return;
      }
      if (Date.now() >= portReleaseDeadline) {
        throw new Error(`Gateway port ${configuredPort} remained occupied after process stop`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    startupTiming.completeMicroclawPhase("gateway-stop-and-port-release");
    logStartupTiming("gateway-stop-complete");
    if (explicitQuitRequested) {
      rollbackStartupAgentSkills();
      return;
    }

    // Clean stale gateway lock files (survive force-kill / uninstall-reinstall)
    try {
      const lockDir = path.join(process.env.LOCALAPPDATA || "", "Temp", "openclaw");
      if (fs.existsSync(lockDir)) {
        for (const f of fs.readdirSync(lockDir)) {
          if (f.startsWith("gateway.") && f.endsWith(".lock")) {
            fs.unlinkSync(path.join(lockDir, f));
            console.log(`Removed stale lock: ${f}`);
          }
        }
      }
    } catch {}

    if (!fs.existsSync(nodePath)) {
      const msg = `[error] node.exe not found at ${nodePath}`;
      console.error(msg);
      mainWindow?.webContents.send("gateway:log", msg);
      mainWindow?.webContents.send(
        "gateway:log",
        "[hint] 请确认安装程序已完成，或手动检查 .openclaw-node 目录",
      );
      setGatewayStatus("failed");
      rollbackStartupAgentSkills();
      return;
    }
    if (!fs.existsSync(entryPath)) {
      const msg = `[error] openclaw entry not found at ${entryPath}`;
      console.error(msg);
      mainWindow?.webContents.send("gateway:log", msg);
      mainWindow?.webContents.send(
        "gateway:log",
        "[hint] 请确认 openclaw 已正确安装到 .openclaw-node",
      );
      setGatewayStatus("failed");
      rollbackStartupAgentSkills();
      return;
    }

    console.log(
      `Launching gateway: stateDir=${stateDir} auth=${gatewayToken ? "configured" : "missing"}`,
    );
    console.log(`Launching gateway: node=${nodePath} entry=${entryPath} port=${configuredPort}`);

    // Ensure compile cache directory exists for Node 22+ V8 bytecode caching
    const compileCacheDir = path.join(stateDir, COMPILE_CACHE_SUBDIR);
    if (!fs.existsSync(compileCacheDir)) {
      fs.mkdirSync(compileCacheDir, { recursive: true });
    }

    // Spawn gateway as a hidden background process — logs are forwarded
    // to the renderer via the gateway:log IPC channel (visible in Settings).

    const windowsNodeMxcDesired = isWindowsNodeMxcDesired();
    const windowsNodeMxcRequestedMode = getWindowsNodeMxcRequestedMode();
    if (!windowsNodeMxcDesired) {
      await tryConsumeWindowsNodeMxcCronResumeAcknowledgement();
    }
    const storedCronResumeFence = settingsStore.get("windowsNodeMxcCronResumeFence");
    const cronResumeFence =
      windowsNodeMxcDesired || storedCronResumeFence === undefined
        ? null
        : parseWindowsNodeMxcCronResumeFence(storedCronResumeFence);
    if (!windowsNodeMxcDesired && storedCronResumeFence !== undefined && !cronResumeFence) {
      throw new Error("Stored MXC Cron resume fence is invalid");
    }
    if (preparedContainment) {
      if (windowsNodeMxcRequestedMode === "off") {
        throw new Error("Prepared MXC containment cannot be used for a standard Gateway");
      }
      assertPreparedWindowsNodeMxcContainment(preparedContainment, windowsNodeMxcRequestedMode);
    }
    const containmentPreparation =
      windowsNodeMxcDesired && windowsNodeMxcRequestedMode !== "off"
        ? (preparedContainment ??
          (await prepareWindowsNodeMxcContainment(windowsNodeMxcRequestedMode)))
        : null;
    const nextGatewayGenerationId = randomUUID();
    const nextApprovalProofContext = windowsNodeMxcDesired
      ? bundledWindowsNodeHost.createApprovalProofContext(
          nextGatewayGenerationId,
          settingsStore.get("windowsNodeMxcNodeId"),
          getBundledWindowsNodeFolders(),
          stateDir,
          windowsNodeMxcReadinessTransitionId ?? randomUUID(),
          windowsNodeMxcRequestedMode === "limited-dacl" ? "limited-dacl" : "full",
          containmentPreparation?.effectiveTier ?? "",
          containmentPreparation?.ambientAccess ?? null,
        )
      : null;
    const nextRemoteApprovalConfiguration = getWindowsNodeMxcWeixinRemoteApprovalConfiguration();
    const nextWeixinContext = nextApprovalProofContext
      ? prepareWindowsNodeMxcWeixinContext(
          app.getPath("userData"),
          nextApprovalProofContext.gatewayGeneration,
          nextApprovalProofContext.policyFingerprint,
          getBundledWindowsNodeFolders(),
          nextRemoteApprovalConfiguration.enabled,
        )
      : null;
    closeWindowsNodeMxcWeixinRemoteApproval("gateway-generation-change");
    if (
      nextWeixinContext?.remoteApprovalPipe &&
      nextWeixinContext.remoteApprovalToken &&
      nextRemoteApprovalConfiguration.enabled
    ) {
      const server = new WindowsNodeMxcWeixinRemoteApprovalServer(
        nextWeixinContext.remoteApprovalPipe,
        nextWeixinContext.remoteApprovalToken,
        async (source) => ({
          ...(await handleWindowsNodeMxcWeixinRemoteApprovalInbound(source)),
          approvalActive: Boolean(
            pendingWindowsNodeMxcGatewayApproval?.lifecycle.pending &&
            pendingWindowsNodeMxcGatewayApproval.remoteChallengeId,
          ),
        }),
        (accountId) => {
          for (const pending of allPendingWindowsNodeMxcGatewayApprovals()) {
            if (!pending.lifecycle.pending || pending.remoteSource?.accountId !== accountId)
              continue;
            if (pending.remoteChallengeId)
              windowsNodeMxcWeixinRemoteApprovalBroker.invalidateChallenge(
                pending.remoteChallengeId,
                "transport-unavailable",
              );
            publishPendingWeixinRemoteDelivery(pending, {
              state: "unconfirmed",
              reason: "transport-unavailable",
              replyMode: null,
              revision: 0,
            });
            console.info("[weixin-remote-approval]", {
              reason: "transport-unavailable",
              ...remoteApprovalDiagnosticBinding(pending.request),
            });
          }
        },
      );
      try {
        await server.start();
        windowsNodeMxcWeixinRemoteApprovalServer = server;
      } catch (error) {
        server.close();
        console.error("[weixin-remote-approval] Broker transport failed to start:", error);
      }
    }
    const nextHooksEnvironment =
      nextApprovalProofContext && windowsNodeMxcRequestedMode !== "off"
        ? getWindowsNodeMxcHooksEnvironment(
            createWindowsNodeMxcHooksGatePolicy({
              gatewayGeneration: nextApprovalProofContext.gatewayGeneration,
              policyFingerprint: nextApprovalProofContext.policyFingerprint,
              requestedMode: windowsNodeMxcRequestedMode,
              hooksConfig: getWindowsNodeMxcIngressBackup(
                settingsStore.get("windowsNodeMxcToolBackups"),
                "hooks",
              ),
            }),
          )
        : {};
    const nextWeixinEnvironment = nextWeixinContext
      ? getWindowsNodeMxcWeixinEnvironment(nextWeixinContext)
      : {};
    const gwEnv: Record<string, string> = {
      ...gatewayEnvironment,
      OPENCLAW_STATE_DIR: stateDir,
      NODE_OPTIONS: "--disable-warning=ExperimentalWarning --dns-result-order=ipv4first",
      NODE_ENV: "production",
      NODE_COMPILE_CACHE: compileCacheDir,
      // The Desktop owns the Gateway process and its compile cache.
      OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: "1",
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_NO_AUTO_UPDATE: "1",
      OPENCLAW_GATEWAY_HOST_LIFELINE: "stdin",
    };
    for (const reservedName of [
      "MICROCLAW_MXC_APPROVAL_PRELOAD_INITIALIZED",
      "MICROCLAW_MXC_CRON_PAUSED",
      "MICROCLAW_MXC_CRON_RESUME_FENCE_UNIX_MS",
      "MICROCLAW_MXC_CRON_RESUME_ACK_PATH",
      "MICROCLAW_MXC_CRON_RESUME_ACK_TOKEN",
      "MICROCLAW_MXC_HOOKS_GATE_POLICY_BASE64",
      "MICROCLAW_MXC_CANVAS_PHASE1",
    ]) {
      delete gwEnv[reservedName];
    }
    clearInheritedWindowsNodeMxcWeixinEnvironment(gwEnv);
    Object.assign(gwEnv, nextWeixinEnvironment);
    if (windowsNodeMxcDesired) {
      gwEnv.MICROCLAW_MXC_CRON_PAUSED = "1";
      gwEnv.MICROCLAW_MXC_CANVAS_PHASE1 = "1";
    }
    Object.assign(gwEnv, nextHooksEnvironment);
    if (cronResumeFence) {
      Object.assign(gwEnv, getWindowsNodeMxcCronResumeEnvironment(cronResumeFence));
    }

    const approvalCompatPath = app.isPackaged
      ? path.join(process.resourcesPath, "openclaw-approval-replay-compat.mjs")
      : path.join(__dirname, "..", "src", "openclaw-approval-replay-compat.mjs");
    const fsSafeCompatPath = app.isPackaged
      ? path.join(process.resourcesPath, "openclaw-fs-safe-compat.mjs")
      : path.join(__dirname, "..", "src", "openclaw-fs-safe-compat.mjs");
    const localModelCompatPath = app.isPackaged
      ? path.join(process.resourcesPath, "openclaw-local-model-compat.mjs")
      : path.join(__dirname, "..", "src", "openclaw-local-model-compat.mjs");
    const stateOwnerCompatPath = app.isPackaged
      ? path.join(process.resourcesPath, "openclaw-state-owner-compat.mjs")
      : path.join(__dirname, "..", "src", "openclaw-state-owner-compat.mjs");
    if (!fs.existsSync(stateOwnerCompatPath)) {
      throw new Error(
        `OpenClaw state owner compatibility preload is missing: ${stateOwnerCompatPath}`,
      );
    }
    gwEnv.MICROCLAW_WINDOWS_STATE_OWNER_COMPAT = "1";
    if (!fs.existsSync(localModelCompatPath))
      throw new Error("The exact local model adapter is missing");
    gwEnv.MICROCLAW_EXACT_LOCAL_MODELS = "1";
    gwEnv.MICROCLAW_LOCAL_MODEL_PLUGIN_DIR = path.join(stateDir, "extensions", "llama-cpp");
    if (!fs.existsSync(fsSafeCompatPath)) {
      throw new Error(`OpenClaw filesystem compatibility preload is missing: ${fsSafeCompatPath}`);
    }
    gwEnv.MICROCLAW_FS_SAFE_COMPAT = "1";
    gwEnv.MICROCLAW_OPENCLAW_PACKAGE_DIR = openClawPackageDir;
    if (windowsNodeMxcDesired || cronResumeFence) {
      if (!fs.existsSync(approvalCompatPath)) {
        const msg = `[error] Windows Node + MXC compatibility preload is missing: ${approvalCompatPath}`;
        console.error(msg);
        mainWindow?.webContents.send("gateway:log", msg);
        setGatewayStatus("failed");
        rollbackStartupAgentSkills();
        return;
      }
      if (windowsNodeMxcDesired) {
        gwEnv.MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT = "1";
        if (!nextApprovalProofContext) {
          throw new Error("Windows Node + MXC approval proof context is unavailable");
        }
        gwEnv.MICROCLAW_MXC_APPROVAL_PROOF_SECRET = nextApprovalProofContext.secretBase64;
        gwEnv.MICROCLAW_MXC_APPROVAL_PROOF_GATEWAY_GENERATION =
          nextApprovalProofContext.gatewayGeneration;
        gwEnv.MICROCLAW_MXC_APPROVAL_PROOF_POLICY_FINGERPRINT =
          nextApprovalProofContext.policyFingerprint;
        gwEnv.MICROCLAW_MXC_APPROVAL_PROOF_NODE_ID = nextApprovalProofContext.nodeId;
      }
    }

    const gwArgs = [
      "--import",
      pathToFileURL(stateOwnerCompatPath).href,
      "--import",
      pathToFileURL(fsSafeCompatPath).href,
      "--import",
      pathToFileURL(localModelCompatPath).href,
      ...(windowsNodeMxcDesired || cronResumeFence
        ? ["--import", pathToFileURL(approvalCompatPath).href]
        : []),
      entryPath,
      "gateway",
      "run",
      "--port",
      String(configuredPort),
      "--bind",
      "loopback",
      // Never ask OpenClaw to terminate an unowned listener.
      "--allow-unconfigured",
    ];

    if (explicitQuitRequested) {
      rollbackStartupAgentSkills();
      return;
    }
    const spawnStartedAt = Date.now();
    logStartupTiming("gateway-spawn");
    console.info(`[gateway-start] generation=${nextGatewayGenerationId} port=${configuredPort}`);
    startupTiming.spawned(nextGatewayGenerationId);
    const child = spawn(nodePath, gwArgs, {
      cwd: path.dirname(entryPath),
      env: gwEnv,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
      ...(process.platform === "win32" ? { creationFlags: CREATE_NO_WINDOW } : {}),
    });

    gatewayProcess = child;
    gatewayGenerationId = nextGatewayGenerationId;
    currentGatewayStartupTiming = startupTiming;
    electronLifecycleDiagnostics.log("gateway-spawned", {
      gatewayPid: child.pid ?? null,
      gatewayGeneration: nextGatewayGenerationId,
      policy: windowsNodeMxcGatewayStartPolicyOverride ?? "standard",
    });
    gatewayHttpReadyGeneration = null;
    windowsNodeMxcApprovalProofContext = nextApprovalProofContext;
    revokeWindowsNodeMxcWeixinIngress(windowsNodeMxcWeixinContext);
    windowsNodeMxcWeixinContext = nextWeixinContext;
    closeWindowsNodeMxcIngress();
    gatewaySpawnedByUs = true;
    postSpawnChannelCheckCompletedFor = null;
    postSpawnChannelCheck = null;
    child.stdin?.on("error", (error) => {
      electronLifecycleDiagnostics.log("gateway-lifeline-error", {
        gatewayPid: child.pid ?? null,
        gatewayGeneration: nextGatewayGenerationId,
        error: summarizeLifecycleError(error),
      });
    });

    const safeSendLog = (channel: string, payload: unknown) => {
      try {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send(channel, payload);
        }
      } catch {
        // window tearing down — ignore
      }
    };

    // Forward stdout/stderr to the renderer's gateway log viewer
    child.stdout?.on("data", (data: Buffer) => {
      const msg = data.toString("utf-8").trim();
      if (msg) {
        console.log(`[gateway] ${msg}`);
        safeSendLog("gateway:log", msg);
      }
    });
    let startupStderr = "";
    child.stderr?.on("data", (data: Buffer) => {
      startupStderr = (startupStderr + data.toString("utf-8")).slice(-8192);
      const msg = data.toString("utf-8").trim();
      if (msg) {
        console.log(`[gateway:err] ${msg}`);
        safeSendLog("gateway:log", msg);
      }
    });

    child.on("error", (err) => {
      electronLifecycleDiagnostics.log("gateway-spawn-error", {
        gatewayPid: child.pid ?? null,
        error: summarizeLifecycleError(err),
      });
      console.error("Gateway spawn error:", err);
      safeSendLog("gateway:log", `[error] Gateway spawn failed: ${err.message}`);
      safeSendLog("gateway:log", `[info] node=${nodePath} entry=${entryPath}`);
      if (gatewayProcess === child) {
        if (!postInstallReadySignaled) signalPostInstallFailure(err);
        closeWindowsNodeMxcIngress();
        gatewayHttpReadyGeneration = null;
        windowsNodeMxcApprovalProofContext = null;
        bundledWindowsNodeHost.revokeActivationLease();
        stopBundledWindowsNodeHost();
        gatewayProcess = null;
        gatewaySpawnedByUs = false;
        setGatewayStatus("failed");
      }
    });

    child.on("exit", (code, signal) => {
      electronLifecycleDiagnostics.log("gateway-exit", {
        gatewayPid: child.pid ?? null,
        gatewayGeneration: nextGatewayGenerationId,
        elapsedMs: Date.now() - spawnStartedAt,
        exitCode: code,
        signal,
      });
      console.log(`[gateway] exited: code=${code} signal=${signal}`);
      safeSendLog("gateway:log", `Gateway exited: code=${code} signal=${signal}`);
      if (gatewayProcess === child) {
        weixinMutations.gatewayStopped();
        weixinQrSession.reset();
        weixinRuntimeRead = null;
        // EX_CONFIG is terminal: waiting longer cannot repair rejected configuration.
        if (code === 78 && !postInstallReadySignaled) {
          signalPostInstallFailure(
            new Error("Gateway rejected its configuration (exit 78); see the desktop handoff log"),
          );
        }
        closeWindowsNodeMxcIngress();
        gatewayHttpReadyGeneration = null;
        windowsNodeMxcApprovalProofContext = null;
        bundledWindowsNodeHost.revokeActivationLease();
        stopBundledWindowsNodeHost();
        gatewayProcess = null;
        gatewaySpawnedByUs = false;
      }
    });

    // Log ALL IPC messages from gateway for debugging remote permission routing
    child.on("message", (msg: any) => {
      if (msg?.type) {
        console.log(`[gateway-ipc] type=${msg.type} keys=${Object.keys(msg).join(",")}`);
      }
    });

    // Wait for gateway to become ready
    setGatewayStatus("starting");

    const ready = await waitForGatewayReady(
      configuredPort,
      GATEWAY_READY_TIMEOUT_MS,
      () => !explicitQuitRequested && gatewayProcess === child && !child.killed,
    );
    if (explicitQuitRequested) {
      rollbackStartupAgentSkills();
      return;
    }
    if (ready) {
      try {
        startupTiming.httpReady();
        logStartupTiming("gateway-ready", "openclaw");
        electronLifecycleDiagnostics.log("gateway-http-ready", {
          gatewayPid: child.pid ?? null,
          gatewayGeneration: nextGatewayGenerationId,
          elapsedMs: Date.now() - spawnStartedAt,
        });
        gatewayHttpReadyGeneration = nextGatewayGenerationId;
        if (windowsNodeMxcActivationInProgress) {
          markWindowsNodeMxcStartupTiming("http-ready");
        }
        commitStartupAgentSkills();
        setGatewayStatus("running");
      } catch (error) {
        stopGatewayProcess("Gateway startup commit failed");
        rollbackStartupAgentSkills();
        setGatewayStatus("failed");
        throw error;
      }
    } else {
      const retryConvergence = shouldRetryGatewayStartup(
        child.exitCode,
        startupStderr,
        startupRetriesRemaining,
      );
      if (retryConvergence) {
        stopGatewayProcess("Gateway requested plugin migration convergence retry");
        rollbackStartupAgentSkills();
        console.log("[gateway] Retrying once after plugin migration convergence requested restart");
        return startGatewayInner(startupRetriesRemaining - 1);
      }
      mainWindow?.webContents.send(
        "gateway:log",
        `[warn] Gateway health check timed out on port ${configuredPort}`,
      );
      mainWindow?.webContents.send(
        "gateway:log",
        `[info] node=${nodePath} entry=${entryPath} stateDir=${stateDir}`,
      );
      stopGatewayProcess("Gateway startup health check timed out");
      rollbackStartupAgentSkills();
      setGatewayStatus("timeout");
      signalPostInstallFailure(
        new Error(
          child.exitCode !== null
            ? `Gateway exited during startup (code ${child.exitCode}); see the desktop handoff log`
            : "Gateway health check timed out",
        ),
      );
    }
    // Always connect WS — even on timeout the gateway may start shortly after,
    // and GatewayClient has built-in reconnect with exponential backoff.
    connectGatewayWs();

    // Start health monitoring to auto-restart if the gateway goes down
    startHealthMonitor();
  } catch (error) {
    if (agentSkillTransactionPending) {
      if (!explicitQuitRequested) stopGatewayProcess("Rolling back failed Gateway startup");
      rollbackStartupAgentSkills();
    }
    throw error;
  }
}

// (end of startGatewayInner)

// ---------------------------------------------------------------------------
// WebSocket gateway client — mirrors the webchat protocol
// ---------------------------------------------------------------------------

function _extractText(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  if (typeof m.content === "string") return m.content;
  if (typeof m.text === "string") return m.text;
  if (Array.isArray(m.content)) {
    return (m.content as Array<Record<string, unknown>>)
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
  }
  return null;
}

let wsAuthRestartInProgress = false;

async function completePostSpawnChannelStartup(
  client: GatewayClient,
  child: ChildProcess,
): Promise<void> {
  const check = Symbol("post-spawn-channel-check");
  const generation = gatewayGenerationId;
  const startedAt = Date.now();
  postSpawnChannelCheck = check;
  const isCurrent = () =>
    postSpawnChannelCheck === check &&
    gwClient === client &&
    gatewayProcess === child &&
    !explicitQuitRequested &&
    gatewayStopPromise === null &&
    !isWindowsNodeMxcDesired() &&
    client.connected;
  try {
    const result = await waitForPostSpawnChannels({
      readStatus: (timeoutMs) => client.getChannelsStatus(timeoutMs),
      isCurrent,
      onError: (error) => console.warn("[gateway-ws] startup channel status unavailable:", error),
    });
    if (result === "cancelled" || !isCurrent()) return;
    postSpawnChannelCheckCompletedFor = child;
    electronLifecycleDiagnostics.log("gateway-channel-check-complete", {
      channel: "openclaw-weixin",
      result,
      gatewayGeneration: generation,
      elapsedMs: Date.now() - startedAt,
    });
    if (result === "ready") {
      logStartupTiming("channels-ready-without-restart", "integration");
      return;
    }
    console.warn(
      `[gateway-ws] Weixin startup is still pending; keeping Gateway running (generation=${generation})`,
    );
  } finally {
    if (postSpawnChannelCheck === check) {
      postSpawnChannelCheck = null;
    }
  }
}

function connectGatewayWs(): void {
  if (explicitQuitRequested || gatewayStopPromise) return;
  stopBundledWindowsNodeHost();
  gwClient?.stop();
  postSpawnChannelCheck = null;

  gwClient = new GatewayClient({
    port: gatewayPort,
    token: gatewayToken,
    supportsExecApprovals: isWindowsNodeMxcDesired(),
    beforeChatSend: requireEffectiveWindowsNodeMxc,
    onConnected: () => {
      if (explicitQuitRequested || gatewayStopPromise) return;
      console.log("[gateway-ws] connected");
      currentGatewayStartupTiming?.connected(gatewayGenerationId);
      wsAuthRestartInProgress = false;
      if (!isWindowsNodeMxcDesired()) {
        void waitForWindowsNodeMxcCronResumeAcknowledgement().catch((error) => {
          console.error("[cron] MXC resume acknowledgement failed:", error);
        });
      }
      if (isWindowsNodeMxcDesired()) {
        const gateway = gwClient;
        if (gateway && !bundledWindowsNodeStartup) {
          const gatewayGeneration = gatewayProcess;
          if (!gatewayGeneration?.pid) {
            console.error("[bundled-windows-node] managed Gateway process identity is unavailable");
            return;
          }
          const approvalProof = windowsNodeMxcApprovalProofContext;
          if (
            !approvalProof ||
            approvalProof.gatewayGeneration !== gatewayGenerationId ||
            approvalProof.nodeId !== settingsStore.get("windowsNodeMxcNodeId").toLowerCase()
          ) {
            console.error(
              "[bundled-windows-node] approval proof context is unavailable for this Gateway generation",
            );
            void failClosedWindowsNodeMxc(
              "Bundled node approval proof context did not match the managed Gateway generation",
            );
            return;
          }
          const hostGeneration = ++bundledWindowsNodeGeneration;
          const expectedGatewayPolicy = getWindowsNodeMxcGatewayPolicyState(
            readConfig(),
            approvalProof.nodeId,
          );
          if (expectedGatewayPolicy === "drift") {
            void failClosedWindowsNodeMxc(
              "Gateway policy drifted before authenticated RPC readiness",
            );
            return;
          }
          const startOptions = {
            gatewayUrl: `ws://127.0.0.1:${gatewayPort}`,
            gatewayToken,
            gatewayProcessId: gatewayGeneration.pid,
            gatewayGeneration: gatewayGenerationId,
            uiLocale: resolveSupportedLocale(settingsStore.get("language") ?? "en-US"),
            openClawStateRoot: getOpenClawStateDir(),
            folders: getBundledWindowsNodeFolders(),
            requestedStrength:
              getWindowsNodeMxcRequestedMode() === "limited-dacl"
                ? ("limited-dacl" as const)
                : ("full" as const),
            effectiveTier: windowsNodeMxcCurrentEffectiveTier ?? "",
            ambientAccess: windowsNodeMxcCurrentAmbientAccess,
            approvalProof,
            onDiagnostic: (
              event: string,
              details: Record<string, string | number | boolean | null>,
            ) => {
              electronLifecycleDiagnostics.log(`bundled-node-${event}`, details);
            },
            onApproval: (approval: BundledApprovalRequest | null) => {
              if (
                !isCurrentBundledWindowsNodeApprovalCallback({
                  expectedHostGeneration: hostGeneration,
                  currentHostGeneration: bundledWindowsNodeGeneration,
                  gatewayConnected: gateway.connected,
                  gatewayMatches: gwClient === gateway,
                  gatewayProcessMatches: gatewayProcess === gatewayGeneration,
                  expectedGatewayGeneration: approvalProof.gatewayGeneration,
                  currentGatewayGeneration: gatewayGenerationId,
                })
              ) {
                return;
              }
              if (approval) {
                console.info(
                  `[windows-node-mxc-approval-timing] stage=prompt-received layer=node unixMs=${Date.now()} allowedDecisions=deny,allow-once`,
                );
              }
              sendToWindow(
                mainWindow,
                "windows-node-mxc:approval-request",
                approval
                  ? {
                      ...approval,
                      approvalLayer: "node",
                      allowedDecisions: ["deny", "allow-once"],
                    }
                  : null,
              );
            },
          };
          bundledWindowsNodeHost.stop();
          const assertCurrentGatewayGeneration = () => {
            if (
              bundledWindowsNodeGeneration !== hostGeneration ||
              gwClient !== gateway ||
              !gateway.connected ||
              gatewayHttpReadyGeneration !== approvalProof.gatewayGeneration ||
              !gatewayGeneration ||
              gatewayProcess !== gatewayGeneration ||
              gatewayGeneration.exitCode !== null ||
              gatewayGeneration.killed
            ) {
              throw new Error("Managed Gateway generation changed before Windows node startup");
            }
          };
          const startup = startAfterGatewayRpcReady({
            probe: async (timeoutMs) => {
              assertCurrentGatewayGeneration();
              const snapshot = await gateway.request<GatewayConfigSnapshot>(
                "config.get",
                {},
                timeoutMs,
              );
              assertCurrentGatewayGeneration();
              attestWindowsNodeMxcGatewaySnapshot(
                snapshot,
                approvalProof.nodeId,
                expectedGatewayPolicy,
              );
            },
            isCurrent: () => {
              try {
                assertCurrentGatewayGeneration();
                return true;
              } catch {
                return false;
              }
            },
            timeoutMs: MXC_GATEWAY_RPC_READY_TIMEOUT_MS,
            attemptTimeoutMs: MXC_GATEWAY_RPC_PROBE_TIMEOUT_MS,
            initialBackoffMs: MXC_GATEWAY_RPC_PROBE_INITIAL_BACKOFF_MS,
            maxBackoffMs: MXC_GATEWAY_RPC_PROBE_MAX_BACKOFF_MS,
            onAttemptFailure: (error, attempt) => {
              console.warn(
                `[bundled-windows-node] authenticated RPC readiness attempt ${attempt} failed:`,
                error,
              );
            },
            onReady: (result) => {
              markWindowsNodeMxcStartupTiming(
                "rpc-ready",
                `attempts=${result.attempts} probeElapsedMs=${result.elapsedMs}`,
              );
            },
            start: async () => {
              assertCurrentGatewayGeneration();
              await bundledWindowsNodeHost.start(startOptions);
              assertCurrentGatewayGeneration();
              await bundledWindowsNodeHost.ensurePaired(gateway);
              assertCurrentGatewayGeneration();
              markWindowsNodeMxcStartupTiming("node-connected");
            },
          })
            .then(() => undefined)
            .catch((error) => {
              if (bundledWindowsNodeGeneration === hostGeneration) {
                bundledWindowsNodeHost.stop();
              }
              throw error;
            })
            .finally(() => {
              if (bundledWindowsNodeStartup === startup) bundledWindowsNodeStartup = null;
            });
          bundledWindowsNodeStartup = startup;
          void startup.catch((error) => {
            console.error("[bundled-windows-node] start failed:", error);
            if (!windowsNodeMxcSecurityTransitionInProgress) {
              void failClosedWindowsNodeMxc(
                `Bundled node startup failed during authenticated RPC readiness: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          });
        }
      }
      // Sync the status indicator — fixes "timeout" showing while WS is actually connected
      if (gatewayStatus !== "running") {
        setGatewayStatus("running");
      }
      notifyRendererApplicationReady();
      if (
        gatewaySpawnedByUs &&
        postSpawnChannelCheckRequired &&
        gatewayProcess &&
        postSpawnChannelCheckCompletedFor !== gatewayProcess &&
        !postSpawnChannelCheck &&
        gwClient
      ) {
        void completePostSpawnChannelStartup(gwClient, gatewayProcess).catch((error) => {
          console.warn("[gateway-ws] background channel check failed:", error);
        });
      }
    },
    onDisconnected: (reason) => {
      activeModelSessions.clear();
      console.log(`[gateway-ws] disconnected: ${reason}`);
      const activeGeneration =
        isWindowsNodeMxcDesired() &&
        windowsNodeMxcIngressGeneration !== null &&
        windowsNodeMxcIngressGeneration === gatewayGenerationId;
      closeWindowsNodeMxcIngress();
      stopBundledWindowsNodeHost();
      sendToWindow(mainWindow, "gateway:ws-disconnected", reason);
      if (
        activeGeneration &&
        !windowsNodeMxcActivationInProgress &&
        !gatewayRestarting &&
        !gatewayStopPromise &&
        !explicitQuitRequested
      ) {
        void failClosedWindowsNodeMxc(
          `Managed Gateway disconnected: ${reason || "unknown reason"}`,
        );
      }
    },
    onAuthError: (message) => {
      if (explicitQuitRequested || gatewayStopPromise) return;
      // A stale gateway (from a previous install / scheduled task) is running
      // with a different token. Kill it and restart with our token.
      console.log(`[gateway-ws] auth error: ${message} — killing stale gateway`);
      mainWindow?.webContents.send("gateway:log", `[warn] 网关认证失败 (token 不匹配)，正在重启…`);
      if (!wsAuthRestartInProgress) {
        wsAuthRestartInProgress = true;
        setTimeout(async () => {
          try {
            await restartManagedGateway("Replacing Gateway after authentication failure");
          } catch (err: any) {
            console.error("[gateway-ws] restart after auth error failed:", err);
            mainWindow?.webContents.send(
              "gateway:log",
              `[error] 网关重启失败: ${err?.message || err}`,
            );
          } finally {
            wsAuthRestartInProgress = false;
          }
        }, 1500);
      }
    },
    onEvent: (evt) => {
      if (
        forwardGatewaySessionUpdate(evt, (channel, payload) =>
          mainWindow?.webContents.send(channel, payload),
        )
      )
        return;
      if (evt.event === "exec.approval.requested" && isWindowsNodeMxcDesired()) {
        console.info(
          "[weixin-remote-approval-context]",
          describeGatewayApprovalContext(evt.payload),
        );
        const approval = normalizeWindowsNodeMxcGatewayApproval(
          evt.payload,
          settingsStore.get("windowsNodeMxcNodeId"),
          gatewayGenerationId,
          getWindowsNodeMxcRequestedMode(),
        );
        if (!approval) {
          const id =
            evt.payload && typeof evt.payload === "object" && !Array.isArray(evt.payload)
              ? (evt.payload as Record<string, unknown>).id
              : null;
          if (typeof id === "string" && id) {
            void gwClient?.request("exec.approval.resolve", { id, decision: "deny" });
          }
          return;
        }
        const approvalGeneration = gatewayGenerationId;
        void handleWindowsNodeMxcGatewayApproval(approval, approvalGeneration).catch((error) => {
          console.error("[windows-node-mxc] Gateway approval handling failed:", error);
          if (gwClient?.connected && approvalGeneration === gatewayGenerationId) {
            void gwClient
              .request("exec.approval.resolve", { id: approval.id, decision: "deny" })
              .catch((denyError) =>
                console.error("[windows-node-mxc] Gateway approval denial failed:", denyError),
              );
          }
        });
        return;
      }
      if (evt.event === "exec.approval.resolved") {
        const payload =
          evt.payload && typeof evt.payload === "object" && !Array.isArray(evt.payload)
            ? (evt.payload as Record<string, unknown>)
            : null;
        const id = payload?.id;
        const decision =
          payload?.decision === "allow-once" || payload?.decision === "deny"
            ? payload.decision
            : null;
        const pending =
          typeof id === "string" ? findPendingWindowsNodeMxcGatewayApproval(id) : undefined;
        if (pending) {
          const resolutionTarget = windowsNodeMxcGatewayApprovalResolutionTarget;
          if (resolutionTarget && resolutionTarget.id === id) {
            if (decision) resolutionTarget.observedDecision = decision;
            return;
          }
          void pending.lifecycle.observe(decision);
        }
        return;
      }
      if (evt.event === "agent") {
        const lifecycle = agentRunLifecycleEvent(evt.payload);
        if (lifecycle) mainWindow?.webContents.send("chat:event", lifecycle);
        const p = evt.payload as Record<string, unknown> | undefined;
        if (p && p.stream === "tool") {
          const d = p.data as Record<string, unknown> | undefined;
          console.log(`[agent:tool] phase=${d?.phase} name=${d?.name} id=${d?.toolCallId}`);
          mainWindow?.webContents.send("agent:tool-event", p);
        }
      }
      if (evt.event === "chat") {
        const payload = evt.payload as ChatEventPayload | undefined;
        if (!payload) return;
        if (payload.state === "delta" || payload.state === "status")
          activeModelSessions.add(modelChatKey(payload.sessionKey));
        else if (
          payload.state === "final" ||
          payload.state === "error" ||
          payload.state === "aborted"
        ) {
          activeModelSessions.delete(modelChatKey(payload.sessionKey));
        }
        console.log(`[chat:event] state=${payload.state} sessionKey=${payload.sessionKey}`);

        mainWindow?.webContents.send("chat:event", payload);
      }
    },
  });
  gwClient.start();
}

async function refreshGatewayGitHubCopilotAuthStatus(): Promise<void> {
  const client = gwClient;
  if (!client?.connected) return;
  try {
    await client.request("models.authStatus", { refresh: true });
  } catch (error) {
    console.warn("[github-copilot-auth] Gateway auth refresh unavailable:", error);
  }
}

// --- Skill dependency (PATH) indexing ---
// Skills declare required CLIs in their SKILL.md metadata (requires.bins). To tell
// whether a skill is actually usable we must check if those binaries are on PATH.
// Doing a per-binary lookup (or spawning `where`/`which`) is extremely slow (~11s for
// ~40 bins). Instead we list each PATH directory ONCE and build an in-memory Set of
// executable basenames; membership checks are then O(1). The index is cached for the
// session and only rebuilt on an explicit refresh (e.g. after the user installs a CLI).
let pathExecutableIndexCache: Set<string> | null = null;

function buildPathExecutableIndex(): Set<string> {
  const exts = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((e) => e.toLowerCase())
    .filter(Boolean);
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const index = new Set<string>();
  for (const dir of dirs) {
    let items: string[];
    try {
      items = fs.readdirSync(dir);
    } catch {
      continue; // missing/inaccessible PATH entry — skip
    }
    for (const item of items) {
      const lower = item.toLowerCase();
      index.add(lower); // bare name (covers scripts without an extension)
      const ext = path.extname(lower);
      if (ext && exts.includes(ext)) {
        index.add(lower.slice(0, lower.length - ext.length));
      }
    }
  }
  return index;
}

function getPathExecutableIndex(forceRebuild = false): Set<string> {
  if (forceRebuild || !pathExecutableIndexCache) {
    pathExecutableIndexCache = buildPathExecutableIndex();
  }
  return pathExecutableIndexCache;
}

// A skill's usability requirements, mirroring openclaw's `metadata.openclaw.requires`
// plus the top-level `os` gate. The runtime (`evaluateRuntimeRequires`) rejects a skill
// unless ALL of these are satisfied, so the UI must evaluate every field — not just
// `bins` — or it will show skills as available that the gateway silently drops.
interface SkillRequirements {
  bins: string[]; // every one of these CLIs must be on PATH
  anyBins: string[]; // at least ONE of these CLIs must be on PATH
  env: string[]; // every one of these env vars must be set
  config: string[]; // every one of these dotted config paths must be truthy
  os: string[]; // if non-empty, current platform must be included
  primaryEnv?: string; // env var that a skill's `apiKey` config satisfies
}

// Extract the balanced `{ ... }` object following `metadata:` in a SKILL.md frontmatter.
// The block is multi-line and, importantly, uses RELAXED JSON with trailing commas,
// which `JSON.parse` rejects — callers must tolerate that (see parseSkillRequirements).
function extractMetadataBlock(frontmatter: string): string | null {
  const key = frontmatter.indexOf("metadata:");
  if (key < 0) return null;
  const start = frontmatter.indexOf("{", key);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < frontmatter.length; i++) {
    const c = frontmatter[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return frontmatter.slice(start, i + 1);
    }
  }
  return null;
}

// Parse a skill's requirements out of its SKILL.md frontmatter. Handles the multi-line,
// trailing-comma "relaxed JSON" that openclaw skills ship with. Falls back to a
// bins-only regex if the block can't be parsed, so we never regress the old behavior.
function parseSkillRequirements(frontmatter: string): SkillRequirements {
  const empty: SkillRequirements = { bins: [], anyBins: [], env: [], config: [], os: [] };
  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const block = extractMetadataBlock(frontmatter);
  if (block) {
    // Strip trailing commas (`,` before `}` or `]`) so JSON.parse accepts the block.
    const relaxed = block.replace(/,(\s*[}\]])/g, "$1");
    try {
      const meta = JSON.parse(relaxed);
      const oc = meta?.openclaw ?? meta?.clawdbot ?? {};
      const req = oc?.requires ?? {};
      return {
        bins: asStringArray(req.bins),
        anyBins: asStringArray(req.anyBins),
        env: asStringArray(req.env),
        config: asStringArray(req.config),
        os: asStringArray(oc.os),
        primaryEnv: typeof oc.primaryEnv === "string" ? oc.primaryEnv : undefined,
      };
    } catch {
      // fall through to regex fallback
    }
  }

  // Fallback: pull just the `bins` array (legacy behavior) when the block is missing
  // or unparseable.
  const match = frontmatter.match(/"requires"\s*:\s*\{[^}]*?"bins"\s*:\s*\[([^\]]*)\]/);
  if (!match) return empty;
  return {
    ...empty,
    bins: match[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean),
  };
}

// Resolve a dotted config path (e.g. "channels.discord.token") to its value, mirroring
// openclaw's `resolveConfigPath`.
function resolveConfigPath(config: any, dotted: string): unknown {
  const parts = dotted.split(".").filter(Boolean);
  let current: any = config;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = current[part];
  }
  return current;
}

// Truthiness check matching openclaw's `isTruthy`: empty/whitespace strings and 0 are
// falsy; any non-empty object/array is truthy.
function isConfigValueTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

// Skills that ship in the OpenClaw package but are intentionally not surfaced in
// MicroClaw because they cannot work on Windows (macOS-only tooling) or are otherwise
// unusable here. These directories may still exist on disk, so we filter them out of
// the Skills list by name. Keep in sync with deployer/skill_catalog.py removals.
const EXCLUDED_SKILL_IDS = new Set<string>([
  "apple-notes", // macOS Apple Notes
  "apple-reminders", // macOS Apple Reminders
  "imsg", // macOS Messages / iMessage
  "peekaboo", // macOS-only UI automation
  "model-usage", // restricted upstream to macOS / CodexBar
  "tmux", // upstream supports macOS and Linux only
  "desktop-beautify", // catalog-only, no skill dir; requires Notezilla
]);

function registerIpcHandlers(): void {
  // --- Gateway ---
  ipcMain.handle("gateway:get-port", () => gatewayPort);
  // gateway:get-token intentionally removed — the renderer does not need
  // direct access to the gateway auth token.  All gateway communication
  // flows through main-process IPC handlers (chat:send-message, etc.).
  ipcMain.handle("gateway:get-status", () => gatewayStatus);
  ipcMain.handle("gateway:is-service-ready", () => isApplicationServiceReady());
  ipcMain.handle("gateway:restart", async (_event, options?: unknown) => {
    assertWindowsNodeMxcConfigurationMutable();
    const reason = resolveGatewayRestartReason(options);
    try {
      await restartManagedGateway(reason);
      mainWindow?.webContents.send("gateway:log", "[restart] 网关重启完成");
    } catch (err: any) {
      const msg = `[error] Gateway restart failed: ${err?.message || err}`;
      console.error(msg);
      mainWindow?.webContents.send("gateway:log", msg);
      throw err;
    }
  });

  // --- Config ---
  ipcMain.handle("config:get-state-dir", () => getOpenClawStateDir());
  ipcMain.handle("config:is-configured", () => isConfigured());
  ipcMain.handle("config:needs-setup", () => needsSetup());
  ipcMain.handle("config:read", () => readConfig());
  ipcMain.handle("config:read-env", () => loadStateDirEnv());
  ipcMain.handle("model:apply-config", (event, input: unknown) => {
    assertTrustedRendererIpc(event);
    return withModelConfigurationMutation(() => applyModelConfiguration(input));
  });
  ipcMain.handle("config:write", async (_event, config: any, expectedConfig?: unknown) => {
    return withModelConfigurationMutation(async () => {
      const stateDir = getOpenClawStateDir();
      await fs.promises.mkdir(stateDir, { recursive: true });
      assertConfigWriteAllowed(config, readConfig());
      if (isWindowsNodeMxcDesired()) {
        throw new Error("config:write is blocked while Windows Node + MXC mode is enabled");
      }
      if (expectedConfig !== undefined) assertModelConfigUnchanged(expectedConfig, readConfig());
      fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
    });
  });

  // --- Skills ---
  const buildSkillsPayload = (forceRebuildPathIndex: boolean) => {
    const homeDir = app.getPath("home");
    const builtinDir = resolveBuiltinSkillsDir();
    const customDir = path.join(homeDir, ".agents", "skills");
    const managedDir = path.join(homeDir, ".openclaw", "skills");

    // Build (or reuse) the PATH executable index used to resolve skill dependencies.
    const pathIndex = getPathExecutableIndex(forceRebuildPathIndex);

    // Load certification catalog (builtin)
    let catalog: Record<string, { description: string; platform: string[] }> = {};
    try {
      const catalogPath = path.join(getOpenClawStateDir(), "skill_catalog.json");
      if (fs.existsSync(catalogPath)) {
        catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
      }
    } catch {
      /* catalog unavailable — all skills show as non-windows */
    }

    // Load managed skill catalog
    let managedCatalog: Record<string, { description: string; platform: string[] }> = {};
    try {
      const managedCatalogPath = path.join(getOpenClawStateDir(), "managed_skill_catalog.json");
      if (fs.existsSync(managedCatalogPath)) {
        managedCatalog = JSON.parse(fs.readFileSync(managedCatalogPath, "utf-8"));
      }
    } catch {}

    // Load allowBundled and entries from config
    const config = readConfig();
    const allowBundled: string[] | undefined = config?.skills?.allowBundled;
    const entries: Record<string, { enabled: boolean }> = config?.skills?.entries ?? {};

    function scanSkills(dir: string, source: "builtin" | "custom" | "managed"): any[] {
      const results: any[] = [];
      if (!fs.existsSync(dir)) return results;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (EXCLUDED_SKILL_IDS.has(entry.name)) continue;
        const skillMd = path.join(dir, entry.name, "SKILL.md");
        let name = entry.name;
        let description = "";
        let requirements: SkillRequirements = {
          bins: [],
          anyBins: [],
          env: [],
          config: [],
          os: [],
        };
        if (fs.existsSync(skillMd)) {
          const content = fs.readFileSync(skillMd, "utf-8");
          // Extract the YAML frontmatter block (between the first two `---` fences) so
          // the full multi-line `metadata` object is available to the parser. Fall back
          // to the whole file if the closing fence isn't found.
          let frontmatter = content;
          const fenceStart = content.indexOf("---");
          if (fenceStart >= 0) {
            const fenceEnd = content.indexOf("\n---", fenceStart + 3);
            if (fenceEnd >= 0) frontmatter = content.slice(fenceStart, fenceEnd);
          }
          const nameMatch = frontmatter.match(/^name:\s*(.+)/m);
          const descMatch = frontmatter.match(/^description:\s*(.+)/m);
          if (nameMatch) name = nameMatch[1].trim();
          if (descMatch) description = descMatch[1].replace(/^["']|["']$/g, "").trim();
          requirements = parseSkillRequirements(frontmatter);
        }

        // Evaluate every requirement type the runtime checks (see openclaw's
        // `evaluateRuntimeRequires`). A skill is only usable when ALL are satisfied;
        // checking `bins` alone (the old behavior) marked skills gated by env vars,
        // channel config, or alternative CLIs as available even though the gateway
        // silently drops them. See #83.
        const skillCfg: any = (entries as Record<string, any>)[entry.name] ?? {};
        const hasBin = (b: string): boolean => pathIndex.has(b.toLowerCase());
        const hasEnv = (envName: string): boolean =>
          Boolean(
            process.env[envName] ||
            skillCfg?.env?.[envName] ||
            (skillCfg?.apiKey && requirements.primaryEnv === envName),
          );

        const missingBins = requirements.bins.filter((b) => !hasBin(b));
        // `anyBins` is unmet only when NONE of the alternatives are present.
        const missingAnyBins =
          requirements.anyBins.length > 0 && !requirements.anyBins.some((b) => hasBin(b))
            ? requirements.anyBins
            : [];
        const missingEnv = requirements.env.filter((e) => !hasEnv(e));
        const missingConfig = requirements.config.filter(
          (c) => !isConfigValueTruthy(resolveConfigPath(config, c)),
        );
        const osMismatch =
          requirements.os.length > 0 && !requirements.os.includes(process.platform);

        const eligible =
          missingBins.length === 0 &&
          missingAnyBins.length === 0 &&
          missingEnv.length === 0 &&
          missingConfig.length === 0 &&
          !osMismatch;

        let enabled = true;

        if (source === "managed") {
          const windowsAdapted = managedCatalog[entry.name]?.platform?.includes("windows") ?? false;
          enabled = entries[entry.name]?.enabled ?? windowsAdapted;
          if (!description && managedCatalog[entry.name]?.description) {
            description = managedCatalog[entry.name].description;
          }
        } else if (source === "custom") {
          // Custom (user-authored) skills default to enabled; persisted per-skill via
          // skills.entries so the user can toggle them on/off from the UI.
          enabled = entries[entry.name]?.enabled ?? true;
        } else {
          if (source === "builtin" && allowBundled && allowBundled.length > 0) {
            enabled = allowBundled.includes(entry.name);
          }
        }

        results.push({
          id: entry.name,
          name,
          description,
          source,
          platform: catalog[entry.name]?.platform ?? managedCatalog[entry.name]?.platform ?? [],
          enabled,
          installed: true,
          requiredBins: requirements.bins,
          missingBins,
          missingAnyBins,
          missingEnv,
          missingConfig,
          osRequired: requirements.os,
          osMismatch,
          eligible,
        });
      }
      return results;
    }

    const builtin = scanSkills(builtinDir, "builtin");
    const custom = scanSkills(customDir, "custom");
    const managedOnDisk = scanSkills(managedDir, "managed");

    // Only expose managed skills that are actually installed on disk. Catalog-only
    // entries (defined in managed_skill_catalog.json but not present on disk) are
    // intentionally omitted because there is no in-app install action for them. See #58.

    // Skills the user authors (e.g. via skill-creator) land in the managed skills
    // directory but are NOT part of the shipped managed catalog. Reclassify those as
    // custom so they appear under "Custom Skills" instead of the built-in workspace
    // skills. Catalog workspace skills (officecli, excel-xlsx, …) stay managed.
    const managedWorkspace = managedOnDisk.filter(
      (s) => managedCatalog[s.id] !== undefined || isAgentOwnedSkillId(s.id),
    );
    const userAuthored = managedOnDisk
      .filter((s) => managedCatalog[s.id] === undefined && !isAgentOwnedSkillId(s.id))
      // Reclassified from managed → custom: recompute `enabled` with custom
      // semantics (default on) rather than the managed default (off when not
      // windows-adapted in the catalog).
      .map((s) => ({ ...s, source: "custom" as const, enabled: entries[s.id]?.enabled ?? true }));

    return { builtin, custom: [...custom, ...userAuthored], managed: managedWorkspace };
  };

  ipcMain.handle("skills:list", () => buildSkillsPayload(false));

  // Rebuild the PATH executable index (picks up CLIs the user installed/removed while
  // the app was running) and recompute skill eligibility. Cheap — only re-indexes PATH.
  ipcMain.handle("skills:refresh", () => buildSkillsPayload(true));

  ipcMain.handle("skills:update-allowlist", (_event, allowBundled: string[]) => {
    const config = readConfig() || {};
    if (!config.skills) config.skills = {};
    config.skills.allowBundled = allowBundled;
    const stateDir = getOpenClawStateDir();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
  });

  ipcMain.handle(
    "skills:update-managed-entries",
    (_event, updatedEntries: Record<string, { enabled: boolean }>) => {
      const config = readConfig() || {};
      if (!config.skills) config.skills = {};
      if (!config.skills.entries) config.skills.entries = {};
      Object.assign(config.skills.entries, updatedEntries);
      const stateDir = getOpenClawStateDir();
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
    },
  );

  ipcMain.handle("skills:integrity-check", (): IntegrityResult => {
    return verifySkillIntegrity();
  });

  ipcMain.handle("skills:generate-snapshot", () => {
    generateAndSignSnapshot();
  });

  ipcMain.handle("skills:pending-integrity-result", (): IntegrityResult | null => {
    return pendingIntegrityResult;
  });

  ipcMain.handle("skills:accept-integrity-changes", () => {
    generateAndSignSnapshot();
    pendingIntegrityResult = null;
  });

  ipcMain.handle(
    "skills:set-agent-skills",
    async (
      _event,
      agentId: string,
      skillIds: string[],
    ): Promise<{ agentId: string; skills: string[] }> => {
      assertWindowsNodeMxcConfigurationMutable();
      if (typeof agentId !== "string" || agentId.length === 0) {
        throw new Error("A non-empty agentId is required");
      }
      const skills = sanitizeAgentSkillIds(skillIds ?? []);

      const configPath = getConfigPath();
      const originalConfigText = fs.readFileSync(configPath, "utf-8");
      const config = readConfig();
      if (!config) throw new Error("OpenClaw configuration is unavailable");

      // Persist match-names (not raw slugs) so OpenClaw's frontmatter-name based
      // allowlist filter binds every eligible skill. The IPC input and return value
      // stay slug-based; resolution happens only at the openclaw.json write.
      applyAgentSkillsToConfig(config, agentId, skills);

      const alreadyRunning = await checkExistingGateway(gatewayPort);
      const managedGateway = gatewaySpawnedByUs && gatewayProcess !== null;
      if (
        requiresExternalGatewayStop(
          alreadyRunning,
          true,
          gatewaySpawnedByUs,
          gatewayProcess !== null,
        )
      ) {
        throw new Error(
          "Cannot update agent skills while MicroClaw is connected to an externally managed Gateway",
        );
      }

      let restartAttempted = false;
      try {
        writeConfigTextAtomically(JSON.stringify(config, null, 2));
        restartAttempted = true;
        await restartManagedGateway(`Updating skills for agent ${agentId}`);
        return { agentId, skills };
      } catch (error) {
        try {
          writeConfigTextAtomically(originalConfigText);
          if (restartAttempted && managedGateway) {
            await restartManagedGateway(`Rolling back failed skills update for ${agentId}`);
          }
        } catch {
          // Preserve the original failure; rollback is best-effort.
        }
        throw error;
      }
    },
  );

  // Dev-only diagnostics: run the OpenClaw CLI directly (reads config from disk;
  // does NOT require the gateway to be up) to surface each skill's gating status
  // for the given agent. Merges `skills list` (per-skill booleans + missing) with
  // `skills check` (aggregate buckets + detailed missingRequirements).
  ipcMain.handle(
    "skills:get-status",
    async (_event, agentId: string): Promise<SkillsStatusResult> => {
      const emptySummary = { total: 0, modelVisible: 0 };
      if (typeof agentId !== "string" || agentId.length === 0) {
        return {
          ok: false,
          error: "A non-empty agentId is required",
          summary: emptySummary,
          skills: [],
        };
      }

      const nodePath = resolveNodePath();
      const entryPath = resolveOpenClawEntry();
      if (!fs.existsSync(nodePath) || !fs.existsSync(entryPath)) {
        return { ok: false, error: "OpenClaw CLI not found", summary: emptySummary, skills: [] };
      }

      const stateDir = getOpenClawStateDir();
      const compileCacheDir = path.join(stateDir, COMPILE_CACHE_SUBDIR);

      const runCli = (subArgs: string[]): Promise<Record<string, unknown> | null> =>
        new Promise((resolve) => {
          const spawnOpts: Record<string, unknown> = {
            cwd: path.dirname(entryPath),
            env: {
              ...process.env,
              OPENCLAW_STATE_DIR: stateDir,
              NODE_COMPILE_CACHE: compileCacheDir,
            },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          };
          if (process.platform === "win32") {
            spawnOpts.creationFlags = CREATE_NO_WINDOW;
          }
          let stdout = "";
          let stderr = "";
          let settled = false;
          const child = spawn(nodePath, [entryPath, ...subArgs], spawnOpts);
          child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
          child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
          const finish = (value: Record<string, unknown> | null) => {
            if (settled) return;
            settled = true;
            resolve(value);
          };
          child.on("error", () => finish(null));
          child.on("close", () => {
            try {
              const parsed = JSON.parse(stripJsonBanner(stdout));
              finish(typeof parsed === "object" && parsed !== null ? parsed : null);
            } catch {
              if (stderr.trim()) console.error(`[skills:get-status] CLI stderr: ${stderr.trim()}`);
              finish(null);
            }
          });
          setTimeout(() => {
            if (!settled) {
              child.kill();
              finish(null);
            }
          }, SKILLS_STATUS_TIMEOUT_MS);
        });

      try {
        // `skills list --json` already carries every per-skill boolean and the
        // per-skill `missing` requirements the panel renders, so we only spawn one
        // CLI process (the cold CLI can take ~60–90s). normalizeSkillsStatus stays
        // tolerant of a null `check` payload.
        const listJson = await runCli(["skills", "list", "--agent", agentId, "--json"]);
        if (!listJson) {
          return {
            ok: false,
            error: "OpenClaw skills CLI produced no parseable output",
            summary: emptySummary,
            skills: [],
          };
        }
        const skills = normalizeSkillsStatus(listJson, null);
        return {
          ok: true,
          summary: {
            total: skills.length,
            modelVisible: skills.filter((s) => s.modelVisible).length,
          },
          skills,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          summary: emptySummary,
          skills: [],
        };
      }
    },
  );

  // Dev-only: global master toggle for a single skill. Controls OpenClaw's global
  // gating (both layers): the per-skill `skills.entries[key].enabled` flag and, for
  // bundled skills, membership in `skills.allowBundled`. Operates on skillKey (slug).
  ipcMain.handle(
    "skills:set-global-enabled",
    async (
      _event,
      params: { skillKey: string; enabled: boolean },
    ): Promise<{ skillKey: string; enabled: boolean }> => {
      assertWindowsNodeMxcConfigurationMutable();
      const skillKey = params?.skillKey;
      const enabled = params?.enabled;
      if (typeof skillKey !== "string" || skillKey.length === 0) {
        throw new Error("A non-empty skillKey is required");
      }
      if (typeof enabled !== "boolean") {
        throw new Error("enabled must be a boolean");
      }

      // Validate against actually-discovered skills and learn whether it's bundled.
      const payload = buildSkillsPayload(false);
      const discovered = [...payload.builtin, ...payload.custom, ...payload.managed].find(
        (s) => s.id === skillKey,
      );
      if (!discovered) {
        throw new Error(`Unknown skill "${skillKey}"`);
      }
      const isBundled = discovered.source === "builtin";

      const configPath = getConfigPath();
      const originalConfigText = fs.readFileSync(configPath, "utf-8");
      const config = readConfig();
      if (!config) throw new Error("OpenClaw configuration is unavailable");

      applyGlobalSkillChange(config, skillKey, enabled, isBundled);

      const alreadyRunning = await checkExistingGateway(gatewayPort);
      const managedGateway = gatewaySpawnedByUs && gatewayProcess !== null;
      if (
        requiresExternalGatewayStop(
          alreadyRunning,
          true,
          gatewaySpawnedByUs,
          gatewayProcess !== null,
        )
      ) {
        throw new Error(
          "Cannot update skill state while MicroClaw is connected to an externally managed Gateway",
        );
      }

      let restartAttempted = false;
      try {
        writeConfigTextAtomically(JSON.stringify(config, null, 2));
        restartAttempted = true;
        await restartManagedGateway(`Toggling global state for skill ${skillKey}`);
        return { skillKey, enabled };
      } catch (error) {
        try {
          writeConfigTextAtomically(originalConfigText);
          if (restartAttempted && managedGateway) {
            await restartManagedGateway(`Rolling back failed global toggle for ${skillKey}`);
          }
        } catch {
          // Preserve the original failure; rollback is best-effort.
        }
        throw error;
      }
    },
  );

  // Dev-only: batched apply of BOTH the per-agent allowlist and any number of global
  // on/off changes in a SINGLE atomic config write + SINGLE gateway restart. The panel
  // stages per-agent and global toggles locally and flushes them here on "Apply &
  // reload", so the user waits for exactly one restart instead of one per flip. Mirrors
  // the robustness of skills:set-agent-skills + skills:set-global-enabled (validation,
  // atomic write, rollback-on-failure) using the shared skill-config helpers.
  ipcMain.handle(
    "skills:apply-agent-config",
    async (
      _event,
      params: { agentId: string; skillIds: string[]; globalChanges: GlobalSkillChange[] },
    ): Promise<{ agentId: string; skills: string[]; globalChanges: GlobalSkillChange[] }> => {
      assertWindowsNodeMxcConfigurationMutable();
      const agentId = params?.agentId;
      if (typeof agentId !== "string" || agentId.length === 0) {
        throw new Error("A non-empty agentId is required");
      }
      if (!AGENT_CATALOG.some((agent) => agent.id === agentId)) {
        throw new Error(`Unknown agent "${agentId}"`);
      }
      const skills = sanitizeAgentSkillIds(params?.skillIds ?? []);

      // Validate every global change against actually-discovered skills and learn
      // whether each is bundled (only bundled skills are gated by allowBundled).
      const rawGlobalChanges = Array.isArray(params?.globalChanges) ? params.globalChanges : [];
      const payload = buildSkillsPayload(false);
      const discovered = [...payload.builtin, ...payload.custom, ...payload.managed];
      const globalChanges: Array<GlobalSkillChange & { bundled: boolean }> = [];
      for (const change of rawGlobalChanges) {
        const skillKey = change?.skillKey;
        const enabled = change?.enabled;
        if (typeof skillKey !== "string" || skillKey.length === 0) {
          throw new Error("Each global change requires a non-empty skillKey");
        }
        if (typeof enabled !== "boolean") {
          throw new Error("Each global change requires a boolean enabled");
        }
        const match = discovered.find((s) => s.id === skillKey);
        if (!match) {
          throw new Error(`Unknown skill "${skillKey}"`);
        }
        globalChanges.push({ skillKey, enabled, bundled: match.source === "builtin" });
      }

      const configPath = getConfigPath();
      const originalConfigText = fs.readFileSync(configPath, "utf-8");
      const config = readConfig();
      if (!config) throw new Error("OpenClaw configuration is unavailable");

      // Stage every change onto the single config object before writing once.
      applyAgentSkillsToConfig(config, agentId, skills);
      for (const change of globalChanges) {
        applyGlobalSkillChange(config, change.skillKey, change.enabled, change.bundled);
      }

      const alreadyRunning = await checkExistingGateway(gatewayPort);
      const managedGateway = gatewaySpawnedByUs && gatewayProcess !== null;
      if (
        requiresExternalGatewayStop(
          alreadyRunning,
          true,
          gatewaySpawnedByUs,
          gatewayProcess !== null,
        )
      ) {
        throw new Error(
          "Cannot update skill state while MicroClaw is connected to an externally managed Gateway",
        );
      }

      let restartAttempted = false;
      try {
        writeConfigTextAtomically(JSON.stringify(config, null, 2));
        restartAttempted = true;
        await restartManagedGateway(`Applying skill config for agent ${agentId}`);
        return {
          agentId,
          skills,
          globalChanges: globalChanges.map(({ skillKey, enabled }) => ({ skillKey, enabled })),
        };
      } catch (error) {
        try {
          writeConfigTextAtomically(originalConfigText);
          if (restartAttempted && managedGateway) {
            await restartManagedGateway(`Rolling back failed skill config apply for ${agentId}`);
          }
        } catch {
          // Preserve the original failure; rollback is best-effort.
        }
        throw error;
      }
    },
  );

  // --- Chat (WebSocket gateway protocol) ---
  ipcMain.handle("dialog:open-files", async (_event, params?: { currentTotalBytes?: number }) => {
    if (!mainWindow) throw new Error("Main window is not available");
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled) return { attachments: [], rejections: [] };
    const currentTotalBytes =
      typeof params?.currentTotalBytes === "number" && Number.isFinite(params.currentTotalBytes)
        ? Math.max(0, params.currentTotalBytes)
        : 0;
    return prepareChatAttachments(result.filePaths, undefined, undefined, currentTotalBytes);
  });

  ipcMain.handle("logs:export-gateway", async (_event, lines: unknown) => {
    if (!mainWindow) throw new Error("Main window is not available");
    const contents = formatGatewayLogExport(lines);
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath("documents"), createGatewayLogExportFilename()),
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.promises.writeFile(result.filePath, contents, "utf-8");
    return { canceled: false, filePath: result.filePath };
  });

  ipcMain.handle(
    "attachment:import-clipboard-images",
    async (_event, params?: { images?: unknown; currentTotalBytes?: number }) => {
      const currentTotalBytes =
        typeof params?.currentTotalBytes === "number" && Number.isFinite(params.currentTotalBytes)
          ? Math.max(0, params.currentTotalBytes)
          : 0;
      return prepareClipboardImageAttachments(
        params?.images,
        app.getPath("temp"),
        currentTotalBytes,
      );
    },
  );

  ipcMain.handle(
    "chat:send-message",
    async (_event, params: { sessionKey: string; message: string; attachments?: unknown }) => {
      if (!gwClient?.connected) throw new Error("Gateway not connected");
      if (modelConfigurationMutationInProgress)
        throw new Error("A model configuration change is being applied; wait for it to finish");
      localModelService.assertChatAllowed();
      sessionModelService.assertChatAllowed();
      // Mark that the latest input is from the local desktop UI.
      const activeKey = modelChatKey(params.sessionKey);
      activeModelSessions.add(activeKey);
      try {
        await assertChatModelEnabled(params.sessionKey);
        await gwClient.sendChat(
          params.sessionKey,
          params.message,
          validateChatAttachments(params.attachments),
        );
      } catch (error) {
        activeModelSessions.delete(activeKey);
        throw error;
      }
    },
  );

  ipcMain.handle("chat:load-history", async (_event, params: { sessionKey: string }) => {
    if (!gwClient?.connected) throw new Error("Gateway not connected");
    const client = gwClient;
    const timing = currentGatewayStartupTiming;
    const generation = gatewayGenerationId;
    const history = await client.loadHistory(params.sessionKey);
    if (client === gwClient && timing === currentGatewayStartupTiming) {
      timing?.historyReady(generation);
    }
    return history;
  });

  ipcMain.handle("chat:observe-session", async (_event, params: { sessionKey: string | null }) => {
    if (!gwClient) throw new Error("Gateway client unavailable");
    if (params.sessionKey !== null && typeof params.sessionKey !== "string")
      throw new Error("Invalid observed session");
    await gwClient.observeChatSession(params.sessionKey);
  });

  ipcMain.handle("chat:list-session-titles", async (_event, params: { keys: string[] }) => {
    if (!gwClient?.connected) throw new Error("Gateway not connected");
    return await gwClient.listSessionTitles(params.keys);
  });

  ipcMain.handle("chat:generate-session-title", async (_event, params: { sessionKey: string }) => {
    if (!gwClient?.connected) throw new Error("Gateway not connected");
    sessionModelService.assertChatAllowed();
    const client = gwClient;
    return withInternalModelChat(
      () => client.generateSessionTitle(params.sessionKey),
      params.sessionKey,
    );
  });

  ipcMain.handle("chat:abort", async (_event, params: { sessionKey: string }) => {
    if (!gwClient?.connected) throw new Error("Gateway not connected");
    await gwClient.abortChat(params.sessionKey);
  });

  ipcMain.handle("chat:delete-session", async (_event, params: { sessionKey: string }) => {
    if (!gwClient?.connected) throw new Error("Gateway not connected");
    sessionModelService.assertIdle();
    await withWindowsNodeMxcDurableApprovalLock(() =>
      getWindowsNodeMxcDurableApprovalStore().revokeSession(params.sessionKey),
    );
    await gwClient.deleteSession(params.sessionKey);
  });

  ipcMain.handle("chat:clear-history", async () => {
    if (!gwClient?.connected) throw new Error("Gateway not connected");
    sessionModelService.assertIdle();
    await withWindowsNodeMxcDurableApprovalLock(() =>
      getWindowsNodeMxcDurableApprovalStore().revokeAll(),
    );
    return await gwClient.clearAllHistory();
  });

  ipcMain.handle("gateway:warm-up-agent", async () => {
    if (!gwClient?.connected) throw new Error("Gateway not connected");
    if (modelConfigurationMutationInProgress || localModelService.busy || sessionModelService.busy)
      return { outcome: "skipped", transcriptDeleted: true };
    if (
      hasLocalModelPrimary(readConfig()) ||
      (!internalFeatures.githubCopilot &&
        getPrimaryModel(readConfig())?.startsWith("github-copilot/"))
    ) {
      return { outcome: "skipped", transcriptDeleted: true };
    }
    if (
      isWindowsNodeMxcDesired() &&
      !isWindowsNodeMxcIngressReleased(
        true,
        gatewayGenerationId,
        windowsNodeMxcIngressGeneration,
        windowsNodeMxcActivationInProgress,
      )
    ) {
      console.log("[gateway-ws] agent warm-up skipped: Windows Node + MXC ingress is locked");
      return { outcome: "skipped", transcriptDeleted: true };
    }
    if (needsSetup()) {
      console.log("[gateway-ws] agent warm-up skipped: no model is configured");
      return { outcome: "skipped", transcriptDeleted: true };
    }
    const client = gwClient;
    return withInternalModelChat(() => client.warmUpAgent());
  });

  ipcMain.handle("chat:is-connected", () => isApplicationServiceReady());

  // --- Cron / Scheduled Tasks ---
  ipcMain.handle("cron:list", async () => {
    if (!gwClient?.connected) throw new Error("Gateway not connected");
    const result = await gwClient.listCronJobs();
    const requestedMode = getWindowsNodeMxcRequestedMode();
    return requestedMode === "off"
      ? result
      : annotateWindowsNodeMxcPausedCronJobs(result, requestedMode);
  });

  // --- Agents ---
  ipcMain.handle("agents:list", async () => {
    if (!gwClient?.connected) throw new Error("Gateway not connected");
    return await gwClient.listAgents();
  });
  ipcMain.handle("agents:add", async (_event, agentId: string) => {
    if (typeof agentId !== "string" || !agentId.trim()) {
      throw new Error("Agent id is required");
    }
    if (isWindowsNodeMxcDesired()) {
      throw new Error("Agent roster changes are blocked while Windows Node + MXC mode is enabled");
    }
    if (!gwClient?.connected) throw new Error("Gateway not connected");
    if (agentRosterChangeInProgress) {
      throw new Error("Another agent roster change is already in progress");
    }
    agentRosterChangeInProgress = true;
    try {
      return await addCatalogAgent(agentId);
    } finally {
      agentRosterChangeInProgress = false;
    }
  });
  ipcMain.handle("agents:remove", async (_event, agentId: string) => {
    if (typeof agentId !== "string" || !agentId.trim()) {
      throw new Error("Agent id is required");
    }
    if (isWindowsNodeMxcDesired()) {
      throw new Error("Agent roster changes are blocked while Windows Node + MXC mode is enabled");
    }
    if (!gwClient?.connected) throw new Error("Gateway not connected");
    if (agentRosterChangeInProgress) {
      throw new Error("Another agent roster change is already in progress");
    }
    agentRosterChangeInProgress = true;
    try {
      return await removeCatalogAgent(agentId);
    } finally {
      agentRosterChangeInProgress = false;
    }
  });

  // --- Channels ---
  ipcMain.handle("channels:list", async () => {
    if (isWindowsNodeMxcDesired()) return { channels: [] };
    if (!gwClient?.connected) return { channels: [] };
    try {
      return await gwClient.listChannels();
    } catch (err) {
      console.warn("[channels:list] failed:", err);
      return { channels: [] };
    }
  });

  // --- WeChat Plugin ---
  ipcMain.handle("plugin:weixin:get-status", async () => {
    const config = readConfig();
    const requestedEnabled = !!config?.plugins?.entries?.["openclaw-weixin"]?.enabled;
    const pausedByMxc =
      requestedEnabled && isWindowsNodeMxcDesired() && !isApplicationIngressReady();
    const effectiveEnabled = requestedEnabled && !pausedByMxc;
    const installed = !!config?.plugins?.installs?.["openclaw-weixin"];
    const accountStatus = readWeixinAccountStatus(getOpenClawStateDir());
    const runtime = await readWeixinRuntimeStatus();
    const connection =
      runtime && effectiveEnabled
        ? getWeixinRuntimeConnection(runtime, accountStatus.currentAccount?.accountId)
        : { connected: false, connecting: false };
    reconcileWindowsNodeMxcWeixinRemoteApprovalOwner("weixin-account-status-changed");
    return {
      enabled: requestedEnabled,
      requestedEnabled,
      effectiveEnabled,
      pausedByMxc,
      installed,
      ...accountStatus,
      ...connection,
      runtimeKnown: runtime !== null,
      ready: effectiveEnabled && runtime !== null && isWeixinLoginReady(runtime),
      qrSession: weixinQrSession.status,
      loginInProgress:
        !!weixinLoginProcess || ["starting", "waiting"].includes(weixinQrSession.status.state),
      loginRequiresRestart: weixinMutations.loginRequiresRestart,
      mutationLocked: getWeixinMutationLock().locked,
      mutationLockRevision: weixinMutationLockRevision,
    };
  });

  ipcMain.handle("plugin:weixin:set-enabled", async (_event, enabled: boolean) =>
    weixinMutations.run(assertWindowsNodeMxcConfigurationMutable, async () => {
      assertWindowsNodeMxcConfigurationMutable();
      if (typeof enabled !== "boolean") throw new Error("Supply a boolean WeChat plugin state");
      weixinMutations.beginPluginChange(!!weixinLoginProcess);
      try {
        if (!enabled) {
          settingsStore.set("windowsNodeMxcWeixinRemoteApproval", {
            enabled: false,
            owner: null,
          });
          closeWindowsNodeMxcWeixinRemoteApproval("weixin-disabled");
        }
        await setWeixinPluginEnabled(
          { gateway: () => gwClient, assertMutable: assertWindowsNodeMxcConfigurationMutable },
          enabled,
        );
        return { ok: true };
      } catch (error) {
        console.error("[weixin:set-enabled] failed:", error);
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          restartRequired: error instanceof WeixinPluginActivationError && error.restartRequired,
        };
      } finally {
        weixinMutations.endPluginChange();
      }
    }),
  );

  ipcMain.handle("plugin:weixin:login", async () =>
    weixinMutations.run(assertWindowsNodeMxcConfigurationMutable, async () => {
      assertWindowsNodeMxcConfigurationMutable();
      weixinMutations.prepareCliLogin();
      if (weixinLoginProcess) {
        weixinLoginProcess.kill();
        weixinLoginProcess = null;
      }
      const nodePath = resolveNodePath();
      const entryPath = resolveOpenClawEntry();
      if (!fs.existsSync(nodePath) || !fs.existsSync(entryPath)) {
        return { ok: false, error: "OpenClaw CLI not found" };
      }
      return new Promise<{ ok: boolean; error?: string }>((resolve) => {
        const args = [entryPath, "channels", "login", "--channel", "openclaw-weixin"];
        const stateDir = getOpenClawStateDir();
        const compileCacheDir = path.join(stateDir, COMPILE_CACHE_SUBDIR);
        const activationOutcomeToken = randomUUID();
        const spawnOpts: any = {
          cwd: path.dirname(entryPath),
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: stateDir,
            NODE_COMPILE_CACHE: compileCacheDir,
            MICROCLAW_WEIXIN_LOGIN_OUTCOME_TOKEN: activationOutcomeToken,
          },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        };
        if (process.platform === "win32") {
          spawnOpts.creationFlags = CREATE_NO_WINDOW;
        }
        const child = spawn(nodePath, args, spawnOpts);
        weixinLoginProcess = child;
        let settled = false;
        const activationOutcomeParser = createWeixinLoginCliOutcomeParser(activationOutcomeToken);

        child.stdout?.on("data", (chunk: Buffer) => {
          const visibleOutput = activationOutcomeParser.push(chunk.toString("utf-8"));
          if (visibleOutput) {
            mainWindow?.webContents.send("plugin:weixin:login-output", visibleOutput);
          }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          mainWindow?.webContents.send("plugin:weixin:login-output", chunk.toString("utf-8"));
        });
        child.on("error", (err) => {
          weixinLoginProcess = null;
          if (!settled) {
            settled = true;
            resolve({ ok: false, error: err.message });
          }
        });
        child.on("close", (code) => {
          weixinLoginProcess = null;
          const trailingOutput = activationOutcomeParser.finish();
          if (trailingOutput) {
            mainWindow?.webContents.send("plugin:weixin:login-output", trailingOutput);
          }
          const activationOutcome = activationOutcomeParser.outcome;
          electronLifecycleDiagnostics.log("weixin-login-cli-activation-outcome", {
            exitCode: code,
            outcome: activationOutcome ?? "missing",
          });
          if (code === 0) {
            weixinMutations.qrConnected();
            reconcileWindowsNodeMxcWeixinRemoteApprovalOwner("weixin-account-replaced");
          }
          mainWindow?.webContents.send("plugin:weixin:login-done", { code });
          if (!settled) {
            settled = true;
            resolve({ ok: code === 0, error: code !== 0 ? `Exit code ${code}` : undefined });
          }
          if (code === 0 && (activationOutcome === "reload-failed" || activationOutcome === null)) {
            const fallbackReason =
              activationOutcome === "reload-failed"
                ? "config-mutation-failed"
                : "activation-outcome-missing";
            console.warn(`[weixin-login] Managed restart fallback required: ${fallbackReason}`);
            electronLifecycleDiagnostics.log("weixin-login-managed-restart-fallback", {
              reason: fallbackReason,
            });
            mainWindow?.webContents.send(
              "gateway:log",
              `[weixin] Channel hot reload unavailable (${fallbackReason}); reconnecting the managed Gateway…`,
            );
            setTimeout(() => {
              void restartManagedGateway(
                `Activating Weixin after CLI hot reload failure: ${fallbackReason}`,
              ).catch((error) =>
                console.error(
                  "[weixin-login] managed restart fallback failed:",
                  error instanceof Error ? error.message : String(error),
                ),
              );
            }, 0);
          } else if (code === 0) {
            console.info(
              `[weixin-login] CLI activation completed without Gateway replacement: ${activationOutcome}`,
            );
          }
        });
        setTimeout(() => {
          if (!settled) {
            settled = true;
            child.kill();
            weixinLoginProcess = null;
            resolve({ ok: false, error: "Login timed out" });
          }
        }, WEIXIN_LOGIN_TIMEOUT_MS);
      });
    }),
  );

  ipcMain.handle("plugin:weixin:cancel-login", async () => {
    if (weixinLoginProcess) {
      weixinLoginProcess.kill();
      weixinLoginProcess = null;
    }
    const gateway = gwClient;
    const connectionGeneration = gateway?.connectionGeneration;
    const qrEpoch = weixinMutations.currentEpoch;
    await weixinQrSession.cancel(async (sessionKey) => {
      try {
        if (sessionKey) {
          if (
            !gateway?.connected ||
            gwClient !== gateway ||
            gateway.connectionGeneration !== connectionGeneration
          ) {
            throw new Error("Gateway changed while cancelling WeChat login");
          }
          const result = await gateway.weixinLoginQrCancel(sessionKey);
          if (!result.cancelled) throw new Error("WeChat login cancellation was not confirmed");
        }
        await weixinMutations.cancelQr();
      } catch (error) {
        if (sessionKey) weixinMutations.qrUnconfirmed(qrEpoch);
        throw error;
      }
    });
  });

  // --- WeChat QR Login via Gateway RPC (fast path, no CLI spawn) ---
  ipcMain.handle(
    "plugin:weixin:login-qr-start",
    async (_event, params?: { accountId?: string; force?: boolean }) => {
      assertWindowsNodeMxcConfigurationMutable();
      return weixinQrSession.start(
        () =>
          weixinMutations.run(assertWindowsNodeMxcConfigurationMutable, async () => {
            if (!gwClient?.connected) {
              return { ok: false, message: "Gateway not connected", canFallback: false };
            }
            const gateway = gwClient;
            const connectionGeneration = gateway.connectionGeneration;
            try {
              const status = await gateway.getChannelsStatus();
              assertWindowsNodeMxcConfigurationMutable();
              if (
                gwClient !== gateway ||
                !gateway.connected ||
                gateway.connectionGeneration !== connectionGeneration ||
                !isWeixinLoginReady(status)
              ) {
                return {
                  ok: false,
                  message: "WeChat channel is not ready yet",
                  canFallback: false,
                };
              }
            } catch (error) {
              return {
                ok: false,
                message: error instanceof Error ? error.message : String(error),
                canFallback: false,
              };
            }
            weixinMutations.prepareCliLogin();
            if (weixinLoginProcess) throw new Error("Finish the current WeChat login first");
            const qrEpoch = weixinMutations.beginQr();
            try {
              const result = await gateway.weixinLoginQrStart(params);
              if (result.qrDataUrl && !result.sessionKey) {
                weixinMutations.qrUnconfirmed(qrEpoch);
                return {
                  ok: false,
                  message: "Gateway returned a QR without a session key",
                  restartRequired: true,
                };
              }
              weixinMutations.settleKnownQrStart(Boolean(result.qrDataUrl), qrEpoch);
              return { ok: true, ...result, canFallback: !result.qrDataUrl };
            } catch (error) {
              const knownRejection = isKnownWeixinQrStartRejection(error);
              if (knownRejection) weixinMutations.settleKnownQrStart(false, qrEpoch);
              else weixinMutations.qrUnconfirmed(qrEpoch);
              const message = error instanceof Error ? error.message : String(error);
              console.error("[weixin:login-qr-start] failed:", message);
              return {
                ok: false,
                message,
                error: message,
                canFallback: knownRejection,
                restartRequired: !knownRejection,
              };
            }
          }),
        (sessionKey) => waitForWeixinConnection({ sessionKey, timeoutMs: 35_000 }),
      );
    },
  );

  ipcMain.handle("plugin:weixin:login-qr-wait", () => {
    const session = weixinQrSession.status;
    return {
      connected: session.state === "connected",
      pending: session.state === "waiting" || session.state === "starting",
      expired: session.state === "expired",
      qrDataUrl: session.qrDataUrl,
      message: session.message,
      restartRequired: weixinMutations.loginRequiresRestart,
    };
  });

  ipcMain.handle("plugin:weixin:disconnect", async (_event, params?: { accountId?: string }) =>
    weixinMutations.run(assertWindowsNodeMxcConfigurationMutable, async () => {
      weixinMutations.prepareCliLogin();
      if (weixinLoginProcess) throw new Error("Finish the current WeChat login first");
      settingsStore.set("windowsNodeMxcWeixinRemoteApproval", { enabled: false, owner: null });
      closeWindowsNodeMxcWeixinRemoteApproval("weixin-logout");
      const gateway = gwClient;
      if (!gateway?.connected) return { ok: false, error: "Gateway not connected" };
      const status = readWeixinAccountStatus(getOpenClawStateDir());
      if (status.invariantState === "multiple" || status.invariantState === "invalid") {
        return { ok: false, error: "Repair the invalid WeChat account index before disconnecting" };
      }
      const accountId = status.currentAccount?.accountId;
      if (!accountId) return { ok: true };
      if (params?.accountId && params.accountId !== accountId) {
        return { ok: false, error: "The WeChat account changed; refresh its status first" };
      }
      try {
        const result = await gateway.request<{ cleared?: boolean; loggedOut?: boolean }>(
          "channels.logout",
          { channel: "openclaw-weixin", accountId },
          10_000,
        );
        weixinRuntimeRead = null;
        if (!result.cleared || result.loggedOut === false) {
          return { ok: false, error: "WeChat logout was not confirmed" };
        }
        weixinQrSession.reset();
        return { ok: true };
      } catch (error) {
        if (!isKnownWeixinQrStartRejection(error)) weixinMutations.qrUnconfirmed();
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );

  registerLocalModelHandlers(ipcMain, localModelService);
  registerSessionModelHandlers(ipcMain, sessionModelService);

  // --- Model connection test (runs in main process to avoid CORS) ---
  ipcMain.handle("model:discover-models", (_event, params: unknown) =>
    discoverProviderModels(params, { ...process.env, ...loadStateDirEnv() }),
  );
  ipcMain.handle("model:register-catalog-model", (_event, input: unknown) =>
    withModelConfigurationMutation(async () => {
      const params = parseProviderCatalogSelection(input);
      await prepareProviderCatalogModel(params.modelRef, params.expectedConfig);
      settingsStore.set("modelFormSelections", {
        ...settingsStore.get("modelFormSelections"),
        [params.modelRef.split("/", 1)[0]]: params.modelRef,
      });
    }),
  );
  ipcMain.handle(
    "model:test-connection",
    async (
      _event,
      params: {
        baseUrl: string;
        apiKey: string;
        apiFormat: string;
        modelName: string;
        reasoningEffort?: string;
      },
    ) => {
      const { baseUrl, apiKey: configuredApiKey, apiFormat, modelName, reasoningEffort } = params;
      const apiKeyResult = resolveModelApiKey(configuredApiKey, {
        ...process.env,
        ...loadStateDirEnv(),
      });
      if (!apiKeyResult.ok) return apiKeyResult;
      const apiKey = apiKeyResult.value;

      const baseUrlResult = prepareModelBaseUrl(baseUrl);
      if (!baseUrlResult.ok) return baseUrlResult;
      const versionedBase = baseUrlResult.value;
      const normalizedReasoning =
        reasoningEffort === "minimal" ||
        reasoningEffort === "low" ||
        reasoningEffort === "medium" ||
        reasoningEffort === "high" ||
        reasoningEffort === "xhigh"
          ? reasoningEffort
          : undefined;
      try {
        if (apiFormat === "anthropic") {
          const res = await requestModelEndpoint(appendModelEndpoint(versionedBase, "messages"), {
            method: "POST",
            signal: AbortSignal.timeout(MODEL_CONNECTION_TEST_TIMEOUT_MS),
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: modelName || "claude-3-haiku-20240307",
              max_tokens: 1,
              messages: [{ role: "user", content: "hi" }],
            }),
          });
          if (res.ok) {
            return {
              ok: true,
              message: "Connection successful (Anthropic)",
              baseUrl: versionedBase,
            };
          }
          return { ok: false, message: `Failed: HTTP ${res.status} ${res.statusText}` };
        } else if (apiFormat === "openai-responses") {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

          const body: Record<string, unknown> = {
            model: modelName || "gpt-4o",
            input: "hi",
            max_output_tokens: 1,
          };
          if (normalizedReasoning) {
            body.reasoning = { effort: normalizedReasoning };
          }

          const res = await requestModelEndpoint(appendModelEndpoint(versionedBase, "responses"), {
            method: "POST",
            signal: AbortSignal.timeout(MODEL_CONNECTION_TEST_TIMEOUT_MS),
            headers,
            body: JSON.stringify(body),
          });
          if (res.ok) {
            return {
              ok: true,
              message: "Connection successful (OpenAI Responses)",
              baseUrl: versionedBase,
            };
          }
          return { ok: false, message: `Failed: HTTP ${res.status} ${res.statusText}` };
        } else {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
          const res = await requestModelEndpoint(
            appendModelEndpoint(versionedBase, "chat/completions"),
            {
              method: "POST",
              signal: AbortSignal.timeout(MODEL_CONNECTION_TEST_TIMEOUT_MS),
              headers,
              body: JSON.stringify({
                model: modelName || "gpt-4o",
                max_tokens: 1,
                messages: [{ role: "user", content: "hi" }],
              }),
            },
          );
          if (res.ok) {
            return {
              ok: true,
              message: "Connection successful (OpenAI)",
              baseUrl: versionedBase,
            };
          }
          return { ok: false, message: `Failed: HTTP ${res.status} ${res.statusText}` };
        }
      } catch (err: any) {
        return { ok: false, message: "Connection failed: " + (err.message || "Network error") };
      }
    },
  );

  ipcMain.handle("model:github-copilot:prepare", async () => {
    assertGitHubCopilotEnabled(internalFeatures.githubCopilot);
    assertWindowsNodeMxcConfigurationMutable();
    return withModelConfigurationMutation(async () => {
      const config = readConfig();
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error("OpenClaw configuration is unavailable");
      }
      const nextConfig = structuredClone(config);
      const changed = ensureGitHubCopilotProviderPlugin(nextConfig);
      await applyModelConfiguration({
        config: nextConfig,
        expectedConfig: config,
        action: "copilot-prepare",
        providerKey: "github-copilot",
      });
      if (changed) {
        invalidateGitHubCopilotAuthStatusCache();
      }
      return { restartRequired: false };
    });
  });

  ipcMain.handle("model:github-copilot:start-login", () => {
    assertGitHubCopilotEnabled(internalFeatures.githubCopilot);
    assertWindowsNodeMxcConfigurationMutable();
    if (modelConfigurationMutationInProgress) {
      throw new Error("A model configuration change is in progress");
    }
    const sessionId = githubCopilotAuthManager.start(resolveGitHubCopilotAuthRuntime());
    githubCopilotLoginInProgress = true;
    return { sessionId };
  });

  ipcMain.handle("model:github-copilot:cancel-login", (_event, sessionId?: string) => ({
    cancelled: githubCopilotAuthManager.cancel(sessionId),
  }));

  ipcMain.handle("model:github-copilot:disconnect", async () => {
    sessionModelService.assertIdle();
    githubCopilotAuthManager.stop();
    githubCopilotLoginInProgress = false;
    return withModelConfigurationMutation(async () => {
      const result = await disconnectGitHubCopilot(resolveGitHubCopilotAuthRuntime());
      await refreshGatewayGitHubCopilotAuthStatus();
      return result;
    });
  });

  ipcMain.handle("model:select-default", async (_event, params: unknown) =>
    withModelConfigurationMutation(async () => {
      const startedAt = Date.now();
      try {
        const selected = await selectDefaultModel(
          {
            githubCopilotEnabled: internalFeatures.githubCopilot,
            gateway: () => gwClient,
            readConfig,
            assertMutable: assertCloudModelMutable,
            prepareModel: prepareProviderCatalogModel,
          },
          params,
        );
        console.info(`[model:select-default] applied in ${Date.now() - startedAt}ms`);
        return selected;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "Default model selection failed";
        console.warn(`[model:select-default] failed after ${Date.now() - startedAt}ms: ${message}`);
        throw new Error(message, { cause });
      }
    }),
  );

  ipcMain.handle("model:github-copilot:status", () => {
    if (!internalFeatures.githubCopilot) return { authenticated: false };
    const client = gwClient;
    const queryGateway = client?.connected ? () => client.request("models.authStatus") : undefined;
    return getGitHubCopilotAuthStatus(resolveGitHubCopilotAuthRuntime(), queryGateway);
  });

  ipcMain.handle("model:github-copilot:list-models", async () => {
    if (!internalFeatures.githubCopilot) return [];
    const client = gwClient;
    const queryGateway = client?.connected
      ? (params: Record<string, unknown>, timeoutMs: number) =>
          client.request("models.list", params, timeoutMs)
      : undefined;
    return listGitHubCopilotModels(resolveGitHubCopilotAuthRuntime(), queryGateway);
  });

  const backgroundUsageLedger = new BackgroundUsageLedger(
    path.join(app.getPath("userData"), "usage", "background-requests.json"),
  );
  const usageSnapshots = new UsageSnapshotCache(
    path.join(app.getPath("userData"), "usage", "snapshots.json"),
    async (range) => {
      if (!gwClient?.connected) throw new Error("Gateway 未连接");
      return queryAccountedUsage(
        (method, params) => gwClient!.request(method, params),
        backgroundUsageLedger,
        range,
        () =>
          console.warn("[usage] Background usage could not be refreshed; keeping cached totals"),
      );
    },
  );

  ipcMain.handle("usage:get-stats", async () => {
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - USAGE_QUERY_DAYS * 86_400_000)
      .toISOString()
      .split("T")[0];

    const result: any = await usageSnapshots.get({ startDate, endDate, limit: 1000 }, "summary");

    const totals = result?.totals || {};
    const aggregates = result?.aggregates || {};
    const daily = aggregates.daily || [];
    const byModel = aggregates.byModel || [];

    // Build model breakdown
    const modelBreakdown: Record<
      string,
      {
        requests: number;
        promptTokens: number;
        completionTokens: number;
        spend: number;
      }
    > = {};
    const modelSpend: Record<string, number> = {};
    for (const m of byModel) {
      const name = m.model || m.provider || "unknown";
      const mt = m.totals || {};
      modelBreakdown[name] = {
        requests: m.count || 0,
        promptTokens: mt.input || 0,
        completionTokens: mt.output || 0,
        spend: mt.totalCost || 0,
      };
      modelSpend[name] = mt.totalCost || 0;
    }

    // Build daily spend
    const dailySpend: Record<string, number> = {};
    for (const d of daily) {
      if (d.date) dailySpend[d.date] = d.cost || 0;
    }

    // The gateway reports cost in USD; fetch the live USD→CNY rate so the
    // renderer can convert + relabel spend to ¥ (falls back gracefully offline).
    const fx = await getUsdToCnyRate();

    return {
      updatedAt: result.updatedAt,
      totalSpend: totals.totalCost || 0,
      maxBudget: null,
      modelSpend,
      keyName: "",
      budgetDuration: null,
      budgetResetAt: null,
      totalPromptTokens: totals.input || 0,
      totalCompletionTokens: totals.output || 0,
      totalTokens: totals.totalTokens || 0,
      totalRequests: result.requestCount,
      usageSources: result.usageSources,
      backgroundUsageAvailable: result.backgroundUsageAvailable,
      backgroundRequests: result.backgroundRequests,
      modelBreakdown,
      dailySpend,
      hasDetailedLogs: (result?.sessions?.length || 0) > 0 || result.backgroundRequests > 0,
      // Extra fields from gateway
      cacheReadTokens: totals.cacheRead || 0,
      cacheWriteTokens: totals.cacheWrite || 0,
      sessionCount: result?.sessions?.length || 0,
      toolCalls: aggregates.tools?.totalCalls || 0,
      // USD→CNY conversion metadata (spend values above remain raw USD)
      exchangeRate: fx.rate,
      currency: fx.currency,
    };
  });

  // Live USD→CNY exchange rate used to render spend figures in CNY.
  ipcMain.handle("usage:get-exchange-rate", async () => {
    return getUsdToCnyRate();
  });

  // Detailed usage stats for the full Usage dashboard page
  ipcMain.handle(
    "usage:get-detailed-stats",
    async (_event, params: { startDate?: string; endDate?: string; filter?: string }) => {
      const endDate = params.endDate || new Date().toISOString().split("T")[0];
      const startDate =
        params.startDate ||
        new Date(Date.now() - USAGE_QUERY_DAYS * 86_400_000).toISOString().split("T")[0];

      const result: any = await usageSnapshots.get({ startDate, endDate, limit: 5000 });

      const totals = result?.totals || {};
      const aggregates = result?.aggregates || {};
      const sessions: any[] = result?.sessions || [];

      // Compute aggregate messages from sessions if aggregates.messages is incomplete
      const aggMessages = aggregates.messages || {};
      if (!aggMessages.total && sessions.length) {
        let total = 0,
          user = 0,
          assistant = 0,
          toolCalls = 0,
          errors = 0;
        for (const s of sessions) {
          const mc = s.usage?.messageCounts || {};
          total += mc.total || 0;
          user += mc.user || 0;
          assistant += mc.assistant || 0;
          toolCalls += mc.toolCalls || 0;
          errors += mc.errors || 0;
        }
        aggMessages.total = total;
        aggMessages.user = user;
        aggMessages.assistant = assistant;
        aggMessages.toolCalls = toolCalls;
        aggMessages.errors = errors;
      }

      // Compute aggregate tools from sessions if aggregates.tools is incomplete
      const aggTools = aggregates.tools || {};
      if (!aggTools.totalCalls && sessions.length) {
        let totalCalls = 0;
        const toolSet = new Set<string>();
        for (const s of sessions) {
          const mc = s.usage?.messageCounts || {};
          totalCalls += mc.toolCalls || 0;
        }
        aggTools.totalCalls = totalCalls;
        aggTools.uniqueTools = toolSet.size;
      }

      // Build error aggregation by day/hour from daily data
      const errTotal = (aggregates.daily || []).reduce(
        (sum: number, d: any) => sum + (d.errors || 0),
        0,
      );
      const errorsByDay = (aggregates.daily || [])
        .filter((d: any) => d.errors > 0)
        .map((d: any) => ({ date: d.date, count: d.errors, messages: d.messages || 0 }));

      // Build byTool from aggregates.tools or sessions
      const byTool: Array<{ tool: string; calls: number }> = [];
      if (aggregates.tools?.byTool) {
        for (const [name, calls] of Object.entries(aggregates.tools.byTool)) {
          byTool.push({ tool: name, calls: calls as number });
        }
      }

      return {
        usageSources: result.usageSources,
        backgroundUsageAvailable: result.backgroundUsageAvailable,
        backgroundRequests: result.backgroundRequests,
        requestCount: result.requestCount,
        totals: {
          totalCost: totals.totalCost || 0,
          input: totals.input || 0,
          output: totals.output || 0,
          totalTokens: totals.totalTokens || 0,
          cacheRead: totals.cacheRead || 0,
          cacheWrite: totals.cacheWrite || 0,
        },
        aggregates: {
          daily: (aggregates.daily || []).map((d: any) => ({
            date: d.date,
            tokens: d.tokens || 0,
            cost: d.cost || 0,
            input: d.input || 0,
            output: d.output || 0,
            cacheRead: d.cacheRead || 0,
            cacheWrite: d.cacheWrite || 0,
            messages: d.messages || 0,
            toolCalls: d.toolCalls || 0,
            errors: d.errors || 0,
          })),
          byModel: (aggregates.byModel || []).map((m: any) => ({
            model: m.model || "unknown",
            provider: m.provider || "",
            count: m.count || 0,
            totals: m.totals || {},
          })),
          byProvider: (aggregates.byProvider || []).map((p: any) => ({
            provider: p.provider || p.name || "unknown",
            count: p.count || 0,
            totals: p.totals || {},
          })),
          byAgent: (aggregates.byAgent || []).map((a: any) => ({
            agent: a.agentId || a.agent || a.name || "unknown",
            count: a.count || 0,
            totals: a.totals || {},
          })),
          byChannel: (aggregates.byChannel || []).map((c: any) => ({
            channel: c.channel || c.name || "unknown",
            count: c.count || 0,
            totals: c.totals || {},
          })),
          byTool,
          messages: aggMessages,
          tools: aggTools,
          errors: {
            total: errTotal,
            byDay: errorsByDay,
          },
        },
        sessions: sessions.map((s: any) => {
          const usage = s.usage || {};
          const mc = usage.messageCounts || {};
          return {
            key: s.key || s.sessionKey || "",
            agent: s.agentId || s.agent || "",
            channel: s.channel || "",
            provider: s.modelProvider || s.provider || "",
            model: s.model || "",
            messages: mc.total || 0,
            tools: mc.toolCalls || 0,
            errors: mc.errors || 0,
            tokens: usage.totalTokens || 0,
            cost: usage.totalCost || 0,
            duration: (usage.durationMs || 0) / 1000,
            createdAt: usage.firstActivity
              ? new Date(usage.firstActivity).toISOString()
              : s.updatedAt
                ? new Date(s.updatedAt).toISOString()
                : "",
          };
        }),
        startDate,
        endDate,
      };
    },
  );

  // --- Settings ---
  ipcMain.handle("settings:get", () => settingsStore.store);
  ipcMain.handle("settings:set", (_event, key: string, value: any) => {
    if (!RENDERER_WRITABLE_SETTING_KEYS.has(key)) {
      throw new Error(`Setting "${key}" cannot be changed through the generic settings API`);
    }
    settingsStore.set(key as any, value);
    if (key === "autoStart") {
      app.setLoginItemSettings({ openAtLogin: !!value });
    } else if (key === "language") {
      updateTrayMenu(gatewayStatus, resolveSupportedLocale(String(value)));
    }
  });

  // --- Experimental Windows Node + MXC sandbox (security framework #202) ---
  ipcMain.handle("windows-node-mxc:get-status", () => getWindowsNodeMxcStatus());
  ipcMain.handle("windows-node-mxc:approval-current", () =>
    getPendingWindowsNodeMxcApprovalForRenderer(),
  );

  ipcMain.handle("windows-node-mxc:durable-approvals:list", () =>
    getWindowsNodeMxcDurableApprovalStore().list(),
  );

  ipcMain.handle("windows-node-mxc:durable-approvals:revoke", async (_event, id: string) => {
    await withWindowsNodeMxcDurableApprovalLock(() =>
      getWindowsNodeMxcDurableApprovalStore().revoke(id),
    );
    return getWindowsNodeMxcDurableApprovalStore().list();
  });

  ipcMain.handle("windows-node-mxc:durable-approvals:revoke-all", async () => {
    await withWindowsNodeMxcDurableApprovalLock(() =>
      getWindowsNodeMxcDurableApprovalStore().revokeAll(),
    );
    return [];
  });

  ipcMain.handle(
    "windows-node-mxc:set-enabled",
    async (
      event,
      params: {
        enabled?: boolean;
        requestedMode?: WindowsNodeMxcRequestedMode;
        acknowledgeLimitedFilesystem?: boolean;
        nodeId?: string;
      },
    ) => {
      assertTrustedRendererIpc(event);
      assertNativeWeixinRemoteApprovalAuthority(params);
      const requestedMode =
        params?.requestedMode ??
        (params?.enabled === true ? "full" : params?.enabled === false ? "off" : null);
      if (requestedMode !== "off" && requestedMode !== "full" && requestedMode !== "limited-dacl") {
        throw new Error("A valid MXC containment mode is required");
      }
      const lifecycleOperation =
        windowsNodeMxcLifecycleOperations.acquire<WindowsNodeMxcRuntimeStatus>(
          {
            kind: "set-enabled",
            requestedMode,
          },
          windowsNodeMxcLifecycleOperationHooks(requestedMode),
        );
      if (lifecycleOperation.joined) return lifecycleOperation.promise;
      let transitionSucceeded = false;
      let automaticReadinessStarted = false;
      let transitionMutationStarted = false;
      let validationStarted = false;
      let cronSuspendedBeforePreflight = false;
      let standardRuntimeRecovered = false;
      let remoteApprovalPlan: WeixinRemoteApprovalTransitionPlan;
      let remoteApprovalSelection: WeixinRemoteApprovalActivationSelection | undefined;
      let remoteApprovalPlanPersisted = false;
      let previousRemoteApprovalConfiguration = migrateWeixinRemoteApprovalConfiguration(null);
      let transitionInitialSelection: WindowsNodeMxcSelection | null = null;
      let preparedContainment: PreparedWindowsNodeMxcContainment | undefined;
      let lifecycleError: unknown = new Error(
        "Windows Node + MXC lifecycle operation ended without a result",
      );
      try {
        localModelService.assertIdle();
        sessionModelService.assertIdle();
        previousRemoteApprovalConfiguration = migrateWeixinRemoteApprovalConfiguration(
          settingsStore.get("windowsNodeMxcWeixinRemoteApproval"),
        );
        const enabled = requestedMode !== "off";
        const currentSelection = getWindowsNodeMxcSelection();
        transitionInitialSelection = currentSelection;
        const nextSelection = createWindowsNodeMxcSelection(
          requestedMode,
          params?.acknowledgeLimitedFilesystem === true ||
            (requestedMode === "limited-dacl" &&
              currentSelection.requestedMode === "limited-dacl" &&
              currentSelection.limitedFilesystemAcknowledgedAt !== null),
        );
        if (gwClient?.connected && (!gatewaySpawnedByUs || !isManagedGatewayProcessAlive())) {
          throw new Error(
            "Windows Node + MXC mode requires MicroClaw's managed Gateway; stop the external Gateway first",
          );
        }
        const config = readConfig();
        if (!config || typeof config !== "object" || Array.isArray(config)) {
          throw new Error("OpenClaw configuration is unavailable");
        }
        const nativeConsent = await planWeixinRemoteApprovalNativeTransition({
          request: params,
          currentMode: currentSelection.requestedMode,
          requestedMode,
          currentConfiguration: previousRemoteApprovalConfiguration,
          readOptions: () => getWeixinRemoteApprovalActivationOptions(readConfig()),
          locale: resolveSupportedLocale(settingsStore.get("language") ?? "en-US"),
          showDialog: async (options) => {
            const window = mainWindow;
            if (!window || window.isDestroyed()) {
              throw new Error("The MicroClaw window is unavailable for local consent");
            }
            return dialog.showMessageBox(window, options);
          },
        });
        remoteApprovalPlan = nativeConsent.plan;
        remoteApprovalSelection = nativeConsent.selection;

        const configuredPort = config?.gateway?.port || gatewayPort || DEFAULT_PORT;
        const suspendCronBeforePreflight = shouldSuspendWindowsNodeMxcCronBeforePreflight(
          getWindowsNodeMxcRequestedMode(),
          requestedMode,
        );
        if (suspendCronBeforePreflight) {
          transitionMutationStarted = true;
          setWindowsNodeMxcLifecycleState("locking");
          closeWindowsNodeMxcIngress();
          windowsNodeMxcActivationInProgress = false;
          bundledWindowsNodeHost.revokeActivationLease();
          sendToWindow(mainWindow, "gateway:ws-disconnected", "Security mode transition");
          sendToWindow(mainWindow, "gateway:service-loading");
          await stopGatewayForSecurityTransition(configuredPort);
          cronSuspendedBeforePreflight = true;
        }
        if (enabled) {
          const validationDetail = mainT(
            resolveSupportedLocale(settingsStore.get("language") ?? "en-US"),
            requestedMode === "limited-dacl"
              ? "mxc.assessingLimitedAmbientAccess"
              : "mxc.verifyingFullBackend",
          );
          const validationStartedAt = Date.now();
          validationStarted = true;
          setWindowsNodeMxcLifecycleState("validating", validationDetail);
          try {
            const result = await prepareWindowsNodeMxcContainment(requestedMode);
            preparedContainment = {
              requestedMode,
              transitionId: windowsNodeMxcReadinessTransitionId,
              ...result,
            };
            electronLifecycleDiagnostics.log("mxc-validation-complete", {
              requestedMode,
              elapsedMs: Date.now() - validationStartedAt,
            });
          } catch (error) {
            electronLifecycleDiagnostics.log("mxc-validation-failed", {
              requestedMode,
              elapsedMs: Date.now() - validationStartedAt,
              error: summarizeLifecycleError(
                error instanceof Error ? error.message : String(error),
              ),
            });
            throw error;
          }
        }

        if (!cronSuspendedBeforePreflight) {
          transitionMutationStarted = true;
          setWindowsNodeMxcLifecycleState("locking");
          closeWindowsNodeMxcIngress();
          windowsNodeMxcActivationInProgress = false;
          bundledWindowsNodeHost.revokeActivationLease();
          sendToWindow(mainWindow, "gateway:ws-disconnected", "Security mode transition");
          sendToWindow(mainWindow, "gateway:service-loading");
        } else {
          setWindowsNodeMxcLifecycleState("locking");
        }
        if (enabled) {
          const nodeId = bundledWindowsNodeHost.ensureIdentityNodeId();
          const applied = applyWindowsNodeMxcGatewayPolicy(
            config,
            nodeId,
            settingsStore.get("windowsNodeMxcToolBackups"),
            "locked",
          );
          if (!cronSuspendedBeforePreflight) {
            await stopGatewayForSecurityTransition(configuredPort);
          }
          remoteApprovalPlan = planWeixinRemoteApprovalTransition({
            currentMode: currentSelection.requestedMode,
            requestedMode,
            currentConfiguration: previousRemoteApprovalConfiguration,
            options: getWeixinRemoteApprovalActivationOptions(readConfig()),
            selection: remoteApprovalSelection,
          });
          persistWindowsNodeMxcWeixinRemoteApprovalPlan(remoteApprovalPlan, "activation-disabled");
          remoteApprovalPlanPersisted = remoteApprovalPlan.action === "persist";
          settingsStore.set("windowsNodeMxcToolBackups", applied.backups);
          settingsStore.set("windowsNodeMxcNodeId", nodeId);
          settingsStore.set("windowsNodeMxcSelection", nextSelection);
          settingsStore.delete("windowsNodeMxcCronResumeFence");
          if (requestedMode === "limited-dacl") {
            await withWindowsNodeMxcDurableApprovalLock(() =>
              getWindowsNodeMxcDurableApprovalStore().revokeAll(),
            );
          }
          settingsStore.delete("windowsNodeMxcSmoke");
          writeConfigTextAtomically(JSON.stringify(applied.config, null, 2));
          automaticReadinessStarted = true;
          const status = await runAutomaticWindowsNodeMxcReadiness(preparedContainment);
          transitionSucceeded = true;
          lifecycleOperation.succeed(status);
          return status;
        } else {
          stopBundledWindowsNodeHost();
          const cronResumeAcknowledgementToken = randomUUID();
          const cronResumeAcknowledgementDir = path.join(
            app.getPath("userData"),
            "mxc-cron-resume",
          );
          fs.mkdirSync(cronResumeAcknowledgementDir, { recursive: true });
          const cronResumeAcknowledgementPath = path.join(
            cronResumeAcknowledgementDir,
            `${cronResumeAcknowledgementToken}.json`,
          );
          settingsStore.set(
            "windowsNodeMxcCronResumeFence",
            createWindowsNodeMxcCronResumeFence(
              cronResumeAcknowledgementPath,
              cronResumeAcknowledgementToken,
            ),
          );
          const restored = restoreWindowsNodeMxcGatewayPolicy(
            config,
            settingsStore.get("windowsNodeMxcToolBackups"),
          );
          await stopGatewayForSecurityTransition(configuredPort);
          writeConfigTextAtomically(JSON.stringify(restored, null, 2));
          settingsStore.set("windowsNodeMxcToolBackups", {});
          settingsStore.delete("windowsNodeMxcSmoke");
          settingsStore.delete("windowsNodeMxcAmbientAccess");
          persistWindowsNodeMxcWeixinRemoteApprovalPlan(remoteApprovalPlan, "mxc-off");
          remoteApprovalPlanPersisted = remoteApprovalPlan.action === "persist";
          settingsStore.set("windowsNodeMxcSelection", nextSelection);
          windowsNodeMxcCurrentAmbientAccess = null;
          windowsNodeMxcCurrentEffectiveTier = null;
          setWindowsNodeMxcLifecycleState("starting-standard");
          postSpawnChannelCheck = null;
          mainWindow?.webContents.send(
            "gateway:log",
            "[start] MXC Off: starting without a tool execution sandbox",
          );
          await startGateway();
          await waitForManagedGatewayConnection();
          await waitForWindowsNodeMxcCronResumeAcknowledgement();
          setWindowsNodeMxcLifecycleState("idle");
          transitionSucceeded = true;
          const status = await getWindowsNodeMxcStatus();
          lifecycleOperation.succeed(status);
          return status;
        }
      } catch (error) {
        lifecycleError = error;
        const detail = error instanceof Error ? error.message : String(error);
        if (!transitionMutationStarted && !validationStarted) {
          electronLifecycleDiagnostics.log("mxc-activation-rejected-before-mutation", {
            requestedMode,
            error: summarizeLifecycleError(detail),
          });
          throw error;
        }
        if (
          remoteApprovalPlanPersisted &&
          transitionInitialSelection?.requestedMode === "off" &&
          !isWindowsNodeMxcDesired()
        ) {
          settingsStore.set(
            "windowsNodeMxcWeixinRemoteApproval",
            previousRemoteApprovalConfiguration,
          );
          windowsNodeMxcWeixinRemoteApprovalBroker.configure({
            enabled: false,
            owner: previousRemoteApprovalConfiguration.owner,
          });
        }
        if (isWindowsNodeMxcDesired()) {
          setWindowsNodeMxcLifecycleState("locked", detail);
          if (!automaticReadinessStarted) {
            await failClosedWindowsNodeMxc(`Security-mode transition failed: ${detail}`);
          }
        } else {
          windowsNodeMxcCurrentAmbientAccess = null;
          windowsNodeMxcCurrentEffectiveTier = null;
          settingsStore.delete("windowsNodeMxcAmbientAccess");
          setWindowsNodeMxcLifecycleState("failed", detail);
          if (cronSuspendedBeforePreflight && !automaticReadinessStarted) {
            try {
              setWindowsNodeMxcLifecycleState("starting-standard");
              postSpawnChannelCheck = null;
              mainWindow?.webContents.send(
                "gateway:log",
                "[start] Restoring standard Gateway after MXC preflight failure",
              );
              await startGateway();
              await waitForManagedGatewayConnection();
              setWindowsNodeMxcLifecycleState("idle");
              standardRuntimeRecovered = true;
            } catch (recoveryError) {
              const recoveryDetail =
                recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
              setWindowsNodeMxcLifecycleState(
                "failed",
                `MXC preflight failed and the standard Gateway could not be restored: ${recoveryDetail}`,
              );
              setGatewayStatus("failed");
              const aggregateError = new AggregateError(
                [error, recoveryError],
                `MXC preflight failed and the standard Gateway could not be restored: ${recoveryDetail}`,
                { cause: recoveryError },
              );
              lifecycleError = aggregateError;
              throw aggregateError;
            }
          } else if (transitionMutationStarted) {
            try {
              await stopGatewayForSecurityTransition(gatewayPort || DEFAULT_PORT);
            } finally {
              setGatewayStatus("failed");
            }
          } else {
            throw error;
          }
        }
        throw error;
      } finally {
        if (!lifecycleOperation.settled) lifecycleOperation.fail(lifecycleError);
        if (transitionSucceeded || standardRuntimeRecovered) notifyRendererApplicationReady();
      }
    },
  );

  ipcMain.handle(
    "windows-node-mxc:approval-respond",
    async (
      event,
      params: {
        requestId?: unknown;
        decision?: unknown;
        origin?: unknown;
      },
    ) => {
      assertTrustedRendererIpc(event);
      const requestId = params?.requestId;
      const decision = params?.decision;
      if (typeof requestId !== "string" || requestId.length === 0) {
        throw new Error("Invalid Windows node approval request ID");
      }
      if (
        typeof decision !== "string" ||
        !["deny", "allow-once", "allow-always"].includes(decision)
      ) {
        throw new Error("Invalid Windows node approval decision");
      }
      const normalizedDecision = decision as WindowsNodeMxcApprovalDecision;
      const origin = params?.origin === "timeout" ? "timeout" : "desktop";
      if (
        params?.origin !== undefined &&
        params.origin !== "desktop" &&
        params.origin !== "timeout"
      ) {
        throw new Error("Invalid local approval origin");
      }
      if (origin === "timeout" && normalizedDecision !== "deny") {
        throw new Error("A permission timeout can only deny");
      }
      const gatewayApproval = findPendingWindowsNodeMxcGatewayApproval(requestId);
      if (gatewayApproval?.request.id === requestId) {
        await resolvePendingWindowsNodeMxcGatewayApproval(
          requestId,
          normalizedDecision,
          true,
          undefined,
          origin,
        );
        return;
      }
      if (normalizedDecision === "allow-always") {
        throw new Error("Diagnostic node approvals are one-use only");
      }
      bundledWindowsNodeHost.respond(requestId, normalizedDecision);
    },
  );

  // --- Updates ---
  ipcMain.handle("updates:check", () => {
    return checkForUpdates({
      currentVersion: app.getVersion(),
      manifestUrl: UPDATE_MANIFEST_URL,
      storeManaged: process.windowsStore,
    });
  });

  // --- Window ---
  ipcMain.handle("window:minimize", () => {
    minimizeWindow(mainWindow, settingsStore.get("minimizeToTray"));
  });
  ipcMain.handle("window:maximize", () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  ipcMain.handle("window:is-maximized", () => mainWindow?.isMaximized() ?? false);
  ipcMain.handle("window:close", () => mainWindow?.close());
  ipcMain.handle("window:resize-to-setup", () => {
    if (!mainWindow) return;
    mainWindow.setSize(SETUP_WINDOW_WIDTH, SETUP_WINDOW_HEIGHT);
    mainWindow.center();
  });
  ipcMain.handle("window:expand-to-full", () => {
    if (!mainWindow) return;
    mainWindow.setResizable(true);
    const savedBounds = store.get("windowBounds") as
      | { width?: number; height?: number; x?: number; y?: number }
      | undefined;
    const width = savedBounds?.width || DEFAULT_WINDOW_WIDTH;
    const height = savedBounds?.height || DEFAULT_WINDOW_HEIGHT;
    mainWindow.setSize(width, height);
    mainWindow.center();
    (mainWindow as any).__registerSaveBounds?.();
  });

  // --- Shell ---
  ipcMain.handle("shell:open-external", (_event, url: unknown) => {
    if (typeof url !== "string" || (!url.startsWith("https://") && !url.startsWith("http://"))) {
      throw new Error("Only HTTP(S) links can be opened");
    }
    return shell.openExternal(url);
  });

  ipcMain.handle("attachment:open", async (_event, request: unknown) => {
    try {
      const targetPath = await prepareAttachmentForOpen(
        request,
        app.getPath("temp"),
        getOpenClawStateDir(),
      );
      const error = await shell.openPath(targetPath);
      return error ? { ok: false, error } : { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  const beginWindowsNodeMxcFolderDraftMutation = () => {
    if (windowsNodeMxcSecurityTransitionInProgress) {
      throw new Error("Wait for the Windows Node + MXC lifecycle operation to finish");
    }
    if (windowsNodeMxcFolderPolicyMutationInProgress) {
      throw new Error("Another approved folder draft change is already in progress");
    }
    windowsNodeMxcFolderPolicyMutationInProgress = true;
  };

  const endWindowsNodeMxcFolderDraftMutation = () => {
    windowsNodeMxcFolderPolicyMutationInProgress = false;
  };

  const getReparsePathComponents = (dir: string): Set<string> => {
    const normalized = path.win32.normalize(dir);
    const parsed = path.win32.parse(normalized);
    const components: string[] = [];
    let current = parsed.root;
    for (const component of normalized.slice(parsed.root.length).split("\\").filter(Boolean)) {
      current = path.win32.join(current, component);
      components.push(current);
    }
    if (components.length === 0) return new Set();

    const powershellPath = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const script =
      "& { foreach ($candidate in $args) { try { [Console]::Out.WriteLine([int][System.IO.File]::GetAttributes($candidate)) } catch { exit 2 } } }";
    try {
      const output = execFileSync(
        powershellPath,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, ...components],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 10_000,
        },
      );
      const attributes = output
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((value) => Number.parseInt(value, 10));
      if (
        attributes.length !== components.length ||
        attributes.some((value) => !Number.isInteger(value))
      ) {
        throw new Error("Unexpected Windows file-attribute response");
      }
      return new Set(
        components
          .filter((_component, index) => (attributes[index] & 0x400) !== 0)
          .map((component) => normalizeDirPath(component).toLowerCase()),
      );
    } catch (error) {
      console.warn(
        `[windows-node-mxc] Could not verify reparse attributes for "${dir}"; rejecting the folder:`,
        error,
      );
      return new Set(components.map((component) => normalizeDirPath(component).toLowerCase()));
    }
  };

  const validateWindowsNodeMxcUserDir = (dir: string) => {
    let reparseComponents: Set<string> | null = null;
    return validateWindowsNodeMxcFolderPath(
      dir,
      (candidate) => fs.realpathSync.native(candidate),
      (candidate) => {
        reparseComponents ??= getReparsePathComponents(dir);
        return (
          fs.lstatSync(candidate).isSymbolicLink() ||
          reparseComponents.has(normalizeDirPath(candidate).toLowerCase())
        );
      },
      sensitiveWindowsRoots(
        path.join(app.getPath("userData"), "windows-node"),
        getOpenClawStateDir(),
      ),
    );
  };

  const normalizeCompleteWindowsNodeMxcFolderPolicy = (draft: WindowsNodeMxcFolderPolicy) => {
    const result = normalizeWindowsNodeMxcFolderPolicy(draft, validateWindowsNodeMxcUserDir);
    if (!result.ok) {
      throw new Error(
        `Approved folder policy rejected${result.path ? ` (${result.path})` : ""}: ${
          result.reason ?? "invalid policy"
        }`,
      );
    }
    return result.dirs;
  };

  const persistWindowsNodeMxcFolderPolicy = (
    next: WindowsNodeMxcFolderPolicy,
    previous: WindowsNodeMxcFolderPolicy,
    lastError: string | null,
  ) => {
    settingsStore.store = {
      ...settingsStore.store,
      windowsNodeMxcFolders: { rw: [...next.rw], ro: [...next.ro] },
      windowsNodeMxcFolderPolicyRecovery: {
        previous: { rw: [...previous.rw], ro: [...previous.ro] },
        draft: { rw: [...next.rw], ro: [...next.ro] },
        updatedAt: new Date().toISOString(),
        lastError,
        failurePhase: null,
      },
    };
  };

  ipcMain.handle("windows-node-mxc:get-folders", () => getWindowsNodeMxcFolderPolicy());

  ipcMain.handle(
    "windows-node-mxc:set-folder-policy",
    (event, draft: WindowsNodeMxcFolderPolicy) => {
      assertTrustedRendererIpc(event);
      beginWindowsNodeMxcFolderDraftMutation();
      try {
        if (isWindowsNodeMxcDesired()) {
          throw new Error("Use Apply and reactivate to change an active MXC folder policy");
        }
        const next = normalizeCompleteWindowsNodeMxcFolderPolicy(draft);
        persistWindowsNodeMxcFolderPolicy(next, getWindowsNodeMxcFolderPolicy(), null);
        return next;
      } finally {
        endWindowsNodeMxcFolderDraftMutation();
      }
    },
  );

  ipcMain.handle(
    "windows-node-mxc:stage-folder",
    async (event, params: { access: "rw" | "ro"; draft: WindowsNodeMxcFolderPolicy }) => {
      assertTrustedRendererIpc(event);
      beginWindowsNodeMxcFolderDraftMutation();
      try {
        if (params?.access !== "rw" && params?.access !== "ro") {
          throw new Error("Invalid MXC folder access");
        }
        const current = normalizeCompleteWindowsNodeMxcFolderPolicy(params.draft);
        if (!mainWindow) return { ok: false, canceled: true, dirs: current };
        const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
        if (result.canceled || result.filePaths.length === 0) {
          return { ok: false, canceled: true, dirs: current };
        }
        const validation = validateWindowsNodeMxcUserDir(result.filePaths[0]);
        if (!validation.ok || !validation.canonicalPath) {
          return {
            ok: false,
            canceled: false,
            reason: validation.reason,
            removedChildren: [],
            dirs: current,
          };
        }
        return {
          ...planWindowsNodeMxcFolderUpsert(current, validation.canonicalPath, params.access),
          canceled: false,
        };
      } finally {
        endWindowsNodeMxcFolderDraftMutation();
      }
    },
  );

  ipcMain.handle(
    "windows-node-mxc:validate-folder-policy",
    (event, draft: WindowsNodeMxcFolderPolicy) => {
      assertTrustedRendererIpc(event);
      return normalizeCompleteWindowsNodeMxcFolderPolicy(draft);
    },
  );

  ipcMain.handle(
    "windows-node-mxc:apply-folder-policy",
    async (event, draft: WindowsNodeMxcFolderPolicy) => {
      assertTrustedRendererIpc(event);
      if (!isWindowsNodeMxcDesired()) {
        throw new Error("Apply and reactivate requires Windows Node + MXC mode");
      }
      const lifecycleOperation =
        windowsNodeMxcLifecycleOperations.acquire<WindowsNodeMxcRuntimeStatus>(
          { kind: "apply-folder-policy" },
          windowsNodeMxcLifecycleOperationHooks(),
        );
      if (lifecycleOperation.joined) return lifecycleOperation.promise;
      try {
        windowsNodeMxcActivationInProgress = true;
        const previous = getWindowsNodeMxcFolderPolicy();
        const recovery = {
          previous: { rw: [...previous.rw], ro: [...previous.ro] },
          draft: {
            rw: Array.isArray(draft?.rw) ? [...draft.rw] : [],
            ro: Array.isArray(draft?.ro) ? [...draft.ro] : [],
          },
          updatedAt: new Date().toISOString(),
          lastError: null,
          failurePhase: null,
        };
        settingsStore.set("windowsNodeMxcFolderPolicyRecovery", recovery);
        await runWindowsNodeMxcFolderPolicyTransaction(draft, previous, {
          setPhase: setWindowsNodeMxcLifecycleState,
          closeIngress: () => {
            closeWindowsNodeMxcIngress();
            sendToWindow(mainWindow, "gateway:ws-disconnected", "Applying MXC folder policy");
          },
          rejectPendingApprovals: async () => {
            for (const pending of allPendingWindowsNodeMxcGatewayApprovals()) {
              if (gwClient?.connected) {
                await gwClient.request("exec.approval.resolve", {
                  id: pending.request.id,
                  decision: "deny",
                });
              }
            }
            pendingWindowsNodeMxcGatewayApproval = null;
            queuedWindowsNodeMxcGatewayApprovals.length = 0;
            const nodePending = bundledWindowsNodeHost.status().pendingApproval;
            if (nodePending) bundledWindowsNodeHost.respond(nodePending.id, "deny");
            sendToWindow(mainWindow, "windows-node-mxc:approval-request", null);
          },
          revokeAuthorization: () => {
            bundledWindowsNodeHost.revokeActivationLease();
            windowsNodeMxcApprovalProofContext = null;
            settingsStore.delete("windowsNodeMxcSmoke");
          },
          preflightExactBackend: async () => {
            const requestedMode = getWindowsNodeMxcRequestedMode();
            if (requestedMode === "off") throw new Error("MXC containment mode is off");
            await prepareWindowsNodeMxcContainment(requestedMode);
          },
          validatePolicy: (candidate) => normalizeCompleteWindowsNodeMxcFolderPolicy(candidate),
          stopCurrentGeneration: async () => {
            await stopGatewayForSecurityTransition(gatewayPort || DEFAULT_PORT);
          },
          persistPolicy: async (next, old) => {
            // The new native MXC generation owns its filesystem grants.
            persistWindowsNodeMxcFolderPolicy(next, old, null);
          },
          startLockedGeneration: async () => {
            const config = readConfig();
            if (!config || typeof config !== "object" || Array.isArray(config)) {
              throw new Error("OpenClaw configuration is unavailable");
            }
            const nodeId = bundledWindowsNodeHost.ensureIdentityNodeId();
            const locked = applyWindowsNodeMxcGatewayPolicy(
              config,
              nodeId,
              settingsStore.get("windowsNodeMxcToolBackups"),
              "locked",
            );
            settingsStore.set("windowsNodeMxcToolBackups", locked.backups);
            writeConfigTextAtomically(JSON.stringify(locked.config, null, 2));
            await startGatewayWithWindowsNodeMxcPolicy("locked");
            const generation = gatewayGenerationId;
            await waitForBundledWindowsNodeGeneration(generation);
            return waitForWindowsNodeMxcBaseReady(generation, "locked", false);
          },
          attestLockedGeneration: (status) =>
            assertWindowsNodeMxcBaseReady(status, "locked", false),
          smokeLockedGeneration: async (status) => {
            const smoke = await runCurrentWindowsNodeMxcSmoke(status);
            if (!isWindowsNodeMxcSmokePassed(smoke)) {
              throw new Error(
                `Locked-generation ${smoke.profile} failed: execution=${smoke.execution.reason}; outsideRoot=${smoke.deniedOutsideRoot?.reason ?? "not-required"}`,
              );
            }
          },
          startActiveGeneration: async () => {
            const config = readConfig();
            if (!config || typeof config !== "object" || Array.isArray(config)) {
              throw new Error("OpenClaw configuration is unavailable");
            }
            const nodeId = bundledWindowsNodeHost.ensureIdentityNodeId();
            const active = applyWindowsNodeMxcGatewayPolicy(
              config,
              nodeId,
              settingsStore.get("windowsNodeMxcToolBackups"),
              "active",
            );
            await stopGatewayForSecurityTransition(gatewayPort || DEFAULT_PORT);
            settingsStore.delete("windowsNodeMxcSmoke");
            settingsStore.set("windowsNodeMxcToolBackups", active.backups);
            writeConfigTextAtomically(JSON.stringify(active.config, null, 2));
            await startGatewayWithWindowsNodeMxcPolicy("active");
            const generation = gatewayGenerationId;
            await waitForBundledWindowsNodeGeneration(generation);
            return waitForWindowsNodeMxcBaseReady(generation, "active", false);
          },
          attestActiveGeneration: (status) =>
            assertWindowsNodeMxcBaseReady(status, "active", false),
          smokeActiveGeneration: async (status) => {
            const smoke = await runCurrentWindowsNodeMxcSmoke(status);
            if (!isWindowsNodeMxcSmokePassed(smoke)) {
              throw new Error(
                `Active-generation ${smoke.profile} failed: execution=${smoke.execution.reason}; outsideRoot=${smoke.deniedOutsideRoot?.reason ?? "not-required"}`,
              );
            }
          },
          mintActivationLease: async () => {
            await bundledWindowsNodeHost.setActivationLease("active", 120_000);
          },
          verifyActiveGeneration: async () => {
            const status = await getWindowsNodeMxcStatus();
            if (!status.effectiveEnabled) {
              throw new Error(
                `Final MXC activation verification failed: ${status.blockers.join("; ")}`,
              );
            }
            return status;
          },
          releaseIngress: (status) => {
            releaseWindowsNodeMxcIngress(status.gatewayGeneration);
            windowsNodeMxcActivationInProgress = false;
            sendToWindow(mainWindow, "gateway:ws-connected", gwClient?.mainSessionKey || null);
          },
          lockAfterFailure: async (error, context) => {
            const primaryErrorDetail = describeWindowsNodeMxcFolderTransactionError(error);
            setWindowsNodeMxcLifecycleState(
              "locked",
              `${context.failurePhase}: ${primaryErrorDetail}`,
            );
            closeWindowsNodeMxcIngress();
            windowsNodeMxcActivationInProgress = true;
            bundledWindowsNodeHost.revokeActivationLease();
            settingsStore.delete("windowsNodeMxcSmoke");
            const recoveryErrors: unknown[] = [];
            let generationStopped = false;
            try {
              await stopGatewayForSecurityTransition(gatewayPort || DEFAULT_PORT);
              generationStopped = true;
            } catch (recoveryError) {
              recoveryErrors.push(recoveryError);
            }
            if (context.persisted) {
              if (!context.applied) {
                recoveryErrors.push(
                  new Error("Persisted MXC folder policy is unavailable for exact rollback"),
                );
              } else {
                if (generationStopped) {
                  try {
                    persistWindowsNodeMxcFolderPolicy(
                      context.previous,
                      context.applied,
                      "Previous folder policy restored after activation failure",
                    );
                  } catch (recoveryError) {
                    recoveryErrors.push(recoveryError);
                  }
                } else {
                  recoveryErrors.push(
                    new Error(
                      "Folder policy rollback was blocked because the previous MXC process tree could not be proven stopped",
                    ),
                  );
                }
              }
            }
            try {
              settingsStore.set("windowsNodeMxcFolderPolicyRecovery", {
                previous: context.previous,
                draft: context.applied ?? context.draft,
                updatedAt: new Date().toISOString(),
                lastError: primaryErrorDetail,
                failurePhase: context.failurePhase,
              });
            } catch (recoveryError) {
              recoveryErrors.push(recoveryError);
            }
            let lockedConfigReady = false;
            try {
              const config = readConfig();
              if (!config || typeof config !== "object" || Array.isArray(config)) {
                throw new Error("OpenClaw configuration is unavailable for locked recovery");
              }
              const nodeId = bundledWindowsNodeHost.ensureIdentityNodeId();
              const locked = applyWindowsNodeMxcGatewayPolicy(
                config,
                nodeId,
                settingsStore.get("windowsNodeMxcToolBackups"),
                "locked",
              );
              settingsStore.set("windowsNodeMxcToolBackups", locked.backups);
              writeConfigTextAtomically(JSON.stringify(locked.config, null, 2));
              lockedConfigReady = true;
            } catch (recoveryError) {
              recoveryErrors.push(recoveryError);
            }
            if (generationStopped && lockedConfigReady) {
              try {
                await startGatewayWithWindowsNodeMxcPolicy("locked");
              } catch (startError) {
                recoveryErrors.push(startError);
                setGatewayStatus("failed");
              }
            }
            windowsNodeMxcActivationInProgress = false;
            if (recoveryErrors.length > 0) {
              const recoveryFailure = new AggregateError(
                [error, ...recoveryErrors],
                "MXC folder policy failed and locked recovery was incomplete",
              );
              const recoveryFailureDetail =
                describeWindowsNodeMxcFolderTransactionError(recoveryFailure);
              setWindowsNodeMxcLifecycleState(
                "locked",
                `${context.failurePhase}: ${recoveryFailureDetail}`,
              );
              try {
                settingsStore.set("windowsNodeMxcFolderPolicyRecovery", {
                  previous: context.previous,
                  draft: context.applied ?? context.draft,
                  updatedAt: new Date().toISOString(),
                  lastError: recoveryFailureDetail,
                  failurePhase: context.failurePhase,
                });
              } catch (persistError) {
                console.error(
                  "[windows-node-mxc] Could not persist complete folder recovery diagnostics:",
                  persistError,
                );
              }
              throw recoveryFailure;
            }
          },
        });
        const status = await getWindowsNodeMxcStatus();
        lifecycleOperation.succeed(status);
        return status;
      } catch (error) {
        console.error(
          `[windows-node-mxc] Folder policy apply failed during ${windowsNodeMxcLifecycleState}: ${describeWindowsNodeMxcFolderTransactionError(error)}`,
        );
        lifecycleOperation.fail(error);
        throw error;
      } finally {
        windowsNodeMxcActivationInProgress = false;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  requestExplicitQuit("single-instance-lock-denied");
} else {
  app.on("second-instance", () => {
    showOrRecoverMainWindow("second-instance");
    // Ensure gateway is alive when user re-opens the app
    ensureGatewayConnected().catch((err) =>
      console.error("[second-instance] gateway reconnect failed:", err),
    );
  });
}

app.whenReady().then(async () => {
  if (explicitQuitRequested) return;
  logStartupTiming("app-ready");
  if (!settingsStore.has("language")) {
    settingsStore.set("language", resolveSupportedLocale(app.getLocale()));
  }

  try {
    const home = app.getPath("home");
    const microclawRoot = path.join(home, ".microclaw");
    const expectedStateDir = path.join(home, ".openclaw");
    const installerOwnsUpgrade =
      typeof postInstallTransactionId === "string" &&
      validateInstallerOwnedUpgrade(microclawRoot, postInstallTransactionId, {
        expectedStateDir,
      });
    if (!installerOwnsUpgrade) {
      const recovery = recoverInterruptedOpenClawUpgrade(microclawRoot, {
        expectedStateDir,
      });
      if (recovery.status === "rolled-back") {
        console.log("[upgrade] Restored the previous OpenClaw package and state");
      }
    } else {
      console.log(`[upgrade] Installer owns verifying transaction ${postInstallTransactionId}`);
    }
  } catch (error) {
    signalPostInstallFailure(error);
    console.error("[upgrade] Startup recovery failed:", error);
    const inProgress = error instanceof UpgradeInProgressError;
    dialog.showErrorBox(
      inProgress ? "MicroClaw upgrade in progress" : "OpenClaw recovery failed",
      error instanceof Error ? error.message : String(error),
    );
    requestExplicitQuit("startup-recovery-failed");
    return;
  }

  registerIpcHandlers();

  // Sync auto-start with OS
  app.setLoginItemSettings({ openAtLogin: settingsStore.get("autoStart") });

  const initialWindow = createMainWindow();
  mainWindow = initialWindow;
  logStartupTiming("window-created");

  const trayCallbacks = {
    onShowWindow: () => {
      showOrRecoverMainWindow("tray");
      // Ensure gateway is alive when user shows window from tray
      ensureGatewayConnected().catch((err) =>
        console.error("[tray-show] gateway reconnect failed:", err),
      );
    },
    onRestartGateway: () => {
      restartManagedGateway("Restart requested from system tray").catch((error) =>
        console.error("[tray] Gateway restart failed:", error),
      );
    },
    onQuit: () => requestExplicitQuit("tray"),
  };
  createTray(trayCallbacks, resolveSupportedLocale(settingsStore.get("language") ?? "en-US"));

  // Skill integrity check — must run BEFORE loading renderer so
  // pendingIntegrityResult is ready when App.vue calls the IPC.
  if (migrateLegacySkillIntegritySnapshot()) {
    console.log("Migrated skill integrity snapshot to the current root-aware schema");
  }
  const integrityResult = verifySkillIntegrity();
  if (!integrityResult.snapshotExists) {
    console.log(
      "No skill integrity snapshot found — generating baseline (installer may not have run)...",
    );
    generateAndSignSnapshot();
  } else if (!integrityResult.valid) {
    console.log("Skill integrity check failed — changes detected");
    pendingIntegrityResult = integrityResult;
  }
  logStartupTiming("integrity-complete");

  // Gateway startup is independent of renderer loading. Starting it here lets
  // the local UI and background service initialize concurrently.
  logStartupTiming("gateway-requested");
  startApplicationServices().catch((err) => {
    signalPostInstallFailure(err);
    console.error("Failed to start application services:", err);
  });

  try {
    await loadMainWindowRenderer(initialWindow);
    logStartupTiming("renderer-loaded");
  } catch (error) {
    electronLifecycleDiagnostics.log("initial-renderer-load-failed", {
      error: summarizeLifecycleError(error),
    });
    scheduleMainWindowRecovery("initial-renderer-load-failed", initialWindow, true);
  }

  // Watch skill directories for mid-session changes
  if (!explicitQuitRequested) startSkillFileWatcher();
});

app.on("window-all-closed", () => {
  const state = lifecycleWindowState();
  const shouldQuit = shouldQuitAfterAllWindowsClosed(process.platform, state);
  electronLifecycleDiagnostics.log("window-all-closed", { shouldQuit });
  if (shouldQuit) {
    requestExplicitQuit("window-all-closed");
  } else {
    scheduleMainWindowRecovery("window-all-closed");
  }
});

app.on("before-quit", (event) => {
  if (applicationQuitReady) return;
  event.preventDefault();
  if (!explicitQuitRequested) explicitQuitRequested = true;
  if (applicationQuitPromise) return;
  const startedAt = Date.now();
  electronLifecycleDiagnostics.log("before-quit");
  closeWindowsNodeMxcIngress();
  bundledWindowsNodeHost.revokeActivationLease();
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  // Clean up skill file watchers
  for (const w of skillWatchers) {
    try {
      w.close();
    } catch {}
  }
  skillWatchers = [];
  if (watcherDebounceTimer) {
    clearTimeout(watcherDebounceTimer);
    watcherDebounceTimer = null;
  }
  destroyTray();
  githubCopilotAuthManager.stop();
  gwClient?.stop();
  stopBundledWindowsNodeHost();
  const gatewayShutdown = windowsNodeMxcSecurityTransitionInProgress
    ? stopGatewayForSecurityTransition(
        gatewayPort || DEFAULT_PORT,
        "Application quit during security transition",
      )
    : stopGatewayProcessGracefully("Application quit");
  applicationQuitPromise = gatewayShutdown
    .catch((error) => {
      electronLifecycleDiagnostics.log("application-gateway-stop-failed", {
        error: summarizeLifecycleError(error),
      });
    })
    .finally(() => {
      electronLifecycleDiagnostics.log("application-stop-complete", {
        elapsedMs: Date.now() - startedAt,
      });
      applicationQuitReady = true;
      app.quit();
    });
});

app.on("will-quit", () => {
  electronLifecycleDiagnostics.log("will-quit");
});

app.on("quit", (_event, exitCode) => {
  electronLifecycleDiagnostics.log("quit", { exitCode });
});

app.on("child-process-gone", (_event, details) => {
  electronLifecycleDiagnostics.log("child-process-gone", {
    processType: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName ?? null,
    name: details.name ?? null,
  });
});

app.on("activate", () => {
  showOrRecoverMainWindow("app-activate");
  ensureGatewayConnected().catch((err) =>
    console.error("[activate] gateway reconnect failed:", err),
  );
});
