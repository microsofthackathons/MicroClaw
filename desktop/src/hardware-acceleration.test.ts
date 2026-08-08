import { describe, expect, it } from "vitest";
import { shouldDisableHardwareAcceleration } from "./hardware-acceleration";

describe("shouldDisableHardwareAcceleration", () => {
  it("keeps GPU acceleration enabled for a local Windows console session", () => {
    expect(shouldDisableHardwareAcceleration({ SESSIONNAME: "Console" })).toBe(false);
  });

  it("lets Chromium choose the rendering backend for RDP sessions", () => {
    expect(shouldDisableHardwareAcceleration({ SESSIONNAME: "RDP-Tcp#12" })).toBe(false);
  });

  it("honors the explicit GPU disable override", () => {
    expect(
      shouldDisableHardwareAcceleration({
        SESSIONNAME: "Console",
        ELECTRON_DISABLE_GPU: "1",
      }),
    ).toBe(true);
  });

  it("keeps GPU acceleration enabled when no explicit override is present", () => {
    expect(shouldDisableHardwareAcceleration({})).toBe(false);
  });

  it("uses the compatibility fallback on untested Windows preview builds", () => {
    expect(shouldDisableHardwareAcceleration({}, "win32", "10.0.26310")).toBe(true);
  });

  it("keeps GPU acceleration enabled on the maximum tested Windows build", () => {
    expect(shouldDisableHardwareAcceleration({}, "win32", "10.0.26100")).toBe(false);
  });
});
