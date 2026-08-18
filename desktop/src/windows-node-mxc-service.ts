import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
  classifyMissingEffectiveToolSession,
  extractEffectiveToolNames,
  getWindowsNodeMxcGatewayPolicyState,
  getMxcTierWarning,
  listAgentSessionKeys,
  listConfiguredSandboxFolders,
  normalizeWindowsNodeRecord,
  validateEffectiveToolNames,
  validateSelectedWindowsNode,
  validateWindowsNodeMxcSettings,
  type WindowsNodeMxcGatewayPolicyState,
} from "./windows-node-mxc";
import type { BundledWindowsNodeHostStatus } from "./bundled-windows-node-host";

const WINDOWS_NODE_SETTINGS_FILENAME = "settings.json";
const HOSTNAME_MARKER = "MICROCLAW_MXC_HOSTNAME_OK";
const POWERSHELL_MARKER = "MICROCLAW_MXC_POWERSHELL_OK";

export interface WindowsNodeMxcGateway {
  connected: boolean;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export interface StoredWindowsNodeMxcSmoke {
  nodeId: string;
  settingsFingerprint: string;
  probeTier: string;
  checkedAt: string;
  hostname: MxcSmokeResult;
  powershell: MxcSmokeResult;
}

export interface WindowsNodeMxcRuntimeStatus {
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
  gatewayPolicyState: WindowsNodeMxcGatewayPolicyState;
  gatewayPolicyReady: boolean;
  effectiveToolsReady: boolean;
  durableApprovalsPresent: boolean | null;
  probe: MxcProbeResult;
  smoke: StoredWindowsNodeMxcSmoke | null;
  blockers: string[];
  warnings: string[];
  remediation: string[];
}

export interface InspectWindowsNodeMxcOptions {
  desiredEnabled: boolean;
  selectedNodeId: string;
  config: unknown;
  gateway: WindowsNodeMxcGateway | null;
  managedGateway: boolean;
  storedSmoke?: StoredWindowsNodeMxcSmoke | null;
  appData?: string;
  localAppData?: string;
  userProfile?: string;
  environment?: NodeJS.ProcessEnv;
  bundledHost?: BundledWindowsNodeHostStatus;
  bundledFolders?: WindowsNodeMxcFolder[];
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
  const environment = options.environment ?? process.env;
  const appData = options.appData ?? environment.APPDATA ?? "";
  const localAppData = options.localAppData ?? environment.LOCALAPPDATA ?? "";
  const userProfile = options.userProfile ?? environment.USERPROFILE ?? os.homedir();
  const selectedNodeId = options.selectedNodeId.trim();
  const bundled = options.bundledHost;
  const settingsPath = bundled
    ? "MicroClaw-managed policy"
    : resolveWindowsNodeSettingsPath(environment, appData);
  const companionPath = bundled ? bundled.hostPath : resolveWindowsCompanionPath(localAppData);
  const wxcExecPath = bundled ? bundled.wxcExecPath : resolveWxcExecPath(environment, localAppData);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const remediation: string[] = [];

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
        SystemRunAllowOutbound: false,
        SandboxClipboard: 0,
      } satisfies WindowsNodeMxcSettings)
    : await readWindowsNodeSettings(settingsPath);
  const settingsCheck = validateWindowsNodeMxcSettings(settings);
  blockers.push(...settingsCheck.blockers);
  warnings.push(...settingsCheck.warnings);
  if (bundled && !bundled.processRunning) {
    blockers.push(bundled.lastError ?? "Bundled MicroClaw Windows node host is not running");
    remediation.push("Restart MicroClaw so it can start its app-owned Windows node host.");
  } else if (!settings) {
    remediation.push(
      `Install and launch OpenClaw Windows Companion, then configure its Sandbox page. Expected settings: ${settingsPath}`,
    );
  } else if (!settingsCheck.ready) {
    remediation.push(
      "In Windows Companion, enable node mode and system tools; enable MXC and strict host-fallback blocking; enable Allow Windows UI APIs; disable network, clipboard, MCP, and all non-system node capabilities.",
    );
  }

  const settingsFingerprint = settings ? fingerprintSecuritySettings(settings) : null;
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

  const probe = await runMxcProbe(wxcExecPath);
  if (probe.outcome !== "supported") {
    blockers.push(probe.reason ?? "MXC probe did not report a usable tier");
    remediation.push(
      `Repair MXC or set OPENCLAW_WXC_EXEC to the pinned wxc-exec.exe; checked ${wxcExecPath}`,
    );
  }
  const tierWarning = getMxcTierWarning(probe);
  if (tierWarning) warnings.push(tierWarning);
  warnings.push(...probe.warnings);

  const gatewayPolicyState = getWindowsNodeMxcGatewayPolicyState(options.config, selectedNodeId);
  const gatewayPolicyReady = gatewayPolicyState === "locked";
  if (gatewayPolicyState === "drift") {
    blockers.push("Gateway agent tool policy drifted from the diagnostic-only locked MXC policy");
  } else if (gatewayPolicyState === "active") {
    blockers.push("Active Gateway execution is unsupported without atomic ingress quarantine");
  } else {
    blockers.push("Gateway agent execution remains diagnostic-only and locked");
  }

  let nodes: WindowsNodeRecord[] = [];
  let selectedNode: WindowsNodeRecord | null = null;
  let effectiveToolsReady = false;
  let durableApprovalsPresent: boolean | null = null;
  if (!selectedNodeId) {
    blockers.push("Select one paired local Windows node by stable node ID");
  }
  if (options.desiredEnabled && !options.managedGateway) {
    blockers.push("Windows Node + MXC mode requires a freshly started MicroClaw managed Gateway");
  }
  if (!options.gateway?.connected) {
    blockers.push("MicroClaw managed Gateway is not connected");
  } else {
    try {
      const payload = await options.gateway.request<unknown>("node.list", {});
      nodes = extractNodeRecords(payload);
      selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
      blockers.push(...validateSelectedWindowsNode(selectedNode).blockers);
      if (bundled && selectedNode?.connected) {
        try {
          const attestation = await options.gateway.request("node.invoke", {
            nodeId: selectedNodeId,
            command: WINDOWS_NODE_MXC_REQUIRED_CWD_COMMAND,
            params: {},
            timeoutMs: 15_000,
            idempotencyKey: randomUUID(),
          });
          const attestationCheck = validateBundledCwdAttestation(attestation);
          if (!attestationCheck.ready) blockers.push(...attestationCheck.blockers);
        } catch (error) {
          blockers.push(`Bundled node CWD attestation failed: ${messageOf(error)}`);
        }
      }
    } catch (error) {
      blockers.push(`Could not list Gateway nodes: ${messageOf(error)}`);
    }

    if (selectedNodeId) {
      const agentIds = listAgentIds(options.config);
      try {
        const expectedToolsState = gatewayPolicyState === "active" ? "active" : "locked";
        const sessionKeys = await listAgentSessionKeys(options.gateway, agentIds);
        const effectiveChecks = await Promise.all(
          agentIds.map(async (agentId) => {
            const sessionKey = sessionKeys.get(agentId);
            if (!sessionKey) {
              return classifyMissingEffectiveToolSession(agentId, expectedToolsState);
            }
            const result = await options.gateway!.request("tools.effective", {
              agentId,
              sessionKey,
            });
            const check = validateEffectiveToolNames(
              extractEffectiveToolNames(result),
              expectedToolsState,
            );
            return {
              ready: check.ready,
              blockers: check.blockers.map((blocker) => `Agent "${agentId}": ${blocker}`),
              warnings: [],
            };
          }),
        );
        effectiveToolsReady = effectiveChecks.every((check) => check.ready);
        blockers.push(...effectiveChecks.flatMap((check) => check.blockers));
        warnings.push(...effectiveChecks.flatMap((check) => check.warnings));
      } catch (error) {
        blockers.push(`Could not verify effective Gateway tools: ${messageOf(error)}`);
      }

      try {
        const approvals = await options.gateway.request("exec.approvals.node.get", {
          nodeId: selectedNodeId,
        });
        durableApprovalsPresent = bundled ? false : hasDurableApprovals(approvals);
        if (durableApprovalsPresent) {
          blockers.push(
            "Selected node has durable exec approvals, which the pinned Windows Node does not bind to cwd",
          );
        }
      } catch (error) {
        if (bundled) {
          durableApprovalsPresent = false;
        } else {
          blockers.push(`Could not verify selected-node durable approvals: ${messageOf(error)}`);
        }
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

  const smoke =
    options.storedSmoke &&
    options.storedSmoke.nodeId === selectedNodeId &&
    options.storedSmoke.settingsFingerprint === settingsFingerprint &&
    options.storedSmoke.probeTier === probe.tier
      ? options.storedSmoke
      : null;
  if (!smoke || smoke.hostname.outcome !== "passed" || smoke.powershell.outcome !== "passed") {
    blockers.push(
      "A current contained hostname.exe and PowerShell child-process smoke proof is required",
    );
    remediation.push(
      bundled
        ? "Run the contained child-process check from MicroClaw Security settings and approve each command in MicroClaw."
        : "Run the contained child-process check from MicroClaw Security settings and approve each command once in Windows Companion.",
    );
  }

  return {
    desiredEnabled: options.desiredEnabled,
    effectiveEnabled: options.desiredEnabled && blockers.length === 0,
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
    gatewayPolicyState,
    gatewayPolicyReady,
    effectiveToolsReady,
    durableApprovalsPresent,
    probe,
    smoke,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    remediation: [...new Set(remediation)],
  };
}

export function validateBundledCwdAttestation(value: unknown): {
  ready: boolean;
  blockers: string[];
} {
  const record = findAttestationRecord(value);
  const expected = {
    contract: "microclaw.windows-cwd.v1",
    approvedRootOnly: true,
    canonicalFinalPath: true,
    rejectsReparseComponents: true,
    durableApprovalBindsCwd: true,
    launchTimeRevalidation: true,
    omittedCwdUsesIsolatedScratch: true,
    hostFallbackAbsent: true,
  };
  const blockers = Object.entries(expected)
    .filter(([key, expectedValue]) => record?.[key] !== expectedValue)
    .map(([key]) => `Bundled node CWD attestation is missing or invalid: ${key}`);
  return { ready: blockers.length === 0, blockers };
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
  nodeId: string,
  settingsFingerprint: string,
  probeTier: string,
): Promise<StoredWindowsNodeMxcSmoke> {
  if (!gateway.connected) throw new Error("MicroClaw managed Gateway is not connected");
  if (!nodeId.trim()) throw new Error("A stable Windows node ID is required");
  if (!settingsFingerprint) throw new Error("Strict Windows Companion settings are not loaded");
  if (!probeTier) throw new Error("A supported MXC tier is required");

  const hostname = await invokeSmoke(
    gateway,
    nodeId,
    [
      "C:\\Windows\\System32\\cmd.exe",
      "/d",
      "/s",
      "/c",
      `"C:\\Windows\\System32\\hostname.exe" && echo ${HOSTNAME_MARKER}`,
    ],
    HOSTNAME_MARKER,
  );
  let powershell: MxcSmokeResult = {
    outcome: "failed",
    reason: "PowerShell smoke was not run because hostname.exe did not pass",
  };
  if (hostname.outcome === "passed") {
    powershell = await invokeSmoke(
      gateway,
      nodeId,
      [
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Console]::Out.Write('${POWERSHELL_MARKER}')`,
      ],
      POWERSHELL_MARKER,
    );
  }
  return {
    nodeId: nodeId.trim(),
    settingsFingerprint,
    probeTier,
    checkedAt: new Date().toISOString(),
    hostname,
    powershell,
  };
}

async function invokeSmoke(
  gateway: WindowsNodeMxcGateway,
  nodeId: string,
  command: string[],
  marker: string,
): Promise<MxcSmokeResult> {
  try {
    const result = await gateway.request("node.invoke", {
      nodeId,
      command: "system.run",
      params: {
        command,
        timeoutMs: 15_000,
        agentId: "main",
        sessionKey: "agent:main:main",
      },
      timeoutMs: 60_000,
      idempotencyKey: randomUUID(),
    });
    return classifyMxcSmoke(result, marker);
  } catch (error) {
    return classifyMxcSmoke({ error: messageOf(error) }, marker);
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

function fingerprintSecuritySettings(settings: WindowsNodeMxcSettings): string {
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
    SandboxCustomFolders: settings.SandboxCustomFolders,
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

function listAgentIds(config: unknown): string[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const agents = (config as Record<string, unknown>).agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return [];
  const list = (agents as Record<string, unknown>).list;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const id = (entry as Record<string, unknown>).id;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  });
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

async function runMxcProbe(wxcExecPath: string): Promise<MxcProbeResult> {
  if (!fs.existsSync(wxcExecPath)) {
    return classifyMxcProbe(null, "", "", `wxc-exec.exe not found at ${wxcExecPath}`);
  }
  return new Promise((resolve) => {
    execFile(
      wxcExecPath,
      ["--probe"],
      {
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
      },
      (error, stdout, stderr) => {
        if (error && "killed" in error && error.killed) {
          resolve(classifyMxcProbe(null, "", "wxc-exec --probe timed out", "probe timed out"));
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

export const WINDOWS_NODE_MXC_DIAGNOSTIC_COMMANDS = [
  ...WINDOWS_NODE_MXC_REQUIRED_COMMANDS,
  WINDOWS_NODE_MXC_REQUIRED_CWD_COMMAND,
] as const;
