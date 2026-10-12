import type { WindowsNodeMxcRequestedMode } from "./windows-node-mxc-modes";
import { isAbsolute } from "node:path";

export const WINDOWS_NODE_MXC_CRON_RESUME_FENCE_CONTRACT =
  "microclaw.windows-node-mxc.cron-resume.v1";

export interface WindowsNodeMxcCronResumeFence {
  contract: typeof WINDOWS_NODE_MXC_CRON_RESUME_FENCE_CONTRACT;
  resumeAfterUnixMs: number;
  createdAt: string;
  acknowledgementPath: string;
  acknowledgementToken: string;
}

export function createWindowsNodeMxcCronResumeFence(
  acknowledgementPath: string,
  acknowledgementToken: string,
  nowUnixMs = Date.now(),
): WindowsNodeMxcCronResumeFence {
  if (!Number.isSafeInteger(nowUnixMs) || nowUnixMs < 0) {
    throw new Error("MXC Cron resume fence timestamp is invalid");
  }
  if (!isAbsolute(acknowledgementPath) || !acknowledgementToken.trim()) {
    throw new Error("MXC Cron resume acknowledgement binding is invalid");
  }
  return {
    contract: WINDOWS_NODE_MXC_CRON_RESUME_FENCE_CONTRACT,
    resumeAfterUnixMs: nowUnixMs,
    createdAt: new Date(nowUnixMs).toISOString(),
    acknowledgementPath,
    acknowledgementToken,
  };
}

export function parseWindowsNodeMxcCronResumeFence(
  value: unknown,
): WindowsNodeMxcCronResumeFence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.contract !== WINDOWS_NODE_MXC_CRON_RESUME_FENCE_CONTRACT ||
    !Number.isSafeInteger(candidate.resumeAfterUnixMs) ||
    (candidate.resumeAfterUnixMs as number) < 0 ||
    typeof candidate.createdAt !== "string" ||
    candidate.createdAt !== new Date(candidate.resumeAfterUnixMs as number).toISOString() ||
    typeof candidate.acknowledgementPath !== "string" ||
    !isAbsolute(candidate.acknowledgementPath) ||
    typeof candidate.acknowledgementToken !== "string" ||
    !candidate.acknowledgementToken.trim()
  ) {
    return null;
  }
  return candidate as unknown as WindowsNodeMxcCronResumeFence;
}

export function getWindowsNodeMxcCronResumeEnvironment(
  value: unknown,
): Record<string, string> {
  const fence = parseWindowsNodeMxcCronResumeFence(value);
  if (!fence) throw new Error("Stored MXC Cron resume fence is invalid");
  return {
    MICROCLAW_MXC_CRON_RESUME_FENCE_UNIX_MS: String(fence.resumeAfterUnixMs),
    MICROCLAW_MXC_CRON_RESUME_ACK_PATH: fence.acknowledgementPath,
    MICROCLAW_MXC_CRON_RESUME_ACK_TOKEN: fence.acknowledgementToken,
  };
}

export function isWindowsNodeMxcCronResumeAcknowledgement(
  value: unknown,
  fence: WindowsNodeMxcCronResumeFence,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.contract === WINDOWS_NODE_MXC_CRON_RESUME_FENCE_CONTRACT &&
    candidate.resumeAfterUnixMs === fence.resumeAfterUnixMs &&
    candidate.acknowledgementToken === fence.acknowledgementToken &&
    Number.isSafeInteger(candidate.completedAtUnixMs) &&
    (candidate.completedAtUnixMs as number) >= fence.resumeAfterUnixMs
  );
}

export function annotateWindowsNodeMxcPausedCronJobs(
  result: { jobs?: unknown[] },
  requestedMode: WindowsNodeMxcRequestedMode,
): { jobs: unknown[]; pausedByMxc: true; requestedMode: WindowsNodeMxcRequestedMode } {
  if (requestedMode === "off") {
    throw new Error("MXC Cron pause metadata requires an active containment mode");
  }
  return {
    jobs: (Array.isArray(result.jobs) ? result.jobs : []).map((job) =>
      job && typeof job === "object" && !Array.isArray(job)
        ? {
            ...job,
            pausedByMxc: true,
            effectiveEnabled: false,
            requestedMode,
          }
        : job,
    ),
    pausedByMxc: true,
    requestedMode,
  };
}
