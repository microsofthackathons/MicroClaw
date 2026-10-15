import {
  applyWindowsNodeMxcGatewayPolicy,
  validateWindowsNodeMxcGatewayPolicy,
  type AgentToolsBackup,
} from "./windows-node-mxc";
import { isDeepStrictEqual } from "node:util";

export type GatewayConfigSnapshot = {
  config?: unknown;
  hash?: unknown;
  configRevisionHash?: unknown;
  appliedConfigHash?: unknown;
};

type GatewayConfigPatchAck = {
  ok?: unknown;
  hash?: unknown;
  changedPaths?: unknown;
  restart?: unknown;
  sentinel?: {
    payload?: {
      stats?: {
        requiresRestart?: unknown;
      };
    };
  };
};

export type WindowsNodeMxcPolicyPromotionOptions = {
  gateway: {
    request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  };
  nodeId: string;
  backups: AgentToolsBackup;
  expectedGeneration: string;
  currentGeneration: () => string;
  isCurrent: () => boolean;
  requestTimeoutMs: number;
};

export type WindowsNodeMxcPolicyPromotionResult = {
  backups: AgentToolsBackup;
  appliedHash: string;
};

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
  const lockedSnapshot = await readAppliedSnapshot(options, "locked");
  const active = applyWindowsNodeMxcGatewayPolicy(
    lockedSnapshot.config,
    options.nodeId,
    options.backups,
    "active",
  );

  try {
    const ack = await patchAgents(
      options,
      lockedSnapshot.hash,
      active.config.agents,
      getAgentToolReplacePaths(active.config.agents),
    );
    assertHotAppliedAck(ack);
    const activeSnapshot = await readAppliedSnapshot(options, "active");
    assertMatchingAckHash(ack, activeSnapshot.hash);
    assertExactConfig(activeSnapshot.config, active.config, "active policy");
    return { backups: active.backups, appliedHash: activeSnapshot.appliedConfigHash };
  } catch (error) {
    assertCurrent(options);
    try {
      await rollbackWindowsNodeMxcPolicy(options, lockedSnapshot.config);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "MXC policy promotion failed and the locked-policy rollback also failed",
        { cause: rollbackError },
      );
    }
    throw error;
  }
}

async function rollbackWindowsNodeMxcPolicy(
  options: WindowsNodeMxcPolicyPromotionOptions,
  lockedConfig: Record<string, unknown>,
): Promise<void> {
  const current = await readSnapshot(options, "either", false);
  if (validateWindowsNodeMxcGatewayPolicy(current.config, options.nodeId, "locked").ready) {
    const verified = await readAppliedSnapshot(options, "locked");
    assertExactConfig(verified.config, lockedConfig, "locked rollback");
    return;
  }

  const ack = await patchAgents(
    options,
    current.hash,
    lockedConfig.agents,
    getAgentToolReplacePaths(lockedConfig.agents),
  );
  assertHotAppliedAck(ack);
  const verified = await readAppliedSnapshot(options, "locked");
  assertMatchingAckHash(ack, verified.hash);
  assertExactConfig(verified.config, lockedConfig, "locked rollback");
}

async function readAppliedSnapshot(
  options: WindowsNodeMxcPolicyPromotionOptions,
  expectedPolicy: "locked" | "active" | "either",
): Promise<ReturnType<typeof attestWindowsNodeMxcGatewaySnapshot>> {
  return readSnapshot(options, expectedPolicy, true);
}

