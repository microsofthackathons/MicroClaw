import { describe, expect, it } from "vitest";
import { resolveGatewayRestartReason } from "./gateway-restart-reason";

describe("resolveGatewayRestartReason", () => {
  it.each([
    ["startup-retry", "startup error screen"],
    ["settings-manual", "Settings"],
    ["plugins-manual", "Plugins"],
    ["copilot-plugin-activation", "GitHub Copilot"],
  ])("records the source of %s", (reason, source) => {
    expect(resolveGatewayRestartReason({ reason })).toContain(source);
  });

  it("does not label unspecified legacy requests as explicit user actions", () => {
    expect(resolveGatewayRestartReason(undefined)).toContain("reason unspecified");
    expect(resolveGatewayRestartReason({ hard: true })).toContain("reason unspecified");
  });

  it.each([null, "settings-manual", { reason: "secret\nforged log" }, { reason: "__proto__" }])(
    "rejects arbitrary renderer-provided log text: %j",
    (input) => {
      expect(() => resolveGatewayRestartReason(input)).toThrow();
    },
  );
});
