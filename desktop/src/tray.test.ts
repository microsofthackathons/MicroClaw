import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GatewayStatus } from "./constants";

const trayEventHandlers = vi.hoisted(() => new Map<string, () => void>());
const menuTemplates = vi.hoisted(() => [] as Electron.MenuItemConstructorOptions[][]);

// ── Mock electron ─────────────────────────────────────────────────────
vi.mock("electron", () => {
  class MockTray {
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    on = vi.fn((event: string, handler: () => void) => {
      trayEventHandlers.set(event, handler);
    });
    destroy = vi.fn();
  }
  return {
    app: {
      quit: vi.fn(),
    },
    Tray: MockTray,
    Menu: {
      buildFromTemplate: vi.fn((template: Electron.MenuItemConstructorOptions[]) => {
        menuTemplates.push(template);
        return {};
      }),
    },
    nativeImage: {
      createFromPath: vi.fn().mockReturnValue({ isEmpty: () => false }),
      createEmpty: vi.fn().mockReturnValue({}),
    },
  };
});

vi.mock("path", async () => {
  const actual = await vi.importActual("path");
  return actual;
});

import { createTray, updateTrayMenu, destroyTray } from "./tray";
import { app } from "electron";

beforeEach(() => {
  vi.clearAllMocks();
  trayEventHandlers.clear();
  menuTemplates.length = 0;
});

describe("createTray", () => {
  it("creates tray without throwing", () => {
    const callbacks = {
      onShowWindow: vi.fn(),
      onRestartGateway: vi.fn(),
    };
    expect(() => createTray(callbacks, "en-US")).not.toThrow();
  });

  it("opens the app on a single click", () => {
    const callbacks = {
      onShowWindow: vi.fn(),
      onRestartGateway: vi.fn(),
    };
    createTray(callbacks, "en-US");

    trayEventHandlers.get("click")?.();

    expect(callbacks.onShowWindow).toHaveBeenCalledOnce();
  });
});

describe("updateTrayMenu", () => {
  it("updates menu for each valid status", () => {
    const callbacks = {
      onShowWindow: vi.fn(),
      onRestartGateway: vi.fn(),
    };
    createTray(callbacks, "en-US");

    const statuses: GatewayStatus[] = [
      "stopped",
      "starting",
      "running",
      "restarting",
      "failed",
      "stopping",
      "timeout",
    ];

    for (const status of statuses) {
      expect(() => updateTrayMenu(status)).not.toThrow();
    }
  });

  it("keeps commands functional after a status update", () => {
    const callbacks = {
      onShowWindow: vi.fn(),
      onRestartGateway: vi.fn(),
    };
    createTray(callbacks, "en-US");

    updateTrayMenu("running");
    const updatedMenu = menuTemplates.at(-1)!;
    const open = updatedMenu.find((item) => item.label === "Open MicroClaw");
    const restart = updatedMenu.find((item) => item.label === "Restart Gateway");

    open?.click?.({} as Electron.MenuItem, undefined as never, {} as Electron.KeyboardEvent);
    restart?.click?.({} as Electron.MenuItem, undefined as never, {} as Electron.KeyboardEvent);

    expect(callbacks.onShowWindow).toHaveBeenCalledOnce();
    expect(callbacks.onRestartGateway).toHaveBeenCalledOnce();
    expect(updatedMenu[0].label).toBe("✅ Gateway Running");
  });

  it("localizes status and commands when the language changes", () => {
    createTray(
      {
        onShowWindow: vi.fn(),
        onRestartGateway: vi.fn(),
      },
      "en-US",
    );

    updateTrayMenu("running", "zh-CN");
    const menu = menuTemplates.at(-1)!;

    expect(menu[0].label).toBe("✅ 网关运行中");
    expect(menu.find((item) => item.label === "打开 MicroClaw")).toBeDefined();
    expect(menu.find((item) => item.label === "重启网关")).toBeDefined();
    expect(menu.find((item) => item.label === "退出")).toBeDefined();
  });

  it("quits the app from the menu", () => {
    createTray(
      {
        onShowWindow: vi.fn(),
        onRestartGateway: vi.fn(),
      },
      "en-US",
    );
    const menu = menuTemplates.at(-1)!;
    const quit = menu.find((item) => item.label === "Quit");

    quit?.click?.({} as Electron.MenuItem, undefined as never, {} as Electron.KeyboardEvent);

    expect(app.quit).toHaveBeenCalledOnce();
  });
});

describe("destroyTray", () => {
  it("destroys tray without throwing", () => {
    const callbacks = {
      onShowWindow: vi.fn(),
      onRestartGateway: vi.fn(),
    };
    createTray(callbacks, "en-US");
    expect(() => destroyTray()).not.toThrow();
  });

  it("handles multiple destroy calls gracefully", () => {
    expect(() => destroyTray()).not.toThrow();
    expect(() => destroyTray()).not.toThrow();
  });
});
