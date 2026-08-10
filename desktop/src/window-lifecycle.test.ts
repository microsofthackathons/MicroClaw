import { describe, expect, it, vi } from "vitest";
import { minimizeWindow, showAndFocusWindow, type AppWindow } from "./window-lifecycle";

function createWindow(options?: { destroyed?: boolean; minimized?: boolean }) {
  const calls: string[] = [];
  const window: AppWindow = {
    isDestroyed: () => options?.destroyed ?? false,
    isMinimized: () => options?.minimized ?? false,
    minimize: vi.fn(() => calls.push("minimize")),
    hide: vi.fn(() => calls.push("hide")),
    restore: vi.fn(() => calls.push("restore")),
    setSkipTaskbar: vi.fn(() => calls.push("taskbar")),
    show: vi.fn(() => calls.push("show")),
    focus: vi.fn(() => calls.push("focus")),
  };
  return { calls, window };
}

describe("showAndFocusWindow", () => {
  it("restores a minimized window before showing and focusing it", () => {
    const { calls, window } = createWindow({ minimized: true });

    showAndFocusWindow(window);

    expect(calls).toEqual(["restore", "taskbar", "show", "focus"]);
  });

  it("shows a hidden window without restoring it", () => {
    const { calls, window } = createWindow();

    showAndFocusWindow(window);

    expect(calls).toEqual(["taskbar", "show", "focus"]);
  });

  it("ignores a destroyed window", () => {
    const { calls, window } = createWindow({ destroyed: true });

    showAndFocusWindow(window);

    expect(calls).toEqual([]);
  });
});

describe("minimizeWindow", () => {
  it("hides the window from the taskbar when minimize to tray is enabled", () => {
    const { calls, window } = createWindow();

    minimizeWindow(window, true);

    expect(calls).toEqual(["taskbar", "hide"]);
  });

  it("keeps the window in the taskbar when minimize to tray is disabled", () => {
    const { calls, window } = createWindow();

    minimizeWindow(window, false);

    expect(calls).toEqual(["taskbar", "minimize"]);
  });

  it("ignores a destroyed window", () => {
    const { calls, window } = createWindow({ destroyed: true });

    minimizeWindow(window, true);

    expect(calls).toEqual([]);
  });
});
