import { app, Tray, Menu, nativeImage } from "electron";
import * as path from "path";
import type { GatewayStatus } from "./constants";

let tray: Tray | null = null;

/** Callback set provided by main.ts — includes a quit hook to set the isQuitting flag. */
let quitCallback: (() => void) | null = null;

export function createTray(callbacks: {
  onShowWindow: () => void;
  onRestartGateway: () => void;
  onQuit: () => void;
}): void {
  const iconPath = path.join(
    __dirname,
    process.platform === "win32" ? "../assets/microclaw.ico" : "../assets/microclaw.png",
  );
  const icon = nativeImage.createFromPath(iconPath);

  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("MicroClaw");
  quitCallback = callbacks.onQuit;

  updateTrayMenu("stopped", callbacks);

  tray.on("click", () => {
    callbacks.onShowWindow();
  });
}

/** Clean up the tray icon (call from before-quit). */
export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

export function updateTrayMenu(
  gatewayStatus: GatewayStatus,
  callbacks?: { onShowWindow: () => void; onRestartGateway: () => void },
): void {
  if (!tray) return;

  const statusLabels: Record<GatewayStatus, string> = {
    stopped: "⏹ Gateway Stopped",
    starting: "⏳ Gateway Starting...",
    running: "✅ Gateway Running",
    restarting: "🔄 Gateway Restarting...",
    failed: "❌ Gateway Failed",
    stopping: "⏳ Gateway Stopping...",
    timeout: "⚠️ Gateway Timeout",
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: statusLabels[gatewayStatus] || `Gateway: ${gatewayStatus}`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Open MicroClaw",
      click: () => callbacks?.onShowWindow(),
    },
    {
      label: "Restart Gateway",
      click: () => callbacks?.onRestartGateway(),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        quitCallback?.();
        app.quit();
      },
    },
  ];

  const contextMenu = Menu.buildFromTemplate(template);
  tray.setContextMenu(contextMenu);
}
