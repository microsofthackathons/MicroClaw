import { describe, expect, it } from "vitest";
import {
  createWindowsNodeMxcSelection,
  describeWindowsNodeMxcLimitedAvailability,
  migrateWindowsNodeMxcSelection,
  summarizeWindowsNodeMxcAmbientAccess,
  validateWindowsNodeMxcAmbientAccessAssessment,
} from "./windows-node-mxc-modes";
import { classifyMxcProbe } from "./windows-node-mxc";

describe("Windows Node MXC containment modes", () => {
  it("migrates a remembered enabled legacy setting conservatively to Full", () => {
    expect(migrateWindowsNodeMxcSelection(undefined, true)).toEqual({
      version: 1,
      requestedMode: "full",
      limitedFilesystemAcknowledgedAt: null,
    });
  });

  it("preserves only explicit persisted Limited selection evidence", () => {
    expect(
      migrateWindowsNodeMxcSelection(
        {
          version: 1,
          requestedMode: "limited-dacl",
          limitedFilesystemAcknowledgedAt: "2026-10-09T00:00:00.000Z",
        },
        true,
      ),
    ).toEqual({
      version: 1,
      requestedMode: "limited-dacl",
      limitedFilesystemAcknowledgedAt: "2026-10-09T00:00:00.000Z",
    });
  });

  it("requires explicit Limited filesystem acknowledgment", () => {
    expect(() => createWindowsNodeMxcSelection("limited-dacl", false)).toThrow(
      "explicit acknowledgment",
    );
  });

  it("accepts only an attested appcontainer-dacl tier for Limited", () => {
    const dacl = classifyMxcProbe(
      0,
      JSON.stringify({ tier: "appcontainer-dacl", needsDaclAugmentation: true }),
      "",
    );
    const full = classifyMxcProbe(0, JSON.stringify({ tier: "base-container" }), "");
    expect(describeWindowsNodeMxcLimitedAvailability(dacl).available).toBe(true);
    expect(describeWindowsNodeMxcLimitedAvailability(full).available).toBe(false);
  });

  it("separates sensitive activation blockers from ordinary ambient warnings", () => {
    const summary = summarizeWindowsNodeMxcAmbientAccess({
      contract: "microclaw.windows-node-mxc-ambient-access.v1",
      hash: "a".repeat(64),
      checkedAt: "2026-10-09T00:00:00.000Z",
      entries: [
        { category: "downloads", status: "read-write" },
        { category: "ssh", status: "read" },
        { category: "browser-edge", status: "denied" },
      ],
    });
    expect(summary.ordinaryAccessible).toEqual([
      { category: "downloads", status: "read-write" },
    ]);
    expect(summary.sensitiveAccessible).toEqual([{ category: "ssh", status: "read" }]);
  });

  it("requires every bounded ambient-access category", () => {
    expect(
      validateWindowsNodeMxcAmbientAccessAssessment({
        contract: "microclaw.windows-node-mxc-ambient-access.v1",
        hash: "a".repeat(64),
        checkedAt: "2026-10-09T00:00:00.000Z",
        entries: [{ category: "downloads", status: "read-write" }],
      }),
    ).toBe(false);
  });
});
