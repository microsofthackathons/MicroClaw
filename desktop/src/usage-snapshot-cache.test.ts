import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeBackgroundUsage } from "./usage-accounting";
import {
  UsageStatsNotReadyError,
  type AccountedUsageResult,
  type UsageRange,
} from "./usage-service";
import { UsageSnapshotCache } from "./usage-snapshot-cache";

const roots: string[] = [];
const now = Date.parse("2026-10-27T03:00:00Z");
const range: UsageRange = { startDate: "2026-09-27", endDate: "2026-10-27", limit: 1000 };

function result(totalTokens: number, updatedAt = now): AccountedUsageResult {
  return mergeBackgroundUsage(
    { updatedAt, totals: { totalTokens }, cacheStatus: { status: "fresh" } },
    [],
    range.startDate,
    range.endDate,
  );
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "microclaw-usage-snapshots-"));
  roots.push(root);
  const storage = join(root, "snapshots.json");
  const fetch = vi.fn<(range: UsageRange) => Promise<AccountedUsageResult>>();
  return { storage, fetch, cache: new UsageSnapshotCache(storage, fetch) };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("persistent usage snapshots", () => {
  it("persists the first complete result without changing its accounting", async () => {
    const { cache, fetch, storage } = await fixture();
    fetch.mockResolvedValue(result(53_532));
    expect(await cache.get(range)).toEqual(result(53_532));
    const data = JSON.parse(await readFile(storage, "utf8"));
    expect(data.snapshots[0].range).toEqual(range);
    expect(data.snapshots[0].result).toEqual(result(53_532));
  });

  it("returns the previous total immediately while refreshing in the background", async () => {
    const { cache, fetch } = await fixture();
    fetch.mockResolvedValueOnce(result(41_967));
    await cache.refresh(range);
    let finish!: (value: AccountedUsageResult) => void;
    fetch.mockImplementationOnce(
      () => new Promise<AccountedUsageResult>((resolve) => (finish = resolve)),
    );

    expect((await cache.get(range)).totals.totalTokens).toBe(41_967);
    expect(fetch).toHaveBeenCalledTimes(2);
    finish(result(53_532, now + 60_000));
    expect((await cache.refresh(range)).totals.totalTokens).toBe(53_532);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([41_967, 0])(
    "restores %i after a restart even when the Gateway is offline",
    async (tokens) => {
      const { cache, fetch, storage } = await fixture();
      fetch.mockResolvedValue(result(tokens));
      await cache.refresh(range);

      const offline = vi.fn().mockRejectedValue(new Error("Gateway disconnected"));
      const restored = new UsageSnapshotCache(storage, offline);
      expect((await restored.get(range)).totals.totalTokens).toBe(tokens);
      await expect(restored.refresh(range)).rejects.toThrow("Gateway disconnected");
      expect(
        JSON.parse(await readFile(storage, "utf8")).snapshots[0].result.totals.totalTokens,
      ).toBe(tokens);
    },
  );

  it("never replaces a complete snapshot with a partial result", async () => {
    const { cache, fetch, storage } = await fixture();
    fetch.mockResolvedValueOnce(result(41_967));
    await cache.refresh(range);
    vi.useFakeTimers();
    fetch.mockRejectedValue(new UsageStatsNotReadyError());

    expect((await cache.get(range)).totals.totalTokens).toBe(41_967);
    const refresh = cache.refresh(range).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await refresh).toBeInstanceOf(UsageStatsNotReadyError);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(JSON.parse(await readFile(storage, "utf8")).snapshots[0].result.totals.totalTokens).toBe(
      41_967,
    );
  });

  it("silently retries incomplete statistics and stores the complete replacement", async () => {
    const { cache, fetch } = await fixture();
    fetch.mockResolvedValueOnce(result(41_967));
    await cache.refresh(range);
    vi.useFakeTimers();
    fetch
      .mockRejectedValueOnce(new UsageStatsNotReadyError())
      .mockResolvedValueOnce(result(53_532, now + 60_000));

    expect((await cache.get(range)).totals.totalTokens).toBe(41_967);
    const refresh = cache.refresh(range);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await refresh).totals.totalTokens).toBe(53_532);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps the previous complete total when background coverage is unavailable", async () => {
    const { cache, fetch, storage } = await fixture();
    fetch.mockResolvedValueOnce(result(53_532));
    await cache.refresh(range);
    vi.useFakeTimers();
    fetch.mockResolvedValue({ ...result(47_674), backgroundUsageAvailable: false });

    expect((await cache.get(range)).totals.totalTokens).toBe(53_532);
    const refresh = cache.refresh(range).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await refresh).toBeInstanceOf(UsageStatsNotReadyError);
    expect(JSON.parse(await readFile(storage, "utf8")).snapshots[0].result.totals.totalTokens).toBe(
      53_532,
    );
  });

  it("accepts a newer complete decrease instead of retaining a historical maximum", async () => {
    const { cache, fetch } = await fixture();
    fetch.mockResolvedValueOnce(result(53_532)).mockResolvedValueOnce(result(0, now + 60_000));
    await cache.refresh(range);
    expect((await cache.refresh(range)).totals.totalTokens).toBe(0);
  });

  it("does not replace a newer snapshot with an older Gateway cache", async () => {
    const { cache, fetch } = await fixture();
    fetch.mockResolvedValueOnce(result(53_532, now + 60_000)).mockResolvedValueOnce(result(41_967));
    await cache.refresh(range);
    expect((await cache.refresh(range)).totals.totalTokens).toBe(53_532);
  });

  it("coalesces concurrent refreshes and returns independent snapshots", async () => {
    const { cache, fetch } = await fixture();
    let finish!: (value: AccountedUsageResult) => void;
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => (started = resolve));
    fetch.mockImplementation(() => {
      started();
      return new Promise<AccountedUsageResult>((resolve) => (finish = resolve));
    });
    const first = cache.refresh(range);
    const second = cache.refresh(range);
    await fetching;
    expect(fetch).toHaveBeenCalledTimes(1);
    finish(result(53_532));
    const [left, right] = await Promise.all([first, second]);
    left.totals.totalTokens = 0;
    expect(right.totals.totalTokens).toBe(53_532);
  });

  it("does not reuse another date range as a valid result", async () => {
    const { cache, fetch } = await fixture();
    fetch.mockResolvedValueOnce(result(53_532));
    await cache.refresh(range);
    fetch.mockRejectedValue(new Error("Gateway disconnected"));
    await expect(cache.get({ ...range, startDate: "2026-10-26" })).rejects.toThrow(
      "Gateway disconnected",
    );
  });

  it("retains the rolling summary across date changes without expiring it", async () => {
    const { cache, fetch, storage } = await fixture();
    fetch.mockResolvedValue(result(53_532));
    await cache.refresh(range, "summary");
    const nextRange = { ...range, startDate: "2026-09-28", endDate: "2026-10-28" };
    const offline = vi.fn().mockRejectedValue(new Error("Gateway disconnected"));
    const restored = new UsageSnapshotCache(storage, offline);

    expect((await restored.get(nextRange, "summary")).totals.totalTokens).toBe(53_532);
    await expect(restored.refresh(nextRange, "summary")).rejects.toThrow("Gateway disconnected");
    expect(offline).toHaveBeenCalledWith(nextRange);
  });

  it("recovers from a corrupt cache file", async () => {
    const { cache, fetch, storage } = await fixture();
    await writeFile(storage, "not valid JSON");
    fetch.mockResolvedValue(result(53_532));
    expect((await cache.get(range)).totals.totalTokens).toBe(53_532);
  });
});
