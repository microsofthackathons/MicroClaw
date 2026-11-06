import { describe, expect, it, vi } from "vitest";
import {
  INSTALLER_RUNTIME_ARGUMENT,
  INSTALLER_RUNTIME_RECEIPT,
  prepareInstallerRuntime,
} from "./installer-runtime";
import {
  RUNTIME_PREPARATION_TIMING_PREFIX,
  RuntimePreparationTiming,
} from "./runtime-preparation-timing";

describe("installer runtime preparation", () => {
  it("publishes the canonical runtime only after preparation finishes", async () => {
    const root = "C:\\Users\\New User\\AppData\\Roaming\\microclaw\\runtime\\openclaw";
    const write = vi.fn();
    const prepare = vi.fn(async (timing: RuntimePreparationTiming) => {
      expect(timing).toBeInstanceOf(RuntimePreparationTiming);
      expect(
        write.mock.calls.some(([message]) => message.startsWith(INSTALLER_RUNTIME_RECEIPT)),
      ).toBe(false);
      return root;
    });
    expect(await prepareInstallerRuntime(prepare, write)).toBe(0);
    expect(write).toHaveBeenLastCalledWith(
      `${INSTALLER_RUNTIME_RECEIPT}${JSON.stringify({ runtimeRoot: root })}`,
    );
    const events = write.mock.calls
      .map(([message]) => message)
      .filter((message) => message.startsWith(RUNTIME_PREPARATION_TIMING_PREFIX))
      .map((message) => JSON.parse(message.slice(RUNTIME_PREPARATION_TIMING_PREFIX.length)));
    expect(events).toEqual([
      expect.objectContaining({
        phase: "desktop-startup",
        status: "success",
        durationMs: expect.any(Number),
      }),
      expect.objectContaining({ phase: "preparation-total", kind: "summary", status: "started" }),
      expect.objectContaining({ phase: "preparation-total", kind: "summary", status: "success" }),
    ]);
    expect(INSTALLER_RUNTIME_ARGUMENT).toBe("--prepare-installer-runtime");
  });

  it("does not report success when the packaged runtime is missing", async () => {
    const write = vi.fn();
    expect(await prepareInstallerRuntime(async () => null, write)).toBe(1);
    expect(write).toHaveBeenLastCalledWith(
      "[runtime] Installer preparation failed: The packaged OpenClaw runtime is unavailable",
    );
    expect(
      write.mock.calls.some(([message]) => message.startsWith(INSTALLER_RUNTIME_RECEIPT)),
    ).toBe(false);
  });

  it("reports preparation failures without opening the desktop or producing a receipt", async () => {
    const write = vi.fn();
    const prepare = vi.fn().mockRejectedValue(new Error("Archive extraction failed"));
    expect(await prepareInstallerRuntime(prepare, write)).toBe(1);
    expect(write).toHaveBeenLastCalledWith(
      "[runtime] Installer preparation failed: Archive extraction failed",
    );
    const events = write.mock.calls
      .map(([message]) => message)
      .filter((message) => message.startsWith(RUNTIME_PREPARATION_TIMING_PREFIX))
      .map((message) => JSON.parse(message.slice(RUNTIME_PREPARATION_TIMING_PREFIX.length)));
    expect(events.at(-1)).toMatchObject({ phase: "preparation-total", status: "failed" });
    expect(
      write.mock.calls.some(([message]) => message.startsWith(INSTALLER_RUNTIME_RECEIPT)),
    ).toBe(false);
  });
});
