import { describe, expect, it } from "vitest";
import { agentRunLifecycleEvent } from "./chat-run-lifecycle";

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
