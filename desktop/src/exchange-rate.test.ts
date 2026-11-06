import { afterEach, describe, expect, it, vi } from "vitest";
import { getUsdToCnyRate, resetExchangeRateCache } from "./exchange-rate";
import { USD_TO_CNY_FALLBACK_RATE } from "./constants";

afterEach(() => {
  resetExchangeRateCache();
});

describe("getUsdToCnyRate", () => {
  it("returns the live CNY rate from a valid response", async () => {
    const result = await getUsdToCnyRate(async () => ({
      amount: 1,
      base: "USD",
      date: "2026-07-29",
      rates: { CNY: 7.15 },
    }));

    expect(result.rate).toBe(7.15);
    expect(result.currency).toBe("CNY");
    expect(result.isFallback).toBe(false);
  });

  it("caches the rate within the TTL and does not refetch", async () => {
    const fetchJson = vi.fn(async () => ({ rates: { CNY: 7.11 } }));

    const first = await getUsdToCnyRate(fetchJson, 1_000);
    const second = await getUsdToCnyRate(fetchJson, 2_000);

    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(first.rate).toBe(7.11);
    expect(second.rate).toBe(7.11);
    expect(second.fetchedAt).toBe(1_000);
  });

  it("refetches once the cache TTL has elapsed", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ rates: { CNY: 7.0 } })
      .mockResolvedValueOnce({ rates: { CNY: 7.5 } });

    const first = await getUsdToCnyRate(fetchJson, 0);
    // 12h + 1ms later — past the TTL.
    const second = await getUsdToCnyRate(fetchJson, 12 * 60 * 60 * 1_000 + 1);

    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(first.rate).toBe(7.0);
    expect(second.rate).toBe(7.5);
  });

  it("falls back to the hardcoded rate when the fetch fails", async () => {
    const result = await getUsdToCnyRate(async () => {
      throw new Error("offline");
    });

    expect(result.rate).toBe(USD_TO_CNY_FALLBACK_RATE);
    expect(result.isFallback).toBe(true);
  });

  it("falls back when the response is missing a valid CNY rate", async () => {
    const result = await getUsdToCnyRate(async () => ({ rates: {} }));

    expect(result.rate).toBe(USD_TO_CNY_FALLBACK_RATE);
    expect(result.isFallback).toBe(true);
  });

  it("reuses the last good rate when a later fetch fails", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ rates: { CNY: 7.2 } })
      .mockRejectedValueOnce(new Error("offline"));

    await getUsdToCnyRate(fetchJson, 0);
    const stale = await getUsdToCnyRate(fetchJson, 12 * 60 * 60 * 1_000 + 1);

    expect(stale.rate).toBe(7.2);
    expect(stale.isFallback).toBe(false);
  });
});
