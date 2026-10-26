import { createServer, type RequestListener } from "node:http";
import { describe, expect, it } from "vitest";
import { discoverProviderModels } from "./provider-model-catalog";

async function withEndpoint(handler: RequestListener, run: (base: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  try {
    await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("provider model catalog", () => {
  it("uses only authenticated GET /models and returns remote IDs without presets", async () => {
    await withEndpoint(
      (request, response) => {
        expect(request.method).toBe("GET");
        expect(request.url).toBe("/v1/models");
        expect(request.headers.authorization).toBe("Bearer fixture-key");
        response.end(
          JSON.stringify({ data: [{ id: "remote-new" }, { id: "remote-new" }, { id: "other" }] }),
        );
      },
      async (baseUrl) => {
        expect(
          await discoverProviderModels(
            { baseUrl, apiKey: "${CATALOG_KEY}" },
            {
              CATALOG_KEY: "fixture-key",
            },
          ),
        ).toEqual({ ok: true, models: ["remote-new", "other"] });
      },
    );
  });

  it.each([401, 403])("reports HTTP %i without leaking provider bodies or keys", async (status) => {
    await withEndpoint(
      (_request, response) => {
        response.writeHead(status);
        response.end(JSON.stringify({ error: { message: "Rejected fixture-key" } }));
      },
      async (baseUrl) => {
        expect(await discoverProviderModels({ baseUrl, apiKey: "fixture-key" }, {})).toEqual({
          ok: false,
          error: "authentication",
        });
      },
    );
  });

  it.each([
    [404, "{}", "unavailable"],
    [200, "not json", "response"],
    [200, '{"data":[{"name":"missing-id"}]}', "response"],
    [200, '{"data":[]}', "empty"],
    [200, '{"models":["invented"]}', "response"],
    [200, '{"data":[{"id":"bad model"}]}', "response"],
  ])("does not invent a list for status %i / %s", async (status, body, error) => {
    await withEndpoint(
      (_request, response) => {
        response.writeHead(Number(status));
        response.end(String(body));
      },
      async (baseUrl) => {
        expect(await discoverProviderModels({ baseUrl, apiKey: "fixture-key" }, {})).toEqual({
          ok: false,
          error,
        });
      },
    );
  });

  it("refuses masked keys and invalid endpoints before contacting a provider", async () => {
    expect(
      await discoverProviderModels({ baseUrl: "https://example.com", apiKey: "sk-*****" }, {}),
    ).toEqual({ ok: false, error: "maskedKey" });
    expect(
      await discoverProviderModels({ baseUrl: "https://example.com", apiKey: "${MISSING}" }, {}),
    ).toEqual({ ok: false, error: "credentials" });
    expect(
      await discoverProviderModels({ baseUrl: "file:///test", apiKey: "fixture" }, {}),
    ).toEqual({ ok: false, error: "endpoint" });
  });

  it("does not forward credentials through redirects", async () => {
    await withEndpoint(
      (_request, response) => {
        response.writeHead(302, { Location: "https://example.com/collect" });
        response.end();
      },
      async (baseUrl) => {
        expect(await discoverProviderModels({ baseUrl, apiKey: "fixture" }, {})).toEqual({
          ok: false,
          error: "network",
        });
      },
    );
  });

  it("bounds the response body", async () => {
    await withEndpoint(
      (_request, response) => response.end("x".repeat(1024 * 1024 + 1)),
      async (baseUrl) => {
        expect(await discoverProviderModels({ baseUrl, apiKey: "fixture" }, {})).toEqual({
          ok: false,
          error: "network",
        });
      },
    );
  });
});
