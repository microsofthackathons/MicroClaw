import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  WINDOWS_NODE_MXC_REQUIRED_COMMANDS,
  WINDOWS_NODE_MXC_REQUIRED_CWD_COMMAND,
  type MxcProbeResult,
  type MxcSmokeResult,
  type WindowsNodeMxcFolder,
  type WindowsNodeMxcSettings,
  type WindowsNodeRecord,
  classifyMxcProbe,
  classifyMxcSmoke,
  describeMxcExactBackendEligibility,
  getWindowsNodeMxcGatewayPolicyState,
  getMxcTierWarning,
  listConfiguredSandboxFolders,
  normalizeWindowsNodeRecord,
  validateSelectedWindowsNode,
  validateWindowsNodeMxcSettings,
  type WindowsNodeMxcGatewayPolicyState,
} from "./windows-node-mxc";
import {
  selectWindowsNodeMxcAutomaticMode,
  type WindowsNodeMxcAmbientAccessAssessment,
  type WindowsNodeMxcEffectiveStrength,
  type WindowsNodeMxcModeAvailability,
  type WindowsNodeMxcRequestedMode,
} from "./windows-node-mxc-modes";
import type {
  BundledWindowsNodeActivationLease,
  BundledWindowsNodeHostStatus,
} from "./bundled-windows-node-host";
import {
  WINDOWS_NODE_MXC_READINESS_AGENT_ID,
  WINDOWS_NODE_MXC_READINESS_COMMAND,
  WINDOWS_NODE_MXC_READINESS_PROBES,
  createWindowsNodeMxcReadinessProofMinter,
  windowsNodeMxcReadinessSessionKey,
  type WindowsNodeMxcReadinessPlan,
  type WindowsNodeMxcReadinessProbeKind,
  type WindowsNodeMxcReadinessProofContext,
} from "./windows-node-mxc-readiness-proof";

const WINDOWS_NODE_SETTINGS_FILENAME = "settings.json";
const EXECUTION_MARKER = "MICROCLAW_MXC_EXECUTION_OK";
const ATTENDED_SMOKE_GATEWAY_TIMEOUT_MS = 90_000;
const ATTENDED_SMOKE_CLIENT_TIMEOUT_MS = 95_000;
const READINESS_PREPARE_GATEWAY_TIMEOUT_MS = 90_000;
const READINESS_PREPARE_CLIENT_TIMEOUT_MS = 95_000;

