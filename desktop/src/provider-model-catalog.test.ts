import { createServer, type RequestListener } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderModelCatalog, discoverProviderModels } from "./provider-model-catalog";

afterEach(() => vi.restoreAllMocks());

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

describe("shared provider model catalog", () => {
  it("shares in-flight discovery and reuses a fresh catalog without exposing mutable results", async () => {
    let requests = 0;
    const catalog = createProviderModelCatalog();
    await withEndpoint(
      (_request, response) => {
        requests++;
        response.end(JSON.stringify({ data: [{ id: "live" }] }));
      },
      async (baseUrl) => {
        const [first, second] = await Promise.all([
          catalog({ baseUrl, apiKey: "fixture" }, {}),
          catalog({ baseUrl: `${baseUrl}/`, apiKey: " fixture " }, {}),
        ]);
        expect(first).toEqual({ ok: true, models: ["live"] });
        expect(second).toEqual(first);
        if (first.ok) first.models.push("untrusted");
        expect(await catalog({ baseUrl, apiKey: "fixture" }, {})).toEqual({
          ok: true,
          models: ["live"],
        });
        expect(requests).toBe(1);
      },
    );
  });

  it("refreshes successful catalogs after one minute", async () => {
    let requests = 0;
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const catalog = createProviderModelCatalog();
    await withEndpoint(
      (_request, response) => {
        requests++;
        response.end(JSON.stringify({ data: [{ id: `live-${requests}` }] }));
      },
      async (baseUrl) => {
        const input = { baseUrl, apiKey: "fixture" };
        await catalog(input, {});
        clock.mockReturnValue(60_999);
        expect(await catalog(input, {})).toEqual({ ok: true, models: ["live-1"] });
        clock.mockReturnValue(61_000);
        expect(await catalog(input, {})).toEqual({ ok: true, models: ["live-2"] });
        expect(requests).toBe(2);
      },
    );
  });

  it("isolates endpoints and resolved credentials, including environment-key rotation", async () => {
    const requests: string[] = [];
    const catalog = createProviderModelCatalog();
    await withEndpoint(
      (request, response) => {
        requests.push(`${request.url} ${request.headers.authorization}`);
        response.end(JSON.stringify({ data: [{ id: "live" }] }));
      },
      async (baseUrl) => {
        const input = { baseUrl, apiKey: "${CATALOG_KEY}" };
        await catalog(input, { CATALOG_KEY: "first" });
        await catalog({ baseUrl, apiKey: "first" }, {});
        await catalog(input, { CATALOG_KEY: "second" });
        await catalog(
          { ...input, baseUrl: baseUrl.replace("/v1", "/other") },
          {
            CATALOG_KEY: "second",
          },
        );
        expect(requests).toEqual([
          "/v1/models Bearer first",
          "/v1/models Bearer second",
          "/other/models Bearer second",
        ]);
        expect(await catalog(input, {})).toEqual({ ok: false, error: "credentials" });
        expect(await catalog({ baseUrl, apiKey: "*****" }, {})).toEqual({
          ok: false,
          error: "maskedKey",
        });
        expect(requests).toHaveLength(3);
      },
    );
  });

  it("does not cache failed discovery", async () => {
    let requests = 0;
    const catalog = createProviderModelCatalog();
    await withEndpoint(
      (_request, response) => {
        requests++;
        response.writeHead(requests === 1 ? 401 : 200);
        response.end(JSON.stringify({ data: [{ id: "live" }] }));
      },
      async (baseUrl) => {
        const input = { baseUrl, apiKey: "fixture" };
        expect(await catalog(input, {})).toEqual({ ok: false, error: "authentication" });
        expect(await catalog(input, {})).toEqual({ ok: true, models: ["live"] });
        expect(requests).toBe(2);
      },
    );
  });

  it("bounds the number of cached credential scopes", async () => {
    let requests = 0;
    const catalog = createProviderModelCatalog();
    await withEndpoint(
      (_request, response) => {
        requests++;
        response.end(JSON.stringify({ data: [{ id: "live" }] }));
      },
      async (baseUrl) => {
        for (let index = 0; index < 17; index++) {
          await catalog({ baseUrl, apiKey: `fixture-${index}` }, {});
        }
        await catalog({ baseUrl, apiKey: "fixture-0" }, {});
        expect(requests).toBe(18);
      },
    );
  });
});
