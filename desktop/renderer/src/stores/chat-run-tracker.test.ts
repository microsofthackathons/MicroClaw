import { describe, expect, it } from "vitest";
import { ChatRunTracker } from "./chat-run-tracker";

describe("identified and unidentified authoritative conversation runtime", () => {
  const key = "agent:main:main";
  const busy = { key, hasActiveRun: true };
  const idle = { key, hasActiveRun: false, activeRunIds: [] };
  it("represents unknown identity explicitly, retains known evidence and requires authoritative idle", () => {
    const tracker = new ChatRunTracker();
    expect(tracker.snapshot(key, busy, 0)).toBe(true);
    expect(tracker.active(key)).toMatchObject({ id: null });
    tracker.begin(key, "known");
    expect(tracker.snapshot(key, busy, tracker.revision(key))).toBe(true);
    expect(tracker.active(key)).toMatchObject({ id: "known" });
    tracker.finish(key, "known");
    expect(tracker.active(key)).toMatchObject({ id: null });
    expect(tracker.isClosed(key, "known")).toBe(true);
    tracker.snapshot(key, idle, tracker.revision(key));
    expect(tracker.active(key)).toBeNull();
    expect(tracker.begin(key, "known")).toBe(false);
  });
  it("does not apply unknown identity or idle snapshots across a newer lifecycle revision or session", () => {
    const tracker = new ChatRunTracker();
    const revision = tracker.revision(key);
    tracker.begin(key, "new");
    expect(tracker.snapshot(key, busy, revision)).toBe(false);
    expect(tracker.snapshot(key, idle, revision)).toBe(false);
    expect(tracker.active(key)).toMatchObject({ id: "new" });
    expect(tracker.active("agent:other:main")).toBeNull();
    expect(() => tracker.snapshot("agent:other:main", busy, 0)).toThrow(
      "Invalid Gateway chat runtime snapshot",
    );
  });
  it.each([
    null,
    [],
    { key, hasActiveRun: false },
    { key, hasActiveRun: "true" },
    { key, hasActiveRun: true, activeRunIds: undefined },
    { key, hasActiveRun: true, activeRunIds: null },
    { key, hasActiveRun: true, activeRunIds: [] },
    { key, hasActiveRun: false, activeRunIds: ["run"] },
    { key, hasActiveRun: true, activeRunIds: [""] },
    { key, hasActiveRun: true, activeRunIds: [" run"] },
    { key, hasActiveRun: true, activeRunIds: ["run", "run"] },
    { key, hasActiveRun: true, activeRunIds: [7] },
  ])("still rejects malformed or conflicting identified metadata %#", (runtime) => {
    expect(() => new ChatRunTracker().snapshot(key, runtime, 0)).toThrow(
      "Invalid Gateway chat runtime snapshot",
    );
  });
});
