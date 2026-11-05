import { beforeEach } from "vitest";
import type {} from "vitest/jsdom";

for (const storageName of ["localStorage", "sessionStorage"] as const) {
  Object.defineProperty(globalThis, storageName, {
    configurable: true,
    enumerable: true,
    value: jsdom.window[storageName],
    writable: true,
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
