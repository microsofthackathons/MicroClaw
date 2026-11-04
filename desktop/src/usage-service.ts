import type { BackgroundUsageLedger } from "./background-usage-ledger";
import {
  mergeBackgroundUsage,
  type BackgroundUsageEntry,
  type SessionUsageResult,
} from "./usage-accounting";

export interface UsageRange {
  startDate: string;
  endDate: string;
  limit: number;
}

export class UsageStatsNotReadyError extends Error {
  constructor() {
    super("Usage statistics are not complete yet");
    this.name = "UsageStatsNotReadyError";
  }
}

export function hasCompleteSessionUsage(result: SessionUsageResult): boolean {
  const status = result.cacheStatus;
  return (
    !status ||
    (status.status === "fresh" &&
      (status.pendingFiles ?? 0) === 0 &&
      (status.staleFiles ?? 0) === 0)
  );
}

export async function queryAccountedUsage(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  ledger: Pick<BackgroundUsageLedger, "synchronize" | "readSnapshot">,
  range: UsageRange,
  warn: () => void = () => {},
) {
  const result = await request("sessions.usage", {
    ...range,
    agentScope: "all",
    includeContextWeight: true,
  });
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Invalid Gateway usage response");
  if (!hasCompleteSessionUsage(result as SessionUsageResult)) throw new UsageStatsNotReadyError();
  const totalTokens = (result as SessionUsageResult).totals?.totalTokens;
  if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens < 0)
    throw new Error("Invalid Gateway usage totals");
  let entries: BackgroundUsageEntry[];
  let available = true;
  try {
    const tail = await request("logs.tail", { limit: 1, maxBytes: 1 });
    const file = tail && typeof tail === "object" && "file" in tail ? tail.file : undefined;
    if (typeof file !== "string" || !file) throw new Error("Gateway log path unavailable");
    entries = await ledger.synchronize(file);
  } catch {
    available = false;
    warn();
    entries = await ledger.readSnapshot().catch(() => []);
  }
  return mergeBackgroundUsage(
    result as SessionUsageResult,
    entries,
    range.startDate,
    range.endDate,
    available,
  );
}

export type AccountedUsageResult = Awaited<ReturnType<typeof queryAccountedUsage>>;
