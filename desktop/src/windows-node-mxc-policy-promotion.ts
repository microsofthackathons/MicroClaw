import { validateWindowsNodeMxcGatewayPolicy, type AgentToolsBackup } from "./windows-node-mxc";
import { readAgentRoster } from "./agent-roster";
import { isDeepStrictEqual } from "node:util";

export type GatewayConfigSnapshot = {
  config?: unknown;
  hash?: unknown;
  configRevisionHash?: unknown;
  appliedConfigHash?: unknown;
};

const SAFE_GATEWAY_ERROR_CODES = new Set([
  "BAD_REQUEST",
  "CONFLICT",
  "FORBIDDEN",
  "INTERNAL_ERROR",
  "INVALID_REQUEST",
  "NOT_FOUND",
  "RATE_LIMITED",
  "TIMEOUT",
  "UNAUTHORIZED",
  "UNAVAILABLE",
]);

type GenerationBoundGatewayOptions = {
  gateway: {
    request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  };
  nodeId: string;
  expectedGeneration: string;
  currentGeneration: () => string;
  isCurrent: () => boolean;
  requestTimeoutMs: number;
};

export type WindowsNodeMxcPolicyPromotionOptions = GenerationBoundGatewayOptions & {
  backups: AgentToolsBackup;
  agentReadinessTimeoutMs: number;
  agentReadinessPollIntervalMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

export type WindowsNodeMxcPolicyPromotionResult = {
  backups: AgentToolsBackup;
  appliedHash: string;
};

export type WindowsNodeMxcAgentReadinessOptions = GenerationBoundGatewayOptions & {
  timeoutMs: number;
  pollIntervalMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

export async function waitForWindowsNodeMxcAgentReadiness(
  options: WindowsNodeMxcAgentReadinessOptions,
): Promise<void> {
  if (options.timeoutMs <= 0 || options.pollIntervalMs <= 0) {
    throw new Error("MXC agent database readiness timings must be positive");
  }

  const lockedSnapshot = await readAppliedSnapshot(options, "locked");
  await waitForAgentReadiness(options, lockedSnapshot.config);
}

async function waitForAgentReadiness(
  options: WindowsNodeMxcAgentReadinessOptions,
  lockedConfig: Record<string, unknown>,
): Promise<void> {
  const agentIds = getConfiguredAgentIds(lockedConfig);
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + options.timeoutMs;
  let pendingAgentId = agentIds[0] ?? "unknown";

  while (now() < deadline) {
    assertCurrent(options);
    let pending = false;
    for (const agentId of agentIds) {
      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;
      const probe = await probeAgentDatabaseReadiness(
        options,
        agentId,
        Math.min(options.requestTimeoutMs, remainingMs),
      );
      assertCurrent(options);
      if (probe.status === "error") {
        if (probe.admissionCode !== "agent-database-inspection-pending") {
          throw new Error(
            `Gateway agent database readiness failed for agent "${agentId}"${
              probe.admissionCode
                ? `: ${probe.admissionCode}`
                : probe.gatewayCode
                  ? `: ${probe.gatewayCode}`
                  : ""
            }`,
          );
        }
        pending = true;
        pendingAgentId = agentId;
        break;
      }
    }
    if (!pending) return;

    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(options.pollIntervalMs, remainingMs));
  }

  throw new Error(
    `Gateway agent database readiness timed out after ${options.timeoutMs}ms while agent "${pendingAgentId}" was still preparing`,
  );
}

async function probeAgentDatabaseReadiness(
  options: WindowsNodeMxcAgentReadinessOptions,
  agentId: string,
  timeoutMs: number,
): Promise<
  { status: "ready" } | { status: "error"; admissionCode?: string; gatewayCode?: string }
> {
  try {
    await options.gateway.request(
      "sessions.list",
      { agentId, limit: 1, includeDerivedTitles: false },
      timeoutMs,
    );
    return { status: "ready" };
  } catch (error) {
    return {
      status: "error",
      admissionCode: getAgentDatabaseAdmissionCode(error),
      gatewayCode: getGatewayErrorCode(error),
    };
  }
}

export function attestWindowsNodeMxcGatewaySnapshot(
  snapshot: GatewayConfigSnapshot,
  nodeId: string,
  expectedPolicy: "locked" | "active" | "either",
): {
  config: Record<string, unknown>;
  hash: string;
  configRevisionHash: string;
  appliedConfigHash: string;
} {
  if (!snapshot.config || typeof snapshot.config !== "object" || Array.isArray(snapshot.config)) {
    throw new Error("Gateway config.get did not return a configuration object");
  }
  const hash = nonEmptyString(snapshot.hash, "persisted config hash");
  const configRevisionHash = nonEmptyString(
    snapshot.configRevisionHash,
    "resolved config revision hash",
  );
  const appliedConfigHash = nonEmptyString(snapshot.appliedConfigHash, "applied config hash");
  if (configRevisionHash !== appliedConfigHash) {
    throw new Error("Gateway persisted policy has not been applied to the active runtime");
  }
  const policy = validateWindowsNodeMxcGatewayPolicy(snapshot.config, nodeId, expectedPolicy);
  if (!policy.ready) {
    throw new Error(
      `Gateway ${expectedPolicy} policy attestation failed: ${policy.blockers.join("; ")}`,
    );
  }
  return {
    config: snapshot.config as Record<string, unknown>,
    hash,
    configRevisionHash,
    appliedConfigHash,
  };
}

export async function promoteWindowsNodeMxcPolicy(
  options: WindowsNodeMxcPolicyPromotionOptions,
): Promise<WindowsNodeMxcPolicyPromotionResult> {
  assertCurrent(options);
  const initialSnapshot = await readAppliedSnapshot(options, "active");
  await waitForAgentReadiness(
    {
      ...options,
      timeoutMs: options.agentReadinessTimeoutMs,
      pollIntervalMs: options.agentReadinessPollIntervalMs,
    },
    initialSnapshot.config,
  );
  const activeSnapshot = await readAppliedSnapshot(options, "active");
  if (
    activeSnapshot.hash !== initialSnapshot.hash ||
    activeSnapshot.configRevisionHash !== initialSnapshot.configRevisionHash ||
    activeSnapshot.appliedConfigHash !== initialSnapshot.appliedConfigHash ||
    !isDeepStrictEqual(activeSnapshot.config, initialSnapshot.config)
  ) {
    throw new Error("Gateway policy changed while agent databases were preparing");
  }
  return { backups: options.backups, appliedHash: activeSnapshot.appliedConfigHash };
}

async function readAppliedSnapshot(
  options: GenerationBoundGatewayOptions,
  expectedPolicy: "locked" | "active" | "either",
): Promise<ReturnType<typeof attestWindowsNodeMxcGatewaySnapshot>> {
  assertCurrent(options);
  const snapshot = await requestGatewaySafely<GatewayConfigSnapshot>(
    options,
    "config.get",
    {},
    "config snapshot request",
  );
  assertCurrent(options);
  return attestWindowsNodeMxcGatewaySnapshot(snapshot, options.nodeId, expectedPolicy);
}

async function requestGatewaySafely<T>(
  options: GenerationBoundGatewayOptions,
  method: string,
  params: unknown,
  operation: string,
): Promise<T> {
  const result = await captureGatewayRequest(() =>
    options.gateway.request<T>(method, params, options.requestTimeoutMs),
  );
  if (result.ok) return result.value;
  throw new Error(`Gateway ${operation} failed${result.code ? `: ${result.code}` : ""}`);
}

async function captureGatewayRequest<T>(
  request: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; code?: string }> {
  try {
    return { ok: true, value: await request() };
  } catch (error) {
    return { ok: false, code: getGatewayErrorCode(error) };
  }
}

function assertCurrent(options: GenerationBoundGatewayOptions): void {
  if (
    !options.isCurrent() ||
    options.currentGeneration() !== options.expectedGeneration ||
    !options.expectedGeneration
  ) {
    throw new Error("Managed Gateway generation changed during MXC policy promotion");
  }
}

function getConfiguredAgentIds(config: Record<string, unknown>): string[] {
  const ids = readAgentRoster(config.agents).map(({ id }) => id);
  if (ids.length === 0) {
    throw new Error("MXC agent database readiness requires at least one agent entry");
  }
  return ids;
}

function getAgentDatabaseAdmissionCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const code = (details as Record<string, unknown>).code;
  return code === "agent-database-inspection-pending" ||
    code === "agent-database-inspection-failed" ||
    code === "agent-database-ownership-mismatch"
    ? code
    : undefined;
}

function getGatewayErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && SAFE_GATEWAY_ERROR_CODES.has(code) ? code : undefined;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Gateway response is missing its ${label}`);
  }
  return value;
}
