import type { BackgroundUsageLedger } from "./background-usage-ledger";
import {
  mergeBackgroundUsage,
  type BackgroundUsageEntry,
  type SessionUsageResult,
} from "./usage-accounting";

export async function queryAccountedUsage(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  ledger: Pick<BackgroundUsageLedger, "synchronize" | "readSnapshot">,
  range: { startDate: string; endDate: string; limit: number },
  warn: () => void = () => {},
) {
  const result = await request("sessions.usage", {
    ...range,
    agentScope: "all",
    includeContextWeight: true,
  });
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Invalid Gateway usage response");
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
