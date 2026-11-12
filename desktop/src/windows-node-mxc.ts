import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readAgentRoster } from "./agent-roster";
import { parseCommandConsentPreview, type CommandConsentPreview } from "./command-consent";
import { computeWindowsNodeMxcApprovalPlanSha256 } from "./windows-node-mxc-readiness-proof";
import {
  POWERSHELL_FILESYSTEM_SCOPE_MARKER,
  validatePowerShellFilesystemInitialization,
  type PowerShellFilesystemInitialization,
} from "./windows-node-mxc-powershell-scope";

export const WINDOWS_NODE_MXC_MODE = "windows-node-mxc";
export const WINDOWS_NODE_MXC_REQUIRED_COMMANDS = [
  "system.run",
  "system.run.readiness",
  "system.run.prepare",
  "system.which",
] as const;
export const WINDOWS_NODE_MXC_REQUIRED_CWD_COMMAND = "system.run.cwd-policy";
export const WINDOWS_NODE_MXC_NODE_COMMANDS = [
  ...WINDOWS_NODE_MXC_REQUIRED_COMMANDS,
  WINDOWS_NODE_MXC_REQUIRED_CWD_COMMAND,
] as const;
const LEGACY_WINDOWS_NODE_MXC_NODE_COMMANDS = [
  "system.run",
  "system.run.readiness",
  "system.run.prepare",
  "system.which",
  "system.run.cwd-policy",
  "canvas.present",
  "canvas.hide",
  "canvas.navigate",
  "canvas.eval",
  "canvas.snapshot",
  "canvas.caps",
  "canvas.a2ui.push",
  "canvas.a2ui.pushJSONL",
  "canvas.a2ui.reset",
  "canvas.a2ui.dump",
] as const;
export const WINDOWS_NODE_MXC_MEMORY_PLUGIN_ID = "memory-core";
export const WINDOWS_NODE_MXC_MEMORY_TOOLS = ["memory_search", "memory_get"] as const;
export const WINDOWS_NODE_MXC_TOOL_ALLOWLIST = [
  "exec",
  "web_search",
  "web_fetch",
  "message",
  "canvas",
  ...WINDOWS_NODE_MXC_MEMORY_TOOLS,
] as const;
export const WINDOWS_NODE_MXC_LOCKED_TOOL_ALLOWLIST = [
  "__microclaw_windows_node_mxc_locked__",
] as const;
export const WINDOWS_NODE_MXC_TOOL_DENYLIST = ["process", "group:fs"] as const;
export const WINDOWS_NODE_MXC_MODEL_PROVIDER_PLUGIN_IDS = ["github-copilot"] as const;
export const WINDOWS_NODE_MXC_LOCKED_TOOL_DENYLIST = [
  "group:runtime",
  "group:fs",
  "group:plugins",
  "browser",
  "gateway",
  "nodes",
] as const;

export type WindowsNodeMxcGatewayPolicyState = "active" | "locked" | "drift";

export function selectWindowsNodeMxcGatewayStartPolicy(
  override: "active" | "locked" | null,
  activationInProgress: boolean,
): "active" | "locked" {
  return override ?? (activationInProgress ? "active" : "locked");
}

export function isWindowsNodeMxcIngressReleased(
  desired: boolean,
  gatewayGeneration: string,
  releasedGeneration: string | null,
  activationInProgress: boolean,
): boolean {
  return (
    !desired ||
    (!activationInProgress &&
      gatewayGeneration.length > 0 &&
      releasedGeneration === gatewayGeneration)
  );
}

export type SandboxFolderAccess = "ro" | "rw";

export interface WindowsNodeMxcFolder {
  path: string;
  access: SandboxFolderAccess;
}

export interface WindowsNodeMxcFolderLists {
  rw: string[];
  ro: string[];
}

export type WindowsNodeMxcFolderPolicyReason =
  | "duplicate"
  | "path-nonlocal"
  | "path-not-found"
  | "path-reparse-point"
  | "acl-failed"
  | "folder-not-configured";

export interface WindowsNodeMxcFolderPathResult {
  ok: boolean;
  canonicalPath: string | null;
  reason?: WindowsNodeMxcFolderPolicyReason;
}

export interface WindowsNodeMxcFolderPlan {
  ok: boolean;
  reason?: WindowsNodeMxcFolderPolicyReason;
  dirs: WindowsNodeMxcFolderLists;
}

export type WindowsNodeMxcApprovalDecision = "deny" | "allow-once" | "allow-always";

export interface WindowsNodeMxcApprovalOrigin {
  contract: "microclaw.gateway-approval-origin.v1";
  gatewayGeneration: string;
  agentId: string;
  runSessionKey: string;
  executionSessionKey: string;
  runId: string;
  toolCallId: string;
  nodeId: string;
  channel: string;
  accountId: string;
  to: string;
}

export interface WindowsNodeMxcGatewayApproval {
  id: string;
  expiresAtUnixMs?: number;
  command: string;
  executable: string;
  arguments: string[];
  executablePath: string;
  executableSha256: string;
  canonicalCwd: string;
  agent: string | null;
  sessionKey: string;
  origin?: WindowsNodeMxcApprovalOrigin;
  declaredAccess: Array<{
    access: SandboxFolderAccess;
    path: string;
  }>;
  hasMutableFileOperand: boolean;
  policyFingerprint?: string;
  planSha256?: string;
  folderChanges?: WindowsNodeMxcFolder[];
  allowedDecisions: WindowsNodeMxcApprovalDecision[];
  providerInitialization?: PowerShellFilesystemInitialization;
  commandConsent?: CommandConsentPreview;
}

export interface WindowsNodeMxcApprovalActivity {
  gatewayGeneration: string;
  sessionKey: string;
  runId: string;
  toolCallId: string;
}

export interface WindowsNodeMxcRendererApproval extends Pick<
  WindowsNodeMxcGatewayApproval,
  | "id"
  | "executable"
  | "arguments"
  | "canonicalCwd"
  | "agent"
  | "declaredAccess"
  | "allowedDecisions"
  | "expiresAtUnixMs"
  | "providerInitialization"
  | "folderChanges"
> {
  commandText?: string;
  containmentStrength?: "off" | "limited-dacl" | "full";
  approvalLayer: "gateway" | "node";
  activity?: WindowsNodeMxcApprovalActivity;
  remoteDelivery?:
    | import("./windows-node-mxc-weixin-remote-approval-delivery").WeixinRemoteDeliveryState
    | null;
}

/** Project an already authenticated origin for display, not approval authority. */
export function projectWindowsNodeMxcApprovalForRenderer(
  approval: WindowsNodeMxcGatewayApproval,
  gatewayGeneration: string,
): WindowsNodeMxcRendererApproval {
  const { origin, ...details } = approval;
  const activity =
    origin?.gatewayGeneration === gatewayGeneration &&
    origin.executionSessionKey === approval.sessionKey &&
    origin.agentId === approval.agent &&
    origin.runSessionKey.startsWith(`agent:${origin.agentId}:`) &&
    origin.runId &&
    origin.toolCallId
      ? {
          gatewayGeneration,
          sessionKey: origin.runSessionKey,
          runId: origin.runId,
          toolCallId: origin.toolCallId,
        }
      : undefined;
  return {
    ...details,
    approvalLayer: "gateway",
    commandText: approval.command,
    ...(activity ? { activity } : {}),
  };
}