async function readSnapshot(
  options: WindowsNodeMxcPolicyPromotionOptions,
  expectedPolicy: "locked" | "active" | "either",
  requireApplied: boolean,
): Promise<{
  config: Record<string, unknown>;
  hash: string;
  configRevisionHash: string;
  appliedConfigHash: string;
}> {
  assertCurrent(options);
  const snapshot = await options.gateway.request<GatewayConfigSnapshot>(
    "config.get",
    {},
    options.requestTimeoutMs,
  );
  assertCurrent(options);
  if (!requireApplied) {
    if (!snapshot.config || typeof snapshot.config !== "object" || Array.isArray(snapshot.config)) {
      throw new Error("Gateway config.get did not return a configuration object");
    }
    const hash = nonEmptyString(snapshot.hash, "persisted config hash");
    const policy = validateWindowsNodeMxcGatewayPolicy(
      snapshot.config,
      options.nodeId,
      expectedPolicy,
    );
    if (!policy.ready) {
      throw new Error(
        `Gateway ${expectedPolicy} policy attestation failed: ${policy.blockers.join("; ")}`,
      );
    }
    return {
      config: snapshot.config as Record<string, unknown>,
      hash,
      configRevisionHash:
        typeof snapshot.configRevisionHash === "string" ? snapshot.configRevisionHash : "",
      appliedConfigHash:
        typeof snapshot.appliedConfigHash === "string" ? snapshot.appliedConfigHash : "",
    };
  }
  return attestWindowsNodeMxcGatewaySnapshot(snapshot, options.nodeId, expectedPolicy);
}

async function patchAgents(
  options: WindowsNodeMxcPolicyPromotionOptions,
  baseHash: string,
  agents: unknown,
  replacePaths: string[],
): Promise<GatewayConfigPatchAck> {
  assertCurrent(options);
  const ack = await options.gateway.request<GatewayConfigPatchAck>(
    "config.patch",
    {
      baseHash,
      raw: JSON.stringify({ agents }),
      replacePaths,
      note: "Promote verified MicroClaw MXC policy without restarting the Gateway",
    },
    options.requestTimeoutMs,
  );
  assertCurrent(options);
  return ack;
}

function assertHotAppliedAck(ack: GatewayConfigPatchAck): void {
  if (ack.ok !== true) throw new Error("Gateway rejected the MXC policy promotion");
  if (ack.restart !== undefined && ack.restart !== null) {
    throw new Error("Gateway attempted to restart while promoting the MXC policy");
  }
  if (ack.sentinel?.payload?.stats?.requiresRestart !== false) {
    throw new Error("Gateway did not prove that MXC policy promotion was hot-applied");
  }
  if (
    !Array.isArray(ack.changedPaths) ||
    ack.changedPaths.length === 0 ||
    !ack.changedPaths.every(
      (path) =>
        typeof path === "string" &&
        ((path.startsWith("agents.entries.") && path.includes(".tools")) || path === "agents.list"),
    )
  ) {
    throw new Error("Gateway MXC policy promotion changed an unexpected configuration path");
  }
}

function assertMatchingAckHash(ack: GatewayConfigPatchAck, snapshotHash: string): void {
  const ackHash = nonEmptyString(ack.hash, "config.patch acknowledgement hash");
  if (ackHash !== snapshotHash) {
    throw new Error("Gateway config.patch acknowledgement did not match exact read-back");
  }
}

function assertExactConfig(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  label: string,
): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`Gateway ${label} read-back drifted from the exact requested configuration`);
  }
}

function getAgentToolReplacePaths(agents: unknown): string[] {
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    throw new Error("MXC one-process promotion requires an explicit agent roster");
  }
  const roster = agents as Record<string, unknown>;
  if (Array.isArray(roster.list)) {
    if (roster.list.length === 0) {
      throw new Error("MXC one-process promotion requires at least one agent entry");
    }
    return ["agents.list"];
  }
  const entries = roster.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new Error("MXC one-process promotion requires agents.entries or agents.list");
  }
  const agentIds = Object.keys(entries);
  if (agentIds.length === 0) {
    throw new Error("MXC one-process promotion requires at least one agent entry");
  }
  return agentIds.flatMap((agentId) => [
    `agents.entries.${agentId}.tools.allow`,
    `agents.entries.${agentId}.tools.deny`,
  ]);
}

function assertCurrent(options: WindowsNodeMxcPolicyPromotionOptions): void {
  if (
    !options.isCurrent() ||
    options.currentGeneration() !== options.expectedGeneration ||
    !options.expectedGeneration
  ) {
    throw new Error("Managed Gateway generation changed during MXC policy promotion");
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Gateway response is missing its ${label}`);
  }
  return value;
}
