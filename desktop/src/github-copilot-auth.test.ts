import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGitHubCopilotAuthStatusArgs,
  buildGitHubCopilotLogoutArgs,
  getGitHubCopilotAuthStatus,
  GITHUB_COPILOT_AUTH_AGENT_ID,
  invalidateGitHubCopilotAuthStatusCache,
  parseGitHubCopilotAuthStatus,
  parseGitHubCopilotDisconnectResult,
  parseGitHubCopilotGatewayAuthStatus,
  parseGitHubCopilotGatewayModels,
  parseGitHubCopilotWorkerLine,
} from "./github-copilot-auth";
import {
  buildGitHubCopilotLoginOptions,
  GITHUB_COPILOT_AUTH_AGENT_ID as WORKER_AUTH_AGENT_ID,
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