const DECLARED_ACCESS_TAG_PATTERN = /\[declare-access\]([\s\S]*?)\[\/declare-access\]/i;
const LEADING_DECLARED_ACCESS_PATTERN =
  /^[ \t]*(?:(?:#|::|REM\b)[ \t]*)?\[declare-access\]([\s\S]*?)\[\/declare-access\][ \t]*(?:\r\n|\n|\r|$)/i;
const DECLARED_ACCESS_MARKER_PATTERN = /\[\/?declare-access\]/i;
const ABSOLUTE_LOCAL_PATH_PATTERN = /^[a-z]:\\/i;

function parseGatewayDeclaredAccess(
  commandPreview: string,
  requireLocalPath: boolean,
): WindowsNodeMxcGatewayApproval["declaredAccess"] | null {
  if (!DECLARED_ACCESS_MARKER_PATTERN.test(commandPreview)) return [];

  const declarations = new Map<string, WindowsNodeMxcGatewayApproval["declaredAccess"][number]>();
  let remaining = commandPreview;
  let matched = false;
  while (true) {
    const match = LEADING_DECLARED_ACCESS_PATTERN.exec(remaining);
    if (!match) break;
    matched = true;
    const entries = match[1].split(";").map((entry) => entry.trim());
    if (entries.length === 0 || entries.some((entry) => !entry)) return null;
    for (const entry of entries) {
      const separator = entry.indexOf(":");
      if (separator <= 0 || separator === entry.length - 1) return null;
      const access = entry.slice(0, separator).trim().toLowerCase();
      const requestedPath = entry.slice(separator + 1).trim();
      if (
        (access !== "ro" && access !== "rw") ||
        !requestedPath ||
        (requireLocalPath && !ABSOLUTE_LOCAL_PATH_PATTERN.test(requestedPath))
      ) {
        return null;
      }
      const key = requestedPath.toLowerCase();
      const existing = declarations.get(key);
      if (!existing || (existing.access === "ro" && access === "rw")) {
        declarations.set(key, { access, path: requestedPath });
      }
    }
    remaining = remaining.slice(match[0].length);
  }

  if (
    !matched ||
    !remaining.trim() ||
    DECLARED_ACCESS_TAG_PATTERN.test(remaining) ||
    DECLARED_ACCESS_MARKER_PATTERN.test(remaining)
  ) {
    return null;
  }
  return [...declarations.values()].sort(compareDeclaredAccessPath);
}

function normalizeStructuredDeclaredAccess(
  value: unknown,
  requireLocalPath: boolean,
): WindowsNodeMxcGatewayApproval["declaredAccess"] | null {
  if (!Array.isArray(value)) return null;
  const entries = new Map<string, WindowsNodeMxcGatewayApproval["declaredAccess"][number]>();
  for (const candidate of value) {
    const entry = asRecord(candidate);
    const access = typeof entry.access === "string" ? entry.access.toLowerCase() : "";
    const requestedPath = typeof entry.path === "string" ? entry.path.trim() : "";
    if (
      (access !== "ro" && access !== "rw") ||
      !requestedPath ||
      (requireLocalPath && !ABSOLUTE_LOCAL_PATH_PATTERN.test(requestedPath))
    ) {
      return null;
    }
    const key = requestedPath.toLowerCase();
    const existing = entries.get(key);
    if (existing && existing.access !== access) return null;
    entries.set(key, { access, path: requestedPath });
  }
  return [...entries.values()].sort(compareDeclaredAccessPath);
}

function compareDeclaredAccessPath(
  left: WindowsNodeMxcGatewayApproval["declaredAccess"][number],
  right: WindowsNodeMxcGatewayApproval["declaredAccess"][number],
): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function declaredAccessMatches(
  left: WindowsNodeMxcGatewayApproval["declaredAccess"],
  right: WindowsNodeMxcGatewayApproval["declaredAccess"],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.access === right[index]?.access &&
        entry.path.toLowerCase() === right[index]?.path.toLowerCase(),
    )
  );
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function normalizeWindowsNodeMxcGatewayApproval(
  payload: unknown,
  selectedNodeId: string,
  gatewayGeneration?: string,
  requestedMode?: string,
): WindowsNodeMxcGatewayApproval | null {
  const envelope = asRecord(payload);
  const request = asRecord(envelope.request);
  const plan = asRecord(request.systemRunPlan);
  const commandConsent = parseCommandConsentPreview(plan.commandConsent);
  if (Object.hasOwn(plan, "commandConsent") && !commandConsent) return null;
  const id = typeof envelope.id === "string" ? envelope.id.trim() : "";
  const expiresAtMs = envelope.expiresAtMs;
  const host = typeof request.host === "string" ? request.host : "";
  const nodeId = typeof request.nodeId === "string" ? request.nodeId : "";
  const argv = plan.argv;
  const hasInitialization = Object.hasOwn(plan, "providerInitialization");
  const commandText =
    typeof plan.commandText === "string"
      ? hasInitialization
        ? plan.commandText
        : plan.commandText.trim()
      : "";
  const commandPreview =
    typeof plan.commandPreview === "string"
      ? hasInitialization
        ? plan.commandPreview
        : plan.commandPreview.trim()
      : "";
  const executablePath = typeof plan.executablePath === "string" ? plan.executablePath.trim() : "";
  const executableSha256 =
    typeof plan.executableSha256 === "string" ? plan.executableSha256.toLowerCase() : "";
  const cwdBinding = typeof plan.cwdBinding === "string" ? plan.cwdBinding.trim() : "";
  const requireLocalPath = requestedMode !== "off";
  const previewDeclaredAccess = parseGatewayDeclaredAccess(commandPreview, requireLocalPath);
  const declaredAccess = normalizeStructuredDeclaredAccess(plan.declaredAccess, requireLocalPath);
  const policyFingerprint = plan.policyFingerprint;
  if (
    policyFingerprint !== undefined &&
    (typeof policyFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(policyFingerprint))
  ) {
    return null;
  }
  const hasMutableFileOperand =
    Object.hasOwn(plan, "mutableFileOperand") &&
    plan.mutableFileOperand !== null &&
    plan.mutableFileOperand !== undefined;
  const hasCanonicalCwd =
    Object.hasOwn(plan, "cwd") &&
    (plan.cwd === null || (typeof plan.cwd === "string" && plan.cwd.trim().length > 0));
  const hasCanonicalAgent =
    Object.hasOwn(plan, "agentId") &&
    (plan.agentId === null || (typeof plan.agentId === "string" && plan.agentId.trim().length > 0));
  const hasCanonicalSession =
    Object.hasOwn(plan, "sessionKey") &&
    typeof plan.sessionKey === "string" &&
    plan.sessionKey.trim().length > 0;
  const hasCanonicalPreview =
    !Object.hasOwn(plan, "commandPreview") ||
    plan.commandPreview === null ||
    typeof plan.commandPreview === "string";
  if (
    !id ||
    (expiresAtMs !== undefined &&
      (!Number.isSafeInteger(expiresAtMs) || Number(expiresAtMs) <= 0)) ||
    host !== "node" ||
    nodeId.toLowerCase() !== selectedNodeId.trim().toLowerCase() ||
    !isNonEmptyStringArray(argv) ||
    !commandText ||
    !/^[a-z]:\\/i.test(executablePath) ||
    !/^[a-f0-9]{64}$/.test(executableSha256) ||
    !cwdBinding ||
    !hasCanonicalCwd ||
    !hasCanonicalAgent ||
    !hasCanonicalSession ||
    !hasCanonicalPreview ||
    declaredAccess === null ||
    previewDeclaredAccess === null ||
    !declaredAccessMatches(declaredAccess, previewDeclaredAccess)
  ) {
    return null;
  }
  const providerInitialization =
    hasInitialization && requestedMode === "full"
      ? validatePowerShellFilesystemInitialization(
          plan.providerInitialization,
          argv,
          executablePath,
          declaredAccess,
          commandPreview,
        )
      : null;
  if (
    (hasInitialization && !providerInitialization) ||
    (!hasInitialization &&
      argv.some((argument) => argument.includes(POWERSHELL_FILESYSTEM_SCOPE_MARKER)))
  )
    return null;

  const advertised = Array.isArray(envelope.allowedDecisions)
    ? envelope.allowedDecisions
    : Array.isArray(request.allowedDecisions)
      ? request.allowedDecisions
      : [];
  const allowed = advertised.filter(
    (decision): decision is WindowsNodeMxcApprovalDecision =>
      decision === "deny" || decision === "allow-once" || decision === "allow-always",
  );
  if (!allowed.includes("deny")) allowed.push("deny");
  if (!allowed.includes("allow-once")) allowed.unshift("allow-once");
  const alwaysIndex = allowed.indexOf("allow-always");
  if (!commandConsent?.allowAlwaysAvailable && alwaysIndex >= 0) allowed.splice(alwaysIndex, 1);
  if (commandConsent?.allowAlwaysAvailable && alwaysIndex < 0) allowed.push("allow-always");

  const rawOrigin = asRecord(request.remoteApprovalOrigin);
  const origin =
    rawOrigin.contract === "microclaw.gateway-approval-origin.v1" &&
    typeof gatewayGeneration === "string" &&
    rawOrigin.gatewayGeneration === gatewayGeneration &&
    rawOrigin.agentId === plan.agentId &&
    rawOrigin.executionSessionKey === plan.sessionKey &&
    rawOrigin.runId === request.runId &&
    rawOrigin.toolCallId === request.toolCallId &&
    rawOrigin.nodeId === request.nodeId &&
    isNonEmptyString(rawOrigin.agentId) &&
    isNonEmptyString(rawOrigin.runSessionKey) &&
    isNonEmptyString(rawOrigin.runId) &&
    isNonEmptyString(rawOrigin.toolCallId) &&
    isNonEmptyString(rawOrigin.channel) &&
    isNonEmptyString(rawOrigin.accountId) &&
    isNonEmptyString(rawOrigin.to) &&
    rawOrigin.channel === request.turnSourceChannel &&
    rawOrigin.accountId === request.turnSourceAccountId &&
    rawOrigin.to === request.turnSourceTo &&
    isNonEmptyString(plan.sessionKey)
      ? {
          contract: "microclaw.gateway-approval-origin.v1" as const,
          gatewayGeneration,
          agentId: rawOrigin.agentId,
          runSessionKey: rawOrigin.runSessionKey,
          executionSessionKey: plan.sessionKey,
          runId: rawOrigin.runId,
          toolCallId: rawOrigin.toolCallId,
          nodeId,
          channel: rawOrigin.channel,
          accountId: rawOrigin.accountId,
          to: rawOrigin.to,
        }
      : undefined;

  return {
    id,
    ...(typeof expiresAtMs === "number" ? { expiresAtUnixMs: expiresAtMs } : {}),
    command: commandText,
    executable: argv[0],
    arguments: argv.slice(1),
    executablePath,
    executableSha256,
    canonicalCwd: cwdBinding,
    agent: typeof plan.agentId === "string" && plan.agentId.trim() ? plan.agentId : null,
    sessionKey: plan.sessionKey as string,
    ...(origin ? { origin } : {}),
    declaredAccess,
    hasMutableFileOperand,
    ...(typeof policyFingerprint === "string"
      ? {
          policyFingerprint,
          planSha256: computeWindowsNodeMxcApprovalPlanSha256({
            argv,
            cwd: typeof plan.cwd === "string" ? plan.cwd : null,
            commandText: plan.commandText as string,
            commandPreview: typeof plan.commandPreview === "string" ? plan.commandPreview : null,
            agentId: typeof plan.agentId === "string" ? plan.agentId : null,
            sessionKey: plan.sessionKey as string,
            executablePath: plan.executablePath as string,
            executableSha256,
            cwdBinding,
            declaredAccess,
            ...(providerInitialization ? { providerInitialization } : {}),
            policyFingerprint,
          }),
        }
      : {}),
    allowedDecisions: [...new Set(allowed)],
    ...(commandConsent ? { commandConsent } : {}),
    ...(providerInitialization ? { providerInitialization } : {}),
  };
}

export function getWindowsNodeMxcMissingFolders(
  approval: Pick<WindowsNodeMxcGatewayApproval, "canonicalCwd" | "declaredAccess">,
  folders: WindowsNodeMxcFolder[],
): WindowsNodeMxcFolder[] {
  const requested = new Map<string, WindowsNodeMxcFolder>();
  const entries = [
    ...(approval.canonicalCwd === "isolated-scratch:v1"
      ? []
      : [{ path: approval.canonicalCwd, access: "ro" as const }]),
    ...approval.declaredAccess,
  ];
  for (const entry of entries) {
    const key = normalizeWindowsPath(entry.path);
    const previous = requested.get(key);
    if (!previous || entry.access === "rw") requested.set(key, { ...entry });
  }
  const candidates = [...requested.values()].sort(
    (left, right) =>
      normalizeWindowsPath(left.path).length - normalizeWindowsPath(right.path).length ||
      compareWindowsPaths(left.path, right.path),
  );
  const missing: WindowsNodeMxcFolder[] = [];
  let plannedFolders = [...folders];
  for (const entry of candidates) {
    const key = normalizeWindowsPath(entry.path);
    const grant = plannedFolders
      .filter((folder) => isWithinWindowsRoot(key, normalizeWindowsPath(folder.path)))
      .sort(
        (left, right) =>
          normalizeWindowsPath(right.path).length - normalizeWindowsPath(left.path).length,
      )[0];
    if (grant && (grant.access === "rw" || entry.access === "ro")) continue;
    missing.push(entry);
    // A proposed parent does not override an existing, more-specific child grant.
    plannedFolders = plannedFolders.filter((folder) => normalizeWindowsPath(folder.path) !== key);
    plannedFolders.push(entry);
  }
  return missing.sort((left, right) => compareWindowsPaths(left.path, right.path));
}

export interface WindowsNodeMxcSettings {
  EnableNodeMode?: boolean;
  NodeSystemRunEnabled?: boolean;
  NodeCanvasEnabled?: boolean;
  NodeScreenEnabled?: boolean;
  NodeCameraEnabled?: boolean;
  NodeLocationEnabled?: boolean;
  NodeBrowserProxyEnabled?: boolean;
  NodeSttEnabled?: boolean;
  NodeTtsEnabled?: boolean;
  EnableMcpServer?: boolean;
  SystemRunSandboxEnabled?: boolean;
  SystemRunBlockHostFallbackWhenMxcUnavailable?: boolean;
  SystemRunAllowOutbound?: boolean;
  SystemRunAllowWindowsUi?: boolean;
  SandboxClipboard?: number;
  SandboxDocumentsAccess?: number | null;
  SandboxDownloadsAccess?: number | null;
  SandboxDesktopAccess?: number | null;
  SandboxCustomFolders?: Array<{ Path?: string; Access?: number }>;
}

export interface WindowsNodeRecord {
  id: string;
  displayName: string;
  platform: string;
  connected: boolean;
  paired: boolean;
  remoteIp: string | null;
  commands: string[];
}

export interface WindowsNodeReadiness {
  ready: boolean;
  blockers: string[];
  warnings: string[];
}

export interface MxcBackendProbeFacts {
  baseContainerApiPresent: boolean | null;
  bfscfgPresent: boolean | null;
  bfsCompiledIn: boolean | null;
}

export interface MxcProbeResult {
  outcome: "supported" | "unsupported" | "error";
  windowsUnsupported?: boolean;
  supportsProtectedPathDenies?: boolean;
  tier: string | null;
  needsDaclAugmentation: boolean;
  degraded: boolean;
  warnings: string[];
  probes: MxcBackendProbeFacts;
  reason: string | null;
}

export interface MxcExactBackendEligibility {
  eligible: boolean;
  summary: string | null;
  blockers: string[];
  remediation: string[];
}

export interface MxcSmokeResult {
  outcome:
    | "passed"
    | "sandbox-unavailable"
    | "child-launch-failed"
    | "approval-required"
    | "timed-out"
    | "failed";
  reason: string;
}

export interface CanonicalCwdResult {
  allowed: boolean;
  canonicalPath: string | null;
  access: SandboxFolderAccess | null;
  reason: string | null;
}

export type AgentToolsBackup = Record<string, unknown | null>;
const GATEWAY_NODES_BACKUP_KEY = "$microclaw.gateway.nodes";
const INGRESS_BACKUP_KEYS = {
  channels: "$microclaw.ingress.channels",
  cron: "$microclaw.ingress.cron",
  hooks: "$microclaw.ingress.hooks",
  plugins: "$microclaw.ingress.plugins",
} as const;
export type WindowsNodeMxcIngressField = keyof typeof INGRESS_BACKUP_KEYS;

export interface WindowsNodeMxcPolicyApplication {
  config: Record<string, unknown>;
  backups: AgentToolsBackup;
  agentIds: string[];
}

export function getWindowsNodeMxcIngressBackup(
  backups: AgentToolsBackup,
  field: WindowsNodeMxcIngressField,
): unknown {
  const backupKey = INGRESS_BACKUP_KEYS[field];
  if (!Object.hasOwn(backups, backupKey)) return undefined;
  return structuredClone(backups[backupKey]);
}

export function migrateWindowsNodeMxcToolBackupAliases(
  backups: AgentToolsBackup,
  aliases: Readonly<Record<string, string>>,
): AgentToolsBackup {
  const migrated = structuredClone(backups);
  for (const [legacyId, canonicalId] of Object.entries(aliases)) {
    if (Object.hasOwn(migrated, legacyId) && !Object.hasOwn(migrated, canonicalId)) {
      migrated[canonicalId] = structuredClone(migrated[legacyId]);
    }
  }
  return migrated;
}

export function buildWindowsNodeMxcToolPolicy(nodeId: string): Record<string, unknown> {
  const normalizedNodeId = nodeId.trim();
  if (!normalizedNodeId) throw new Error("A stable Windows node ID is required");

  return {
    profile: "full",
    allow: [...WINDOWS_NODE_MXC_TOOL_ALLOWLIST],
    deny: [...WINDOWS_NODE_MXC_TOOL_DENYLIST],
    codeMode: false,
    exec: {
      host: "node",
      node: normalizedNodeId,
      security: "allowlist",
      // The Gateway supplies a one-use dispatch proof for every node run. The
      // native Windows Node policy decides whether the user actually sees a prompt.
      ask: "always",
      timeoutSeconds: 1800,
      strictInlineEval: true,
    },
  };
}

export function applyWindowsNodeCommandPolicy(
  source: Record<string, unknown>,
  nodeId: string,
): Record<string, unknown> {
  const config = structuredClone(source);
  const exec = buildWindowsNodeMxcToolPolicy(nodeId).exec;
  const globalTools = asRecord(config.tools);
  config.tools = { ...globalTools, exec: { ...asRecord(globalTools.exec), ...asRecord(exec) } };
  const agents = asRecord(config.agents);
  for (const { config: agent } of readAgentRoster(agents)) {
    const tools = asRecord(agent.tools);
    agent.tools = { ...tools, exec: { ...asRecord(tools.exec), ...asRecord(exec) } };
  }
  config.agents = agents;
  const gateway = asRecord(config.gateway);
  const nodes = asRecord(gateway.nodes);
  const commands = asRecord(nodes.commands);
  const required = new Set<string>([
    ...WINDOWS_NODE_MXC_REQUIRED_COMMANDS,
    WINDOWS_NODE_MXC_REQUIRED_CWD_COMMAND,
  ]);
  const supported = new Set<string>(WINDOWS_NODE_MXC_NODE_COMMANDS);
  const commandList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  nodes.commands = {
    ...commands,
    allow: [...new Set([...commandList(commands.allow ?? nodes.allowCommands), ...supported])],
    deny: commandList(commands.deny ?? nodes.denyCommands).filter(
      (command) => !required.has(command),
    ),
  };
  delete nodes.allowCommands;
  delete nodes.denyCommands;
  gateway.nodes = nodes;
  config.gateway = gateway;
  return config;
}

export function applyWindowsNodeMxcGatewayPolicy(
  source: Record<string, unknown>,
  nodeId: string,
  existingBackups: AgentToolsBackup = {},
  _state: Exclude<WindowsNodeMxcGatewayPolicyState, "drift"> = "active",
): WindowsNodeMxcPolicyApplication {
  const config = restoreWindowsNodeMxcGatewayPolicy(source, existingBackups);
  const agents =
    config.agents && typeof config.agents === "object" && !Array.isArray(config.agents)
      ? (config.agents as Record<string, unknown>)
      : {};
  const list = readAgentRoster(agents);
  if (list.length === 0) {
    throw new Error("Windows Node + MXC mode requires at least one configured agent");
  }

  const agentIds: string[] = [];
  for (const { id: rawId } of list) {
    const id = rawId.trim();
    if (!id) throw new Error("Every configured agent must have a stable ID");
    agentIds.push(id);
  }
  return { config: applyWindowsNodeCommandPolicy(config, nodeId), backups: {}, agentIds };
}

function restoreImposedField(
  current: Record<string, unknown>,
  previous: Record<string, unknown>,
  field: string,
  imposed: unknown,
): void {
  if (!Object.hasOwn(current, field) || !isDeepStrictEqual(current[field], imposed)) return;
  if (Object.hasOwn(previous, field)) current[field] = structuredClone(previous[field]);
  else delete current[field];
}

function restoreImposedList(
  current: Record<string, unknown>,
  previous: Record<string, unknown>,
  field: string,
  imposed: readonly string[],
): boolean {
  const value = current[field];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string") ||
    !imposed.every((entry) => value.includes(entry))
  ) {
    return false;
  }
  const additions = value.filter((entry) => !imposed.includes(entry));
  const prior = previous[field];
  if (additions.length === 0) {
    restoreImposedField(current, previous, field, value);
  } else if (Array.isArray(prior) && prior.every((entry) => typeof entry === "string")) {
    current[field] = [...new Set([...prior, ...additions])];
  } else if (!Object.hasOwn(previous, field) || prior === null) {
    if (field === "deny") current[field] = additions;
    else if (prior === null) current[field] = null;
    else delete current[field];
  } else {
    return false;
  }
  return true;
}

