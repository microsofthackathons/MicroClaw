import { app, Tray, Menu, nativeImage } from "electron";
import * as path from "path";
import type { GatewayStatus } from "./constants";
import { t, type SupportedLocale } from "./i18n";

let tray: Tray | null = null;

interface TrayCallbacks {
  onShowWindow: () => void;
  onRestartGateway: () => void;
}

let trayCallbacks: TrayCallbacks | null = null;
let trayLocale: SupportedLocale = "en-US";

export function createTray(callbacks: TrayCallbacks, locale: SupportedLocale): void {
  const iconPath = path.join(
    __dirname,
    process.platform === "win32" ? "../assets/microclaw.ico" : "../assets/microclaw.png",
  );
  const icon = nativeImage.createFromPath(iconPath);

  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("MicroClaw");
  trayCallbacks = callbacks;
  trayLocale = locale;

  updateTrayMenu("stopped");

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
  trayCallbacks = null;
}

export function updateTrayMenu(gatewayStatus: GatewayStatus, locale?: SupportedLocale): void {
  if (!tray) return;
  if (locale) trayLocale = locale;

  const statusLabels: Record<GatewayStatus, string> = {
    stopped: `⏹ ${t(trayLocale, "tray.status.stopped")}`,
    starting: `⏳ ${t(trayLocale, "tray.status.starting")}`,
    running: `✅ ${t(trayLocale, "tray.status.running")}`,
    restarting: `🔄 ${t(trayLocale, "tray.status.restarting")}`,
    failed: `❌ ${t(trayLocale, "tray.status.failed")}`,
    stopping: `⏳ ${t(trayLocale, "tray.status.stopping")}`,
    timeout: `⚠️ ${t(trayLocale, "tray.status.timeout")}`,
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: statusLabels[gatewayStatus] || `Gateway: ${gatewayStatus}`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: t(trayLocale, "tray.open"),
      click: () => trayCallbacks?.onShowWindow(),
    },
    {
      label: t(trayLocale, "tray.restartGateway"),
      click: () => trayCallbacks?.onRestartGateway(),
    },
    { type: "separator" },
    {
      label: t(trayLocale, "tray.quit"),
      click: () => {
        app.quit();
      },
    },
  ];

  const contextMenu = Menu.buildFromTemplate(template);
  tray.setContextMenu(contextMenu);
}