export interface WindowsNodeMxcGateway {
  connected: boolean;
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

export function isCurrentBundledWindowsNodeApprovalCallback(state: {
  expectedHostGeneration: number;
  currentHostGeneration: number;
  gatewayConnected: boolean;
  gatewayMatches: boolean;
  gatewayProcessMatches: boolean;
  expectedGatewayGeneration: string;
  currentGatewayGeneration: string;
}): boolean {
  return (
    state.expectedHostGeneration === state.currentHostGeneration &&
    state.gatewayConnected &&
    state.gatewayMatches &&
    state.gatewayProcessMatches &&
    state.expectedGatewayGeneration === state.currentGatewayGeneration
  );
}

export interface StoredWindowsNodeMxcSmoke {
  profile: "full-smoke" | "limited-minimal-smoke";
  gatewayGeneration: string;
  nodeId: string;
  settingsFingerprint: string;
  probeTier: string;
  containmentStrength: Exclude<WindowsNodeMxcEffectiveStrength, "off">;
  ambientAccessHash: string | null;
  checkedAt: string;
  execution: MxcSmokeResult;
  deniedOutsideRoot: MxcSmokeResult | null;
}

export interface WindowsNodeMxcReadinessAuthorization {
  transitionId: string;
  proofContext: WindowsNodeMxcReadinessProofContext;
}

export interface WindowsNodeMxcRuntimeStatus {
  requestedMode: WindowsNodeMxcRequestedMode;
  effectiveStrength: WindowsNodeMxcEffectiveStrength;
  effectiveTier: string | null;
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
  folders: WindowsNodeMxcFolder[];
  nodes: WindowsNodeRecord[];
  selectedNode: WindowsNodeRecord | null;
  helperRevision?: string;
  mxcRuntimeVersion?: string;
  cwdPolicyContract?: string;
  cwdAttestationReady: boolean;
  activationLeaseContract?: string;
  gatewayGeneration: string;
  activationLeaseMode: "diagnostic" | "active" | null;
  activationLeaseExpiresAt: string | null;
  gatewayPolicyState: WindowsNodeMxcGatewayPolicyState;
  gatewayPolicyReady: boolean;
  durableApprovalsPresent: boolean | null;
  probe: MxcProbeResult | null;
  fullAvailability: WindowsNodeMxcModeAvailability | null;
  limitedAvailability: WindowsNodeMxcModeAvailability | null;
  ambientAccess: WindowsNodeMxcAmbientAccessAssessment | null;
  smoke: StoredWindowsNodeMxcSmoke | null;
  blockers: string[];
  warnings: string[];
  remediation: string[];
}

export interface InspectWindowsNodeMxcOptions {
  requestedMode: WindowsNodeMxcRequestedMode;
  desiredEnabled: boolean;
  selectedNodeId: string;
  config: unknown;
  gateway: WindowsNodeMxcGateway | null;
  managedGateway: boolean;
  gatewayGeneration: string;
  storedSmoke?: StoredWindowsNodeMxcSmoke | null;
  appData?: string;
  localAppData?: string;
  userProfile?: string;
  environment?: NodeJS.ProcessEnv;
  bundledHost?: BundledWindowsNodeHostStatus;
  bundledFolders?: WindowsNodeMxcFolder[];
  runtimeIntegrityError?: string;
  ambientAccess?: WindowsNodeMxcAmbientAccessAssessment | null;
}

export function resolveWindowsNodeSettingsPath(
  environment: NodeJS.ProcessEnv = process.env,
  appData = environment.APPDATA ?? "",
): string {
  const override = environment.OPENCLAW_TRAY_DATA_DIR?.trim();
  return path.join(override || path.join(appData, "OpenClawTray"), WINDOWS_NODE_SETTINGS_FILENAME);
}

export function resolveWindowsCompanionPath(localAppData = process.env.LOCALAPPDATA ?? ""): string {
  return path.join(localAppData, "OpenClawTray", "OpenClaw.Tray.WinUI.exe");
}

export function resolveWxcExecPath(
  environment: NodeJS.ProcessEnv = process.env,
  localAppData = environment.LOCALAPPDATA ?? "",
): string {
  const override = environment.OPENCLAW_WXC_EXEC?.trim();
  if (override) return override;
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  return path.join(localAppData, "OpenClawTray", "tools", "mxc", architecture, "wxc-exec.exe");
}

export async function inspectWindowsNodeMxc(
  options: InspectWindowsNodeMxcOptions,
): Promise<WindowsNodeMxcRuntimeStatus> {
  return inspectWindowsNodeMxcState(options, "readiness");
}

export type WindowsNodeMxcHeartbeatStatus = Pick<
  WindowsNodeMxcRuntimeStatus,
  "effectiveEnabled" | "gatewayPolicyState" | "blockers"
>;

export async function inspectWindowsNodeMxcHeartbeat(
  options: InspectWindowsNodeMxcOptions,
): Promise<WindowsNodeMxcHeartbeatStatus> {
  const { effectiveEnabled, gatewayPolicyState, blockers } = await inspectWindowsNodeMxcState(
    options,
    "heartbeat",
  );
  return { effectiveEnabled, gatewayPolicyState, blockers };
}

async function inspectWindowsNodeMxcState(
  options: InspectWindowsNodeMxcOptions,
  inspection: "readiness" | "heartbeat",
): Promise<WindowsNodeMxcRuntimeStatus> {
  if (options.requestedMode === "limited-dacl") {
    throw new Error("The retired DACL selection must be migrated to Full before use");
  }
  const environment = options.environment ?? process.env;
  const appData = options.appData ?? environment.APPDATA ?? "";
  const localAppData = options.localAppData ?? environment.LOCALAPPDATA ?? "";
  const userProfile = options.userProfile ?? environment.USERPROFILE ?? os.homedir();
  const selectedNodeId = options.selectedNodeId.trim();
  const desiredEnabled = options.requestedMode !== "off";
  const bundled = options.bundledHost;
  const settingsPath = bundled
    ? "MicroClaw-managed policy"
    : resolveWindowsNodeSettingsPath(environment, appData);
  const companionPath = bundled ? bundled.hostPath : resolveWindowsCompanionPath(localAppData);
  const wxcExecPath = bundled
    ? bundled.sdkProbePath
    : resolveWxcExecPath(environment, localAppData);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const remediation: string[] = [];
  const heartbeat = inspection === "heartbeat";
  const heartbeatRuntimeReady =
    desiredEnabled &&
    bundled?.processRunning === true &&
    bundled.processId !== null &&
    bundled.processId > 0 &&
    bundled.nodeId === selectedNodeId &&
    bundled.gatewayGeneration === options.gatewayGeneration &&
    bundled.requestedStrength === "full" &&
    bundled.effectiveTier === "base-container";
  if (heartbeat && !heartbeatRuntimeReady) {
    blockers.push("MXC heartbeat requires the current running Full BaseContainer node");
  }
  if (heartbeat && options.runtimeIntegrityError) {
    blockers.push(options.runtimeIntegrityError);
  }

  const settings = bundled
    ? ({
        EnableNodeMode: true,
        NodeSystemRunEnabled: true,
        NodeCanvasEnabled: false,
        NodeScreenEnabled: false,
        NodeCameraEnabled: false,
        NodeLocationEnabled: false,
        NodeBrowserProxyEnabled: false,
        NodeSttEnabled: false,
        NodeTtsEnabled: false,
        EnableMcpServer: false,
        SystemRunSandboxEnabled: true,
        SystemRunBlockHostFallbackWhenMxcUnavailable: true,
        SystemRunAllowWindowsUi: true,
        SystemRunAllowOutbound: true,
        SandboxClipboard: 0,
      } satisfies WindowsNodeMxcSettings)
    : await readWindowsNodeSettings(settingsPath);
  const settingsCheck = validateWindowsNodeMxcSettings(settings);
  blockers.push(...settingsCheck.blockers);
  warnings.push(...settingsCheck.warnings);
  if (!settings) {
    remediation.push(
      `Install and launch OpenClaw Windows Companion, then configure its Sandbox page. Expected settings: ${settingsPath}`,
    );
  } else if (!settingsCheck.ready) {
    remediation.push(
      "In Windows Companion, enable node mode and system commands, MXC with strict host-fallback blocking, Windows UI APIs, and outbound networking; set sandbox clipboard to None.",
    );
  }

  const settingsFingerprint = settings
    ? fingerprintSecuritySettings(settings, Boolean(bundled))
    : null;
  const folders = bundled
    ? (options.bundledFolders ?? [])
    : settings
      ? listConfiguredSandboxFolders(settings, userProfile)
      : [];
  const companionInstalled = bundled ? fs.existsSync(companionPath) : fs.existsSync(companionPath);
  if (!companionInstalled) {
    blockers.push(
      bundled
        ? "Bundled MicroClaw Windows node host is missing"
        : "OpenClaw Windows Companion is not installed at the supported per-user path",
    );
    remediation.push(
      bundled
        ? "Repair or reinstall MicroClaw's bundled Windows node resources."
        : `Install the pinned Windows Companion build at ${companionPath}`,
    );
  }

  const probe = heartbeat
    ? null
    : options.runtimeIntegrityError
      ? classifyMxcProbe(null, "", "", options.runtimeIntegrityError)
      : await runMxcProbe(wxcExecPath);
  const observedTier = heartbeat ? (bundled?.effectiveTier ?? null) : (probe?.tier ?? null);
  const backendEligibility = probe ? describeMxcExactBackendEligibility(probe) : null;
  const fullAvailability: WindowsNodeMxcModeAvailability | null = backendEligibility
    ? {
        available: backendEligibility.eligible,
        summary: backendEligibility.summary,
        blockers: backendEligibility.blockers,
        remediation: backendEligibility.remediation,
      }
    : null;
  const selectedAvailability = fullAvailability;
  if (!heartbeat && desiredEnabled && !selectedAvailability) {
    blockers.push("MXC backend availability has not been verified");
  } else if (desiredEnabled && selectedAvailability && !selectedAvailability.available) {
    blockers.push(...selectedAvailability.blockers);
    remediation.push(...selectedAvailability.remediation);
  }
  const tierWarning = options.requestedMode === "full" && probe ? getMxcTierWarning(probe) : null;
  if (tierWarning) warnings.push(tierWarning);
  if (probe) warnings.push(...probe.warnings);
  if (bundled && desiredEnabled) {
    const expectedStrength = "full";
    if (bundled.requestedStrength !== null && bundled.requestedStrength !== expectedStrength) {
      blockers.push(
        `Bundled node containment strength drifted from ${expectedStrength} to ${bundled.requestedStrength}`,
      );
    }
    if (
      bundled.effectiveTier !== null &&
      probe?.tier != null &&
      bundled.effectiveTier.toLowerCase() !== probe.tier.toLowerCase()
    ) {
      blockers.push(`Bundled node MXC tier drifted from ${bundled.effectiveTier} to ${probe.tier}`);
    }
  }
  if (
    bundled &&
    !bundled.processRunning &&
    (heartbeat || selectedAvailability?.available) &&
    desiredEnabled
  ) {
    blockers.push(bundled.lastError ?? "Bundled MicroClaw Windows node host is not running");
    remediation.push("Restart MicroClaw so it can start its app-owned Windows node host.");
  }

  const gatewayPolicyState = getWindowsNodeMxcGatewayPolicyState(options.config, selectedNodeId);
  const gatewayPolicyReady = gatewayPolicyState !== "drift";
  if (gatewayPolicyState === "drift") {
    blockers.push("Gateway node-exec routing no longer matches the app-owned Windows node");
  } else if (gatewayPolicyState === "locked") {
    blockers.push("Gateway agent execution remains diagnostic-only and locked");
  }

  let nodes: WindowsNodeRecord[] = [];
  let selectedNode: WindowsNodeRecord | null = null;
  let durableApprovalsPresent: boolean | null = null;
  let cwdAttestationReady = false;
  if (!selectedNodeId) {
    blockers.push(
      bundled
        ? "The app-owned Windows node identity is unavailable"
        : "Select one paired local Windows node by stable node ID",
    );
  }
  if (desiredEnabled && !options.managedGateway) {
    blockers.push("Windows Node + MXC mode requires a freshly started MicroClaw managed Gateway");
  }
  if (desiredEnabled && !options.gateway?.connected) {
    blockers.push("MicroClaw managed Gateway is not connected");
  } else if (desiredEnabled && options.gateway?.connected) {
    try {
      const payload = await options.gateway.request<unknown>("node.list", {});
      nodes = extractNodeRecords(payload);
      if (bundled?.nodeId) {
        nodes = nodes.map((node) =>
          node.id === bundled.nodeId ? { ...node, displayName: bundled.displayName } : node,
        );
      }
      selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
      blockers.push(...validateSelectedWindowsNode(selectedNode, bundled?.nodeId ?? "").blockers);
      if (bundled && selectedNode?.connected) {
        try {
          const attestation = await options.gateway.request("node.invoke", {
            nodeId: selectedNodeId,
            command: WINDOWS_NODE_MXC_REQUIRED_CWD_COMMAND,
            params: {},
            timeoutMs: 30_000,
            idempotencyKey: randomUUID(),
          });
          const attestationCheck = validateBundledCwdAttestation(
            attestation,
            options.requestedMode,
          );
          cwdAttestationReady = attestationCheck.ready;
          durableApprovalsPresent = attestationCheck.durableApprovalsPresent;
          if (!attestationCheck.ready) blockers.push(...attestationCheck.blockers);
        } catch (error) {
          blockers.push(`Bundled node CWD attestation failed: ${messageOf(error)}`);
        }
      }
    } catch (error) {
      blockers.push(`Could not list Gateway nodes: ${messageOf(error)}`);
    }

    if (selectedNodeId && !bundled) {
      try {
        const approvals = await options.gateway.request("exec.approvals.node.get", {
          nodeId: selectedNodeId,
        });
        durableApprovalsPresent = hasDurableApprovals(approvals);
      } catch (error) {
        blockers.push(`Could not verify selected-node durable approvals: ${messageOf(error)}`);
      }
      if (durableApprovalsPresent) {
        blockers.push(
          "Selected node has durable exec approvals, which the pinned Windows Node does not bind to cwd",
        );
      }
    }
  }

  if (
    selectedNode &&
    selectedNode.commands.includes(WINDOWS_NODE_MXC_REQUIRED_CWD_COMMAND) === false
  ) {
    remediation.push(
      "Upstream Windows Node must canonicalize cwd through reparse points, restrict it to configured folder grants, bind canonical cwd into durable approval identity, and revalidate immediately before launch.",
    );
  }

  const smoke = selectCurrentWindowsNodeMxcSmoke(
    options.storedSmoke,
    options.gatewayGeneration,
    selectedNodeId,
    settingsFingerprint,
    observedTier,
    "full",
    null,
  );
  if (!smoke || !isWindowsNodeMxcSmokePassed(smoke)) {
    blockers.push(
      "Current Full contained execution and outside-root denial smoke proofs are required",
    );
    remediation.push(
      bundled
        ? "Retry automatic readiness. MicroClaw authorizes only its fixed internal probes; normal commands still require approval."
        : "Run the contained child-process check from MicroClaw Security settings and approve each command once in Windows Companion.",
    );
  } else if (bundled && gatewayPolicyState === "locked") {
    remediation.push("Activate the verified MXC route from MicroClaw Security settings.");
  }

  const activationLease = bundled?.activationLease ?? null;
  if (gatewayPolicyState === "active") {
    if (
      !isCurrentBundledActivationLease(
        activationLease,
        "active",
        options.gatewayGeneration,
        bundled?.policyFingerprint ?? null,
      )
    ) {
      blockers.push(
        "The bundled node does not hold an active generation- and policy-bound activation lease",
      );
    }
  } else if (activationLease?.mode === "active") {
    blockers.push("The bundled node retained an active lease while the Gateway policy is locked");
  }

  const effectiveEnabled =
    desiredEnabled && gatewayPolicyState === "active" && blockers.length === 0;
  const containmentAttested =
    desiredEnabled && (heartbeat ? heartbeatRuntimeReady : fullAvailability?.available === true);

  return {
    requestedMode: options.requestedMode,
    effectiveStrength: containmentAttested ? "full" : "off",
    effectiveTier: containmentAttested ? observedTier : null,
    desiredEnabled,
    effectiveEnabled,
    selectedNodeId,
    settingsPath,
    companionPath,
    companionInstalled,
    settingsLoaded: settings !== null,
    settingsFingerprint,
    strictFallbackEffective:
      settings?.SystemRunSandboxEnabled === true &&
      settings.SystemRunBlockHostFallbackWhenMxcUnavailable === true,
    allowWindowsUiEffective: settings?.SystemRunAllowWindowsUi === true,
    folders,
    nodes,
    selectedNode,
    helperRevision: bundled?.helperRevision,
    mxcRuntimeVersion: bundled?.runtimeVersion,
    cwdPolicyContract: bundled?.cwdPolicyContract,
    cwdAttestationReady,
    activationLeaseContract: bundled ? "microclaw.windows-activation.v1" : undefined,
    gatewayGeneration: options.gatewayGeneration,
    activationLeaseMode: activationLease?.mode ?? null,
    activationLeaseExpiresAt: activationLease
      ? new Date(activationLease.expiresAtUnixMs).toISOString()
      : null,
    gatewayPolicyState,
    gatewayPolicyReady,
    durableApprovalsPresent,
    probe,
    fullAvailability,
    limitedAvailability: null,
    ambientAccess: null,
    smoke,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    remediation: [...new Set(remediation)],
  };
}

export function shouldStopManagedGatewayForWindowsNodeMxc(
  status: Pick<WindowsNodeMxcRuntimeStatus, "effectiveEnabled" | "gatewayPolicyState">,
): boolean {
  if (status.gatewayPolicyState === "drift") return true;
  return status.gatewayPolicyState === "active" && !status.effectiveEnabled;
}

export function isCurrentWindowsNodeMxcSmoke(value: unknown): value is StoredWindowsNodeMxcSmoke {
  if (!isRecord(value)) return false;
  return (
    value.profile === "full-smoke" &&
    typeof value.gatewayGeneration === "string" &&
    typeof value.nodeId === "string" &&
    typeof value.settingsFingerprint === "string" &&
    typeof value.probeTier === "string" &&
    value.containmentStrength === "full" &&
    value.ambientAccessHash === null &&
    typeof value.checkedAt === "string" &&
    isMxcSmokeResult(value.execution) &&
    (value.deniedOutsideRoot === null || isMxcSmokeResult(value.deniedOutsideRoot))
  );
}

export function isWindowsNodeMxcSmokePassed(smoke: StoredWindowsNodeMxcSmoke): boolean {
  if (smoke.execution.outcome !== "passed") return false;
  return (
    smoke.profile === "full-smoke" &&
    smoke.containmentStrength === "full" &&
    smoke.ambientAccessHash === null &&
    smoke.deniedOutsideRoot?.outcome === "passed"
  );
}

export function selectCurrentWindowsNodeMxcSmoke(
  value: unknown,
  gatewayGeneration: string,
  nodeId: string,
  settingsFingerprint: string | null,
  probeTier: string | null | undefined,
  containmentStrength: Exclude<WindowsNodeMxcEffectiveStrength, "off"> = "full",
  ambientAccessHash: string | null = null,
): StoredWindowsNodeMxcSmoke | null {
  return isCurrentWindowsNodeMxcSmoke(value) &&
    value.gatewayGeneration === gatewayGeneration &&
    value.nodeId === nodeId &&
    value.settingsFingerprint === settingsFingerprint &&
    value.probeTier === probeTier &&
    value.containmentStrength === containmentStrength &&
    value.profile === "full-smoke" &&
    value.ambientAccessHash === ambientAccessHash
    ? value
    : null;
}

export function isCurrentBundledActivationLease(
  lease: BundledWindowsNodeActivationLease | null,
  mode: BundledWindowsNodeActivationLease["mode"],
  gatewayGeneration: string,
  policyFingerprint: string | null,
): boolean {
  return (
    lease !== null &&
    lease.mode === mode &&
    lease.gatewayGeneration === gatewayGeneration &&
    lease.policyFingerprint === policyFingerprint &&
    lease.expiresAtUnixMs > Date.now()
  );
}

export function validateBundledCwdAttestation(
  value: unknown,
  requestedMode: WindowsNodeMxcRequestedMode = "full",
): {
  ready: boolean;
  blockers: string[];
  durableApprovalsPresent: boolean | null;
} {
  if (requestedMode !== "full") {
    return {
      ready: false,
      blockers: ["Full MXC containment is required for this attestation"],
      durableApprovalsPresent: null,
    };
  }
  const record = findAttestationRecord(value);
  const expected = {
    contract: "microclaw.windows-cwd.v1",
    approvedRootOnly: true,
    canonicalFinalPath: true,
    rejectsReparseComponents: true,
    durableApprovalBindsCwd: false,
    durableApprovalBindsDeclaredAccess: false,
    launchTimeRevalidation: true,
    omittedCwdUsesIsolatedScratch: true,
    hostFallbackAbsent: true,
    activationLeaseContract: "microclaw.windows-activation.v1",
    generationBoundActivation: true,
    policyBoundActivation: true,
    launchTimeLeaseRevalidation: true,
    approvalProofContract: "microclaw.windows-node-approval.v2",
    activeRunsRequireApprovalProof: true,
    approvalProofOneUse: true,
    approvalProofBindsPreparedPlan: true,
    approvalProofPlanContract: "microclaw.windows-node-approval-plan.v2",
    approvalProofBindsExecutableContent: true,
    approvalProofBindsActivation: true,
    launchTimeApprovalProofRevalidation: true,
    durableApprovalStoreProtected: true,
    readinessProofContract: "microclaw.windows-node-readiness.v1",
    readinessProofBindsTransition: true,
    readinessProofBindsPreparedPlan: true,
    readinessProofExactBuiltInsOnly: true,
    readinessProofOneUse: true,
    launchTimeReadinessProofRevalidation: true,
    exactFilesystemIsolationRequired: true,
    degradedIsolationTierRejected: true,
    requestedContainmentStrength: "full",
    folderPolicyIsExclusiveBoundary: true,
    durableApprovalsAllowed: true,
    ambientAssessmentBound: false,
    outboundNetworkEnabled: true,
  };
  const blockers = Object.entries(expected)
    .filter(([key, expectedValue]) => record?.[key] !== expectedValue)
    .map(([key]) => `Bundled node CWD attestation is missing or invalid: ${key}`);
  const durableApprovalsPresent =
    typeof record?.durableApprovalsPresent === "boolean" ? record.durableApprovalsPresent : null;
  if (durableApprovalsPresent === null) {
    blockers.push("Bundled node CWD attestation is missing or invalid: durableApprovalsPresent");
  }
  return { ready: blockers.length === 0, blockers, durableApprovalsPresent };
}

function findAttestationRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.contract === "microclaw.windows-cwd.v1") return record;
  for (const key of ["payload", "result", "data"]) {
    const nested = findAttestationRecord(record[key]);
    if (nested) return nested;
  }
  return null;
}

