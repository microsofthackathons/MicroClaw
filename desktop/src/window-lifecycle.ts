export interface AppWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
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
