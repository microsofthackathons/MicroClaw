export interface AppWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  minimize(): void;
  hide(): void;
  restore(): void;
  setSkipTaskbar(skip: boolean): void;
  show(): void;
  focus(): void;
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
