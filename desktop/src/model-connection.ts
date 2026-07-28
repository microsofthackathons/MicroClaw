import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import type { LookupFunction } from "node:net";

type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

const CREDENTIAL_REFERENCE_PATTERN = /^\$\{([A-Z][A-Z0-9_]*)\}$/;

interface ModelRequestOptions {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

interface PinnedRequestOptions extends HttpsRequestOptions {
  autoSelectFamily?: boolean;
  autoSelectFamilyAttemptTimeout?: number;
}

export interface ModelConnectionResponse {
  ok: boolean;
  status: number;
  statusText: string;
}

function normalizeHostname(value: string): string {
  return value.replace(/^\[|\]$/g, "").toLowerCase();
}

function parseIpv4(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").map(Number);
}

function getMappedIpv4(address: string): string | null {
  const normalized = normalizeHostname(address);
  if (!normalized.startsWith("::ffff:")) return null;
  const suffix = normalized.slice("::ffff:".length);
  if (isIP(suffix) === 4) return suffix;

  const groups = suffix.split(":");
  if (groups.length !== 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
    return null;
  }
  const value = parseInt(groups[0], 16) * 65_536 + parseInt(groups[1], 16);
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(
    ".",
  );
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const mappedIpv4 = getMappedIpv4(normalized);
  const ipv4 = parseIpv4(mappedIpv4 ?? normalized);
  if (ipv4) return ipv4[0] === 127;
  return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
}

function isNonPublicAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const mappedIpv4 = getMappedIpv4(normalized);
  const ipv4 = parseIpv4(mappedIpv4 ?? normalized);
  if (ipv4) {
    const [first, second] = ipv4;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }
  if (isIP(normalized) !== 6) return true;
  return (
    normalized === "::" ||
    isLoopbackAddress(normalized) ||
    /^f[cd]/i.test(normalized) ||
    /^fe[89ab]/i.test(normalized) ||
    /^ff/i.test(normalized) ||
    /^2001:db8:/i.test(normalized)
  );
}

export function isAddressAllowedForHost(hostname: string, address: string): boolean {
  const normalizedHost = normalizeHostname(hostname);
  const explicitLoopback = normalizedHost === "localhost" || isLoopbackAddress(normalizedHost);
  return explicitLoopback ? isLoopbackAddress(address) : !isNonPublicAddress(address);
}

export function resolveModelApiKey(
  configuredApiKey: string,
  environment: Record<string, string | undefined>,
): ValidationResult<string> {
  const value = configuredApiKey.trim();
  const reference = CREDENTIAL_REFERENCE_PATTERN.exec(value);
  if ((value.includes("${") || value.includes("}")) && !reference) {
    return {
      ok: false,
      message: "Credential references must use the ${ENV_VAR} format",
    };
  }
  if (!reference) return { ok: true, value };

  const name = reference[1];
  const resolved = environment[name]?.trim();
  if (!resolved) {
    return {
      ok: false,
      message: `Environment variable ${name} is not defined`,
    };
  }
  return { ok: true, value: resolved };
}

export function prepareModelBaseUrl(baseUrl: string): ValidationResult<string> {
  const value = baseUrl.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: "Invalid URL" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: "Only http:// and https:// URLs are allowed" };
  }
  if (url.username || url.password) {
    return { ok: false, message: "Base URL must not contain embedded credentials" };
  }
  const hostname = normalizeHostname(url.hostname);
  if (isIP(hostname) > 0 && !isAddressAllowedForHost(hostname, hostname)) {
    return {
      ok: false,
      message: "URLs pointing to private or reserved network addresses are not allowed",
    };
  }

  url.hash = "";
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = basePath || "/v1";
  return { ok: true, value: url.toString().replace(/\/$/, "") };
}

export function appendModelEndpoint(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
  return url.toString();
}

async function resolvePinnedAddresses(
  hostname: string,
): Promise<Array<{ address: string; family: number }>> {
  const normalizedHost = normalizeHostname(hostname);
  const family = isIP(normalizedHost);
  const addresses = family
    ? [{ address: normalizedHost, family }]
    : await lookup(normalizedHost, { all: true, verbatim: true });

  if (addresses.length === 0) {
    throw new Error("Model endpoint hostname did not resolve");
  }
  if (addresses.some(({ address }) => !isAddressAllowedForHost(normalizedHost, address))) {
    throw new Error("Model endpoint resolves to a private or reserved network address");
  }
  return addresses;
}

function createPinnedLookup(addresses: Array<{ address: string; family: number }>): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, addresses);
      return;
    }
    const requestedFamily = typeof options.family === "number" ? options.family : 0;
    const selected =
      addresses.find(({ family }) => requestedFamily === 0 || family === requestedFamily) ??
      addresses[0];
    callback(null, selected.address, selected.family);
  };
}

export async function requestModelEndpoint(
  urlValue: string,
  options: ModelRequestOptions,
): Promise<ModelConnectionResponse> {
  const url = new URL(urlValue);
  const pinnedAddresses = await resolvePinnedAddresses(url.hostname);
  const originalHostname = normalizeHostname(url.hostname);

  return new Promise<ModelConnectionResponse>((resolve, reject) => {
    const requestOptions: PinnedRequestOptions = {
      protocol: url.protocol,
      hostname: originalHostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: options.method,
      headers: {
        ...options.headers,
        host: url.host,
      },
      ...(url.protocol === "https:" && isIP(originalHostname) === 0
        ? { servername: originalHostname }
        : {}),
      lookup: createPinnedLookup(pinnedAddresses),
      autoSelectFamily: pinnedAddresses.length > 1,
      autoSelectFamilyAttemptTimeout: 250,
      signal: options.signal,
    };
    const handleResponse = (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      const statusText = response.statusMessage ?? "";
      response.resume();
      if (status >= 300 && status < 400) {
        reject(new Error("Redirect responses are not allowed for model endpoints"));
        return;
      }
      resolve({
        ok: status >= 200 && status < 300,
        status,
        statusText,
      });
    };
    const req =
      url.protocol === "https:"
        ? httpsRequest(requestOptions, handleResponse)
        : httpRequest(requestOptions, handleResponse);
    req.on("error", reject);
    req.end(options.body);
  });
}
