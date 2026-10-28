import { describe, expect, it } from "vitest";
import { GatewayStartupTiming, type StartupTimingEvent } from "./startup-timing";

function createTiming(attempt = 1, startedAt = 100) {
  let now = startedAt;
  const events: StartupTimingEvent[] = [];
  return {
    events,
    timing: new GatewayStartupTiming(
      attempt,
      (event) => events.push(event),
      () => now,
    ),
    setTime: (value: number) => {
      now = value;
    },
  };
}

describe("Gateway startup timing", () => {
  it("measures MicroClaw preparation phases without counting application age as phase duration", () => {
    const { timing, events, setTime } = createTiming();
    setTime(125);
    timing.completeMicroclawPhase("configuration-and-personas");
    setTime(140);
    timing.completeMicroclawPhase("weixin-runtime-verification");

    expect(events).toMatchObject([
      { kind: "phase", owner: "microclaw", durationMs: 25, appElapsedMs: 125, attempt: 1 },
      { kind: "phase", owner: "microclaw", durationMs: 15, appElapsedMs: 140, attempt: 1 },
    ]);
  });

  it("separates preflight, child startup, and integration wall times", () => {
    const { timing, events, setTime } = createTiming();
    setTime(150);
    timing.spawned("generation-1");
    setTime(1150);
    timing.httpReady();
    setTime(1170);
    timing.connected("generation-1");
    setTime(1180);
    timing.serviceReady("generation-1");

    expect(events.at(-1)).toMatchObject({
      kind: "summary",
      phase: "application-service-ready",
      mode: "spawned",
      gatewayGeneration: "generation-1",
      appBeforeAttemptMs: 100,
      microclawPreflightMs: 50,
      openclawHttpMs: 1000,
      integrationMs: 30,
      attemptElapsedMs: 1080,
      appElapsedMs: 1180,
    });
    expect(
      events.filter((event) => event.kind === "phase" && event.owner === "integration"),
    ).toMatchObject([
      { phase: "gateway-ws-connected", durationMs: 20 },
      { phase: "application-service-ready", durationMs: 10 },
    ]);
  });

  it("does not invent a cold-start duration when reusing an existing Gateway", () => {
    const { timing, events, setTime } = createTiming();
    setTime(130);
    timing.reused(null);
    setTime(140);
    timing.connected(null);

    expect(events.at(-1)).toMatchObject({
      mode: "reused",
      microclawPreflightMs: 30,
      openclawHttpMs: null,
      integrationMs: 10,
      attemptElapsedMs: 40,
    });
    expect(events.some((event) => event.kind === "phase" && event.owner === "openclaw")).toBe(
      false,
    );
  });

  it("keeps HTTP readiness separate from the first observed history response", () => {
    const { timing, events, setTime } = createTiming();
    setTime(150);
    timing.spawned("generation-1");
    setTime(300);
    timing.httpReady();
    expect(events.some((event) => event.phase === "first-history-response")).toBe(false);
    setTime(400);
    timing.historyReady("generation-1");

    expect(events.at(-1)).toMatchObject({
      phase: "first-history-response",
      openclawHttpMs: 150,
      integrationMs: 100,
    });
  });

  it("ignores stale generations and records each readiness milestone only once", () => {
    const { timing, events, setTime } = createTiming();
    timing.connected(null);
    expect(events).toEqual([]);
    setTime(150);
    timing.spawned("generation-2");
    setTime(250);
    timing.httpReady();
    const beforeStale = events.length;
    timing.connected("generation-1");
    timing.serviceReady("generation-1");
    timing.historyReady("generation-1");
    expect(events).toHaveLength(beforeStale);
    setTime(260);
    timing.connected("generation-2");
    timing.serviceReady("generation-2");
    timing.historyReady("generation-2");
    const completed = events.length;
    setTime(500);
    timing.httpReady();
    timing.connected("generation-2");
    timing.serviceReady("generation-2");
    timing.historyReady("generation-2");
    expect(events).toHaveLength(completed);
  });

  it("keeps restart attempts separate from time already spent in the application", () => {
    const { timing, events, setTime } = createTiming(2, 100000);
    setTime(100020);
    timing.spawned("generation-2");
    setTime(100120);
    timing.httpReady();

    expect(events.at(-1)).toMatchObject({
      attempt: 2,
      appBeforeAttemptMs: 100000,
      microclawPreflightMs: 20,
      openclawHttpMs: 100,
      attemptElapsedMs: 120,
    });
  });

  it("leaves unobserved HTTP timing unknown when WebSocket connects after a readiness timeout", () => {
    const { timing, events, setTime } = createTiming();
    setTime(150);
    timing.spawned("generation-1");
    setTime(1200);
    timing.connected("generation-1");

    expect(events.at(-1)).toMatchObject({
      phase: "gateway-ws-connected",
      openclawHttpMs: null,
      integrationMs: null,
      attemptElapsedMs: 1100,
    });
  });
});
