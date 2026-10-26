import { describe, expect, it } from "vitest";
import { migrateMxcOnlySecuritySettings } from "./mxc-only-settings";

describe("MXC-only security settings", () => {
  it("starts without sandboxing and never restores the retired backend", () => {
    const original = {
      securityMode: "appcontainer",
      sandboxEnabled: true,
      sandboxExternalApps: ["excel"],
      sandboxCapabilities: ["internetClient"],
      sandboxUserDirsRW: ["C:\\Work"],
      sandboxUserDirsRO: ["D:\\Reference"],
      sandboxGrantHistory: ["C:\\Old"],
      windowsNodeMxcPreviousSandboxEnabled: true,
      language: "en-US",
    };
    const migrated = migrateMxcOnlySecuritySettings(original);
    expect(migrated).toEqual({
      language: "en-US",
      windowsNodeMxcSelection: {
        version: 1,
        requestedMode: "off",
        limitedFilesystemAcknowledgedAt: null,
      },
      windowsNodeMxcFolders: { rw: ["C:\\Work"], ro: ["D:\\Reference"] },
    });
    expect(original.sandboxEnabled).toBe(true);
  });

  it.each(["off", "full", "limited-dacl"])(
    "preserves the explicit native %s selection and its folder policy",
    (requestedMode) => {
      const acknowledgedAt = "2026-10-21T16:38:38.272Z";
      const migrated = migrateMxcOnlySecuritySettings({
        securityMode: "windows-node-mxc",
        windowsNodeMxcSelection: {
          version: 1,
          requestedMode,
          limitedFilesystemAcknowledgedAt: acknowledgedAt,
        },
        windowsNodeMxcFolders: { rw: ["C:\\Native"], ro: [] },
        sandboxUserDirsRW: ["C:\\Obsolete"],
        windowsNodeMxcToolBackups: { main: null },
        windowsNodeMxcWeixinRemoteApproval: { enabled: false, owner: null },
      });
      expect(migrated.windowsNodeMxcSelection).toEqual({
        version: 1,
        requestedMode,
        limitedFilesystemAcknowledgedAt: requestedMode === "limited-dacl" ? acknowledgedAt : null,
      });
      expect(migrated.windowsNodeMxcFolders).toEqual({ rw: ["C:\\Native"], ro: [] });
      expect(migrated.windowsNodeMxcToolBackups).toEqual({ main: null });
      expect(migrated.windowsNodeMxcWeixinRemoteApproval).toEqual({
        enabled: false,
        owner: null,
      });
      expect(migrateMxcOnlySecuritySettings(migrated)).toEqual(migrated);
    },
  );

  it("does not turn a previously selected native route off during upgrade", () => {
    expect(
      migrateMxcOnlySecuritySettings({ securityMode: "windows-node-mxc" }).windowsNodeMxcSelection
        .requestedMode,
    ).toBe("full");
  });

  it("defaults a fresh installation to unsandboxed execution", () => {
    expect(migrateMxcOnlySecuritySettings({})).toMatchObject({
      windowsNodeMxcSelection: { requestedMode: "off" },
      windowsNodeMxcFolders: { rw: [], ro: [] },
    });
  });

  it.each([
    { windowsNodeMxcFolders: [] },
    { windowsNodeMxcFolders: { rw: ["C:\\Work", 42], ro: [] } },
    { sandboxUserDirsRW: "C:\\Work" },
  ])("rejects malformed persisted folder policy instead of dropping grants", (settings) => {
    expect(() => migrateMxcOnlySecuritySettings(settings)).toThrow(
      "Invalid saved MXC folder policy",
    );
  });
});
