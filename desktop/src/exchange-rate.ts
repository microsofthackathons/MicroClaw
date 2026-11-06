import {
  EXCHANGE_RATE_API_URL,
  EXCHANGE_RATE_CACHE_TTL_MS,
  USD_TO_CNY_FALLBACK_RATE,
} from "./constants";

/**
 * USD→CNY conversion used to display the spend figures relayed from the OpenClaw
 * gateway. The gateway reports cost in USD (OpenClaw's `estimateUsageCost()` is
 * priced from a USD model catalog); MicroClaw converts to CNY purely for display.
 */
export interface ExchangeRate {
  /** Amount of CNY per 1 USD. */
  rate: number;
  /** Target currency code — always "CNY" here. */
  currency: "CNY";
  /** True when the hardcoded fallback rate was used instead of a live fetch. */
  isFallback: boolean;
  /** Epoch millis when this rate was obtained. */
  fetchedAt: number;
}

/** Injectable JSON fetcher so tests can run without real network access. */
export type FetchJson = (url: string) => Promise<unknown>;

interface CacheEntry {
  rate: number;
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

async function fetchRateJson(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Exchange rate request failed with HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Parses the Frankfurter response shape `{ rates: { CNY: number } }` and returns
 * the CNY rate, or throws if the payload is missing/invalid.
 */
function parseCnyRate(value: unknown): number {
  if (!value || typeof value !== "object") {
    throw new Error("Exchange rate response must be a JSON object");
  }
  const rates = (value as Record<string, unknown>).rates;
  if (!rates || typeof rates !== "object") {
    throw new Error("Exchange rate response is missing rates");
  }
  const cny = (rates as Record<string, unknown>).CNY;
  if (typeof cny !== "number" || !Number.isFinite(cny) || cny <= 0) {
    throw new Error("Exchange rate response is missing a valid CNY rate");
  }
  return cny;
}

/**
 * Returns the current USD→CNY rate, caching it in memory for
 * {@link EXCHANGE_RATE_CACHE_TTL_MS}. Falls back to {@link USD_TO_CNY_FALLBACK_RATE}
 * when the endpoint is unreachable so the UI never breaks.
 */
export async function getUsdToCnyRate(
  fetchJson: FetchJson = fetchRateJson,
  now: number = Date.now(),
): Promise<ExchangeRate> {
  if (cache && now - cache.fetchedAt < EXCHANGE_RATE_CACHE_TTL_MS) {
    return {
      rate: cache.rate,
      currency: "CNY",
      isFallback: false,
      fetchedAt: cache.fetchedAt,
    };
  }

  try {
    const rate = parseCnyRate(await fetchJson(EXCHANGE_RATE_API_URL));
    cache = { rate, fetchedAt: now };
    return { rate, currency: "CNY", isFallback: false, fetchedAt: now };
  } catch {
    // Network/API failure: use the last good cached rate if we have one,
    // otherwise the hardcoded fallback so the usage UI keeps working offline.
    if (cache) {
      return {
        rate: cache.rate,
        currency: "CNY",
        isFallback: false,
        fetchedAt: cache.fetchedAt,
      };
    }
    return {
      rate: USD_TO_CNY_FALLBACK_RATE,
      currency: "CNY",
      isFallback: true,
      fetchedAt: now,
    };
  }
}

/** Clears the in-memory rate cache. Intended for tests. */
export function resetExchangeRateCache(): void {
  cache = null;
}
