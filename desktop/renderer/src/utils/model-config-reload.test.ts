import { describe, expect, it } from "vitest";
import { resolveModelConfigReloadPlan } from "./model-config-reload";

describe("resolveModelConfigReloadPlan", () => {
  it("uses the default hybrid hot reload delay", () => {
    expect(resolveModelConfigReloadPlan({})).toEqual({ restart: false, settleMs: 450 });
  });

  it("honors a custom hot reload debounce", () => {
    expect(
      resolveModelConfigReloadPlan({
        gateway: { reload: { mode: "hot", debounceMs: 700 } },
      }),
    ).toEqual({ restart: false, settleMs: 850 });
  });

  it("restarts when live reload is disabled or explicitly requested", () => {
    expect(
      resolveModelConfigReloadPlan({
        gateway: { reload: { mode: "off" } },
      }),
    ).toEqual({ restart: true, settleMs: 500 });
    expect(resolveModelConfigReloadPlan({}, true)).toEqual({ restart: true, settleMs: 500 });
  });

  it("does not restart a hot-reloadable change with a long debounce", () => {
    expect(
      resolveModelConfigReloadPlan({
        gateway: { reload: { mode: "hybrid", debounceMs: 10_000 } },
      }),
    ).toEqual({ restart: false, settleMs: 10_150 });
  });
});
