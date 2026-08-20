export interface AppWindow {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
  };
  isMinimized(): boolean;
  minimize(): void;
  hide(): void;
  restore(): void;
  setSkipTaskbar(skip: boolean): void;
  show(): void;
  focus(): void;
}

export function sendToWindow(
  window: Pick<AppWindow, "isDestroyed" | "webContents"> | null,
  channel: string,
  ...args: unknown[]
): boolean {
  try {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
    window.webContents.send(channel, ...args);
    return true;
  } catch (error) {
    // The window can be destroyed between the lifecycle checks and send().
    if (error instanceof Error && error.message === "Object has been destroyed") return false;
    throw error;
  }
}

export function showAndFocusWindow(window: AppWindow | null): void {
  if (!window || window.isDestroyed()) return;

  if (window.isMinimized()) {
    window.restore();
  }
  window.setSkipTaskbar(false);
  window.show();
  window.focus();
}

export function minimizeWindow(window: AppWindow | null, minimizeToTray: boolean): void {
  if (!window || window.isDestroyed()) return;

  window.setSkipTaskbar(minimizeToTray);
  if (minimizeToTray) {
    window.hide();
  } else {
    window.minimize();
  }
}
