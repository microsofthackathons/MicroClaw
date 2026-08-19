import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const WINDOWS_NODE_MXC_MODE = "windows-node-mxc";
export const WINDOWS_NODE_MXC_REQUIRED_COMMANDS = [
  "system.run",
  "system.run.prepare",
  "system.which",
] as const;
export const WINDOWS_NODE_MXC_REQUIRED_CWD_COMMAND = "system.run.cwd-policy";
export const WINDOWS_NODE_MXC_NODE_COMMANDS = [
  ...WINDOWS_NODE_MXC_REQUIRED_COMMANDS,
  WINDOWS_NODE_MXC_REQUIRED_CWD_COMMAND,
] as const;
export const WINDOWS_NODE_MXC_TOOL_ALLOWLIST = ["exec"] as const;
export const WINDOWS_NODE_MXC_LOCKED_TOOL_ALLOWLIST = [
  "__microclaw_windows_node_mxc_locked__",
] as const;
export const WINDOWS_NODE_MXC_TOOL_DENYLIST = ["process", "group:fs", "group:plugins"] as const;
export const WINDOWS_NODE_MXC_LOCKED_TOOL_DENYLIST = [
  "group:runtime",
  "group:fs",
  "group:plugins",
  "browser",
  "gateway",
  "nodes",
] as const;

export type WindowsNodeMxcGatewayPolicyState = "active" | "locked" | "drift";

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

export interface MxcProbeResult {
  outcome: "supported" | "unsupported" | "error";
  tier: string | null;
  needsDaclAugmentation: boolean;
  degraded: boolean;
  warnings: string[];
  reason: string | null;
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

type AgentEntry = {
  id?: unknown;
  tools?: unknown;
  [key: string]: unknown;
};

type AgentToolsBackup = Record<string, unknown | null>;
const GATEWAY_NODES_BACKUP_KEY = "$microclaw.gateway.nodes";
const INGRESS_BACKUP_KEYS = {
  channels: "$microclaw.ingress.channels",
  cron: "$microclaw.ingress.cron",
  hooks: "$microclaw.ingress.hooks",
  plugins: "$microclaw.ingress.plugins",
} as const;

export interface WindowsNodeMxcPolicyApplication {
  config: Record<string, unknown>;
  backups: AgentToolsBackup;
  agentIds: string[];
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
      ask: "on-miss",
      timeoutSec: 1800,
      strictInlineEval: true,
    },
  };
}

export function buildWindowsNodeMxcLockedToolPolicy(nodeId: string): Record<string, unknown> {
  return {
    ...buildWindowsNodeMxcToolPolicy(nodeId),
    // OpenClaw treats an empty allow list as unrestricted. This non-tool sentinel
    // makes the allow policy restrictive while matching no runtime tool.
    allow: [...WINDOWS_NODE_MXC_LOCKED_TOOL_ALLOWLIST],
    deny: [...WINDOWS_NODE_MXC_LOCKED_TOOL_DENYLIST],
  };
}