export async function runWindowsNodeMxcSmoke(
  gateway: WindowsNodeMxcGateway,
  gatewayGeneration: string,
  nodeId: string,
  settingsFingerprint: string,
  probe: MxcProbeResult,
  authorization: WindowsNodeMxcReadinessAuthorization,
  containmentStrength: Exclude<WindowsNodeMxcEffectiveStrength, "off"> = "full",
  ambientAccessHash: string | null = null,
  dependencies: {
    now?: () => number;
    log?: (message: string) => void;
  } = {},
): Promise<StoredWindowsNodeMxcSmoke> {
  if (!gateway.connected) throw new Error("MicroClaw managed Gateway is not connected");
  if (!nodeId.trim()) throw new Error("A stable Windows node ID is required");
  if (!settingsFingerprint) throw new Error("Strict Windows Companion settings are not loaded");
  if (containmentStrength !== "full" || ambientAccessHash !== null) {
    throw new Error("Readiness proofs support Full BaseContainer only");
  }
  if (!describeMxcExactBackendEligibility(probe).eligible || !probe.tier) {
    throw new Error(
      probe.reason ?? "Exact filesystem isolation requires the MXC BaseContainer tier",
    );
  }
  if (
    authorization.transitionId !== authorization.proofContext.readinessTransitionId ||
    gatewayGeneration !== authorization.proofContext.gatewayGeneration ||
    nodeId.toLowerCase() !== authorization.proofContext.nodeId.toLowerCase()
  ) {
    throw new Error("Internal readiness authorization does not match this lifecycle generation");
  }
  const minter = createWindowsNodeMxcReadinessProofMinter(authorization.proofContext, {
    now: dependencies.now,
  });
  const profile = "full-smoke";
  const log = dependencies.log ?? console.info;
  const deniedOutsideRoot = await invokeDeniedCwdSmoke(gateway, nodeId, log);
  const execution = await invokeInternalReadinessProbe(
    gateway,
    nodeId,
    "execution",
    EXECUTION_MARKER,
    authorization.transitionId,
    minter,
    profile,
    dependencies.now ?? Date.now,
    log,
  );
  return {
    profile,
    gatewayGeneration,
    nodeId: nodeId.trim(),
    settingsFingerprint,
    probeTier: probe.tier,
    containmentStrength,
    ambientAccessHash,
    checkedAt: new Date().toISOString(),
    execution,
    deniedOutsideRoot,
  };
}

