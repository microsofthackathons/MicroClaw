import { describe, expect, it } from "vitest";
import { PerformanceChatSample } from "./performance-sample";

function sample() {
  const value = new PerformanceChatSample(10);
  value.sessionReady("session", 20);
  value.sent(30);
  value.submitted("session", { runId: "run" });
  return value;
}

describe("performance chat completion boundary", () => {
  it("does not equate submit acknowledgment with completion", () => {
    const value = sample();
    expect(value.snapshot().outcome).toBeNull();
    expect(value.snapshot().metrics.sendToFinalRenderedMs).toBeNull();
  });

  it("requires a matching final and visible body after rendering", () => {
    const value = sample();
    value.event({ sessionKey: "session", runId: "run", state: "delta" });
    value.rendered("run", "answer", false, 40);
    value.event({ sessionKey: "session", runId: "run", state: "final" });
    expect(value.outcome).toBeNull();
    value.rendered("run", "answer", true, 60);
    expect(value.snapshot()).toMatchObject({
      outcome: "success",
      metrics: {
        totalMs: 50,
        sessionReadyMs: 10,
        sendToFirstTextMs: 10,
        sendToFinalRenderedMs: 30,
      },
    });
  });

  it("ignores other sessions, other runs and duplicate terminal events", () => {
    const value = sample();
    value.event({ sessionKey: "other", runId: "background", state: "final" });
    value.event({ sessionKey: "session", runId: "run", state: "delta" });
    value.event({ sessionKey: "session", runId: "other-run", state: "final" });
    value.rendered("run", "answer", true, 45);
    expect(value.outcome).toBeNull();
    value.event({ sessionKey: "session", runId: "run", state: "final" });
    value.rendered("run", "answer", true, 50);
    value.event({ sessionKey: "session", runId: "run", state: "error" });
    value.rendered("run", "answer", true, 999);
    expect(value.outcome).toBe("success");
    expect(value.snapshot().metrics.totalMs).toBe(40);
  });

  it("does not treat reasoning/tool activity or an empty final as answer text", () => {
    const value = sample();
    value.event({ sessionKey: "session", runId: "run", state: "delta" });
    value.rendered("run", "", false, 40);
    value.event({ sessionKey: "session", runId: "run", state: "final" });
    value.rendered("run", "", true, 50);
    expect(value.outcome).toBe("empty-response");
    expect(value.snapshot().metrics.sendToFirstTextMs).toBeNull();
    expect(value.snapshot().metrics.totalMs).toBeNull();
  });

  it.each([
    ["error", "model-error"],
    ["aborted", "cancelled"],
  ])("keeps %s distinct", (state, outcome) => {
    const value = sample();
    value.event({ sessionKey: "session", runId: "run", state });
    expect(value.outcome).toBe(outcome);
    expect(value.snapshot().metrics.totalMs).toBeNull();
  });

  it("does not count lifecycle-end as a rendered final", () => {
    const value = sample();
    value.event({ sessionKey: "session", runId: "run", state: "status", lifecyclePhase: "end" });
    value.rendered("run", "answer", true, 50);
    expect(value.outcome).toBeNull();
  });

  it.each(["error", "aborted"])("rejects %s between final and paint", (state) => {
    const value = sample();
    value.event({ sessionKey: "session", runId: "run", state: "final" });
    value.event({ sessionKey: "session", runId: "run", state });
    value.rendered("run", "answer", true, 50);
    expect(value.outcome).toBe(state === "error" ? "model-error" : "cancelled");
  });

  it("binds to the submission acknowledgment, not the first background run", () => {
    const value = new PerformanceChatSample(10);
    value.sessionReady("session", 20);
    value.sent(30);
    value.event({ sessionKey: "session", runId: "background", state: "final" });
    value.rendered("background", "old answer", true, 35);
    value.event({ sessionKey: "session", runId: "run", state: "delta" });
    value.rendered("run", "answer", false, 40);
    value.submitted("session", { runId: "run" });
    expect(value.runId).toBe("run");
    expect(value.firstTextAt).toBe(40);
    value.rendered("background", "old answer", true, 45);
    expect(value.outcome).toBeNull();
    value.event({ sessionKey: "session", runId: "run", state: "final" });
    value.rendered("run", "answer", true, 50);
    expect(value.outcome).toBe("success");
  });

  it("preserves early final/error events until the actual acknowledgment arrives", () => {
    const value = new PerformanceChatSample(10);
    value.sessionReady("session", 20);
    value.sent(30);
    value.event({ sessionKey: "session", runId: "run", state: "final" });
    value.rendered("run", "answer", true, 40);
    expect(value.outcome).toBeNull();
    value.event({ sessionKey: "session", runId: "run", state: "error" });
    value.submitted("session", { runId: "run" });
    value.rendered("run", "answer", true, 50);
    expect(value.outcome).toBe("model-error");
  });

  it.each([undefined, {}, { runId: "" }])(
    "fails closed without a run acknowledgment: %j",
    (ack) => {
      const value = new PerformanceChatSample(10);
      value.sessionReady("session", 20);
      value.sent(30);
      value.event({ sessionKey: "session", runId: "background", state: "final" });
      value.submitted("session", ack);
      expect(value.outcome).toBe("missing-run-ack");
    },
  );

  it("rejects reuse of an empty session and nonempty newly selected sessions", () => {
    const reused = new PerformanceChatSample(10, "session");
    reused.sessionReady("session", 20, 0);
    expect(reused.outcome).toBe("session-not-new");
    const nonempty = new PerformanceChatSample(10, "old");
    nonempty.sessionReady("new", 20, 1);
    expect(nonempty.outcome).toBe("session-not-empty");
    expect(nonempty.emptySessionVerified).toBe(false);
  });
});
