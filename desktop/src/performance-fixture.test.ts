import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configurePerformanceFixture } from "./performance-fixture";

const roots: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-perf-test-"));
  roots.push(root);
  for (const name of [
    "home",
    "appData",
    "userData",
    "sessionData",
    "temp",
    "localAppData",
    "state",
  ]) {
    fs.mkdirSync(path.join(root, name));
  }
  const marker = path.join(root, "fixture.json");
  fs.writeFileSync(
    marker,
    JSON.stringify({
      kind: "microclaw.performance.fixture.v1",
      disposable: true,
      token: "test-token",
      gatewayPort: 23001,
    }),
  );
  fs.writeFileSync(
    path.join(root, "state", "openclaw.json"),
    JSON.stringify({ gateway: { bind: "loopback", port: 23001 }, tools: { deny: ["*"] } }),
  );
  return {
    root,
    marker,
    environment: { MICROCLAW_PERF_FIXTURE: marker, MICROCLAW_PERF_TOKEN: "test-token" },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    const resolved = fs.realpathSync(root);
    expect(path.dirname(resolved)).toBe(fs.realpathSync(os.tmpdir()));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe("performance fixture isolation", () => {
  it("does nothing on the default startup path", () => {
    const app = { setPath: vi.fn() };
    const environment = { OPENCLAW_STATE_DIR: "unchanged", APPDATA: "unchanged" };
    expect(configurePerformanceFixture(app, environment)).toBe(false);
    expect(app.setPath).not.toHaveBeenCalled();
    expect(environment).toEqual({ OPENCLAW_STATE_DIR: "unchanged", APPDATA: "unchanged" });
  });

  it("requires both explicit flags instead of falling back to the real profile", () => {
    expect(() =>
      configurePerformanceFixture({ setPath: vi.fn() }, { MICROCLAW_PERF_TOKEN: "token" }),
    ).toThrow();
  });

  it("sets all application paths and child environment before stores initialize", () => {
    const value = fixture();
    const app = { setPath: vi.fn() };
    expect(configurePerformanceFixture(app, value.environment)).toBe(true);
    expect(app.setPath).toHaveBeenCalledTimes(5);
    expect(value.environment).toMatchObject({
      HOME: path.join(value.root, "home"),
      APPDATA: path.join(value.root, "appData"),
      OPENCLAW_STATE_DIR: path.join(value.root, "state"),
    });
  });

  it("rejects a wrong token before changing any paths", () => {
    const value = fixture();
    value.environment.MICROCLAW_PERF_TOKEN = "wrong";
    const app = { setPath: vi.fn() };
    expect(() => configurePerformanceFixture(app, value.environment)).toThrow("identity");
    expect(app.setPath).not.toHaveBeenCalled();
  });

  it("rejects a mismatched Gateway port before changing paths", () => {
    const value = fixture();
    fs.writeFileSync(
      path.join(value.root, "state", "openclaw.json"),
      JSON.stringify({ gateway: { bind: "loopback", port: 18789 } }),
    );
    const app = { setPath: vi.fn() };
    expect(() => configurePerformanceFixture(app, value.environment)).toThrow("Gateway port");
    expect(app.setPath).not.toHaveBeenCalled();
  });

  it("rejects a directory junction escaping the disposable root", () => {
    const value = fixture();
    fs.rmdirSync(path.join(value.root, "home"));
    fs.symlinkSync(
      os.tmpdir(),
      path.join(value.root, "home"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() => configurePerformanceFixture({ setPath: vi.fn() }, value.environment)).toThrow(
      "inside the fixture",
    );
    fs.unlinkSync(path.join(value.root, "home"));
  });

  it("rejects a fixture that could expose model tools", () => {
    const value = fixture();
    fs.writeFileSync(
      path.join(value.root, "state", "openclaw.json"),
      JSON.stringify({ gateway: { bind: "loopback", port: 23001 } }),
    );
    const app = { setPath: vi.fn() };
    expect(() => configurePerformanceFixture(app, value.environment)).toThrow("deny-all");
    expect(app.setPath).not.toHaveBeenCalled();
  });
});