export function applyWindowsNodeMxcGatewayPolicy(
  source: Record<string, unknown>,
  nodeId: string,
  existingBackups: AgentToolsBackup = {},
  state: Exclude<WindowsNodeMxcGatewayPolicyState, "drift"> = "active",
): WindowsNodeMxcPolicyApplication {
  const config = structuredClone(source);
  const agents =
    config.agents && typeof config.agents === "object" && !Array.isArray(config.agents)
      ? (config.agents as Record<string, unknown>)
      : {};
  const list = Array.isArray(agents.list) ? (agents.list as AgentEntry[]) : [];
  if (list.length === 0) {
    throw new Error("Windows Node + MXC mode requires at least one configured agent");
  }

  const policy =
    state === "active"
      ? buildWindowsNodeMxcToolPolicy(nodeId)
      : buildWindowsNodeMxcLockedToolPolicy(nodeId);
  const backups = structuredClone(existingBackups);
  const agentIds: string[] = [];
  for (const entry of list) {
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) throw new Error("Every configured agent must have a stable ID");
    if (!Object.hasOwn(backups, id)) {
      backups[id] = Object.hasOwn(entry, "tools") ? structuredClone(entry.tools) : null;
    }
    entry.tools = structuredClone(policy);
    agentIds.push(id);
  }

  agents.list = list;
  config.agents = agents;
  const gateway =
    config.gateway && typeof config.gateway === "object" && !Array.isArray(config.gateway)
      ? (config.gateway as Record<string, unknown>)
      : {};
  if (!Object.hasOwn(backups, GATEWAY_NODES_BACKUP_KEY)) {
    backups[GATEWAY_NODES_BACKUP_KEY] = Object.hasOwn(gateway, "nodes")
      ? structuredClone(gateway.nodes)
      : null;
  }
  const nodes =
    gateway.nodes && typeof gateway.nodes === "object" && !Array.isArray(gateway.nodes)
      ? (gateway.nodes as Record<string, unknown>)
      : {};
  nodes.allowCommands = [...WINDOWS_NODE_MXC_NODE_COMMANDS];
  nodes.denyCommands = [];
  gateway.nodes = nodes;
  config.gateway = gateway;
  for (const [field, backupKey] of Object.entries(INGRESS_BACKUP_KEYS)) {
    if (!Object.hasOwn(backups, backupKey)) {
      backups[backupKey] = Object.hasOwn(config, field) ? structuredClone(config[field]) : null;
    }
  }
  const channels = asRecord(config.channels);
  config.channels = Object.fromEntries(
    Object.entries(channels).map(([channelId, value]) => [
      channelId,
      { ...asRecord(value), enabled: false },
    ]),
  );
  const hooks = asRecord(config.hooks);
  config.hooks = {
    ...hooks,
    enabled: false,
    internal: { ...asRecord(hooks.internal), enabled: false },
  };
  config.cron = { ...asRecord(config.cron), enabled: false };
  const plugins = asRecord(config.plugins);
  const pluginEntries = asRecord(plugins.entries);
  config.plugins = {
    ...plugins,
    enabled: false,
    entries: Object.fromEntries(
      Object.entries(pluginEntries).map(([pluginId, value]) => [
        pluginId,
        { ...asRecord(value), enabled: false },
      ]),
    ),
  };
  return { config, backups, agentIds };
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
  const list = agents && Array.isArray(agents.list) ? (agents.list as AgentEntry[]) : [];
  for (const entry of list) {
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id || !Object.hasOwn(backups, id)) continue;
    const previous = backups[id];
    if (previous === null) delete entry.tools;
    else entry.tools = structuredClone(previous);
  }
  if (Object.hasOwn(backups, GATEWAY_NODES_BACKUP_KEY)) {
    const gateway =
      config.gateway && typeof config.gateway === "object" && !Array.isArray(config.gateway)
        ? (config.gateway as Record<string, unknown>)
        : {};
    const previous = backups[GATEWAY_NODES_BACKUP_KEY];
    if (previous === null) {
      delete gateway.nodes;
      if (Object.keys(gateway).length === 0) delete config.gateway;
      else config.gateway = gateway;
    } else {
      gateway.nodes = structuredClone(previous);
      config.gateway = gateway;
    }
  }
  for (const [field, backupKey] of Object.entries(INGRESS_BACKUP_KEYS)) {
    if (!Object.hasOwn(backups, backupKey)) continue;
    const previous = backups[backupKey];
    if (previous === null) delete config[field];
    else config[field] = structuredClone(previous);
  }
  return config;
}

