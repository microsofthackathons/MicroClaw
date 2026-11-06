import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock electron ─────────────────────────────────────────────────────
const mockApp = vi.hoisted(() => ({ isPackaged: false }));
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === "home") return "C:\\Users\\testuser";
      if (name === "appData") return "C:\\Users\\testuser\\AppData\\Roaming";
      return "";
    }),
    get isPackaged() {
      return mockApp.isPackaged;
    },
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

const mockExecFileSync = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({
  execFileSync: mockExecFileSync,
}));

import * as path from "path";
import {
  getOpenClawStateDir,
  loadGatewayEnvironment,
  loadStateDirEnv,
  isSupportedNodeVersion,
  resolveNodePath,
  resolveOpenClawEntry,
  resolveOpenClawPackageDir,
} from "./path-resolver";

// ── Helpers ───────────────────────────────────────────────────────────
const originalEnv = { ...process.env };

beforeEach(() => {
  mockExistsSync.mockReset().mockReturnValue(false);
  mockReadFileSync.mockReset().mockReturnValue("");
  mockExecFileSync.mockReset().mockReturnValue("v26.1.0\r\n");
  mockApp.isPackaged = false;
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

describe("loadGatewayEnvironment", () => {
  it("uses state-directory values over the desktop process environment", () => {
    mockReadFileSync.mockReturnValue("OPENCLAW_HOME=D:\\state-home\nSTATE_ONLY=from-state\n");

    expect(
      loadGatewayEnvironment("D:\\state", {
        OPENCLAW_HOME: "C:\\process-home",
        PROCESS_ONLY: "from-process",
      }),
    ).toMatchObject({
      OPENCLAW_HOME: "D:\\state-home",
      PROCESS_ONLY: "from-process",
      STATE_ONLY: "from-state",
    });
  });
});

// ── resolveNodePath ─────────────────────────────────────────────────

describe("resolveNodePath", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns deployer-installed node when it exists", () => {
    process.env.USERPROFILE = "C:\\Users\\testuser";
    const expected = path.join("C:\\Users\\testuser", ".openclaw-node", "node.exe");
    mockExistsSync.mockImplementation((p) => String(p) === expected);
    expect(resolveNodePath()).toBe(expected);
  });

  it("falls back to a supported Node on PATH when standard locations are missing", () => {
    process.env.USERPROFILE = "C:\\Users\\testuser";
    mockExistsSync.mockReturnValue(false);
    expect(resolveNodePath()).toBe("node");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "node",
      ["--version"],
      expect.objectContaining({ windowsHide: true, timeout: 5_000 }),
    );
  });

  it("falls back to Program Files when deployer node missing", () => {
    process.env.USERPROFILE = "C:\\Users\\testuser";
    const progFiles = "C:\\Program Files\\nodejs\\node.exe";
    mockExistsSync.mockImplementation((p) => String(p) === progFiles);
    expect(resolveNodePath()).toBe(progFiles);
  });

  it.each(["v22.22.3", "v24.15.9", "v25.9.0", "v26.0.0", "v26.1.0-rc.1"])(
    "skips an unsupported legacy installation (%s)",
    (version) => {
      process.env.USERPROFILE = "C:\\Users\\testuser";
      process.env.ProgramFiles = "C:\\Program Files";
      delete process.env.OPENCLAW_NODE_DIR;
      const legacy = path.join(process.env.USERPROFILE, ".openclaw-node", "node.exe");
      const supported = path.join(process.env.ProgramFiles, "nodejs", "node.exe");
      mockExistsSync.mockImplementation((p) => [legacy, supported].includes(String(p)));
      mockExecFileSync.mockImplementation((p) => (p === legacy ? version : "v26.1.0"));
      expect(resolveNodePath()).toBe(supported);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining(`Skipping unsupported Node.js ${version}`),
      );
    },
  );

  it("skips a broken binary and accepts the per-user MSI installation", () => {
    process.env.ProgramFiles = "C:\\Program Files";
    process.env.LOCALAPPDATA = "C:\\Users\\testuser\\AppData\\Local";
    const broken = path.join(process.env.ProgramFiles, "nodejs", "node.exe");
    const supported = path.join(process.env.LOCALAPPDATA, "Programs", "nodejs", "node.exe");
    mockExistsSync.mockImplementation((p) => [broken, supported].includes(String(p)));
    mockExecFileSync.mockImplementation((p) => {
      if (p === broken) throw new Error("cannot execute");
      return "v24.16.0";
    });
    expect(resolveNodePath()).toBe(supported);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("cannot execute"));
  });

  it("honors a supported absolute OPENCLAW_NODE_DIR override", () => {
    process.env.OPENCLAW_NODE_DIR = "D:\\custom-node";
    const expected = path.join(process.env.OPENCLAW_NODE_DIR, "node.exe");
    mockExistsSync.mockImplementation((p) => String(p) === expected);
    expect(resolveNodePath()).toBe(expected);
  });

  it("does not execute a relative OPENCLAW_NODE_DIR override", () => {
    process.env.OPENCLAW_NODE_DIR = "relative-node";
    mockExistsSync.mockReturnValue(false);
    expect(resolveNodePath()).toBe("node");
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("skips an unsupported bundled runtime", () => {
    mockApp.isPackaged = true;
    vi.stubGlobal("process", { ...process, resourcesPath: "C:\\MicroClaw\\resources" });
    try {
      const bundled = path.join(process.resourcesPath, "node.exe");
      mockExistsSync.mockImplementation((p) => String(p) === bundled);
      mockExecFileSync.mockImplementation((p) => (p === bundled ? "v22.22.3" : "v26.1.0"));
      expect(resolveNodePath()).toBe("node");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["v25.9.0", "v26.0.0", "invalid"])(
    "rejects unsupported Node on PATH (%s) with the required runtime range",
    (version) => {
      mockExecFileSync.mockReturnValue(version);
      expect(() => resolveNodePath()).toThrow(">=24.16.0 <25 || >=26.1.0");
    },
  );

  it("reports how to install Node when no executable runs", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(() => resolveNodePath()).toThrow("Run the MicroClaw installer or install Node.js 26");
  });
});

describe("isSupportedNodeVersion", () => {
  it.each(["24.16.0", "v24.17.0", "26.1.0", "v26.2.0", "27.0.0"])("accepts %s", (version) =>
    expect(isSupportedNodeVersion(version)).toBe(true),
  );

  it.each([
    "22.22.3",
    "v22.99.0",
    "23.10.0",
    "24.15.9",
    "25.9.0",
    "v25.99.0",
    "26.0.0",
    "v26.0.9",
    "",
    "26",
    "26.1",
    "26.1.0.0",
    "26.1.0-rc.1",
    "26.1.0+build.1",
    " 26.1.0",
    "26.1.0\n",
    "vv26.1.0",
    "V26.1.0",
    "026.1.0",
    "26.01.0",
    "26.1.00",
    "２６.1.0",
    "-26.1.0",
    "26.a.0",
  ])("rejects %s", (version) => expect(isSupportedNodeVersion(version)).toBe(false));
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

describe("resolveOpenClawPackageDir", () => {
  it("returns the package root for the openclaw.mjs entry", () => {
    expect(
      resolveOpenClawPackageDir(
        "C:\\Users\\testuser\\AppData\\Roaming\\npm\\node_modules\\openclaw\\openclaw.mjs",
      ),
    ).toBe("C:\\Users\\testuser\\AppData\\Roaming\\npm\\node_modules\\openclaw");
  });

  it("returns the parent of dist for a compiled entry", () => {
    expect(
      resolveOpenClawPackageDir(
        "C:\\Users\\testuser\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js",
      ),
    ).toBe("C:\\Users\\testuser\\AppData\\Roaming\\npm\\node_modules\\openclaw");
  });
});