async function invokeDeniedCwdSmoke(
  gateway: WindowsNodeMxcGateway,
  nodeId: string,
  log: (message: string) => void,
): Promise<MxcSmokeResult> {
  try {
    const result = await gateway.request("node.invoke", {
      nodeId,
      command: "system.run",
      params: {
        command: ["C:\\Windows\\System32\\hostname.exe"],
        cwd: "C:\\Windows",
        timeoutMs: 15_000,
      },
      timeoutMs: 20_000,
      idempotencyKey: randomUUID(),
    });
    const outcome = classifyDeniedCwdSmokeResponse(result, nodeId);
    log(
      `[windows-node-mxc] protected-cwd-proof outcome=${outcome.outcome} ${describeDeniedCwdSmokeResponse(result, nodeId)}`,
    );
    return outcome;
  } catch (error) {
    return classifyDeniedCwdSmoke(messageOf(error));
  }
}

function describeDeniedCwdSmokeResponse(value: unknown, nodeId: string): string {
  const response = isRecord(value) ? value : null;
  const payload = isRecord(response?.payload) ? response.payload : null;
  return JSON.stringify({
    ok: response?.ok === true,
    commandMatches: response?.command === "system.run",
    nodeMatches:
      typeof response?.nodeId === "string" &&
      response.nodeId.toLowerCase() === nodeId.toLowerCase(),
    rejectedBeforeExecution: payload?.executionState === "rejectedBeforeExecution",
    cwdErrorCode:
      payload?.errorCode === "cwd-outside-approved-roots" ? payload.errorCode : "other-or-missing",
    exitCode:
      payload?.exitCode === undefined
        ? "missing"
        : payload.exitCode === null || typeof payload.exitCode === "number"
          ? payload.exitCode
          : "invalid",
    successFalse: payload?.success === false,
    timedOutFalse: payload?.timedOut === false,
  });
}