export function validateWindowsNodeMxcGatewayPolicy(
  config: unknown,
  nodeId: string,
  expectedState: Exclude<WindowsNodeMxcGatewayPolicyState, "drift"> | "either" = "active",
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
  const list = agents && Array.isArray(agents.list) ? (agents.list as AgentEntry[]) : [];
  if (list.length === 0) blockers.push("No configured agents are protected by the MXC policy");

  const active = buildWindowsNodeMxcToolPolicy(nodeId);
  const locked = buildWindowsNodeMxcLockedToolPolicy(nodeId);
  for (const entry of list) {
    const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : "<unknown>";
    const matchesActive = isDeepStrictEqual(entry.tools, active);
    const matchesLocked = isDeepStrictEqual(entry.tools, locked);
    const matchesExpected =
      expectedState === "either"
        ? matchesActive || matchesLocked
        : expectedState === "active"
          ? matchesActive
          : matchesLocked;
    if (!matchesExpected) {
      blockers.push(`Agent "${id}" tool policy drifted from exec-only Windows-node routing`);
    }
  }

  const globalTools =
    root.tools && typeof root.tools === "object" && !Array.isArray(root.tools)
      ? (root.tools as Record<string, unknown>)
      : null;
  const globalDeny = globalTools && Array.isArray(globalTools.deny) ? globalTools.deny : [];
  if (globalDeny.some((value) => value === "exec" || value === "group:runtime")) {
    blockers.push("Global Gateway tool policy blocks node exec");
  }
  const gateway =
    root.gateway && typeof root.gateway === "object" && !Array.isArray(root.gateway)
      ? (root.gateway as Record<string, unknown>)
      : null;
  const nodes =
    gateway?.nodes && typeof gateway.nodes === "object" && !Array.isArray(gateway.nodes)
      ? (gateway.nodes as Record<string, unknown>)
      : null;
  const allowCommands = Array.isArray(nodes?.allowCommands) ? nodes.allowCommands : [];
  const denyCommands = Array.isArray(nodes?.denyCommands) ? nodes.denyCommands : [];
  if (!isDeepStrictEqual(allowCommands, [...WINDOWS_NODE_MXC_NODE_COMMANDS])) {
    blockers.push("Gateway node command allowlist drifted from the bundled system-only surface");
  }
  if (!isDeepStrictEqual(denyCommands, [])) {
    blockers.push("Gateway node command denylist conflicts with the bundled system-only surface");
  }
  const cron = asRecord(root.cron);
  if (cron.enabled !== false) blockers.push("Gateway cron ingress must remain disabled");
  const hooks = asRecord(root.hooks);
  if (hooks.enabled !== false) blockers.push("Gateway webhook ingress must remain disabled");
  if (asRecord(hooks.internal).enabled !== false) {
    blockers.push("Gateway internal-hook ingress must remain disabled");
  }
  const channels = asRecord(root.channels);
  for (const [channelId, value] of Object.entries(channels)) {
    if (asRecord(value).enabled !== false) {
      blockers.push(`Gateway channel "${channelId}" must remain disabled`);
    }
  }
  const plugins = asRecord(root.plugins);
  if (plugins.enabled !== false) blockers.push("Gateway plugins must remain disabled");
  for (const [pluginId, value] of Object.entries(asRecord(plugins.entries))) {
    if (asRecord(value).enabled !== false) {
      blockers.push(`Gateway plugin "${pluginId}" must remain disabled`);
    }
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
    [
      "SystemRunAllowWindowsUi",
      "Windows UI APIs must be allowed for PowerShell compatibility with MXC 0.7",
    ],
  ];
  for (const [property, message] of requiredTrue) {
    if (settings[property] !== true) blockers.push(message);
  }

  const requiredFalse: Array<[keyof WindowsNodeMxcSettings, string]> = [
    ["SystemRunAllowOutbound", "Outbound network access must remain blocked"],
    ["EnableMcpServer", "Local MCP must remain disabled for this mode"],
    ["NodeCanvasEnabled", "Canvas capability must be disabled"],
    ["NodeScreenEnabled", "Screen capability must be disabled"],
    ["NodeCameraEnabled", "Camera capability must be disabled"],
    ["NodeLocationEnabled", "Location capability must be disabled"],
    ["NodeBrowserProxyEnabled", "Browser proxy capability must be disabled"],
    ["NodeSttEnabled", "Speech-to-text capability must be disabled"],
    ["NodeTtsEnabled", "Text-to-speech capability must be disabled"],
  ];
  for (const [property, message] of requiredFalse) {
    if (settings[property] !== false) blockers.push(message);
  }

  if (settings.SandboxClipboard !== 0) blockers.push("Sandbox clipboard policy must be None");

  warnings.push(
    "allowWindowsUi is a PowerShell compatibility relaxation; it does not enable screen, input, canvas, camera, microphone, browser, location, or speech capabilities.",
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
  const allowedCommands = new Set<string>(WINDOWS_NODE_MXC_NODE_COMMANDS);
  const unexpectedCommands = node.commands.filter((command) => !allowedCommands.has(command));
  if (unexpectedCommands.length > 0) {
    blockers.push(`Selected node declares unexpected commands: ${unexpectedCommands.join(", ")}`);
  }
  return { ready: blockers.length === 0, blockers, warnings };
}

export function validateEffectiveToolNames(
  toolNames: string[],
  expectedState: Exclude<WindowsNodeMxcGatewayPolicyState, "drift"> = "active",
): WindowsNodeReadiness {
  const unique = [...new Set(toolNames)].sort();
  const expected = expectedState === "active" ? ["exec"] : [];
  const blockers = isDeepStrictEqual(unique, expected)
    ? []
    : [
        `Effective Gateway tools must be ${
          expectedState === "active" ? 'exactly "exec"' : "empty while readiness is locked"
        }; observed: ${unique.join(", ") || "none"}`,
      ];
  return { ready: blockers.length === 0, blockers, warnings: [] };
}

export function classifyMissingEffectiveToolSession(
  agentId: string,
  expectedState: Exclude<WindowsNodeMxcGatewayPolicyState, "drift">,
): WindowsNodeReadiness {
  if (expectedState === "locked") {
    return {
      ready: true,
      blockers: [],
      warnings: [
        `Agent "${agentId}" has no persisted session; the locked config applies before its first session is created`,
      ],
    };
  }
  return {
    ready: true,
    blockers: [],
    warnings: [
      `Agent "${agentId}" has no persisted session; the exact active config applies before its first session is created`,
    ],
  };
}

export function extractEffectiveToolNames(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("tools.effective returned a non-object payload");
  }
  const groups = (payload as Record<string, unknown>).groups;
  if (!Array.isArray(groups)) {
    throw new Error("tools.effective did not return a groups inventory");
  }

  const names = new Set<string>();
  for (const group of groups) {
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      throw new Error("tools.effective returned a malformed group");
    }
    const tools = (group as Record<string, unknown>).tools;
    if (!Array.isArray(tools)) {
      throw new Error("tools.effective returned a group without a tools inventory");
    }
    for (const tool of tools) {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
        throw new Error("tools.effective returned a malformed tool entry");
      }
      const id = (tool as Record<string, unknown>).id;
      if (typeof id !== "string" || !id.trim()) {
        throw new Error("tools.effective returned a tool without a stable id");
      }
      names.add(id.trim());
    }
  }
  return [...names];
}

