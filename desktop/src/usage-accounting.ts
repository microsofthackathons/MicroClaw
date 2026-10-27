import { createHash } from "node:crypto";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
}

export interface BackgroundUsageEntry {
  id: string;
  timestamp: string;
  source: "memory" | "background";
  provider: string;
  model: string;
  agentId: string;
  totals: UsageTotals;
}

export interface UsageSource {
  source: "session" | BackgroundUsageEntry["source"];
  tokens: number;
}

interface UsageGroup {
  model?: string;
  provider?: string;
  agentId?: string;
  channel?: string;
  count?: number;
  totals?: Partial<UsageTotals>;
}

interface UsageDay {
  date: string;
  tokens?: number;
  cost?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface SessionUsageResult {
  updatedAt?: number;
  cacheStatus?: {
    status: "fresh" | "partial" | "stale" | "refreshing";
    pendingFiles?: number;
    staleFiles?: number;
  };
  totals?: Partial<UsageTotals>;
  aggregates?: {
    daily?: UsageDay[];
    byModel?: UsageGroup[];
    byProvider?: UsageGroup[];
    byAgent?: UsageGroup[];
    byChannel?: UsageGroup[];
    messages?: { assistant?: number };
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function label(value: unknown): string {
  return typeof value === "string" && /^[\w./:@-]{1,256}$/.test(value) ? value : "unknown";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0 };
}

export function parseBackgroundUsageLog(line: string): Omit<BackgroundUsageEntry, "id"> | null {
  if (!line.includes("plugin llm completion")) return null;
  try {
    const log = record(JSON.parse(line));
    if (!log) return null;
    const args = Object.entries(log).filter(([key]) => /^\d+$/.test(key));
    if (!args.some(([, value]) => value === "plugin llm completion")) return null;
    const completion = args.map(([, value]) => record(value)).find((value) => value?.usage);
    const usage = record(completion?.usage);
    if (!completion || !usage) return null;
    if (!["isolated-agent-runtime", "direct-provider"].includes(String(completion.executionMode)))
      return null;
    const timestamp = Date.parse(String(log.time ?? record(log._meta)?.date ?? ""));
    if (!Number.isFinite(timestamp)) return null;
    const input = count(usage.inputTokens);
    const output = count(usage.outputTokens);
    const cacheRead = count(usage.cacheReadTokens);
    const cacheWrite = count(usage.cacheWriteTokens);
    const totalTokens = Math.max(count(usage.totalTokens), input + output + cacheRead + cacheWrite);
    if (!totalTokens) return null;
    const caller = record(completion.caller);
    const memory =
      caller?.kind === "plugin" && ["memory-core", "active-memory"].includes(String(caller.id));
    return {
      timestamp: new Date(timestamp).toISOString(),
      source: memory ? "memory" : "background",
      provider: label(completion.provider),
      model: label(completion.model),
      agentId: label(completion.agentId),
      totals: {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens,
        totalCost:
          typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0
            ? usage.costUsd
            : 0,
      },
    };
  } catch {
    return null;
  }
}

export function usageLogFingerprint(line: string): string {
  return createHash("sha256").update(line.trim()).digest("hex");
}

function addTotals(base: Partial<UsageTotals> | undefined, extra: UsageTotals): UsageTotals {
  const totals = { ...emptyTotals(), ...base };
  for (const key of Object.keys(extra) as Array<keyof UsageTotals>) totals[key] += extra[key];
  return totals;
}

function addGroup(
  groups: UsageGroup[],
  identity: Partial<UsageGroup>,
  entry: BackgroundUsageEntry,
): void {
  let group = groups.find((item) =>
    Object.entries(identity).every(([key, value]) => item[key as keyof UsageGroup] === value),
  );
  if (!group) {
    group = { ...identity, count: 0, totals: emptyTotals() };
    groups.push(group);
  }
  group.count = (group.count ?? 0) + 1;
  group.totals = addTotals(group.totals, entry.totals);
}

export function mergeBackgroundUsage<Result extends SessionUsageResult>(
  result: Result,
  entries: BackgroundUsageEntry[],
  startDate: string,
  endDate: string,
  backgroundUsageAvailable = true,
) {
  const merged = structuredClone(result);
  const totals = { ...emptyTotals(), ...merged.totals };
  const aggregates = merged.aggregates ?? {};
  const daily = aggregates.daily ?? [];
  const byModel = aggregates.byModel ?? [];
  const byProvider = aggregates.byProvider ?? [];
  const byAgent = aggregates.byAgent ?? [];
  const byChannel = aggregates.byChannel ?? [];
  const sessionRequests =
    byModel.reduce((sum, group) => sum + (group.count ?? 0), 0) ||
    aggregates.messages?.assistant ||
    0;
  const sources: UsageSource[] = [
    { source: "session", tokens: totals.totalTokens },
    { source: "memory", tokens: 0 },
    { source: "background", tokens: 0 },
  ];
  let backgroundRequests = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    const date = entry.timestamp.slice(0, 10);
    if (date < startDate || date > endDate || seen.has(entry.id)) continue;
    seen.add(entry.id);
    backgroundRequests += 1;
    Object.assign(totals, addTotals(totals, entry.totals));
    sources.find((item) => item.source === entry.source)!.tokens += entry.totals.totalTokens;
    let day = daily.find((item) => item.date === date);
    if (!day) {
      day = { date };
      daily.push(day);
    }
    day.tokens = (day.tokens ?? 0) + entry.totals.totalTokens;
    day.cost = (day.cost ?? 0) + entry.totals.totalCost;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
      day[key] = (day[key] ?? 0) + entry.totals[key];
    addGroup(byModel, { provider: entry.provider, model: entry.model }, entry);
    addGroup(byProvider, { provider: entry.provider }, entry);
    addGroup(byAgent, { agentId: entry.agentId }, entry);
    addGroup(byChannel, { channel: "background" }, entry);
  }
  return {
    ...merged,
    totals,
    aggregates: {
      ...aggregates,
      daily: daily.sort((left, right) => left.date.localeCompare(right.date)),
      byModel,
      byProvider,
      byAgent,
      byChannel,
    },
    usageSources: sources,
    backgroundRequests,
    requestCount: sessionRequests + backgroundRequests,
    backgroundUsageAvailable,
  };
}