function removeEmptyAddedObject(
  parent: Record<string, unknown>,
  previous: Record<string, unknown>,
  field: string,
): void {
  if (!Object.hasOwn(previous, field) && Object.keys(asRecord(parent[field])).length === 0)
    delete parent[field];
}

export function restoreWindowsNodeMxcGatewayPolicy(
  source: Record<string, unknown>,
  backups: AgentToolsBackup,
): Record<string, unknown> {
  const config = structuredClone(source);
  const agents =
    config.agents && typeof config.agents === "object" && !Array.isArray(config.agents)
      ? (config.agents as Record<string, unknown>)
      : null;
  const list = readAgentRoster(agents ?? undefined);
  for (const { id: rawId, config: entry } of list) {
    const id = rawId.trim();
    if (!id || !Object.hasOwn(backups, id)) continue;
    const tools = asRecord(entry.tools);
    const hasList = (value: unknown, imposed: readonly string[]) =>
      Array.isArray(value) && imposed.every((name) => value.includes(name));
    const legacyActive =
      hasList(tools.allow, WINDOWS_NODE_MXC_TOOL_ALLOWLIST) ||
      hasList(tools.deny, WINDOWS_NODE_MXC_TOOL_DENYLIST);
    const legacyLocked =
      hasList(tools.allow, WINDOWS_NODE_MXC_LOCKED_TOOL_ALLOWLIST) ||
      hasList(tools.deny, WINDOWS_NODE_MXC_LOCKED_TOOL_DENYLIST);
    const currentExec = asRecord(tools.exec);
    const legacyExec =
      tools.profile === "full" &&
      tools.codeMode === false &&
      currentExec.host === "node" &&
      currentExec.security === "allowlist" &&
      currentExec.ask === "always";
    if (!legacyActive && !legacyLocked && !legacyExec) continue;
    const previous = asRecord(backups[id]);
    restoreImposedField(tools, previous, "profile", "full");
    if (!restoreImposedList(tools, previous, "allow", WINDOWS_NODE_MXC_LOCKED_TOOL_ALLOWLIST))
      restoreImposedList(tools, previous, "allow", WINDOWS_NODE_MXC_TOOL_ALLOWLIST);
    if (!restoreImposedList(tools, previous, "deny", WINDOWS_NODE_MXC_LOCKED_TOOL_DENYLIST))
      restoreImposedList(tools, previous, "deny", WINDOWS_NODE_MXC_TOOL_DENYLIST);
    restoreImposedField(tools, previous, "codeMode", false);
    const exec = asRecord(tools.exec);
    const oldExec = asRecord(previous.exec);
    const imposedExec = {
      host: "node",
      ...(typeof exec.node === "string" && exec.node.trim() ? { node: exec.node } : {}),
      security: "allowlist",
      ask: "always",
      timeoutSeconds: 1800,
      strictInlineEval: true,
    };
    for (const [field, imposed] of Object.entries(imposedExec))
      restoreImposedField(exec, oldExec, field, imposed);
    removeEmptyAddedObject(tools, previous, "exec");
    if (backups[id] === null && Object.keys(tools).length === 0) delete entry.tools;
  }
  if (Object.hasOwn(backups, GATEWAY_NODES_BACKUP_KEY)) {
    const gateway = asRecord(config.gateway);
    const nodes = asRecord(gateway.nodes);
    const previous = asRecord(backups[GATEWAY_NODES_BACKUP_KEY]);
    const commands = asRecord(nodes.commands);
    const oldCommands = asRecord(previous.commands);
    const legacyCommands = restoreImposedList(
      commands,
      oldCommands,
      "allow",
      LEGACY_WINDOWS_NODE_MXC_NODE_COMMANDS,
    );
    if (legacyCommands) {
      restoreImposedField(commands, oldCommands, "deny", []);
      removeEmptyAddedObject(nodes, previous, "commands");
      for (const field of ["allowCommands", "denyCommands"]) {
        if (!Object.hasOwn(nodes, field) && Object.hasOwn(previous, field))
          nodes[field] = structuredClone(previous[field]);
      }
    }
    if (backups[GATEWAY_NODES_BACKUP_KEY] === null && Object.keys(nodes).length === 0)
      delete gateway.nodes;
    if (Object.keys(gateway).length === 0) delete config.gateway;
  }
  if (Object.hasOwn(backups, INGRESS_BACKUP_KEYS.channels)) {
    const channels = asRecord(config.channels);
    const previous = asRecord(backups[INGRESS_BACKUP_KEYS.channels]);
    for (const [id, priorValue] of Object.entries(previous)) {
      const current = asRecord(channels[id]);
      const old = asRecord(priorValue);
      restoreImposedField(
        current,
        old,
        "enabled",
        id === "openclaw-weixin" && old.enabled === true,
      );
    }
    if (backups[INGRESS_BACKUP_KEYS.channels] === null && Object.keys(channels).length === 0)
      delete config.channels;
  }
  for (const field of ["cron", "hooks"] as const) {
    const backupKey = INGRESS_BACKUP_KEYS[field];
    if (!Object.hasOwn(backups, backupKey)) continue;
    const current = asRecord(config[field]);
    const previous = asRecord(backups[backupKey]);
    restoreImposedField(current, previous, "enabled", false);
    if (field === "hooks") {
      const internal = asRecord(current.internal);
      restoreImposedField(internal, asRecord(previous.internal), "enabled", false);
      removeEmptyAddedObject(current, previous, "internal");
    }
    if (backups[backupKey] === null && Object.keys(current).length === 0) delete config[field];
  }
  if (Object.hasOwn(backups, INGRESS_BACKUP_KEYS.plugins)) {
    const plugins = asRecord(config.plugins);
    const previous = asRecord(backups[INGRESS_BACKUP_KEYS.plugins]);
    const entries = asRecord(plugins.entries);
    const oldEntries = asRecord(previous.entries);
    const allow = Array.isArray(plugins.allow) ? plugins.allow : [];
    const knownLegacyIds = new Set<string>([
      "canvas",
      WINDOWS_NODE_MXC_MEMORY_PLUGIN_ID,
      "openclaw-weixin",
      ...WINDOWS_NODE_MXC_MODEL_PROVIDER_PLUGIN_IDS,
    ]);
    const legacyAllow =
      allow.includes("canvas") &&
      allow.includes(WINDOWS_NODE_MXC_MEMORY_PLUGIN_ID) &&
      allow.every((id) => typeof id === "string");
    const slots = asRecord(plugins.slots);
    const legacyPluginSettings =
      plugins.enabled === true &&
      slots.memory === WINDOWS_NODE_MXC_MEMORY_PLUGIN_ID &&
      asRecord(entries.canvas).enabled === true &&
      asRecord(entries[WINDOWS_NODE_MXC_MEMORY_PLUGIN_ID]).enabled === true;
    if (legacyAllow || legacyPluginSettings) {
      restoreImposedField(plugins, previous, "enabled", true);
      const imposedAllow = allow.filter((id): id is string => knownLegacyIds.has(id));
      if (legacyAllow) {
        const legacyDeny = Array.isArray(previous.deny)
          ? previous.deny.filter((id) => !imposedAllow.includes(id))
          : [];
        restoreImposedField(plugins, previous, "deny", legacyDeny);
        restoreImposedList(plugins, previous, "allow", imposedAllow);
      }
      restoreImposedField(
        slots,
        asRecord(previous.slots),
        "memory",
        WINDOWS_NODE_MXC_MEMORY_PLUGIN_ID,
      );
      removeEmptyAddedObject(plugins, previous, "slots");
      for (const [id, value] of Object.entries(entries)) {
        const current = asRecord(value);
        const old = asRecord(oldEntries[id]);
        if (Object.hasOwn(oldEntries, id) || knownLegacyIds.has(id)) {
          const imposedEnabled =
            id === "canvas" ||
            id === WINDOWS_NODE_MXC_MEMORY_PLUGIN_ID ||
            imposedAllow.includes(id);
          restoreImposedField(current, old, "enabled", imposedEnabled);
        }
        if (!Object.hasOwn(oldEntries, id) && Object.keys(current).length === 0) delete entries[id];
      }
      removeEmptyAddedObject(plugins, previous, "entries");
    }
    if (backups[INGRESS_BACKUP_KEYS.plugins] === null && Object.keys(plugins).length === 0)
      delete config.plugins;
  }
  return config;
}