export async function listAgentSessionKeys(
  gateway: { request(method: string, params?: unknown): Promise<unknown> },
  agentIds: string[],
): Promise<Map<string, string>> {
  const payload = await gateway.request("sessions.list", { limit: 500 });
  const sessions =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).sessions
      : null;
  if (!Array.isArray(sessions)) {
    throw new Error("sessions.list did not return a sessions inventory");
  }

  const wanted = new Set(agentIds);
  const result = new Map<string, string>();
  let globalSessionKey = "";
  for (const value of sessions) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const session = value as Record<string, unknown>;
    const key =
      typeof session.key === "string"
        ? session.key.trim()
        : typeof session.sessionKey === "string"
          ? session.sessionKey.trim()
          : "";
    if (!key) continue;
    if (key === "global") globalSessionKey = key;
    const keyAgentId = /^agent:([^:]+):/i.exec(key)?.[1];
    const agentId =
      typeof session.agentId === "string" && session.agentId.trim()
        ? session.agentId.trim()
        : keyAgentId || (key === "global" ? "main" : "");
    if (wanted.has(agentId) && !result.has(agentId)) result.set(agentId, key);
  }
  // Pinned OpenClaw explicitly permits an operator tools.effective request to override
  // the agent on the trusted global session, so one persisted global session can attest
  // configured agents that have not yet created their own transcript.
  if (globalSessionKey) {
    for (const agentId of agentIds) {
      if (!result.has(agentId)) result.set(agentId, globalSessionKey);
    }
  }
  return result;
}

