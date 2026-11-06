import type { WindowsNodeMxcRequestedMode } from "./windows-node-mxc-modes";

export const WINDOWS_NODE_MXC_HOOKS_GATE_CONTRACT = "microclaw.windows-node-mxc.hooks-gate.v1";

export interface WindowsNodeMxcHooksGatePolicy {
  contract: typeof WINDOWS_NODE_MXC_HOOKS_GATE_CONTRACT;
  gatewayGeneration: string;
  policyFingerprint: string;
  requestedMode: Exclude<WindowsNodeMxcRequestedMode, "off">;
  externalRequested: boolean;
  internalRequested: boolean;
  basePath: string;
}

export interface WindowsNodeMxcHooksStatus {
  requestedExternalEnabled: boolean;
  requestedInternalEnabled: boolean;
  effectiveExternalEnabled: boolean;
  effectiveInternalEnabled: boolean;
  pausedByMxc: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeHooksPath(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "/hooks";
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  const normalized = withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
  if (normalized === "/") throw new Error("MXC Hooks gate cannot protect the root HTTP path");
  if (
    /[%?#\\]/.test(normalized) ||
    normalized.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("MXC Hooks gate path must be an unambiguous local HTTP path");
  }
  return normalized;
}

function isInternalHooksRequested(hooks: Record<string, unknown>): boolean {
  const internal = asRecord(hooks.internal);
  if (internal.enabled === false) return false;
  if (internal.enabled === true) return true;
  return Object.values(asRecord(internal.entries)).some(
    (entry) => asRecord(entry).enabled !== false,
  );
}

export function inspectWindowsNodeMxcHooksStatus(
  hooksConfig: unknown,
  requestedMode: WindowsNodeMxcRequestedMode,
): WindowsNodeMxcHooksStatus {
  const hooks = asRecord(hooksConfig);
  const requestedExternalEnabled = hooks.enabled === true;
  const requestedInternalEnabled = isInternalHooksRequested(hooks);
  const pausedByMxc =
    requestedMode !== "off" && (requestedExternalEnabled || requestedInternalEnabled);
  return {
    requestedExternalEnabled,
    requestedInternalEnabled,
    effectiveExternalEnabled: requestedMode === "off" && requestedExternalEnabled,
    effectiveInternalEnabled: requestedMode === "off" && requestedInternalEnabled,
    pausedByMxc,
  };
}

export function createWindowsNodeMxcHooksGatePolicy(params: {
  gatewayGeneration: string;
  policyFingerprint: string;
  requestedMode: Exclude<WindowsNodeMxcRequestedMode, "off">;
  hooksConfig: unknown;
}): WindowsNodeMxcHooksGatePolicy {
  const hooks = asRecord(params.hooksConfig);
  if (
    !params.gatewayGeneration ||
    !/^[a-f0-9]{64}$/i.test(params.policyFingerprint) ||
    (params.requestedMode !== "full" && params.requestedMode !== "limited-dacl")
  ) {
    throw new Error("MXC Hooks gate generation context is invalid");
  }
  return {
    contract: WINDOWS_NODE_MXC_HOOKS_GATE_CONTRACT,
    gatewayGeneration: params.gatewayGeneration,
    policyFingerprint: params.policyFingerprint.toLowerCase(),
    requestedMode: params.requestedMode,
    externalRequested: hooks.enabled === true,
    internalRequested: isInternalHooksRequested(hooks),
    basePath: normalizeHooksPath(hooks.path),
  };
}

export function getWindowsNodeMxcHooksEnvironment(
  policy: WindowsNodeMxcHooksGatePolicy,
): Record<string, string> {
  return {
    MICROCLAW_MXC_HOOKS_GATE_POLICY_BASE64: Buffer.from(JSON.stringify(policy), "utf8").toString(
      "base64",
    ),
  };
}
