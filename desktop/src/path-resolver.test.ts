import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock electron ─────────────────────────────────────────────────────
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === "home") return "C:\\Users\\testuser";
      if (name === "appData") return "C:\\Users\\testuser\\AppData\\Roaming";
      return "";
    }),
    isPackaged: false,
  },
}));

// ── Mock fs ───────────────────────────────────────────────────────────
const mockExistsSync = vi.fn().mockReturnValue(false);
const mockReadFileSync = vi.fn().mockReturnValue("");

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: (p: any) => mockExistsSync(p),
    readFileSync: (p: any, opts?: any) => mockReadFileSync(p, opts),
  };
});

import * as path from "path";
import {
  getOpenClawStateDir,
  loadStateDirEnv,
  resolveNodePath,
  resolveOpenClawEntry,
} from "./path-resolver";

// ── Helpers ───────────────────────────────────────────────────────────
const originalEnv = { ...process.env };

beforeEach(() => {
  mockExistsSync.mockReset().mockReturnValue(false);
  mockReadFileSync.mockReset().mockReturnValue("");
});

afterEach(() => {
  // Restore environment variables
  process.env = { ...originalEnv };
});

// ── getOpenClawStateDir ─────────────────────────────────────────────

describe("getOpenClawStateDir", () => {
  it("returns OPENCLAW_STATE_DIR envvar when set", () => {
    process.env.OPENCLAW_STATE_DIR = "D:\\custom\\state";
    expect(getOpenClawStateDir()).toBe("D:\\custom\\state");
  });

  it("returns ~/.openclaw when openclaw.json exists there", () => {
    delete process.env.OPENCLAW_STATE_DIR;
    mockExistsSync.mockImplementation((p) => {
      return String(p) === path.join("C:\\Users\\testuser", ".openclaw", "openclaw.json");
    });
    expect(getOpenClawStateDir()).toBe(path.join("C:\\Users\\testuser", ".openclaw"));
  });

  it("falls back to %APPDATA%/openclaw", () => {
    delete process.env.OPENCLAW_STATE_DIR;
    mockExistsSync.mockReturnValue(false);
    expect(getOpenClawStateDir()).toBe(
      path.join("C:\\Users\\testuser\\AppData\\Roaming", "openclaw"),
    );
  });
});

// ── loadStateDirEnv ─────────────────────────────────────────────────

describe("loadStateDirEnv", () => {
  it("parses key=value pairs from .env file", () => {
    mockReadFileSync.mockReturnValue("API_KEY=secret123\nBASE_URL=http://localhost\n");
    const env = loadStateDirEnv("D:\\state");
    expect(env).toEqual({
      API_KEY: "secret123",
      BASE_URL: "http://localhost",
    });
  });

  it("skips comments and empty lines", () => {
    mockReadFileSync.mockReturnValue("# comment\n\n  \nKEY=value\n# another comment\n");
    const env = loadStateDirEnv("D:\\state");
    expect(env).toEqual({ KEY: "value" });
  });

  it("handles values containing = signs", () => {
    mockReadFileSync.mockReturnValue("URL=https://example.com?a=1&b=2\n");
    const env = loadStateDirEnv("D:\\state");
    expect(env).toEqual({ URL: "https://example.com?a=1&b=2" });
  });

  it("skips lines without valid key", () => {
    mockReadFileSync.mockReturnValue("=nokey\nGOOD=yes\n");
    const env = loadStateDirEnv("D:\\state");
    expect(env).toEqual({ GOOD: "yes" });
  });

  it("returns empty object when .env does not exist", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(loadStateDirEnv("D:\\state")).toEqual({});
  });

  it("handles Windows line endings (\\r\\n)", () => {
    mockReadFileSync.mockReturnValue("A=1\r\nB=2\r\n");
    const env = loadStateDirEnv("D:\\state");
    expect(env).toEqual({ A: "1", B: "2" });
  });
});

// ── resolveNodePath ─────────────────────────────────────────────────

describe("resolveNodePath", () => {
  it("returns deployer-installed node when it exists", () => {
    process.env.USERPROFILE = "C:\\Users\\testuser";
    const expected = path.join("C:\\Users\\testuser", ".openclaw-node", "node.exe");
    mockExistsSync.mockImplementation((p) => String(p) === expected);
    expect(resolveNodePath()).toBe(expected);
  });

  it("falls back to 'node' when nothing exists", () => {
    process.env.USERPROFILE = "C:\\Users\\testuser";
    mockExistsSync.mockReturnValue(false);
    expect(resolveNodePath()).toBe("node");
  });

  it("falls back to Program Files when deployer node missing", () => {
    process.env.USERPROFILE = "C:\\Users\\testuser";
    const progFiles = "C:\\Program Files\\nodejs\\node.exe";
    mockExistsSync.mockImplementation((p) => String(p) === progFiles);
    expect(resolveNodePath()).toBe(progFiles);
  });
});

// ── resolveOpenClawEntry ────────────────────────────────────────────

describe("resolveOpenClawEntry", () => {
  it("returns first matching candidate", () => {
    process.env.USERPROFILE = "C:\\Users\\testuser";
    process.env.APPDATA = "C:\\Users\\testuser\\AppData\\Roaming";
    const expected = path.join(
      "C:\\Users\\testuser",
      ".openclaw-node",
      "node_modules",
      "openclaw",
      "openclaw.mjs",
    );
    mockExistsSync.mockImplementation((p) => String(p) === expected);
    expect(resolveOpenClawEntry()).toBe(expected);
  });

  it("returns fallback candidate when nothing exists", () => {
    process.env.USERPROFILE = "C:\\Users\\testuser";
    process.env.APPDATA = "";
    mockExistsSync.mockReturnValue(false);
    // Should return the first non-empty candidate
    const result = resolveOpenClawEntry();
    expect(result).toContain(".openclaw-node");
    expect(result).toContain("openclaw.mjs");
  });

  it("checks lib/ npm layout as second candidate", () => {
    process.env.USERPROFILE = "C:\\Users\\testuser";
    process.env.APPDATA = "";
    const libPath = path.join(
      "C:\\Users\\testuser",
      ".openclaw-node",
      "lib",
      "node_modules",
      "openclaw",
      "openclaw.mjs",
    );
    mockExistsSync.mockImplementation((p) => String(p) === libPath);
    expect(resolveOpenClawEntry()).toBe(libPath);
  });

  it("falls back to Program Files Node global install", () => {
    process.env.USERPROFILE = "C:\\Users\\testuser";
    process.env.APPDATA = "";
    process.env.ProgramFiles = "C:\\Program Files";
    const programFilesPath = path.join(
      "C:\\Program Files",
      "nodejs",
      "node_modules",
      "openclaw",
      "openclaw.mjs",
    );
    mockExistsSync.mockImplementation((p) => String(p) === programFilesPath);
    expect(resolveOpenClawEntry()).toBe(programFilesPath);
  });
});