function classifyDeniedCwdSmokeResponse(value: unknown, nodeId: string): MxcSmokeResult {
  const failed: MxcSmokeResult = {
    outcome: "failed",
    reason: `The bundled node did not return a valid protected-CWD rejection before execution: ${describeDeniedCwdSmokeResponse(value, nodeId)}`,
  };
  if (
    !isRecord(value) ||
    value.ok !== true ||
    value.command !== "system.run" ||
    typeof value.nodeId !== "string" ||
    value.nodeId.toLowerCase() !== nodeId.toLowerCase() ||
    value.error != null ||
    !isRecord(value.payload)
  ) {
    return failed;
  }
  const payload = value.payload;
  if (
    payload.success !== false ||
    payload.executionState !== "rejectedBeforeExecution" ||
    payload.exitCode != null ||
    payload.timedOut !== false ||
    (payload.stdout !== undefined && payload.stdout !== "") ||
    typeof payload.error !== "string" ||
    !payload.error.trim() ||
    payload.errorCode !== "cwd-outside-approved-roots" ||
    !payload.error.startsWith(`${payload.errorCode}:`)
  ) {
    return failed;
  }
  if (value.payloadJSON != null) {
    try {
      if (
        typeof value.payloadJSON !== "string" ||
        !isDeepStrictEqual(JSON.parse(value.payloadJSON), payload)
      ) {
        return failed;
      }
    } catch {
      return failed;
    }
  }
  return {
    outcome: "passed",
    reason: "The bundled node denied a protected CWD outside approved roots",
  };
}

