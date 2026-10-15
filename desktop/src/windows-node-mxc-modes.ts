import type { MxcProbeResult } from "./windows-node-mxc";

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

const SENSITIVE_AMBIENT_CATEGORIES = new Set<WindowsNodeMxcAmbientAccessCategory>([
  "microclaw-state",
  "openclaw-state",
  "openclaw-roaming-state",
  "ssh",
  "gnupg",
  "aws",
  "azure",
  "kube",
  "gcloud",
  "windows-credentials",
  "powershell-history",
  "browser-chrome",
  "browser-edge",
  "browser-brave",
  "browser-firefox",
]);
const ALL_AMBIENT_CATEGORIES = new Set<WindowsNodeMxcAmbientAccessCategory>([
  "desktop",
  "documents",
  "downloads",
  "microclaw-state",
  "openclaw-state",
  "openclaw-roaming-state",
  "ssh",
  "gnupg",
  "aws",
  "azure",
  "kube",
  "gcloud",
  "windows-credentials",
  "powershell-history",
  "browser-chrome",
  "browser-edge",
  "browser-brave",
  "browser-firefox",
]);

export function migrateWindowsNodeMxcSelection(
  value: unknown,
  legacyDesiredEnabled: boolean,
): WindowsNodeMxcSelection {
  if (isRecord(value) && value.version === WINDOWS_NODE_MXC_SELECTION_VERSION) {
    const requestedMode = value.requestedMode;
    if (
      requestedMode === "off" ||
      requestedMode === "full" ||
      requestedMode === "limited-dacl"
    ) {
      const acknowledgedAt =
        typeof value.limitedFilesystemAcknowledgedAt === "string" &&
        !Number.isNaN(Date.parse(value.limitedFilesystemAcknowledgedAt))
          ? value.limitedFilesystemAcknowledgedAt
          : null;
      return {
        version: WINDOWS_NODE_MXC_SELECTION_VERSION,
        requestedMode,
        limitedFilesystemAcknowledgedAt:
          requestedMode === "limited-dacl" ? acknowledgedAt : null,
      };
    }
  }

  return {
    version: WINDOWS_NODE_MXC_SELECTION_VERSION,
    requestedMode: legacyDesiredEnabled ? "full" : "off",
    limitedFilesystemAcknowledgedAt: null,
  };
}

export function createWindowsNodeMxcSelection(
  requestedMode: WindowsNodeMxcRequestedMode,
  acknowledgeLimitedFilesystem: boolean,
  now = new Date(),
): WindowsNodeMxcSelection {
  if (requestedMode === "limited-dacl" && !acknowledgeLimitedFilesystem) {
    throw new Error(
      "Limited containment requires explicit acknowledgment that selected folders are additive grants, not an exclusive filesystem allowlist",
    );
  }
  return {
    version: WINDOWS_NODE_MXC_SELECTION_VERSION,
    requestedMode,
    limitedFilesystemAcknowledgedAt:
      requestedMode === "limited-dacl" ? now.toISOString() : null,
  };
}

export function describeWindowsNodeMxcLimitedAvailability(
  probe: MxcProbeResult,
): WindowsNodeMxcModeAvailability {
  if (
    probe.tier?.trim().toLowerCase() === "appcontainer-dacl" &&
    probe.outcome !== "error"
  ) {
    return {
      available: true,
      summary:
        "The pinned MXC runtime attested appcontainer-dacl. Filesystem grants are additive and ambient Windows ACL access must be assessed before activation.",
      blockers: [],
      remediation: [],
    };
  }
  const reason =
    probe.reason ??
    `The pinned MXC runtime attested ${probe.tier ?? "no usable containment tier"}, not appcontainer-dacl.`;
  return {
    available: false,
    summary: reason,
    blockers: [reason],
    remediation: [
      "Repair the pinned, signed MXC runtime or use Full containment when an exact backend is available. MicroClaw never downgrades between containment tiers automatically.",
    ],
  };
}

export function summarizeWindowsNodeMxcAmbientAccess(
  assessment: WindowsNodeMxcAmbientAccessAssessment | null,
): {
  sensitiveAccessible: WindowsNodeMxcAmbientAccessEntry[];
  ordinaryAccessible: WindowsNodeMxcAmbientAccessEntry[];
} {
  const entries = assessment?.entries ?? [];
  return {
    sensitiveAccessible: entries.filter(
      (entry) =>
        entry.status !== "denied" && SENSITIVE_AMBIENT_CATEGORIES.has(entry.category),
    ),
    ordinaryAccessible: entries.filter(
      (entry) =>
        entry.status !== "denied" && !SENSITIVE_AMBIENT_CATEGORIES.has(entry.category),
    ),
  };
}

export function validateWindowsNodeMxcAmbientAccessAssessment(
  value: unknown,
): value is WindowsNodeMxcAmbientAccessAssessment {
  if (
    !isRecord(value) ||
    value.contract !== "microclaw.windows-node-mxc-ambient-access.v1" ||
    typeof value.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.hash) ||
    typeof value.checkedAt !== "string" ||
    Number.isNaN(Date.parse(value.checkedAt)) ||
    !Array.isArray(value.entries)
  ) {
    return false;
  }
  const categories = new Set<string>();
  const validEntries = value.entries.every((entry) => {
    if (!isRecord(entry)) return false;
    const category = entry.category;
    const status = entry.status;
    if (
      typeof category !== "string" ||
      ![
        "desktop",
        "documents",
        "downloads",
        "microclaw-state",
        "openclaw-state",
        "openclaw-roaming-state",
        "ssh",
        "gnupg",
        "aws",
        "azure",
        "kube",
        "gcloud",
        "windows-credentials",
        "powershell-history",
        "browser-chrome",
        "browser-edge",
        "browser-brave",
        "browser-firefox",
      ].includes(category) ||
      categories.has(category) ||
      (status !== "denied" && status !== "read" && status !== "read-write")
    ) {
      return false;
    }
    categories.add(category);
    return true;
  });
  return (
    validEntries &&
    categories.size === ALL_AMBIENT_CATEGORIES.size &&
    [...ALL_AMBIENT_CATEGORIES].every((category) => categories.has(category))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
