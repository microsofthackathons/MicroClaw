import { describe, expect, it, vi } from "vitest";
import {
  minimizeWindow,
  sendToWindow,
  showAndFocusWindow,
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
