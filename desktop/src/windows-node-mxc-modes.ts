import { describeMxcExactBackendEligibility, type MxcProbeResult } from "./windows-node-mxc";

export const WINDOWS_NODE_MXC_SELECTION_VERSION = 1 as const;

export type WindowsNodeMxcRequestedMode = "off" | "full" | "limited-dacl";
export type WindowsNodeMxcEffectiveStrength = "off" | "full" | "limited-dacl";
export type WindowsNodeMxcAmbientAccessStatus = "denied" | "read" | "read-write";
export type WindowsNodeMxcAmbientAccessCategory =
  | "desktop"
  | "documents"
  | "downloads"
  | "microclaw-state"
  | "openclaw-state"
  | "openclaw-roaming-state"
  | "ssh"
  | "gnupg"
  | "aws"
  | "azure"
  | "kube"
  | "gcloud"
  | "windows-credentials"
  | "powershell-history"
  | "browser-chrome"
  | "browser-edge"
  | "browser-brave"
  | "browser-firefox";

export interface WindowsNodeMxcSelection {
  version: typeof WINDOWS_NODE_MXC_SELECTION_VERSION;
  requestedMode: WindowsNodeMxcRequestedMode;
  limitedFilesystemAcknowledgedAt: string | null;
}

export interface WindowsNodeMxcAmbientAccessEntry {
  category: WindowsNodeMxcAmbientAccessCategory;
  status: WindowsNodeMxcAmbientAccessStatus;
}

export interface WindowsNodeMxcAmbientAccessAssessment {
  contract: "microclaw.windows-node-mxc-ambient-access.v1";
  hash: string;
  checkedAt: string;
  entries: WindowsNodeMxcAmbientAccessEntry[];
}

export interface WindowsNodeMxcModeAvailability {
  available: boolean;
  summary: string | null;
  blockers: string[];
  remediation: string[];
}

export function migrateWindowsNodeMxcSelection(
  value: unknown,
  legacyDesiredEnabled?: boolean,
): WindowsNodeMxcSelection {
  if (isRecord(value) && value.version === WINDOWS_NODE_MXC_SELECTION_VERSION) {
    const requestedMode = value.requestedMode;
    if (requestedMode === "off" || requestedMode === "full" || requestedMode === "limited-dacl") {
      return {
        version: WINDOWS_NODE_MXC_SELECTION_VERSION,
        requestedMode: requestedMode === "limited-dacl" ? "full" : requestedMode,
        limitedFilesystemAcknowledgedAt: null,
      };
    }
  }

  return {
    version: WINDOWS_NODE_MXC_SELECTION_VERSION,
    requestedMode: legacyDesiredEnabled === false ? "off" : "full",
    limitedFilesystemAcknowledgedAt: null,
  };
}

export function createWindowsNodeMxcSelection(
  requestedMode: WindowsNodeMxcRequestedMode,
  _acknowledgeLimitedFilesystem: boolean,
  _now = new Date(),
): WindowsNodeMxcSelection {
  if (requestedMode === "limited-dacl") throw new Error("Limited DACL containment is retired");
  return {
    version: WINDOWS_NODE_MXC_SELECTION_VERSION,
    requestedMode,
    limitedFilesystemAcknowledgedAt: null,
  };
}

export function selectWindowsNodeMxcAutomaticMode(
  probe: MxcProbeResult,
): Exclude<WindowsNodeMxcRequestedMode, "off"> {
  if (describeMxcExactBackendEligibility(probe).eligible) return "full";
  throw new Error(
    `No supported MXC sandbox is available. ${probe.reason ?? "The runtime did not attest a usable containment tier."}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
