import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  appendModelEndpoint,
  isAddressAllowedForHost,
  prepareModelBaseUrl,
  requestModelEndpoint,
  resolveModelApiKey,
} from "./model-connection";

describe("prepareModelBaseUrl", () => {
  it.each([
    ["http://localhost:11434", "http://localhost:11434/v1"],
    ["http://127.0.0.1:11434/v1", "http://127.0.0.1:11434/v1"],
  ])("allows explicit loopback provider endpoint %s", (value, expected) => {
    expect(prepareModelBaseUrl(value)).toEqual({
      ok: true,
      value: expected,
    });
  });

  it("infers /v1 only for a root URL and preserves provider paths", () => {
    expect(prepareModelBaseUrl("https://example.com")).toEqual({
      ok: true,
      value: "https://example.com/v1",
    });
    expect(prepareModelBaseUrl("https://example.com/compatible-mode")).toEqual({
      ok: true,
      value: "https://example.com/compatible-mode",
    });
    expect(prepareModelBaseUrl("https://example.com/compatible-mode/v1/")).toEqual({
      ok: true,
      value: "https://example.com/compatible-mode/v1",
    });
    expect(prepareModelBaseUrl("https://generativelanguage.googleapis.com/v1beta/openai/")).toEqual(
      {
        ok: true,
        value: "https://generativelanguage.googleapis.com/v1beta/openai",
      },
    );
  });

  it.each([
    "http://10.0.0.1:11434",
    "http://172.16.0.1:11434",
    "http://192.168.1.2:11434",
    "http://169.254.169.254/latest",
  ])("blocks non-loopback private endpoint %s", (value) => {
    expect(prepareModelBaseUrl(value).ok).toBe(false);
  });

  it("appends request paths before query parameters", () => {
    expect(appendModelEndpoint("https://example.com/v1?api-version=1", "responses")).toBe(
      "https://example.com/v1/responses?api-version=1",
    );
  });

  it("rejects DNS and IPv4-mapped IPv6 routes to protected addresses", () => {
    expect(isAddressAllowedForHost("10-0-0-1.nip.io", "10.0.0.1")).toBe(false);
    expect(isAddressAllowedForHost("metadata.example", "::ffff:169.254.169.254")).toBe(false);
    expect(isAddressAllowedForHost("localhost", "127.0.0.1")).toBe(true);
    expect(isAddressAllowedForHost("api.example.com", "8.8.8.8")).toBe(true);
  });

  it("pins loopback requests and rejects redirects", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { Location: "http://169.254.169.254/latest" });
      } else {
        response.writeHead(200);
      }
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      await expect(
        requestModelEndpoint(`http://127.0.0.1:${port}/ok`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(2_000),
        }),
      ).resolves.toMatchObject({ ok: true, status: 200 });
      await expect(
        requestModelEndpoint(`http://127.0.0.1:${port}/redirect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(2_000),
        }),
      ).rejects.toThrow("Redirect responses are not allowed");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("falls back to an IPv6-only localhost endpoint", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "::1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRNOTAVAIL") return;
      throw error;
    }
    const { port } = server.address() as AddressInfo;

    try {
      await expect(
        requestModelEndpoint(`http://localhost:${port}/ok`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(2_000),
        }),
      ).resolves.toMatchObject({ ok: true, status: 200 });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("resolveModelApiKey", () => {
  it("resolves an uppercase environment reference", () => {
    expect(resolveModelApiKey("${MODEL_API_KEY}", { MODEL_API_KEY: " secret " })).toEqual({
      ok: true,
      value: "secret",
    });
  });

  it("allows a blank key for keyless providers", () => {
    expect(resolveModelApiKey("", {})).toEqual({ ok: true, value: "" });
  });

  it.each(["${lowercase}", "${_LEADING_UNDERSCORE}", "${MISSING_BRACE"])(
    "rejects unsupported credential reference %s",
    (value) => {
      expect(resolveModelApiKey(value, {}).ok).toBe(false);
    },
  );

  it("rejects a missing referenced credential", () => {
    expect(resolveModelApiKey("${MODEL_API_KEY}", {})).toEqual({
      ok: false,
      message: "Environment variable MODEL_API_KEY is not defined",
    });
  });
});
