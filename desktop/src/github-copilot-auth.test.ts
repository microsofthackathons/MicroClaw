import { beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import {
  buildGitHubCopilotAuthStatusArgs,
  buildGitHubCopilotLogoutArgs,
  buildGitHubCopilotModelsArgs,
  getGitHubCopilotAuthStatus,
  GITHUB_COPILOT_AUTH_AGENT_ID,
  GITHUB_COPILOT_CATALOG_TIMEOUT_MS,
  invalidateGitHubCopilotAuthStatusCache,
  listGitHubCopilotModels,
  parseGitHubCopilotAuthStatus,
  parseGitHubCopilotCliModels,
  parseGitHubCopilotDisconnectResult,
  parseGitHubCopilotGatewayAuthStatus,
  parseGitHubCopilotGatewayModels,
  parseGitHubCopilotWorkerLine,
} from "./github-copilot-auth";
import {
  buildGitHubCopilotLoginOptions,
  extractDevicePrompt,
  GITHUB_COPILOT_AUTH_AGENT_ID as WORKER_AUTH_AGENT_ID,
  readGitHubCopilotRuntimeConfig,
  resolveGitHubCopilotConfigRuntimePath,
} from "./github-copilot-auth-worker";

const missingRuntime = {
  nodePath: "node",
  entryPath: "missing-openclaw-entry.mjs",
  workerPath: "missing-auth-worker.js",
  openClawPackageDir: ".",
  stateDir: ".",
  compileCacheDir: ".",
};

beforeEach(() => {
  invalidateGitHubCopilotAuthStatusCache();
});

describe("GitHub Copilot auth scope", () => {
  it("uses OpenClaw's fixed main agent as the shared credential owner", () => {
    expect(GITHUB_COPILOT_AUTH_AGENT_ID).toBe("main");
    expect(WORKER_AUTH_AGENT_ID).toBe("main");
    expect(buildGitHubCopilotAuthStatusArgs()).toEqual([
      "models",
      "status",
      "--agent",
      "main",
      "--json",
    ]);
    expect(buildGitHubCopilotLogoutArgs()).toEqual([
      "infer",
      "model",
      "auth",
      "logout",
      "--provider",
      "github-copilot",
      "--agent",
      "main",
      "--json",
    ]);
    expect(
      buildGitHubCopilotLoginOptions({
        config: {},
        prompter: {},
        openUrl: async () => {},
        runtime: {},
      }),
    ).toMatchObject({
      agent: "main",
      provider: "github-copilot",
      method: "device",
      setDefault: false,
    });
  });
});

describe("GitHub Copilot configuration runtime compatibility", () => {
  it("uses the legacy SDK configuration entry when available", () => {
    const runtimeDirectory = path.resolve("openclaw", "dist", "plugin-sdk");
    const legacyPath = path.join(runtimeDirectory, "config-runtime.js");
    expect(
      resolveGitHubCopilotConfigRuntimePath(
        runtimeDirectory,
        (filename) => filename === legacyPath,
      ),
    ).toBe(legacyPath);
  });

  it("uses the OpenClaw 2026.10.5 runtime snapshot entry without the legacy SDK entry", () => {
    const runtimeDirectory = path.resolve("openclaw", "dist", "plugin-sdk");
    expect(resolveGitHubCopilotConfigRuntimePath(runtimeDirectory, () => false)).toBe(
      path.join(runtimeDirectory, "runtime-config-snapshot.js"),
    );
  });

  it.each(["loadConfig", "getRuntimeConfig"] as const)("loads configuration with %s", (method) => {
    const config = { agents: { defaults: {} } };
    const loader = vi.fn().mockReturnValue(config);
    expect(readGitHubCopilotRuntimeConfig({ [method]: loader })).toBe(config);
    expect(loader).toHaveBeenCalledExactlyOnceWith({ skipPluginValidation: true });
  });

  it("rejects an incompatible configuration runtime", () => {
    expect(() => readGitHubCopilotRuntimeConfig({})).toThrow(
      "OpenClaw configuration runtime is incompatible",
    );
  });
});

describe("GitHub Copilot device prompt compatibility", () => {
  it.each(["https://github.com/login/device", "<https://github.com/login/device>"])(
    "extracts the authorization code from URL: %s",
    (url) => {
      const prompt = extractDevicePrompt(
        [
          "Open this URL in your browser and enter the code below.",
          `URL: ${url}`,
          "Code: ABCD-1234",
          "Code expires in 15 minutes. Never share it.",
          "",
          "If a browser does not open automatically after you continue, copy the URL manually.",
        ].join("\n"),
      );

      expect(prompt).toEqual({
        verificationUrl: "https://github.com/login/device",
        userCode: "ABCD-1234",
        expiresInMs: 900_000,
      });
      expect(
        parseGitHubCopilotWorkerLine(
          `MICROCLAW_COPILOT_AUTH:${JSON.stringify({ type: "device-code", ...prompt })}`,
        ),
      ).toEqual({ type: "device-code", ...prompt });
    },
  );

  it.each([
    "https://example.com/login/device",
    "<https://example.com/login/device>",
    "https://github.com/login/device/other",
    "<https://github.com/login/device/other>",
    "https://github.com/login/device.example.com",
    "<https://github.com/login/device.example.com>",
  ])("rejects an unexpected verification URL: %s", (url) => {
    expect(
      extractDevicePrompt(`URL: ${url}\nCode: ABCD-1234\nCode expires in 15 minutes.`),
    ).toBeNull();
  });

  it.each([
    "This will open a GitHub device login to authorize Copilot.",
    "URL: <https://github.com/login/device>\nCode expires in 15 minutes.",
    "URL: <https://github.com/login/device>\nCode: ABCD-1234",
    "URL: <https://github.com/login/device>\nCode: ABCD-1234\nCode expires in 0 minutes.",
  ])("ignores notes without a complete usable device prompt: %s", (message) => {
    expect(extractDevicePrompt(message)).toBeNull();
  });
});

describe("GitHub Copilot CLI model catalog", () => {
  it("refreshes the provider-scoped CLI catalog using the shared auth agent", () => {
    expect(buildGitHubCopilotModelsArgs()).toEqual([
      "models",
      "list",
      "--refresh",
      "--all",
      "--provider",
      "github-copilot",
      "--agent",
      "main",
      "--json",
    ]);
  });

  it("normalizes and deduplicates Copilot entries without exposing other providers", () => {
    expect(
      parseGitHubCopilotCliModels(
        JSON.stringify({
          models: [
            { key: "openai/gpt-5", name: "Other provider" },
            { key: "github-copilot/gpt-5", name: "GPT-5" },
            { key: "github-copilot/gpt-5", name: "GPT-5" },
            { key: "github-copilot/claude-sonnet" },
            { key: "github-copilot/" },
            null,
          ],
        }),
      ),
    ).toEqual([
      { id: "github-copilot/claude-sonnet", name: "claude-sonnet" },
      { id: "github-copilot/gpt-5", name: "GPT-5" },
    ]);
  });

  it("accepts an empty catalog before sign-in", () => {
    expect(parseGitHubCopilotCliModels('{"models":[]}')).toEqual([]);
  });

  it.each(["invalid", "null", "{}", '{"models":{}}'])("rejects malformed output: %s", (output) => {
    expect(() => parseGitHubCopilotCliModels(output)).toThrow("Invalid GitHub Copilot model list");
  });

  it("bounds the model list before normalizing entries", () => {
    expect(() =>
      parseGitHubCopilotCliModels(JSON.stringify({ models: Array(5001).fill({}) })),
    ).toThrow("Invalid GitHub Copilot model list");
  });
});

describe("GitHub Copilot model discovery", () => {
  const catalog = {
    models: [{ provider: "github-copilot", id: "gpt-5.4", name: "GPT-5.4" }],
  };
  const models = [{ id: "github-copilot/gpt-5.4", name: "GPT-5.4" }];

  it("uses an already prepared catalog without refreshing or starting the CLI", async () => {
    const queryGateway = vi.fn().mockResolvedValue(catalog);

    await expect(listGitHubCopilotModels(missingRuntime, queryGateway)).resolves.toEqual(models);
    expect(queryGateway).toHaveBeenCalledExactlyOnceWith(
      { agentId: "main", provider: "github-copilot", view: "all", preparedOnly: true },
      30_000,
    );
    await expect(listGitHubCopilotModels(missingRuntime, queryGateway)).resolves.toEqual(models);
    expect(queryGateway).toHaveBeenCalledOnce();
  });

  it("refreshes an empty prepared catalog before treating the account as having no models", async () => {
    const queryGateway = vi.fn().mockResolvedValueOnce({ models: [] }).mockResolvedValue(catalog);

    await expect(listGitHubCopilotModels(missingRuntime, queryGateway)).resolves.toEqual(models);
    expect(queryGateway).toHaveBeenNthCalledWith(
      2,
      { agentId: "main", provider: "github-copilot", view: "all", refresh: true },
      GITHUB_COPILOT_CATALOG_TIMEOUT_MS,
    );
  });

  it("shares discovery between simultaneous requests", async () => {
    const queryGateway = vi.fn().mockResolvedValueOnce({ models: [] }).mockResolvedValue(catalog);

    await expect(
      Promise.all([
        listGitHubCopilotModels(missingRuntime, queryGateway),
        listGitHubCopilotModels(missingRuntime, queryGateway),
      ]),
    ).resolves.toEqual([models, models]);
    expect(queryGateway).toHaveBeenCalledTimes(2);
  });

  it("falls back to the CLI without caching a failed discovery", async () => {
    const queryGateway = vi
      .fn()
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({ models: [] });

    await expect(listGitHubCopilotModels(missingRuntime, queryGateway)).rejects.toThrow(
      "OpenClaw CLI was not found",
    );
    queryGateway.mockResolvedValue(catalog);
    await expect(listGitHubCopilotModels(missingRuntime, queryGateway)).resolves.toEqual(models);
  });

  it("does not reuse or cache an in-flight catalog from before a new login", async () => {
    let resolveOldCatalog!: (payload: unknown) => void;
    const oldCatalog = new Promise((resolve) => {
      resolveOldCatalog = resolve;
    });
    const oldRequest = listGitHubCopilotModels(missingRuntime, () => oldCatalog);
    invalidateGitHubCopilotAuthStatusCache();
    const queryGateway = vi.fn().mockResolvedValue(catalog);
    await expect(listGitHubCopilotModels(missingRuntime, queryGateway)).resolves.toEqual(models);

    resolveOldCatalog({ models: [{ provider: "github-copilot", id: "old-model" }] });
    await expect(oldRequest).resolves.toEqual([
      { id: "github-copilot/old-model", name: "old-model" },
    ]);
    await expect(listGitHubCopilotModels(missingRuntime, queryGateway)).resolves.toEqual(models);
    expect(queryGateway).toHaveBeenCalledOnce();
  });
});

describe("parseGitHubCopilotWorkerLine", () => {
  it("accepts the fixed GitHub verification URL and a valid device code", () => {
    expect(
      parseGitHubCopilotWorkerLine(
        'MICROCLAW_COPILOT_AUTH:{"type":"device-code","verificationUrl":"https://github.com/login/device","userCode":"ABCD-1234","expiresInMs":900000}',
      ),
    ).toEqual({
      type: "device-code",
      verificationUrl: "https://github.com/login/device",
      userCode: "ABCD-1234",
      expiresInMs: 900000,
    });
  });

  it("rejects a verification URL outside GitHub", () => {
    expect(() =>
      parseGitHubCopilotWorkerLine(
        'MICROCLAW_COPILOT_AUTH:{"type":"open-url","url":"https://example.com/login"}',
      ),
    ).toThrow("unexpected verification URL");
  });

  it("does not accept a successful result without a persisted profile", () => {
    expect(() =>
      parseGitHubCopilotWorkerLine('MICROCLAW_COPILOT_AUTH:{"type":"complete","profileCount":0}'),
    ).toThrow("did not create a credential profile");
  });

  it("accepts a provider-side cancellation without treating it as success", () => {
    expect(parseGitHubCopilotWorkerLine('MICROCLAW_COPILOT_AUTH:{"type":"cancelled"}')).toEqual({
      type: "cancelled",
    });
  });

  it("accepts only full GitHub Copilot references from the model worker", () => {
    expect(
      parseGitHubCopilotWorkerLine(
        'MICROCLAW_COPILOT_AUTH:{"type":"models","models":[{"id":"github-copilot/gpt-5.4","name":"GPT-5.4"}]}',
      ),
    ).toEqual({
      type: "models",
      models: [{ id: "github-copilot/gpt-5.4", name: "GPT-5.4" }],
    });
    expect(() =>
      parseGitHubCopilotWorkerLine(
        'MICROCLAW_COPILOT_AUTH:{"type":"models","models":[{"id":"openai/gpt-5.4","name":"GPT-5.4"}]}',
      ),
    ).toThrow("Invalid GitHub Copilot model reference");
  });
});

describe("GitHub Copilot CLI output parsing", () => {
  it("accepts only usable GitHub Copilot authentication health", () => {
    expect(
      parseGitHubCopilotAuthStatus(
        JSON.stringify({
          auth: {
            oauth: {
              providers: [
                {
                  provider: "github-copilot",
                  status: "ok",
                  profiles: [{ status: "static" }],
                },
              ],
            },
          },
        }),
      ),
    ).toBe(true);
    expect(
      parseGitHubCopilotAuthStatus(
        JSON.stringify({
          auth: {
            oauth: {
              providers: [
                {
                  provider: "github-copilot",
                  status: "expired",
                  profiles: [{ status: "expired" }],
                },
              ],
            },
          },
        }),
      ),
    ).toBe(false);
    expect(
      parseGitHubCopilotAuthStatus(
        JSON.stringify({
          auth: { oauth: { providers: [{ provider: "openai", status: "ok" }] } },
        }),
      ),
    ).toBe(false);
    expect(() => parseGitHubCopilotAuthStatus(JSON.stringify({ profiles: [] }))).toThrow(
      "Invalid GitHub Copilot authentication status",
    );
  });

  it("accepts only a GitHub Copilot provider logout result", () => {
    expect(
      parseGitHubCopilotDisconnectResult(
        JSON.stringify({
          provider: "github-copilot",
          removedProfiles: ["github-copilot:device"],
        }),
      ),
    ).toEqual({ disconnected: true, removedProfiles: 1 });
    expect(() =>
      parseGitHubCopilotDisconnectResult(
        JSON.stringify({ provider: "openai", removedProfiles: [] }),
      ),
    ).toThrow("Invalid GitHub Copilot disconnect response");
  });

  it("reads GitHub Copilot authentication health from the Gateway", () => {
    expect(
      parseGitHubCopilotGatewayAuthStatus({
        ts: Date.now(),
        providers: [
          {
            provider: "github-copilot",
            status: "ok",
            profiles: [{ status: "ok" }],
          },
        ],
      }),
    ).toBe(true);
    expect(
      parseGitHubCopilotGatewayAuthStatus({
        providers: [
          {
            provider: "github-copilot",
            status: "expired",
            profiles: [{ status: "expired" }],
          },
        ],
      }),
    ).toBe(false);
    expect(() => parseGitHubCopilotGatewayAuthStatus({ auth: {} })).toThrow(
      "Invalid GitHub Copilot authentication status",
    );
  });

  it("prefers Gateway authentication health without starting the CLI", async () => {
    const queryGateway = vi.fn().mockResolvedValue({
      providers: [
        {
          provider: "github-copilot",
          status: "ok",
          profiles: [{ status: "ok" }],
        },
      ],
    });

    await expect(getGitHubCopilotAuthStatus(missingRuntime, queryGateway)).resolves.toEqual({
      authenticated: true,
    });
    expect(queryGateway).toHaveBeenCalledOnce();
  });

  it("falls back to the CLI when the Gateway response is unusable", async () => {
    const queryGateway = vi.fn().mockResolvedValue({ providers: "invalid" });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(getGitHubCopilotAuthStatus(missingRuntime, queryGateway)).rejects.toThrow(
      "OpenClaw CLI was not found",
    );
    expect(queryGateway).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });

  it("normalizes GitHub Copilot models returned by the Gateway", () => {
    expect(
      parseGitHubCopilotGatewayModels({
        models: [
          { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
          { provider: "github-copilot", id: "gpt-5.4", name: "GPT-5.4" },
          { provider: "github-copilot", id: "claude-sonnet-4.6" },
        ],
      }),
    ).toEqual([
      {
        id: "github-copilot/claude-sonnet-4.6",
        name: "claude-sonnet-4.6",
      },
      { id: "github-copilot/gpt-5.4", name: "GPT-5.4" },
    ]);
  });
});