export function validateWindowsNodeMxcGatewayPolicy(
  config: unknown,
  nodeId: string,
  _expectedState: Exclude<WindowsNodeMxcGatewayPolicyState, "drift"> | "either" = "active",
): WindowsNodeReadiness {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!nodeId.trim()) {
    return { ready: false, blockers: ["A stable Windows node ID is required"], warnings };
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ready: false, blockers: ["OpenClaw configuration is unavailable"], warnings };
  }

  const root = config as Record<string, unknown>;
  const agents =
    root.agents && typeof root.agents === "object" && !Array.isArray(root.agents)
      ? (root.agents as Record<string, unknown>)
      : null;
  let list: ReturnType<typeof readAgentRoster>;
  try {
    list = readAgentRoster(agents ?? undefined);
  } catch (error) {
    return { ready: false, blockers: [String(error)], warnings };
  }
  if (list.length === 0) blockers.push("No agents are configured for node command routing");

  const expectedExec = asRecord(buildWindowsNodeMxcToolPolicy(nodeId).exec);
  const validateExec = (value: unknown, label: string) => {
    const exec = asRecord(value);
    if (
      Object.entries(expectedExec).some(
        ([field, expected]) => !isDeepStrictEqual(exec[field], expected),
      )
    )
      blockers.push(`${label} does not route command execution through the app-owned Windows node`);
  };
  validateExec(asRecord(root.tools).exec, "Global Gateway tool policy");
  for (const { id, config: entry } of list) {
    validateExec(asRecord(entry.tools).exec, `Agent "${id}"`);
  }

  const gateway =
    root.gateway && typeof root.gateway === "object" && !Array.isArray(root.gateway)
      ? (root.gateway as Record<string, unknown>)
      : null;
  const nodes =
    gateway?.nodes && typeof gateway.nodes === "object" && !Array.isArray(gateway.nodes)
      ? (gateway.nodes as Record<string, unknown>)
      : null;
  const commands = asRecord(nodes?.commands);
  const allowCommands = Array.isArray(commands.allow) ? commands.allow : [];
  const denyCommands = Array.isArray(commands.deny) ? commands.deny : [];
  for (const command of [
    ...WINDOWS_NODE_MXC_REQUIRED_COMMANDS,
    WINDOWS_NODE_MXC_REQUIRED_CWD_COMMAND,
  ]) {
    if (!allowCommands.includes(command) || denyCommands.includes(command))
      blockers.push(`Gateway node command policy does not allow ${command}`);
  }

  return { ready: blockers.length === 0, blockers, warnings };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function getWindowsNodeMxcGatewayPolicyState(
  config: unknown,
  nodeId: string,
): WindowsNodeMxcGatewayPolicyState {
  if (validateWindowsNodeMxcGatewayPolicy(config, nodeId, "active").ready) return "active";
  if (validateWindowsNodeMxcGatewayPolicy(config, nodeId, "locked").ready) return "locked";
  return "drift";
}

