import { describe, expect, it } from "vitest";
import { checkForUpdates, compareVersions } from "./update-checker";

describe("compareVersions", () => {
  it("orders dotted numeric versions", () => {
    expect(compareVersions("1.0.1", "1.0.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0")).toBe(0);
  });

  it("accepts versions with a leading v", () => {
    expect(compareVersions("v1.2.0", "1.1.9")).toBeGreaterThan(0);
  });
});

describe("checkForUpdates", () => {
  it("returns update-available when the manifest version is newer", async () => {
    const result = await checkForUpdates({
      currentVersion: "1.0.0",
      manifestUrl: "https://microclaw.microsoftol.com/releases/latest.json",
      fetchJson: async () => ({
        version: "1.0.1",
        releasedAt: "2026-07-14",
        downloadUrl: "https://microclaw.microsoftol.com/downloads/MicroClawInstaller.zip",
        sha256: "abc123",
        openclawVersion: "2026.3.12",
        releaseNotes: ["Fix model setup config save issue"],
      }),
    });

    expect(result).toEqual({
      status: "update-available",
      currentVersion: "1.0.0",
      latestVersion: "1.0.1",
      releasedAt: "2026-07-14",
      downloadUrl: "https://microclaw.microsoftol.com/downloads/MicroClawInstaller.zip",
      sha256: "abc123",
      openclawVersion: "2026.3.12",
      releaseNotes: ["Fix model setup config save issue"],
    });
  });

  it("returns up-to-date when the manifest version is not newer", async () => {
    const result = await checkForUpdates({
      currentVersion: "1.0.1",
      manifestUrl: "https://microclaw.microsoftol.com/releases/latest.json",
      fetchJson: async () => ({
        version: "1.0.1",
        downloadUrl: "https://microclaw.microsoftol.com/downloads/MicroClawInstaller.zip",
      }),
    });

    expect(result).toEqual({
      status: "up-to-date",
      currentVersion: "1.0.1",
      latestVersion: "1.0.1",
    });
  });

  it("returns error for an invalid manifest instead of throwing", async () => {
    const result = await checkForUpdates({
      currentVersion: "1.0.0",
      manifestUrl: "https://microclaw.microsoftol.com/releases/latest.json",
      fetchJson: async () => ({ version: "1.0.1" }),
    });

    if (result.status !== "error") {
      throw new Error(`Expected error result, got ${result.status}`);
    }
    expect(result.currentVersion).toBe("1.0.0");
    expect(result.message).toContain("downloadUrl");
  });

  it("rejects non-HTTPS download URLs", async () => {
    const result = await checkForUpdates({
      currentVersion: "1.0.0",
      manifestUrl: "https://microclaw.microsoftol.com/releases/latest.json",
      fetchJson: async () => ({
        version: "1.0.1",
        downloadUrl: "http://microclaw.microsoftol.com/downloads/MicroClawInstaller.zip",
      }),
    });

    if (result.status !== "error") {
      throw new Error(`Expected error result, got ${result.status}`);
    }
    expect(result.message).toContain("https");
  });

  it("rejects malformed manifest versions", async () => {
    const result = await checkForUpdates({
      currentVersion: "1.0.0",
      manifestUrl: "https://microclaw.microsoftol.com/releases/latest.json",
      fetchJson: async () => ({
        version: "2.x",
        downloadUrl: "https://microclaw.microsoftol.com/downloads/MicroClawInstaller.zip",
      }),
    });

    if (result.status !== "error") {
      throw new Error(`Expected error result, got ${result.status}`);
    }
    expect(result.message).toContain("version");
  });
});
