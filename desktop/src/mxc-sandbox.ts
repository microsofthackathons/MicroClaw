import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

export const MXC_PLUGIN_ID = "microclaw-mxc";
export const MXC_ALLOWED_PLUGIN_IDS = [
  MXC_PLUGIN_ID,
  "github-copilot",
  "openclaw-weixin",
] as const;
export const MXC_SDK_VERSION = "0.7.0";
export const MXC_POLICY_VERSION = "0.7.0-alpha";
export const MXC_UPSTREAM_COMMIT = "34d7fe2b4b3226bd4d11dc4a32419b7ec198a88b";
export const MXC_TOOL_NAMES = ["mxc_read", "mxc_write", "mxc_edit", "mxc_exec"] as const;

const WXC_HASHES: Record<"x64" | "arm64", string> = {
  x64: "2wo0Ir6eGzlswbJUfHD/FrJ0EkOKMcEKRavzcMrIauI=",
  arm64: "5DDQ5PRPYW6R22hPjYJabck+BqEmK40AvKrHUioxeqs=",
};

const HOST_TOOL_DENY = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
  "code_execution",
  "browser",
  "canvas",
  "gateway",
  "nodes",
  "skill_workshop",
  "image_generate",
  "music_generate",
  "video_generate",
  "session_status",
  "group:fs",
  "group:runtime",
  "group:ui",
];

export interface MxcStoredAgentPolicy {
  readonlyPaths: string[];
  readwritePaths: string[];
}

export interface MxcAgentPolicy extends MxcStoredAgentPolicy {
  workspace: string;
  deniedPaths: string[];
}

export interface MxcProbeResult {
  tier?: "base-container" | "appcontainer-bfs" | "appcontainer-dacl";
  warnings: string[];
  uiCapabilities?: Record<string, boolean>;
}

export interface MxcRuntimeStatus {
  ready: boolean;
  packageReady: boolean;
  hashReady: boolean;
  osSupported: boolean;
  policyReady: boolean;
  workerReady: boolean;
  sdkVersion: string;
  policyVersion: string;
  upstreamCommit: string;
  architecture: string;
  binaryHash: string | null;
  isolationTier: MxcProbeResult["tier"] | null;
  isolationWarnings: string[];
  uiCapabilities?: Record<string, boolean>;
  requiresHostPreparation: boolean;
  lastError: string | null;
  effectivePolicies: Record<string, MxcAgentPolicy>;
}

export interface MxcFolderValidationOptions {
  existing: Array<{ path: string; access: "ro" | "rw" }>;
  blockedRoots: string[];
  blockedExact?: string[];
}

type MxcRuntimeModule = {
  probeMxcRuntime(): Promise<{
    packageVersion: string;
    binaryHash: string;
    platform: string;
    architecture: string;
    probe: MxcProbeResult;
  }>;
  runMxcWorker(
    policy: MxcAgentPolicy,
    request: Record<string, unknown>,
    options?: { timeoutMs?: number; nodeExecutable?: string },
  ): Promise<{ ok: boolean; error?: string }>;
};

const nativeDynamicImport = Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<MxcRuntimeModule>;

function normalizeForComparison(input: string): string {
  const resolved = path.resolve(input);
  const withoutTrailing = resolved.replace(/[\\/]+$/, "");
  return (withoutTrailing || path.parse(resolved).root).toLowerCase();
}