export function classifyDeniedCwdSmoke(message: string): MxcSmokeResult {
  const normalized = message.toLowerCase();
  if (normalized.includes("cwd-outside-approved-root")) {
    return {
      outcome: "passed",
      reason: "The bundled node denied a protected CWD outside approved roots",
    };
  }
  return {
    outcome: "failed",
    reason: `Unapproved-CWD proof failed with an unexpected result: ${message}`,
  };
}

async function invokeInternalReadinessProbe(
  gateway: WindowsNodeMxcGateway,
  nodeId: string,
  probeKind: WindowsNodeMxcReadinessProbeKind,
  marker: string,
  transitionId: string,
  minter: ReturnType<typeof createWindowsNodeMxcReadinessProofMinter>,
  profile: StoredWindowsNodeMxcSmoke["profile"],
  now: () => number,
  log: (message: string) => void,
): Promise<MxcSmokeResult> {
  const command = [...WINDOWS_NODE_MXC_READINESS_PROBES[probeKind]];
  const sessionKey = windowsNodeMxcReadinessSessionKey(transitionId);
  try {
    const prepared = await gateway.request(
      "node.invoke",
      {
        nodeId,
        command: "system.run.prepare",
        params: {
          command,
          timeoutMs: 15_000,
          agentId: WINDOWS_NODE_MXC_READINESS_AGENT_ID,
          sessionKey,
        },
        timeoutMs: READINESS_PREPARE_GATEWAY_TIMEOUT_MS,
        idempotencyKey: randomUUID(),
      },
      READINESS_PREPARE_CLIENT_TIMEOUT_MS,
    );
    const plan = findReadinessPlan(prepared);
    if (!plan) {
      throw new Error(`The bundled node did not return an exact ${probeKind} readiness plan`);
    }
    const proof = minter.mint({ transitionId, nodeId, probeKind, plan });
    const dispatchAtUnixMs = Math.floor(now());
    log(
      `[windows-node-mxc] ${profile} dispatch kind=${probeKind} transition=${transitionId} generation=${proof.gatewayGeneration} proofIssueToDispatchMs=${Math.max(0, dispatchAtUnixMs - proof.issuedAtUnixMs)}`,
    );
    const result = await gateway.request(
      "node.invoke",
      {
        nodeId,
        command: WINDOWS_NODE_MXC_READINESS_COMMAND,
        params: {
          command,
          cwd: null,
          rawCommand: plan.commandText,
          timeoutMs: 15_000,
          agentId: WINDOWS_NODE_MXC_READINESS_AGENT_ID,
          sessionKey,
          systemRunPlan: plan,
          probeKind,
          microclawReadinessProof: proof,
        },
        timeoutMs: ATTENDED_SMOKE_GATEWAY_TIMEOUT_MS,
        idempotencyKey: randomUUID(),
      },
      ATTENDED_SMOKE_CLIENT_TIMEOUT_MS,
    );
    return classifyMxcSmoke(result, marker);
  } catch (error) {
    return classifyMxcSmoke({ error: messageOf(error) }, marker);
  }

  function findReadinessPlan(value: unknown): WindowsNodeMxcReadinessPlan | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      Array.isArray(record.argv) &&
      record.argv.every((entry) => typeof entry === "string") &&
      (record.cwd === undefined || record.cwd === null || typeof record.cwd === "string") &&
      typeof record.commandText === "string" &&
      (record.commandPreview === undefined ||
        record.commandPreview === null ||
        typeof record.commandPreview === "string") &&
      (record.agentId === null || typeof record.agentId === "string") &&
      typeof record.sessionKey === "string" &&
      typeof record.executablePath === "string" &&
      typeof record.executableSha256 === "string" &&
      typeof record.cwdBinding === "string" &&
      Array.isArray(record.declaredAccess)
    ) {
      return {
        ...record,
        cwd: record.cwd ?? null,
        commandPreview: record.commandPreview ?? null,
      } as unknown as WindowsNodeMxcReadinessPlan;
    }
    for (const key of ["plan", "payload", "result", "data"]) {
      const nested = findReadinessPlan(record[key]);
      if (nested) return nested;
    }
    return null;
  }
}

