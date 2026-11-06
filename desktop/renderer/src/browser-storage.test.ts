import { describe, expect, it } from "vitest";
import type {} from "vitest/jsdom";

describe.each(["localStorage", "sessionStorage"] as const)("%s test environment", (storageName) => {
  it("uses the browser Storage implementation from jsdom", () => {
    expect(globalThis[storageName]).toBe(jsdom.window[storageName]);
    expect(globalThis[storageName]).toBeInstanceOf(Storage);
  });

  it("supports browser storage operations", () => {
    const storage = globalThis[storageName];
    expect(storage.length).toBe(0);
    expect(storage.getItem("missing")).toBeNull();

    storage.setItem("session", "draft");
    expect(storage.getItem("session")).toBe("draft");
    expect(storage.length).toBe(1);
    expect(storage.key(0)).toBe("session");

    storage.removeItem("session");
    expect(storage.getItem("session")).toBeNull();
    expect(storage.length).toBe(0);

    storage.setItem("session", "updated");
    storage.clear();
    expect(storage.length).toBe(0);
  });

  it.each(["first", "second"])("isolates stored values for the %s test", () => {
    const storage = globalThis[storageName];
    expect(storage.length).toBe(0);
    storage.setItem("session", "private draft");
  });
});