export function isPathAtOrInside(candidate: string, root: string): boolean {
  const child = normalizeForComparison(candidate);
  const parent = normalizeForComparison(root);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

export function pathsOverlap(left: string, right: string): boolean {
  return isPathAtOrInside(left, right) || isPathAtOrInside(right, left);
}

export function expectedWxcHash(arch: string = process.arch): string {
  return WXC_HASHES[arch === "arm64" ? "arm64" : "x64"];
}

export function sha256Base64(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("base64");
}

export function parseMxcProbe(input: unknown): MxcProbeResult {
  const value =
    typeof input === "string"
      ? (JSON.parse(input) as Record<string, unknown>)
      : ((input ?? {}) as Record<string, unknown>);
  const tier =
    value.tier === "base-container" ||
    value.tier === "appcontainer-bfs" ||
    value.tier === "appcontainer-dacl"
      ? value.tier
      : undefined;
  const warnings = Array.isArray(value.warnings)
    ? value.warnings.filter((item): item is string => typeof item === "string")
    : [];
  const probes =
    value.probes && typeof value.probes === "object"
      ? (value.probes as Record<string, unknown>)
      : undefined;
  const uiCapabilities =
    probes?.uiCapabilities && typeof probes.uiCapabilities === "object"
      ? Object.fromEntries(
          Object.entries(probes.uiCapabilities as Record<string, unknown>).filter(
            (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
          ),
        )
      : undefined;
  return { tier, warnings, uiCapabilities };
}

export function stripMxcWorkerEnvironment(
  source: NodeJS.ProcessEnv,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT"]) {
    const value = source[key];
    if (value) output[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    output[key] = value;
  }
  return output;
}

export function resolveMxcPluginDir(
  packaged: boolean,
  resourcesPath: string,
  moduleDir = __dirname,
): string {
  return packaged
    ? path.join(resourcesPath, "mxc-plugin")
    : path.resolve(moduleDir, "..", "mxc-plugin");
}

export function buildMxcAgentPolicies(
  agentIds: string[],
  stored: Record<string, MxcStoredAgentPolicy>,
  workspaceRoot: string,
  deniedPaths: string[],
): Record<string, MxcAgentPolicy> {
  const result: Record<string, MxcAgentPolicy> = {};
  for (const rawId of agentIds) {
    const agentId = rawId === "main" ? "main" : rawId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const desired = stored[rawId] ?? { readonlyPaths: [], readwritePaths: [] };
    result[rawId] = {
      workspace: path.join(workspaceRoot, agentId),
      readonlyPaths: [...desired.readonlyPaths],
      readwritePaths: [...desired.readwritePaths],
      deniedPaths: [...deniedPaths],
    };
  }
  return result;
}

export function ensureMxcSecurityConfig(
  config: Record<string, any>,
  pluginPath: string,
  policies: Record<string, MxcAgentPolicy>,
): boolean {
  const before = JSON.stringify(config);
  config.plugins ??= {};
  config.plugins.enabled = true;
  config.plugins.load ??= {};
  config.plugins.load.paths = [pluginPath];
  config.plugins.allow = [...MXC_ALLOWED_PLUGIN_IDS];
  if (Array.isArray(config.plugins.deny)) {
    config.plugins.deny = config.plugins.deny.filter(
      (id: unknown) =>
        typeof id === "string" && !MXC_ALLOWED_PLUGIN_IDS.some((allowed) => allowed === id),
    );
  }
  config.plugins.entries ??= {};
  config.plugins.entries[MXC_PLUGIN_ID] = {
    ...(config.plugins.entries[MXC_PLUGIN_ID] ?? {}),
    enabled: true,
    config: {
      sdkVersion: MXC_SDK_VERSION,
      policyVersion: MXC_POLICY_VERSION,
      upstreamCommit: MXC_UPSTREAM_COMMIT,
      fallback: { allowDaclMutation: false },
      agents: policies,
    },
  };

  const tools = (config.tools ??= {});
  tools.profile = "minimal";
  tools.allow = [...MXC_TOOL_NAMES];
  delete tools.alsoAllow;
  tools.deny = [...new Set([...(Array.isArray(tools.deny) ? tools.deny : []), ...HOST_TOOL_DENY])];
  tools.elevated = { ...(tools.elevated ?? {}), enabled: false, allowFrom: {} };
  tools.codeMode = { enabled: false };
  delete tools.bash;
  tools.exec = {
    ...(tools.exec ?? {}),
    applyPatch: { ...(tools.exec?.applyPatch ?? {}), enabled: false, allowModels: [] },
  };
  delete config.sandbox;
  config.agents ??= {};
  config.agents.defaults ??= {};
  delete config.agents.defaults.tools;
  config.agents.defaults.sandbox = { mode: "off" };
  if (Array.isArray(config.agents.list)) {
    for (const agent of config.agents.list) {
      if (agent && typeof agent === "object" && !Array.isArray(agent)) {
        delete agent.sandbox;
        delete agent.tools;
      }
    }
  }
  return before !== JSON.stringify(config);
}

export async function validateMxcFolder(
  candidate: string,
  options: MxcFolderValidationOptions,
): Promise<string> {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
    throw new Error("Choose an existing absolute folder.");
  }
  const canonical = await fs.promises.realpath(candidate);
  if (!(await fs.promises.stat(canonical)).isDirectory()) {
    throw new Error("The selected path is not a folder.");
  }
  if (normalizeForComparison(canonical) === normalizeForComparison(path.parse(canonical).root)) {
    throw new Error("Drive and filesystem roots cannot be shared.");
  }
  for (const blocked of options.blockedRoots) {
    if (blocked) {
      const canonicalBlocked = await canonicalizePolicyPath(blocked);
      if (pathsOverlap(canonical, canonicalBlocked)) {
        throw new Error(`This sensitive location cannot be shared: ${blocked}`);
      }
    }
  }
  for (const blocked of options.blockedExact ?? []) {
    if (blocked) {
      const canonicalBlocked = await canonicalizePolicyPath(blocked);
      if (normalizeForComparison(canonical) === normalizeForComparison(canonicalBlocked)) {
        throw new Error(`This broad location cannot be shared: ${blocked}`);
      }
    }
  }
  const sensitiveSegments =
    /(^|[\\/])(\.ssh|\.gnupg|\.aws|\.azure|\.docker|\.kube|credentials?|docker|wsl|browser profiles?)([\\/]|$)/i;
  if (sensitiveSegments.test(canonical)) {
    throw new Error("Credential, browser, Docker, and WSL data folders cannot be shared.");
  }
  for (const current of options.existing) {
    if (pathsOverlap(canonical, current.path)) {
      throw new Error(`Folder policies cannot overlap: ${current.path}`);
    }
  }
  return canonical;
}

async function canonicalizePolicyPath(candidate: string): Promise<string> {
  try {
    return await fs.promises.realpath(candidate);
  } catch (error: any) {
    if (error?.code === "ENOENT") return path.resolve(candidate);
    throw new Error(`Cannot validate sensitive path ${candidate}: ${error?.message || error}`, {
      cause: error,
    });
  }
}

export function createInitialMxcStatus(): MxcRuntimeStatus {
  return {
    ready: false,
    packageReady: false,
    hashReady: false,
    osSupported: false,
    policyReady: false,
    workerReady: false,
    sdkVersion: MXC_SDK_VERSION,
    policyVersion: MXC_POLICY_VERSION,
    upstreamCommit: MXC_UPSTREAM_COMMIT,
    architecture: process.arch,
    binaryHash: null,
    isolationTier: null,
    isolationWarnings: [],
    requiresHostPreparation: false,
    lastError: "MXC has not been initialized.",
    effectivePolicies: {},
  };
}

export function assertMxcReadyForChat(status: MxcRuntimeStatus): void {
  if (!status.ready) {
    throw new Error(
      `Microsoft MXC tool containment is not ready. No host-tool fallback is allowed. ${
        status.lastError ?? "Open Settings > Security and retry initialization."
      }`,
    );
  }
}

export class MxcRuntimeManager {
  private status = createInitialMxcStatus();

  getStatus(): MxcRuntimeStatus {
    return structuredClone(this.status);
  }

  markPolicyPending(): void {
    this.status.ready = false;
    this.status.policyReady = false;
    this.status.workerReady = false;
    this.status.effectivePolicies = {};
    this.status.lastError = "Folder policy changes are pending MXC reinitialization.";
  }

  markExternalGateway(): void {
    this.status.ready = false;
    this.status.policyReady = false;
    this.status.workerReady = false;
    this.status.effectivePolicies = {};
    this.status.lastError =
      "The running Gateway is externally managed, so MXC policy and worker state are not proven.";
  }

  markGatewayUnavailable(): void {
    this.status.ready = false;
    this.status.policyReady = false;
    this.status.workerReady = false;
    this.status.effectivePolicies = {};
    this.status.lastError =
      "The MXC-verified Gateway exited. Restart MicroClaw before running agent tools.";
  }

  markBlocked(reason: string): void {
    this.status.ready = false;
    this.status.policyReady = false;
    this.status.workerReady = false;
    this.status.effectivePolicies = {};
    this.status.lastError = reason;
  }

  async initialize(
    pluginDir: string,
    policies: Record<string, MxcAgentPolicy>,
    nodeExecutable?: string,
  ): Promise<MxcRuntimeStatus> {
    this.status = createInitialMxcStatus();
    try {
      if (process.platform !== "win32") {
        throw new Error("This experimental POC currently supports Windows only.");
      }
      for (const policy of Object.values(policies)) {
        await fs.promises.mkdir(policy.workspace, { recursive: true });
      }
      const runtimeUrl = pathToFileURL(path.join(pluginDir, "runtime.mjs")).href;
      const runtime = await nativeDynamicImport(runtimeUrl);
      const proof = await runtime.probeMxcRuntime();
      this.status.packageReady = proof.packageVersion === MXC_SDK_VERSION;
      this.status.hashReady = proof.binaryHash === expectedWxcHash(proof.architecture);
      this.status.binaryHash = proof.binaryHash;
      this.status.architecture = proof.architecture;
      this.status.osSupported = proof.platform === "win32";
      this.status.isolationTier = proof.probe.tier ?? null;
      this.status.isolationWarnings = proof.probe.warnings;
      this.status.uiCapabilities = proof.probe.uiCapabilities;
      this.status.requiresHostPreparation = proof.probe.tier === "appcontainer-dacl";
      if (!this.status.packageReady) {
        throw new Error(`Expected @microsoft/mxc-sdk ${MXC_SDK_VERSION}.`);
      }
      if (!this.status.hashReady) {
        throw new Error("The packaged wxc-exec hash does not match Microsoft's pinned payload.");
      }
      if (!proof.probe.tier) {
        throw new Error("wxc-exec --probe did not report a recognized isolation tier.");
      }
      this.status.policyReady = true;
      if (proof.probe.tier === "appcontainer-dacl") {
        throw new Error(
          "This host requires MXC's DACL-mutation fallback, which this fail-closed POC does not support. No ACL was changed. Host preparation is administrator-only and does not by itself grant this POC consent to mutate folder DACLs.",
        );
      }
      const effective: Record<string, MxcAgentPolicy> = {};
      for (const [agentId, policy] of Object.entries(policies)) {
        const result = await runtime.runMxcWorker(
          policy,
          { operation: "ping" },
          { timeoutMs: 5000, nodeExecutable },
        );
        if (!result.ok) throw new Error(result.error || `MXC worker proof failed for ${agentId}.`);
        effective[agentId] = policy;
      }
      this.status.workerReady = true;
      this.status.effectivePolicies = effective;
      this.status.ready = true;
      this.status.lastError = null;
    } catch (error) {
      this.status.ready = false;
      this.status.workerReady = false;
      this.status.effectivePolicies = {};
      this.status.lastError = error instanceof Error ? error.message : String(error);
    }
    return this.getStatus();
  }
}