async function readWindowsNodeSettings(
  settingsPath: string,
): Promise<WindowsNodeMxcSettings | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const contents = await fs.promises.readFile(settingsPath, "utf-8");
      const parsed = JSON.parse(contents);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as WindowsNodeMxcSettings;
      }
    } catch {
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return null;
}

export function fingerprintSecuritySettings(
  settings: WindowsNodeMxcSettings,
  liveFolderPolicy = false,
): string {
  const relevant = {
    EnableNodeMode: settings.EnableNodeMode,
    NodeSystemRunEnabled: settings.NodeSystemRunEnabled,
    NodeCanvasEnabled: settings.NodeCanvasEnabled,
    NodeScreenEnabled: settings.NodeScreenEnabled,
    NodeCameraEnabled: settings.NodeCameraEnabled,
    NodeLocationEnabled: settings.NodeLocationEnabled,
    NodeBrowserProxyEnabled: settings.NodeBrowserProxyEnabled,
    NodeSttEnabled: settings.NodeSttEnabled,
    NodeTtsEnabled: settings.NodeTtsEnabled,
    EnableMcpServer: settings.EnableMcpServer,
    SystemRunSandboxEnabled: settings.SystemRunSandboxEnabled,
    SystemRunBlockHostFallbackWhenMxcUnavailable:
      settings.SystemRunBlockHostFallbackWhenMxcUnavailable,
    SystemRunAllowOutbound: settings.SystemRunAllowOutbound,
    SystemRunAllowWindowsUi: settings.SystemRunAllowWindowsUi,
    SandboxClipboard: settings.SandboxClipboard,
    SandboxDocumentsAccess: settings.SandboxDocumentsAccess,
    SandboxDownloadsAccess: settings.SandboxDownloadsAccess,
    SandboxDesktopAccess: settings.SandboxDesktopAccess,
    // Signed folder revisions are acknowledged separately; activation probes bind the runtime.
    SandboxCustomFolders: liveFolderPolicy ? undefined : settings.SandboxCustomFolders,
    liveFolderPolicyContract: liveFolderPolicy
      ? "microclaw.windows-node-live-policy.v1"
      : undefined,
  };
  return createHash("sha256").update(JSON.stringify(relevant)).digest("hex");
}

