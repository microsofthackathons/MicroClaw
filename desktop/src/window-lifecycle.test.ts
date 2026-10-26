import { describe, expect, it, vi } from "vitest";
import {
  minimizeWindow,
  sendToWindow,
  showAndFocusWindow,
  showStartupWindow,
  shouldPreventWindowClose,
  shouldQuitAfterAllWindowsClosed,
  shouldRecoverWindow,
  type AppWindow,
} from "./window-lifecycle";

function createWindow(options?: {
  destroyed?: boolean;
  minimized?: boolean;
  webContentsDestroyed?: boolean;
  sendError?: Error;
}) {
  const calls: string[] = [];
  const window: AppWindow = {
    isDestroyed: () => options?.destroyed ?? false,
    webContents: {
      isDestroyed: () => options?.webContentsDestroyed ?? false,
      send: vi.fn((channel: string) => {
        if (options?.sendError) throw options.sendError;
        calls.push(`send:${channel}`);
      }),
    },
    isMinimized: () => options?.minimized ?? false,
    minimize: vi.fn(() => calls.push("minimize")),
    hide: vi.fn(() => calls.push("hide")),
    restore: vi.fn(() => calls.push("restore")),
    setSkipTaskbar: vi.fn(() => calls.push("taskbar")),
    show: vi.fn(() => calls.push("show")),
    showInactive: vi.fn(() => calls.push("show-inactive")),
    focus: vi.fn(() => calls.push("focus")),
  };
  return { calls, window };
}

describe("sendToWindow", () => {
  it("sends to a live renderer", () => {
    const { calls, window } = createWindow();

    expect(sendToWindow(window, "gateway:ws-disconnected", "closed")).toBe(true);
    expect(calls).toEqual(["send:gateway:ws-disconnected"]);
  });

  describe("MXC lifecycle window protection", () => {
    it("prevents sole-window close and recovers renderer loss during an operation", () => {
      const state = { lifecycleActive: true, explicitQuitRequested: false };

      expect(shouldPreventWindowClose(state)).toBe(true);
      expect(shouldRecoverWindow(state)).toBe(true);
      expect(shouldQuitAfterAllWindowsClosed("win32", state)).toBe(false);
    });

    it("preserves explicit Quit semantics during an operation", () => {
      const state = { lifecycleActive: true, explicitQuitRequested: true };

      expect(shouldPreventWindowClose(state)).toBe(false);
      expect(shouldRecoverWindow(state)).toBe(false);
      expect(shouldQuitAfterAllWindowsClosed("win32", state)).toBe(true);
    });

    it.each(["locked startup", "active startup"])(
      "recovers a renderer crash during %s without quitting the main process",
      () => {
        const state = { lifecycleActive: true, explicitQuitRequested: false };

        expect(shouldRecoverWindow(state)).toBe(true);
        expect(shouldQuitAfterAllWindowsClosed("win32", state)).toBe(false);
      },
    );

    it("retains normal close-to-quit behavior outside a lifecycle operation", () => {
      const state = { lifecycleActive: false, explicitQuitRequested: false };

      expect(shouldPreventWindowClose(state)).toBe(false);
      expect(shouldRecoverWindow(state)).toBe(false);
      expect(shouldQuitAfterAllWindowsClosed("win32", state)).toBe(true);
    });

    it("does not quit while a scheduled recovery outlives the lifecycle operation", () => {
      const state = {
        lifecycleActive: false,
        recoveryActive: true,
        explicitQuitRequested: false,
      };

      expect(shouldPreventWindowClose(state)).toBe(true);
      expect(shouldRecoverWindow(state)).toBe(true);
      expect(shouldQuitAfterAllWindowsClosed("win32", state)).toBe(false);
    });
  });

  it.each([
    { destroyed: true },
    { webContentsDestroyed: true },
    { sendError: new Error("Object has been destroyed") },
  ])("ignores a renderer that cannot receive events", (options) => {
    const { calls, window } = createWindow(options);

    expect(sendToWindow(window, "gateway:ws-disconnected", "closed")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("does not swallow unrelated renderer send failures", () => {
    const error = new Error("IPC serialization failed");
    const { window } = createWindow({ sendError: error });

    expect(() => sendToWindow(window, "gateway:ws-disconnected", "closed")).toThrow(error);
  });
});

describe("showAndFocusWindow", () => {
  it("restores a minimized window before showing and focusing it", () => {
    const { calls, window } = createWindow({ minimized: true });

    showAndFocusWindow(window);

    expect(calls).toEqual(["restore", "taskbar", "show", "focus"]);
  });

  describe("showStartupWindow", () => {
    it("shows background launches without focusing or restoring the window", () => {
      const { calls, window } = createWindow({ minimized: true });
      showStartupWindow(window, true);
      expect(calls).toEqual(["taskbar", "show-inactive"]);
    });

    it("retains normal foreground startup behavior", () => {
      const { calls, window } = createWindow();
      showStartupWindow(window, false);
      expect(calls).toEqual(["taskbar", "show", "focus"]);
    });

    it("ignores destroyed background windows", () => {
      const { calls, window } = createWindow({ destroyed: true });
      showStartupWindow(window, true);
      expect(calls).toEqual([]);
    });
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
