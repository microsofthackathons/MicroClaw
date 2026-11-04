import { describe, expect, it } from "vitest";
import { planGatewayStatusTransition } from "./gateway-status-transition";

describe("planGatewayStatusTransition", () => {
  it("reopens the loading gate for one managed restart transition", () => {
    expect(planGatewayStatusTransition("running", "restarting")).toEqual({
      resetReadiness: true,
      refreshPort: false,
    });
    expect(planGatewayStatusTransition("restarting", "restarting")).toEqual({
      resetReadiness: false,
      refreshPort: false,
    });
  });

  it("refreshes the managed port when the replacement is running", () => {
    expect(planGatewayStatusTransition("starting", "running")).toEqual({
      resetReadiness: false,
      refreshPort: true,
    });
  });
});
