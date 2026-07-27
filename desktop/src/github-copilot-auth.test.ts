import { describe, expect, it } from "vitest";
import {
  parseGitHubCopilotAuthStatus,
  parseGitHubCopilotDisconnectResult,
  parseGitHubCopilotGatewayAuthStatus,
  parseGitHubCopilotGatewayDisconnectResult,
  parseGitHubCopilotGatewayModels,
  parseGitHubCopilotWorkerLine,
} from "./github-copilot-auth";

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
  it("detects an existing auth profile without exposing profile contents", () => {
    expect(
      parseGitHubCopilotAuthStatus(
        JSON.stringify({ provider: "github-copilot", profiles: [{ id: "private" }] }),
      ),
    ).toBe(true);
    expect(parseGitHubCopilotAuthStatus(JSON.stringify({ profiles: [] }))).toBe(false);
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

  it("accepts the Gateway logout response used to clear inherited profiles", () => {
    expect(
      parseGitHubCopilotGatewayDisconnectResult({
        provider: "github-copilot",
        removedProfiles: ["github-copilot:github"],
        abortedRunIds: [],
      }),
    ).toEqual({ disconnected: true, removedProfiles: 1 });
  });

  it("reads GitHub Copilot authentication from the connected Gateway", () => {
    expect(
      parseGitHubCopilotGatewayAuthStatus({
        providers: [
          {
            provider: "github-copilot",
            status: "static",
            profiles: [{ type: "token", status: "static" }],
          },
        ],
      }),
    ).toBe(true);
    expect(parseGitHubCopilotGatewayAuthStatus({ providers: [] })).toBe(false);
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
