import { describe, expect, it } from "vitest";
import {
  agentRunLifecycleEvent,
  resolveChatHistorySessionKey,
  type ChatHistoryResult,
} from "./chat-run-lifecycle";

describe("chat history session identity", () => {
  const key = "agent:main:main";
  const sessionInfo = { key, isMain: true, hasActiveRun: false, activeRunIds: [] };

  it("uses the canonical runtime key when chat.history echoes the main alias", () => {
    expect(resolveChatHistorySessionKey("main", { sessionKey: "main", sessionInfo })).toBe(key);
  });

  it("accepts a canonical response to an alias and history without runtime metadata", () => {
    expect(resolveChatHistorySessionKey("main", { sessionKey: key, sessionInfo })).toBe(key);
    expect(resolveChatHistorySessionKey("main", { messages: [] })).toBe("main");
    expect(resolveChatHistorySessionKey(key, { sessionInfo })).toBe(key);
  });

  it.each([
    ["agent:other:main", { sessionKey: "agent:other:main", sessionInfo }],
    ["global", { sessionKey: "global", sessionInfo }],
    ["main", { sessionKey: "agent:other:main", sessionInfo }],
    ["main", { sessionKey: "main", sessionInfo: { key, hasActiveRun: false } }],
    ["main", { sessionKey: "main", sessionInfo: null }],
  ])(
    "rejects conflicting canonical identities and malformed runtime for %s",
    (requested, result) => {
      expect(() => resolveChatHistorySessionKey(requested, result as ChatHistoryResult)).toThrow(
        "Invalid Gateway chat runtime snapshot",
      );
    },
  );
});

describe("authoritative external agent run lifecycle", () => {
  it.each(["start", "end", "error"])(
    "forwards exact session/run %s without fabricating a chat turn",
    (phase) => {
      expect(
        agentRunLifecycleEvent({
          stream: "lifecycle",
          sessionKey: "agent:main:main",
          runId: "actual-run",
          data: { phase },
        }),
      ).toEqual({
        state: "status",
        sessionKey: "agent:main:main",
        runId: "actual-run",
        lifecyclePhase: phase,
      });
    },
  );
  it.each([
    null,
    {},
    { stream: "tool" },
    { stream: "lifecycle", runId: "r", data: { phase: "start" } },
  ])("does not infer a run from other events or input %j", (value) => {
    expect(agentRunLifecycleEvent(value)).toBeNull();
  });
});
