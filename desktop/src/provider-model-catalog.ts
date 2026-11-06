import { createHash } from "node:crypto";
import {
  appendModelEndpoint,
  prepareModelBaseUrl,
  requestModelEndpoint,
  resolveModelApiKey,
} from "./model-connection";

export interface ProviderCatalogInput {
  baseUrl: string;
  apiKey: string;
}

export type ProviderCatalogError =
  | "credentials"
  | "maskedKey"
  | "endpoint"
  | "authentication"
  | "unavailable"
  | "response"
  | "empty"
  | "network";

export type ProviderCatalogResult =
  | { ok: true; models: string[] }
  | { ok: false; error: ProviderCatalogError };

function prepareCatalogInput(
  input: unknown,
  environment: Record<string, string | undefined>,
): { ok: true; input: ProviderCatalogInput } | { ok: false; error: ProviderCatalogError } {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ok: false, error: "credentials" };
  const params = input as Partial<ProviderCatalogInput>;
  if (typeof params.apiKey !== "string" || typeof params.baseUrl !== "string")
    return { ok: false, error: "credentials" };
  const key = resolveModelApiKey(params.apiKey, environment);
  if (!key.ok || !key.value) return { ok: false, error: "credentials" };
  if (/[*•●]|__OPENCLAW_REDACTED__/i.test(key.value)) return { ok: false, error: "maskedKey" };
  const base = prepareModelBaseUrl(params.baseUrl);
  if (!base.ok) return { ok: false, error: "endpoint" };
  return { ok: true, input: { baseUrl: base.value, apiKey: key.value } };
}

export async function discoverProviderModels(
  input: unknown,
  environment: Record<string, string | undefined>,
): Promise<ProviderCatalogResult> {
  const prepared = prepareCatalogInput(input, environment);
  return prepared.ok ? requestProviderModels(prepared.input) : prepared;
}

export function createProviderModelCatalog() {
  const entries = new Map<string, { expiresAt: number; promise: Promise<ProviderCatalogResult> }>();
  return async (
    input: unknown,
    environment: Record<string, string | undefined>,
  ): Promise<ProviderCatalogResult> => {
    const prepared = prepareCatalogInput(input, environment);
    if (!prepared.ok) return prepared;
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= Date.now()) entries.delete(id);
    }
    const id = createHash("sha256")
      .update(JSON.stringify([prepared.input.baseUrl, prepared.input.apiKey]))
      .digest("hex");
    const cached = entries.get(id);
    if (cached) return structuredClone(await cached.promise);
    const entry = {
      expiresAt: Infinity,
      promise: requestProviderModels(prepared.input),
    };
    entries.set(id, entry);
    while (entries.size > 16) entries.delete(entries.keys().next().value!);
    const result = await entry.promise;
    if (entries.get(id) === entry) {
      if (result.ok) entry.expiresAt = Date.now() + 60_000;
      else entries.delete(id);
    }
    return structuredClone(result);
  };
}

async function requestProviderModels(input: ProviderCatalogInput): Promise<ProviderCatalogResult> {
  try {
    const result = await requestModelEndpoint(appendModelEndpoint(input.baseUrl, "models"), {
      method: "GET",
      headers: { Authorization: `Bearer ${input.apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
      responseBodyLimit: 1024 * 1024,
    });
    if (result.status === 401 || result.status === 403)
      return { ok: false, error: "authentication" };
    if (!result.ok) return { ok: false, error: "unavailable" };
    let data: unknown;
    try {
      data = JSON.parse(result.body ?? "");
    } catch {
      return { ok: false, error: "response" };
    }
    if (!data || typeof data !== "object" || !("data" in data) || !Array.isArray(data.data))
      return { ok: false, error: "response" };
    const models: string[] = [];
    for (const row of data.data) {
      if (
        !row ||
        typeof row !== "object" ||
        typeof row.id !== "string" ||
        !row.id ||
        row.id.length > 512 ||
        /[\s\\*]/.test(row.id)
      )
        return { ok: false, error: "response" };
      models.push(row.id);
    }
    return models.length
      ? { ok: true, models: [...new Set(models)] }
      : { ok: false, error: "empty" };
  } catch {
    // Never return upstream bodies or exception text that may contain the credential.
    return { ok: false, error: "network" };
  }
}