export function validateWindowsNodeMxcSettings(
  settings: WindowsNodeMxcSettings | null,
): WindowsNodeReadiness {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!settings) {
    return {
      ready: false,
      blockers: ["Windows Companion settings.json is missing or unreadable"],
      warnings,
    };
  }

  const requiredTrue: Array<[keyof WindowsNodeMxcSettings, string]> = [
    ["EnableNodeMode", "Windows Companion node mode is disabled"],
    ["NodeSystemRunEnabled", "Windows node system.run is disabled"],
    ["SystemRunSandboxEnabled", "Windows node MXC sandbox is disabled"],
    [
      "SystemRunBlockHostFallbackWhenMxcUnavailable",
      "Strict MXC host-fallback blocking is disabled",
    ],
    ["SystemRunAllowOutbound", "Contained outbound network access must be enabled for this mode"],
  ];
  for (const [property, message] of requiredTrue) {
    if (settings[property] !== true) blockers.push(message);
  }

  if (settings.SandboxClipboard !== 0) blockers.push("Sandbox clipboard policy must be None");

  warnings.push(
    "MXC contains Windows node commands only; Gateway-native tools, plugins, and channels run outside the sandbox.",
  );
  return { ready: blockers.length === 0, blockers, warnings };
}

export function normalizeWindowsNodeRecord(value: unknown): WindowsNodeRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const idValue = record.id ?? record.nodeId ?? record.deviceId;
  if (typeof idValue !== "string" || !idValue.trim()) return null;
  const commands = Array.isArray(record.commands)
    ? record.commands.filter((entry): entry is string => typeof entry === "string")
    : [];
  const connected =
    record.connected === true ||
    record.online === true ||
    record.status === "connected" ||
    record.status === "online";
  return {
    id: idValue.trim(),
    displayName:
      typeof record.displayName === "string"
        ? record.displayName
        : typeof record.name === "string"
          ? record.name
          : idValue.trim(),
    platform: typeof record.platform === "string" ? record.platform.toLowerCase() : "",
    connected,
    paired: record.paired !== false,
    remoteIp:
      typeof record.remoteIp === "string"
        ? record.remoteIp
        : typeof record.ip === "string"
          ? record.ip
          : null,
    commands,
  };
}