function extractNodeRecords(payload: unknown): WindowsNodeRecord[] {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const values = Array.isArray(payload)
    ? payload
    : Array.isArray(record.nodes)
      ? record.nodes
      : Array.isArray(record.paired)
        ? record.paired
        : [];
  return values
    .map(normalizeWindowsNodeRecord)
    .filter((entry): entry is WindowsNodeRecord => entry !== null);
}

function hasDurableApprovals(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const root = payload as Record<string, unknown>;
  const file =
    root.file && typeof root.file === "object" && !Array.isArray(root.file)
      ? (root.file as Record<string, unknown>)
      : root;
  const agents =
    file.agents && typeof file.agents === "object" && !Array.isArray(file.agents)
      ? (file.agents as Record<string, unknown>)
      : {};
  return Object.values(agents).some((agent) => {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) return false;
    const allowlist = (agent as Record<string, unknown>).allowlist;
    return Array.isArray(allowlist) && allowlist.length > 0;
  });
}

export async function preflightWindowsNodeMxcExactBackend(
  wxcExecPath: string,
  probeRunner: (path: string) => Promise<MxcProbeResult> = runMxcProbe,
): Promise<MxcProbeResult> {
  const probe = await probeRunner(wxcExecPath);
  const eligibility = describeMxcExactBackendEligibility(probe);
  if (!eligibility.eligible) {
    const remediation = eligibility.remediation[0];
    throw new Error(
      `No eligible MXC exact-containment backend is available. ${eligibility.summary}${
        remediation ? ` ${remediation}` : ""
      }`,
    );
  }
  return probe;
}

export async function probeWindowsNodeMxcAutomaticMode(
  wxcExecPath: string,
  probeRunner: (path: string) => Promise<MxcProbeResult> = runMxcProbe,
): Promise<Exclude<WindowsNodeMxcRequestedMode, "off">> {
  return selectWindowsNodeMxcAutomaticMode(await probeRunner(wxcExecPath));
}

export async function probeWindowsNodeMxcAvailability(hostPath: string): Promise<MxcProbeResult> {
  return runMxcProbe(hostPath);
}

export async function preflightWindowsNodeMxcBackend(
  wxcExecPath: string,
  requestedMode: Exclude<WindowsNodeMxcRequestedMode, "off">,
  probeRunner: (path: string) => Promise<MxcProbeResult> = runMxcProbe,
): Promise<MxcProbeResult> {
  if (requestedMode !== "full")
    throw new Error("The retired DACL selection must be migrated to Full before use");
  return preflightWindowsNodeMxcExactBackend(wxcExecPath, probeRunner);
}

async function runMxcProbe(wxcExecPath: string): Promise<MxcProbeResult> {
  if (!fs.existsSync(wxcExecPath)) {
    return classifyMxcProbe(null, "", "", `Windows node host not found at ${wxcExecPath}`);
  }
  return new Promise((resolve) => {
    execFile(
      wxcExecPath,
      ["--mxc-probe"],
      {
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
      },
      (error, stdout, stderr) => {
        if (error && "killed" in error && error.killed) {
          resolve(classifyMxcProbe(null, "", "MXC SDK probe timed out", "probe timed out"));
          return;
        }
        const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve(
          classifyMxcProbe(exitCode, stdout, stderr, error && !stdout ? error.message : undefined),
        );
      },
    );
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMxcSmokeResult(value: unknown): value is MxcSmokeResult {
  return isRecord(value) && typeof value.outcome === "string" && typeof value.reason === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const WINDOWS_NODE_MXC_DIAGNOSTIC_COMMANDS = [
  ...WINDOWS_NODE_MXC_REQUIRED_COMMANDS,
  WINDOWS_NODE_MXC_REQUIRED_CWD_COMMAND,
] as const;
