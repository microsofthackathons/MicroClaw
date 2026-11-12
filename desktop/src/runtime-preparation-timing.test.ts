import { describe, expect, it, vi } from "vitest";
import {
  measureRuntimePhase,
  parseRuntimeTiming,
  RUNTIME_PREPARATION_TIMING_PREFIX,
  RuntimePreparationTiming,
  type RuntimePreparationTimingEvent,
} from "./runtime-preparation-timing";

function fixture() {
  const events: RuntimePreparationTimingEvent[] = [];
  const clock = vi.fn(() => 100);
  const timing = new RuntimePreparationTiming(
    "worker",
    (message) => {
      expect(message.startsWith(RUNTIME_PREPARATION_TIMING_PREFIX)).toBe(true);
      events.push(JSON.parse(message.slice(RUNTIME_PREPARATION_TIMING_PREFIX.length)));
    },
    clock,
  );
  return { timing, events, clock };
}

describe("runtime preparation timing", () => {
  it("only forwards valid timing fields without rewriting worker clocks", () => {
    const { timing, events } = fixture();
    timing.forward("unrelated output");
    timing.forward(RUNTIME_PREPARATION_TIMING_PREFIX + "malformed");
    timing.forward(
      RUNTIME_PREPARATION_TIMING_PREFIX +
        JSON.stringify({
          scope: "worker",
          phase: "archive-extract",
          kind: "phase",
          status: "failed",
          elapsedMs: 17,
          durationMs: 10,
          secret: "not-forwarded",
        }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      scope: "worker",
      phase: "archive-extract",
      kind: "phase",
      status: "failed",
      elapsedMs: 17,
      durationMs: 10,
    });
    expect(
      parseRuntimeTiming(
        RUNTIME_PREPARATION_TIMING_PREFIX + JSON.stringify({ ...events[0], durationMs: -1 }),
      ),
    ).toBeNull();
  });
  it("records a monotonic phase duration without changing its result", () => {
    const { timing, events, clock } = fixture();
    const result = timing.measure("archive-extract", () => {
      clock.mockReturnValue(112.6);
      return "prepared";
    });
    expect(result).toBe("prepared");
    expect(events).toEqual([
      {
        scope: "worker",
        phase: "archive-extract",
        kind: "phase",
        status: "started",
        elapsedMs: 100,
      },
      {
        scope: "worker",
        phase: "archive-extract",
        kind: "phase",
        status: "success",
        elapsedMs: 113,
        durationMs: 13,
      },
    ]);
  });

  it("records cache outcomes explicitly", () => {
    const { timing, events } = fixture();
    expect(
      timing.measure(
        "cache-check",
        () => true,
        (hit) => ({ cache: hit ? "hit" : "miss" }),
      ),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({ cache: "hit", durationMs: 0 });
  });

  it("records failed phases and preserves the original exception", () => {
    const { timing, events, clock } = fixture();
    const failure = Object.assign(new Error("disk failure"), { code: "EIO" });
    expect(() =>
      timing.measure("old-runtime-remove", () => {
        clock.mockReturnValue(145);
        throw failure;
      }),
    ).toThrow(failure);
    expect(events.at(-1)).toMatchObject({
      status: "failed",
      durationMs: 45,
      errorCode: "EIO",
    });
  });

  it("marks nested summaries and only finishes once", () => {
    const { timing, events, clock } = fixture();
    const finish = timing.start("worker-total", "summary");
    clock.mockReturnValue(150);
    finish("failed");
    finish("success");
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ kind: "summary", status: "failed", durationMs: 50 });
  });

  it("does not let a broken log sink change preparation results or failures", () => {
    const timing = new RuntimePreparationTiming("worker", () => {
      throw new Error("logging unavailable");
    });
    expect(timing.measure("cache-check", () => true)).toBe(true);
    const failure = new Error("archive corrupt");
    expect(() =>
      timing.measure("archive-extract", () => {
        throw failure;
      }),
    ).toThrow(failure);
  });

  it("leaves uninstrumented calls unchanged", () => {
    expect(measureRuntimePhase(undefined, "cache-check", () => "unchanged")).toBe("unchanged");
  });
});