export function validateSelectedWindowsNode(
  node: WindowsNodeRecord | null,
  trustedBundledNodeId = "",
): WindowsNodeReadiness {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!node) {
    return { ready: false, blockers: ["The selected Windows node is not paired"], warnings };
  }
  if (!node.connected) blockers.push("The selected Windows node is disconnected");
  if (!node.paired) blockers.push("The selected Windows node requires pairing or reapproval");
  if (node.platform !== "win32" && node.platform !== "windows") {
    blockers.push("The selected node is not a Windows node");
  }
  const appOwnedLocalIdentity =
    trustedBundledNodeId.length > 0 && node.id.toLowerCase() === trustedBundledNodeId.toLowerCase();
  if ((!node.remoteIp || !isLoopbackAddress(node.remoteIp)) && !appOwnedLocalIdentity) {
    blockers.push("The selected node is not proven to be local to this MicroClaw Gateway");
  }
  for (const command of WINDOWS_NODE_MXC_REQUIRED_COMMANDS) {
    if (!node.commands.includes(command))
      blockers.push(`Selected node does not declare ${command}`);
  }
  if (!node.commands.includes(WINDOWS_NODE_MXC_REQUIRED_CWD_COMMAND)) {
    blockers.push(
      "Pinned Windows Node does not expose canonical approved-root cwd enforcement or cwd-bound durable approvals",
    );
  }
  return { ready: blockers.length === 0, blockers, warnings };
}