export function classifyMxcProbe(
  exitCode: number | null,
  stdout: string,
  stderr: string,
  launchError?: string,
): MxcProbeResult {
  if (launchError) return probeError(`wxc-exec --probe could not be launched: ${launchError}`);
  if (!stdout.trim()) {
    return probeError(
      `wxc-exec --probe ${exitCode === 0 ? "returned no output" : `exited ${exitCode}`}${
        stderr.trim() ? `: ${stderr.trim()}` : ""
      }`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return probeError("wxc-exec --probe returned unparseable output");
  }
  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (typeof parsed.error === "string" || parsed.supported === false) {
    return {
      outcome: "unsupported",
      tier: null,
      needsDaclAugmentation: false,
      degraded: false,
      warnings,
      reason:
        typeof parsed.error === "string"
          ? parsed.error
          : "No usable MXC isolation tier is available",
    };
  }
  if (exitCode !== 0) return probeError(`wxc-exec --probe exited ${exitCode}`);
  const tier = typeof parsed.tier === "string" ? parsed.tier.trim() : "";
  if (!tier) return probeError("wxc-exec --probe did not report an isolation tier");
  const normalizedTier = tier.toLowerCase();
  if (!["base-container", "appcontainer-bfs", "appcontainer-dacl"].includes(normalizedTier)) {
    return probeError(`wxc-exec --probe reported an unrecognized isolation tier: ${tier}`);
  }
  const needsDaclAugmentation = parsed.needsDaclAugmentation === true;
  return {
    outcome: "supported",
    tier,
    needsDaclAugmentation,
    degraded:
      needsDaclAugmentation || !["base-container", "appcontainer-bfs"].includes(normalizedTier),
    warnings,
    reason: null,
  };
}

export function getMxcTierWarning(probe: MxcProbeResult): string | null {
  if (probe.outcome !== "supported" || !probe.degraded) return null;
  return `Degraded MXC containment: ${probe.tier ?? "unknown tier"}${
    probe.needsDaclAugmentation ? " requires host DACL augmentation" : ""
  }. This mode remains usable but is weaker than base-container or appcontainer-bfs.`;
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
  sensitiveRoots: string[] = [],
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

  for (const sensitiveRoot of sensitiveRoots) {
    let canonicalSensitive: string;
    try {
      canonicalSensitive = normalizeWindowsPath(realpath(path.win32.normalize(sensitiveRoot)));
    } catch {
      canonicalSensitive = normalizeWindowsPath(sensitiveRoot);
    }
    if (isWithinWindowsRoot(canonicalCwd, canonicalSensitive)) {
      return {
        allowed: false,
        canonicalPath: canonicalCwd,
        access: null,
        reason: "cwd resolves into a sensitive denied root",
      };
    }
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
    tier: null,
    needsDaclAugmentation: false,
    degraded: false,
    warnings: [],
    reason,
  };
}

function normalizeWindowsPath(value: string): string {
  const parsed = path.win32.parse(value);
  const normalized = path.win32.normalize(value);
  const withoutTrailing =
    normalized.length > parsed.root.length ? normalized.replace(/[\\]+$/, "") : normalized;
  return withoutTrailing.toLowerCase();
}

function isWithinWindowsRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}\\`);
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
