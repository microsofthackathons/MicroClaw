import { describe, expect, it } from "vitest";
import { inspectWindowsNodeMxcHooksStatus } from "./windows-node-mxc-hooks";

describe("Windows Node MXC Hooks status", () => {
  it.each(["full", "off"] as const)("preserves configured hooks in %s mode", (mode) => {
    expect(
      inspectWindowsNodeMxcHooksStatus({ enabled: true, internal: { enabled: true } }, mode),
    ).toEqual({
      requestedExternalEnabled: true,
      requestedInternalEnabled: true,
      effectiveExternalEnabled: true,
      effectiveInternalEnabled: true,
      pausedByMxc: false,
    });
  });

  it("reports internal entry configuration and explicit disables", () => {
    expect(
      inspectWindowsNodeMxcHooksStatus(
        { enabled: false, internal: { entries: { audit: { enabled: true } } } },
        "full",
      ),
    ).toMatchObject({
      effectiveExternalEnabled: false,
      effectiveInternalEnabled: true,
      pausedByMxc: false,
    });
    expect(
      inspectWindowsNodeMxcHooksStatus(
        { enabled: false, internal: { enabled: false, entries: { audit: {} } } },
        "full",
      ),
    ).toMatchObject({
      effectiveExternalEnabled: false,
      effectiveInternalEnabled: false,
      pausedByMxc: false,
    });
  });
});