export function classifyMxcProbe(
  exitCode: number | null,
  stdout: string,
  stderr: string,
  launchError?: string,
): MxcProbeResult {
  if (launchError) return probeError(`MXC SDK probe could not be launched: ${launchError}`);
  if (exitCode !== 0) {
    return probeError(
      `MXC SDK probe exited ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
  }
  if (!stdout.trim()) {
    return probeError("MXC SDK probe returned no output");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return probeError("MXC SDK probe returned unparseable output");
  }
  if (
    !parsed ||
    Array.isArray(parsed) ||
    parsed.contract !== "microclaw.mxc-sdk-probe.v1" ||
    typeof parsed.supported !== "boolean" ||
    typeof parsed.windowsUnsupported !== "boolean" ||
    typeof parsed.probeErrored !== "boolean" ||
    typeof parsed.needsDaclAugmentation !== "boolean" ||
    typeof parsed.supportsProtectedPathDenies !== "boolean" ||
    (parsed.tier !== null && typeof parsed.tier !== "string") ||
    !Array.isArray(parsed.warnings) ||
    parsed.warnings.some((entry) => typeof entry !== "string") ||
    !Array.isArray(parsed.reasons) ||
    parsed.reasons.some((entry) => typeof entry !== "string")
  ) {
    return probeError("MXC SDK probe returned an invalid response");
  }
  const warnings = parsed.warnings as string[];
  const reasons = parsed.reasons as string[];
  const tier = typeof parsed.tier === "string" ? parsed.tier : null;
  const probes: MxcBackendProbeFacts = {
    baseContainerApiPresent: tier === "base-container" ? true : null,
    bfscfgPresent: null,
    bfsCompiledIn: null,
  };
  if (parsed.probeErrored || (parsed.supported && parsed.windowsUnsupported)) {
    return probeError(
      reasons.join(" ") || "MXC SDK probe could not verify this Windows installation",
    );
  }
  if (parsed.windowsUnsupported && !parsed.supported) {
    return {
      outcome: "unsupported",
      windowsUnsupported: true,
      supportsProtectedPathDenies: parsed.supportsProtectedPathDenies,
      tier,
      needsDaclAugmentation: parsed.needsDaclAugmentation,
      degraded: true,
      warnings,
      probes,
      reason: reasons.join(" ") || "This Windows installation does not support MXC containment",
    };
  }
  if (
    !parsed.supported ||
    tier !== "base-container" ||
    parsed.needsDaclAugmentation ||
    !parsed.supportsProtectedPathDenies
  ) {
    return probeError(
      reasons.join(" ") || "MXC did not verify BaseContainer with protected-path denies",
    );
  }
  return {
    outcome: "supported",
    windowsUnsupported: false,
    supportsProtectedPathDenies: true,
    tier,
    needsDaclAugmentation: false,
    degraded: false,
    warnings,
    probes,
    reason: null,
  };
}

export function describeMxcExactBackendEligibility(
  probe: MxcProbeResult,
): MxcExactBackendEligibility {
  if (probe.outcome === "supported") {
    return {
      eligible: true,
      summary: null,
      blockers: [],
      remediation: [],
    };
  }

  const blockers = [probe.reason ?? "The MXC BaseContainer probe failed"];
  const remediation = [
    probe.windowsUnsupported === true
      ? "Use a supported Windows client build to enable sandboxing."
      : "Repair the bundled MXC SDK and retry. A failed or uncertain probe never permits host fallback.",
  ];

  return {
    eligible: false,
    summary: blockers.join(" "),
    blockers,
    remediation,
  };
}

export function getMxcTierWarning(probe: MxcProbeResult): string | null {
  if (!probe.degraded) return null;
  return `Rejected degraded MXC containment: ${probe.tier ?? "unknown tier"}${
    probe.needsDaclAugmentation ? " requires host DACL augmentation" : ""
  }. This mode cannot enforce the configured folder policy exactly.`;
}

export function classifyMxcSmoke(value: unknown, expectedMarker: string): MxcSmokeResult {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const payload =
    record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
      ? (record.payload as Record<string, unknown>)
      : record;
  const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
  const stderr = typeof payload.stderr === "string" ? payload.stderr : "";
  const error =
    typeof record.error === "string"
      ? record.error
      : typeof payload.error === "string"
        ? payload.error
        : "";
  const combined = `${stderr}\n${error}`.trim();
  const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : null;

  if (payload.timedOut === true)
    return { outcome: "timed-out", reason: "Contained smoke timed out" };
  if (/approval|allowlist|user denied|exec-approvals/i.test(combined)) {
    return { outcome: "approval-required", reason: combined || "Local approval is required" };
  }
  if (/sandbox.*unavailable|host fallback.*blocked|mxc.*unavailable/i.test(combined)) {
    return { outcome: "sandbox-unavailable", reason: combined };
  }
  if (/0x?c0000142|dll initialization failed|access is denied|access denied/i.test(combined)) {
    return { outcome: "child-launch-failed", reason: combined };
  }
  if (exitCode === 0 && stdout.includes(expectedMarker)) {
    return { outcome: "passed", reason: "Contained external child process completed" };
  }
  return {
    outcome: "failed",
    reason: combined || `Contained smoke exited ${exitCode ?? "without a result"}`,
  };
}

export function canonicalizeApprovedCwd(
  cwd: string,
  approvedFolders: WindowsNodeMxcFolder[],
  realpath: (candidate: string) => string,
): CanonicalCwdResult {
  if (!path.win32.isAbsolute(cwd)) {
    return {
      allowed: false,
      canonicalPath: null,
      access: null,
      reason: "cwd must be an absolute Windows path",
    };
  }

  let canonicalCwd: string;
  try {
    canonicalCwd = normalizeWindowsPath(realpath(path.win32.normalize(cwd)));
  } catch (error) {
    return {
      allowed: false,
      canonicalPath: null,
      access: null,
      reason: `cwd cannot be resolved without following reparse points: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const matches: Array<{ root: string; access: SandboxFolderAccess }> = [];
  for (const folder of approvedFolders) {
    try {
      const root = normalizeWindowsPath(realpath(path.win32.normalize(folder.path)));
      if (isWithinWindowsRoot(canonicalCwd, root)) matches.push({ root, access: folder.access });
    } catch {
      continue;
    }
  }
  matches.sort((left, right) => right.root.length - left.root.length);
  const match = matches[0];
  if (!match) {
    return {
      allowed: false,
      canonicalPath: canonicalCwd,
      access: null,
      reason: "cwd is outside every globally approved folder",
    };
  }
  return {
    allowed: true,
    canonicalPath: canonicalCwd,
    access: match.access,
    reason: null,
  };
}

export function assertWindowsNodeMxcFolderPolicyMutable(
  desiredEnabled: boolean,
  securityTransitionInProgress = false,
  folderMutationInProgress = false,
): void {
  if (desiredEnabled) {
    throw new Error("Disable Windows Node + MXC mode before changing its approved folder policy");
  }
  if (securityTransitionInProgress) {
    throw new Error(
      "Wait for the Windows Node + MXC security-mode transition before changing its approved folder policy",
    );
  }
  if (folderMutationInProgress) {
    throw new Error("Another approved folder policy change is already in progress");
  }
}

export function validateWindowsNodeMxcFolderPath(
  candidate: string,
  realpath: (candidate: string) => string,
  isReparsePoint: (candidate: string) => boolean,
): WindowsNodeMxcFolderPathResult {
  const normalizedInput = normalizeWindowsPathPreservingCase(candidate);
  if (
    !/^[a-z]:\\/i.test(normalizedInput) ||
    normalizedInput.startsWith("\\\\") ||
    normalizedInput.startsWith("\\\\?\\") ||
    normalizedInput.startsWith("\\??\\") ||
    normalizedInput.toLowerCase().startsWith("\\device\\")
  ) {
    return { ok: false, canonicalPath: null, reason: "path-nonlocal" };
  }

  const parsed = path.win32.parse(normalizedInput);
  let current = parsed.root;
  try {
    for (const component of normalizedInput.slice(parsed.root.length).split("\\").filter(Boolean)) {
      current = path.win32.join(current, component);
      if (isReparsePoint(current)) {
        return { ok: false, canonicalPath: null, reason: "path-reparse-point" };
      }
    }
  } catch {
    return { ok: false, canonicalPath: null, reason: "path-not-found" };
  }

  let canonicalPath: string;
  try {
    canonicalPath = normalizeWindowsPathPreservingCase(realpath(normalizedInput));
  } catch {
    return { ok: false, canonicalPath: null, reason: "path-not-found" };
  }
  if (normalizeWindowsPath(canonicalPath) !== normalizeWindowsPath(normalizedInput)) {
    return { ok: false, canonicalPath: null, reason: "path-reparse-point" };
  }

  return { ok: true, canonicalPath };
}

export interface WindowsNodeMxcCompleteFolderPolicyResult {
  ok: boolean;
  reason?: WindowsNodeMxcFolderPolicyReason;
  path?: string;
  dirs: WindowsNodeMxcFolderLists;
}

export function normalizeWindowsNodeMxcFolderPolicy(
  draft: WindowsNodeMxcFolderLists,
  validate: (candidate: string) => WindowsNodeMxcFolderPathResult,
): WindowsNodeMxcCompleteFolderPolicyResult {
  const requested = [
    ...draft.ro.map((folderPath) => ({ path: folderPath, access: "ro" as const })),
    ...draft.rw.map((folderPath) => ({ path: folderPath, access: "rw" as const })),
  ];
  const unique = new Map<string, { path: string; access: SandboxFolderAccess }>();
  for (const entry of requested) {
    const validation = validate(entry.path);
    if (!validation.ok || !validation.canonicalPath) {
      return {
        ok: false,
        reason: validation.reason ?? "path-not-found",
        path: entry.path,
        dirs: { rw: [], ro: [] },
      };
    }
    const key = normalizeWindowsPath(validation.canonicalPath);
    const existing = unique.get(key);
    if (existing && existing.access !== entry.access) {
      return {
        ok: false,
        reason: "duplicate",
        path: validation.canonicalPath,
        dirs: { rw: [], ro: [] },
      };
    }
    unique.set(key, { path: validation.canonicalPath, access: entry.access });
  }

  const entries = [...unique.values()];
  return {
    ok: true,
    dirs: {
      rw: entries
        .filter((entry) => entry.access === "rw")
        .map((entry) => entry.path)
        .sort(compareWindowsPaths),
      ro: entries
        .filter((entry) => entry.access === "ro")
        .map((entry) => entry.path)
        .sort(compareWindowsPaths),
    },
  };
}

export function planWindowsNodeMxcFolderUpsert(
  current: WindowsNodeMxcFolderLists,
  canonicalPath: string,
  access: SandboxFolderAccess,
): WindowsNodeMxcFolderPlan {
  const rw = dedupeWindowsPaths(current.rw);
  const ro = dedupeWindowsPaths(current.ro);
  const target = access === "rw" ? rw : ro;
  const normalizedCandidate = normalizeWindowsPathPreservingCase(canonicalPath);
  const candidateKey = normalizeWindowsPath(normalizedCandidate);
  const equal = (value: string) => normalizeWindowsPath(value) === candidateKey;

  if (target.some(equal)) {
    return {
      ok: false,
      reason: "duplicate",
      dirs: { rw, ro },
    };
  }

  const nextRw = rw.filter((value) => !equal(value));
  const nextRo = ro.filter((value) => !equal(value));
  (access === "rw" ? nextRw : nextRo).push(normalizedCandidate);

  return {
    ok: true,
    dirs: {
      rw: nextRw.sort(compareWindowsPaths),
      ro: nextRo.sort(compareWindowsPaths),
    },
  };
}

export function isWindowsNodeMxcFolderConfigured(
  current: WindowsNodeMxcFolderLists,
  candidate: string,
): boolean {
  const key = normalizeWindowsPath(candidate);
  return [...current.rw, ...current.ro].some((value) => normalizeWindowsPath(value) === key);
}

export function listConfiguredSandboxFolders(
  settings: WindowsNodeMxcSettings,
  userProfile: string,
): WindowsNodeMxcFolder[] {
  const folders: WindowsNodeMxcFolder[] = [];
  const add = (folderPath: string, value: number | null | undefined) => {
    if (value !== 0 && value !== 1) return;
    folders.push({ path: folderPath, access: value === 1 ? "rw" : "ro" });
  };
  add(path.win32.join(userProfile, "Documents"), settings.SandboxDocumentsAccess);
  add(path.win32.join(userProfile, "Downloads"), settings.SandboxDownloadsAccess);
  add(path.win32.join(userProfile, "Desktop"), settings.SandboxDesktopAccess);
  for (const custom of settings.SandboxCustomFolders ?? []) {
    if (typeof custom.Path !== "string" || !custom.Path.trim()) continue;
    add(custom.Path.trim(), custom.Access);
  }
  return folders;
}

function probeError(reason: string): MxcProbeResult {
  return {
    outcome: "error",
    windowsUnsupported: false,
    supportsProtectedPathDenies: false,
    tier: null,
    needsDaclAugmentation: false,
    degraded: false,
    warnings: [],
    probes: {
      baseContainerApiPresent: null,
      bfscfgPresent: null,
      bfsCompiledIn: null,
    },
    reason,
  };
}

function normalizeWindowsPath(value: string): string {
  return normalizeWindowsPathPreservingCase(value).toLowerCase();
}

function normalizeWindowsPathPreservingCase(value: string): string {
  const normalized = path.win32.normalize(value);
  const parsed = path.win32.parse(normalized);
  const withoutTrailing =
    normalized.length > parsed.root.length ? normalized.replace(/[\\]+$/, "") : normalized;
  return withoutTrailing;
}

function isWithinWindowsRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith("\\") ? root : `${root}\\`);
}

function dedupeWindowsPaths(values: string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of values) {
    const key = normalizeWindowsPath(value);
    if (!unique.has(key)) unique.set(key, normalizeWindowsPathPreservingCase(value));
  }
  return [...unique.values()].sort(compareWindowsPaths);
}

function compareWindowsPaths(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function isLoopbackAddress(value: string): boolean {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1" ||
    normalized === "localhost" ||
    normalized.startsWith("127.")
  );
}
