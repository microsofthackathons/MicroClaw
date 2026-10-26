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

export async function discoverProviderModels(
  input: unknown,
  environment: Record<string, string | undefined>,
): Promise<ProviderCatalogResult> {
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
  try {
    const result = await requestModelEndpoint(appendModelEndpoint(base.value, "models"), {
      method: "GET",
      headers: { Authorization: `Bearer ${key.value}`, Accept: "application/json" },
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
