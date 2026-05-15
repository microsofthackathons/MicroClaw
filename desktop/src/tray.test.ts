import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GatewayStatus } from "./constants";

// ── Mock electron ─────────────────────────────────────────────────────
vi.mock("electron", () => {
  class MockTray {
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    on = vi.fn();
    destroy = vi.fn();
  }
  return {
    app: {
      quit: vi.fn(),
    },
    Tray: MockTray,
    Menu: {
      buildFromTemplate: vi.fn().mockReturnValue({}),
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createTray", () => {
  it("creates tray without throwing", () => {
    const callbacks = {
      onShowWindow: vi.fn(),
      onRestartGateway: vi.fn(),
      onQuit: vi.fn(),
    };
    expect(() => createTray(callbacks)).not.toThrow();
  });
});

describe("updateTrayMenu", () => {
  it("updates menu for each valid status", () => {
    const callbacks = {
      onShowWindow: vi.fn(),
      onRestartGateway: vi.fn(),
      onQuit: vi.fn(),
    };
    createTray(callbacks);

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
});

describe("destroyTray", () => {
  it("destroys tray without throwing", () => {
    const callbacks = {
      onShowWindow: vi.fn(),
      onRestartGateway: vi.fn(),
      onQuit: vi.fn(),
    };
    createTray(callbacks);
    expect(() => destroyTray()).not.toThrow();
  });

  it("handles multiple destroy calls gracefully", () => {
    expect(() => destroyTray()).not.toThrow();
    expect(() => destroyTray()).not.toThrow();
  });
});
