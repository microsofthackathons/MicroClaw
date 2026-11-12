import type { WindowsNodeMxcRequestedMode } from "./windows-node-mxc-modes";

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
  _requestedMode: WindowsNodeMxcRequestedMode,
): WindowsNodeMxcHooksStatus {
  const hooks = asRecord(hooksConfig);
  const requestedExternalEnabled = hooks.enabled === true;
  const requestedInternalEnabled = isInternalHooksRequested(hooks);
  return {
    requestedExternalEnabled,
    requestedInternalEnabled,
    effectiveExternalEnabled: requestedExternalEnabled,
    effectiveInternalEnabled: requestedInternalEnabled,
    pausedByMxc: false,
  };
}
