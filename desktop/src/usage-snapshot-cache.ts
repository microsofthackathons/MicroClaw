import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  hasCompleteSessionUsage,
  UsageStatsNotReadyError,
  type AccountedUsageResult,
  type UsageRange,
} from "./usage-service";

const MAX_SNAPSHOTS = 32;
const REFRESH_RETRIES = 2;
const REFRESH_RETRY_MS = 1000;

interface UsageSnapshot {
  scope?: "summary";
  range: UsageRange;
  result: AccountedUsageResult;
}

function rangeKey(range: UsageRange, scope?: "summary"): string {
  return scope ?? JSON.stringify([range.startDate, range.endDate, range.limit]);
}

function validRange(range: unknown): range is UsageRange {
  if (!range || typeof range !== "object") return false;
  const value = range as UsageRange;
  return (
    typeof value.startDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.startDate) &&
    typeof value.endDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.endDate) &&
    value.startDate <= value.endDate &&
    Number.isInteger(value.limit) &&
    value.limit > 0 &&
    value.limit <= 5000
  );
}

function completeResult(value: unknown): value is AccountedUsageResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as AccountedUsageResult;
  return (
    hasCompleteSessionUsage(result) &&
    result.backgroundUsageAvailable === true &&
    (result.updatedAt === undefined ||
      (typeof result.updatedAt === "number" &&
        Number.isFinite(result.updatedAt) &&
        result.updatedAt > 0)) &&
    typeof result.totals?.totalTokens === "number" &&
    Number.isFinite(result.totals.totalTokens) &&
    result.totals.totalTokens >= 0
  );
}

export class UsageSnapshotCache {
  private snapshots = new Map<string, UsageSnapshot>();
  private pending = new Map<string, Promise<AccountedUsageResult>>();
  private loaded: Promise<void> | undefined;
  private saving = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly fetch: (range: UsageRange) => Promise<AccountedUsageResult>,
  ) {}

  async get(range: UsageRange, scope?: "summary"): Promise<AccountedUsageResult> {
    await this.load();
    const snapshot = this.snapshots.get(rangeKey(range, scope));
    const refresh = this.refresh(range, scope);
    if (snapshot) {
      void refresh.catch(() => {});
      return structuredClone(snapshot.result);
    }
    return refresh;
  }

  async refresh(range: UsageRange, scope?: "summary"): Promise<AccountedUsageResult> {
    await this.load();
    const key = rangeKey(range, scope);
    let refresh = this.pending.get(key);
    if (!refresh) {
      refresh = this.fetchComplete(range)
        .then(async (result) => {
          const previous = this.snapshots.get(key);
          if (
            previous?.result.updatedAt !== undefined &&
            result.updatedAt !== undefined &&
            result.updatedAt < previous.result.updatedAt
          ) {
            return previous.result;
          }
          const snapshot = structuredClone({
            scope,
            range,
            result: { ...result, updatedAt: result.updatedAt ?? Date.now() },
          });
          this.snapshots.delete(key);
          this.snapshots.set(key, snapshot);
          while (this.snapshots.size > MAX_SNAPSHOTS) {
            const oldest = [...this.snapshots.keys()].find((candidate) => candidate !== "summary");
            if (oldest !== undefined) this.snapshots.delete(oldest);
          }
          await this.save();
          return snapshot.result;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, refresh);
    }
    return structuredClone(await refresh);
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const data = JSON.parse(await readFile(this.filePath, "utf8"));
        if (data.version !== 1 || !Array.isArray(data.snapshots)) return;
        for (const snapshot of data.snapshots.slice(-MAX_SNAPSHOTS)) {
          if (
            snapshot &&
            (snapshot.scope === undefined || snapshot.scope === "summary") &&
            validRange(snapshot.range) &&
            completeResult(snapshot.result)
          ) {
            this.snapshots.set(rangeKey(snapshot.range, snapshot.scope), snapshot);
          }
        }
      } catch {}
    })();
    return this.loaded;
  }

  private async fetchComplete(range: UsageRange): Promise<AccountedUsageResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.fetch(range);
        if (!completeResult(result)) throw new UsageStatsNotReadyError();
        return result;
      } catch (error) {
        if (!(error instanceof UsageStatsNotReadyError) || attempt >= REFRESH_RETRIES) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, REFRESH_RETRY_MS));
      }
    }
  }

  private save(): Promise<void> {
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.tmp`;
        await writeFile(
          temporary,
          JSON.stringify({ version: 1, snapshots: [...this.snapshots.values()] }),
          { mode: 0o600 },
        );
        await rename(temporary, this.filePath);
      })
      .catch(() => {
        console.warn("[usage] Could not save usage snapshots; keeping in-memory totals");
      });
    return this.saving;
  }
}
