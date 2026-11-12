import { describe, expect, it } from "vitest";
import {
  createWindowsNodeMxcSelection,
  migrateWindowsNodeMxcSelection,
  selectWindowsNodeMxcAutomaticMode,
} from "./windows-node-mxc-modes";
import { classifyMxcProbe } from "./windows-node-mxc";

const probeFor = (tier: string, extra: Record<string, unknown> = {}) =>
  classifyMxcProbe(
    0,
    JSON.stringify({
      contract: "microclaw.mxc-sdk-probe.v1",
      supported: tier === "base-container",
      windowsUnsupported: false,
      probeErrored: false,
      needsDaclAugmentation: false,
      supportsProtectedPathDenies: tier === "base-container",
      tier,
      warnings: [],
      reasons: [],
      ...extra,
    }),
    "",
  );

describe("Windows Node MXC containment modes", () => {
  it("migrates a remembered enabled legacy setting conservatively to Full", () => {
    expect(migrateWindowsNodeMxcSelection(undefined, true)).toEqual({
      version: 1,
      requestedMode: "full",
      limitedFilesystemAcknowledgedAt: null,
    });
  });

  it("migrates the retired Limited selection to Full containment", () => {
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
      requestedMode: "full",
      limitedFilesystemAcknowledgedAt: null,
    });
  });

  it("rejects creating the retired DACL mode", () => {
    expect(() => createWindowsNodeMxcSelection("limited-dacl", false)).toThrow(
      "Limited DACL containment is retired",
    );
  });

  it("selects only the positively attested BaseContainer tier on activation", () => {
    expect(selectWindowsNodeMxcAutomaticMode(probeFor("base-container"))).toBe("full");
  });

  it.each([
    classifyMxcProbe(null, "", "", "probe failed"),
    classifyMxcProbe(0, "not json", ""),
    probeFor("appcontainer-dacl"),
    probeFor("appcontainer-bfs"),
    probeFor("unknown"),
    probeFor("base-container", { supported: false }),
  ])("rejects unusable/error probes without falling back to Limited or Off: %j", (probe) => {
    expect(() => selectWindowsNodeMxcAutomaticMode(probe)).toThrow("No supported MXC sandbox");
  });
});
