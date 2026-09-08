import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const winPath = path.win32;
const home = "C:\\Users\\sandbox-test";
const packageRoot = winPath.join(home, "AppData", "Roaming", "npm", "node_modules", "openclaw");
const entryPath = winPath.join(packageRoot, "openclaw.mjs");
const commandFile = winPath.join(
  packageRoot,
  "node_modules",
  "execa",
  "lib",
  "arguments",
  "command-file.js",
);
const gitPath = winPath.join(
  home,
  "AppData",
  "Local",
  "github-copilot-git-2.53.0-4",
  "cmd",
  "git.exe",
);
const sandboxDir = winPath.join("C:\\MicroClaw", "sandbox");
const sourceDir = path.resolve(__dirname, "..", "..", "appcontainer");
const sources = new Map(
  ["sandbox-state.js", "sandbox-sensitive.js", "sandbox-permission.js", "sandbox-fs-hooks.js"].map(
    (name) => [name, fs.readFileSync(path.join(sourceDir, name), "utf8")],
  ),
);

interface PermissionRequest {
  type: string;
  accessNeeded: string;
  responseFile: string;
}

interface SandboxState {
  state: { sandboxActive: boolean; _roDirs: string[] };
  normDirList(value: string): string[];
}

interface SandboxPermission {
  sendAsyncPermissionRequest(
    type: string,
    deniedPath: string,
    dirPath: string,
    command: string,
    accessNeeded: string,
  ): void;
}

function createSandbox(options: { respond?: boolean; entry?: string; platform?: string } = {}) {
  let now = 1000;
  let decision = "deny";
  const responses = new Map<string, string>();
  const requests: PermissionRequest[] = [];
  const rawOpen = vi.fn((_file: string, _flags?: string) => 42);
  const rawRead = vi.fn((_fd: number, buffer: Buffer) => buffer.write("MZ native executable"));
  const rawReadFile = vi.fn((file: string) => responses.get(file) ?? "private contents");
  const rawWrite = vi.fn();
  const rawClose = vi.fn();
  const rawPromiseOpen = vi.fn(async (_file: string, _flags?: string) => ({ fd: 42 }));
  const fsModule = {
    openSync: rawOpen,
    open: vi.fn(),
    closeSync: rawClose,
    readSync: rawRead,
    readFileSync: rawReadFile,
    readFile: vi.fn(),
    writeFileSync: rawWrite,
    existsSync: (file: string) => responses.has(file),
    mkdirSync: vi.fn(),
    unlinkSync: (file: string) => responses.delete(file),
    promises: { open: rawPromiseOpen },
  };
  const wait = vi.fn((_array: unknown, _index: number, _value: number, timeout: number) => {
    now += timeout;
    return "timed-out";
  });
  const logs = vi.fn();
  const context = createContext({
    Buffer,
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    Atomics: { wait },
    process: {
      platform: options.platform ?? "win32",
      argv: ["C:\\Program Files\\nodejs\\node.exe", options.entry ?? entryPath],
      env: {
        USERPROFILE: home,
        APPDATA: winPath.join(home, "AppData", "Roaming"),
        LOCALAPPDATA: winPath.join(home, "AppData", "Local"),
        TEMP: "C:\\sandbox-ipc",
        OPENCLAW_SANDBOX_PERMISSION_TIMEOUT: "60000",
      },
      stderr: { write: logs },
      send(request: PermissionRequest) {
        requests.push(request);
        if (options.respond !== false) {
          responses.set(request.responseFile, JSON.stringify({ decision }));
        }
      },
    },
  });
  const modules = new Map<string, { exports: unknown }>();
  function load(id: string): unknown {
    if (id === "path") return winPath;
    if (id === "url") {
      return { fileURLToPath: (url: string) => fileURLToPath(url, { windows: true }) };
    }
    if (id === "fs") return fsModule;
    const name = winPath.basename(id);
    const cached = modules.get(name);
    if (cached) return cached.exports;
    const source = sources.get(name);
    if (!source) throw new Error(`Unexpected module: ${id}`);
    const module = { exports: {} };
    modules.set(name, module);
    runInContext(`(function(require, module, exports, __dirname) { ${source}\n})`, context, {
      filename: winPath.join(sandboxDir, name),
    })(load, module, module.exports, sandboxDir);
    return module.exports;
  }
  const state = load("sandbox-state.js") as SandboxState;
  state.state.sandboxActive = true;
  const permission = load("sandbox-permission.js") as SandboxPermission;
  const hooks = load("sandbox-fs-hooks.js") as { install(fs: typeof fsModule): void };
  hooks.install(fsModule);
  const errors: string[] = [];
  context.fs = fsModule;
  context.errors = errors;
  context.spawn = vi.fn();

  function makeProbe(filename = commandFile, functionName = "readShebang") {
    // Execa 10.0.1 (pinned by OpenClaw 2026.8.2) catches failed opens in command-file.js.
    // Run that contract at its actual caller location, using the real sandbox hooks.
    return runInContext(
      `(function ${functionName}(file, flags = "r") {
        let fd;
        try {
          fd = fs.openSync(file, flags);
          const bytes = Buffer.alloc(150);
          fs.readSync(fd, bytes, 0, bytes.length, 0);
          return bytes.toString();
        } catch (error) {
          errors.push(error.code);
          return undefined;
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
        }
      })`,
      context,
      { filename },
    );
  }

  return {
    state,
    permission,
    fs: fsModule,
    rawOpen,
    rawRead,
    rawReadFile,
    rawWrite,
    rawPromiseOpen,
    requests,
    errors,
    logs,
    wait,
    makeProbe,
    context,
    setDecision(value: string) {
      decision = value;
    },
  };
}

describe("OpenClaw executable shebang probes", () => {
  it("does not spend the 60-second IPC timeout reading Git before spawn", () => {
    const sandbox = createSandbox({ respond: false });
    sandbox.context.readShebang = sandbox.makeProbe();
    sandbox.context.gitPath = gitPath;

    runInContext(`readShebang(gitPath); spawn(gitPath, ["--version"]);`, sandbox.context);

    expect(sandbox.errors).toEqual(["EACCES"]);
    expect(sandbox.requests).toEqual([]);
    expect(sandbox.wait).not.toHaveBeenCalled();
    expect(sandbox.rawOpen).not.toHaveBeenCalled();
    expect(sandbox.rawRead).not.toHaveBeenCalled();
    expect(sandbox.context.spawn).toHaveBeenCalledWith(gitPath, ["--version"]);
    expect(sandbox.state.state.sandboxActive).toBe(true);
  });

  it.each([
    "C:\\unapproved\\git.exe",
    "C:\\unapproved\\not-git.exe",
    "C:\\unapproved\\symlink-to-secret.exe",
    "C:\\unapproved\\script-renamed.exe",
    "C:\\unapproved\\GIT.EXE",
  ])("denies the optional probe without opening or trusting %s", (file) => {
    const sandbox = createSandbox();
    expect(sandbox.makeProbe()(file)).toBeUndefined();
    expect(sandbox.errors).toEqual(["EACCES"]);
    expect(sandbox.requests).toEqual([]);
    expect(sandbox.rawOpen).not.toHaveBeenCalled();
    expect(sandbox.rawRead).not.toHaveBeenCalled();
  });

  it.each([
    ["an unrelated caller", "C:\\untrusted\\agent.js", "readShebang", gitPath, "r"],
    [
      "a lookalike execa package",
      "C:\\untrusted\\node_modules\\execa\\lib\\arguments\\command-file.js",
      "readShebang",
      gitPath,
      "r",
    ],
    ["another function in execa", commandFile, "readSecrets", gitPath, "r"],
    ["a script", commandFile, "readShebang", "C:\\unapproved\\script.js", "r"],
    ["a batch command", commandFile, "readShebang", "C:\\unapproved\\git.cmd", "r"],
    ["an arbitrary path", commandFile, "readShebang", "C:\\unapproved\\secrets.txt", "r"],
    ["a relative executable", commandFile, "readShebang", "git.exe", "r"],
    ["write flags", commandFile, "readShebang", gitPath, "r+"],
  ])("retains permission enforcement for %s", (_label, filename, caller, file, flags) => {
    const sandbox = createSandbox();
    expect(sandbox.makeProbe(filename, caller)(file, flags)).toBeUndefined();
    expect(sandbox.errors).toEqual(["EACCES"]);
    expect(sandbox.requests).toHaveLength(1);
    expect(sandbox.requests[0].type).toBe("sandbox-file-permission-request");
    expect(sandbox.requests[0].accessNeeded).toBe(flags === "r+" ? "rw" : "ro");
    expect(sandbox.rawOpen).not.toHaveBeenCalled();
  });

  it("does not authorize or permanently deny subsequent ordinary reads of Git", () => {
    const sandbox = createSandbox();
    sandbox.makeProbe()(gitPath);
    expect(sandbox.requests).toEqual([]);
    expect(() => sandbox.fs.openSync(gitPath, "r")).toThrow(/EACCES/);
    expect(sandbox.requests).toHaveLength(1);
    expect(sandbox.rawOpen).not.toHaveBeenCalled();
  });

  it("does not wait for an existing async permission request or consume its decision", () => {
    const sandbox = createSandbox({ respond: false });
    sandbox.permission.sendAsyncPermissionRequest(
      "sandbox-file-permission-request",
      gitPath,
      winPath.dirname(gitPath),
      "agent read",
      "ro",
    );
    sandbox.makeProbe()(gitPath);
    expect(sandbox.errors).toEqual(["EACCES"]);
    expect(sandbox.requests).toHaveLength(1);
    expect(sandbox.wait).not.toHaveBeenCalled();
    expect(sandbox.rawOpen).not.toHaveBeenCalled();
  });

  it("retains the normal permission timeout for an unapproved agent read", () => {
    const sandbox = createSandbox({ respond: false });
    sandbox.makeProbe("C:\\untrusted\\agent.js")(gitPath);
    expect(sandbox.errors).toEqual(["EACCES"]);
    expect(sandbox.requests).toHaveLength(1);
    expect(sandbox.wait).toHaveBeenCalledTimes(60000 / 200);
    expect(sandbox.rawOpen).not.toHaveBeenCalled();
  });

  it("preserves configured read grants and still denies writes", () => {
    const sandbox = createSandbox();
    sandbox.state.state._roDirs = sandbox.state.normDirList(winPath.dirname(gitPath));
    expect(sandbox.makeProbe()(gitPath)).toContain("MZ");
    expect(sandbox.rawOpen).toHaveBeenCalledTimes(1);
    expect(sandbox.rawRead).toHaveBeenCalledTimes(1);
    expect(sandbox.requests).toEqual([]);
    expect(() => sandbox.fs.openSync(gitPath, "r+")).toThrow(/EACCES/);
    expect(sandbox.requests[0].accessNeeded).toBe("rw");
    expect(sandbox.rawOpen).toHaveBeenCalledTimes(1);
  });

  it("honors an existing user grant but never creates one for the probe", () => {
    const sandbox = createSandbox();
    sandbox.makeProbe()(gitPath);
    sandbox.setDecision("grant-ro");
    sandbox.fs.openSync(gitPath, "r");
    expect(sandbox.requests).toHaveLength(1);
    expect(sandbox.makeProbe()(gitPath)).toContain("MZ");
    expect(sandbox.requests).toHaveLength(1);
    expect(sandbox.rawOpen).toHaveBeenCalledTimes(2);
  });

  it("preserves sensitive-path denial even when the name looks executable", () => {
    const sandbox = createSandbox();
    sandbox.state.state._roDirs = sandbox.state.normDirList(winPath.join(home, ".ssh"));
    sandbox.makeProbe()(winPath.join(home, ".ssh", "git.exe"));
    expect(sandbox.errors).toEqual(["SENSITIVE_PATH_DENIED"]);
    expect(sandbox.requests).toEqual([]);
    expect(sandbox.rawOpen).not.toHaveBeenCalled();
  });

  it("never opens a file even when an untrusted caller spoofs the expected stack", () => {
    const sandbox = createSandbox();
    const frame = `    at readShebang (${commandFile}:1:1)`;
    sandbox.context.forgedStack = `Error\n${frame}`;
    runInContext("Error.prepareStackTrace = () => forgedStack;", sandbox.context);
    expect(() => sandbox.fs.openSync(gitPath, "r")).toThrow(/EACCES/);
    expect(sandbox.rawOpen).not.toHaveBeenCalled();
    expect(sandbox.rawRead).not.toHaveBeenCalled();
  });

  it("falls back to normal permission enforcement when caller identification fails", () => {
    const sandbox = createSandbox();
    runInContext("Error.prepareStackTrace = () => undefined;", sandbox.context);
    sandbox.makeProbe()(gitPath);
    expect(sandbox.errors).toEqual(["EACCES"]);
    expect(sandbox.requests).toHaveLength(1);
    expect(sandbox.rawOpen).not.toHaveBeenCalled();
  });

  it("does not suppress ordinary readFile, promise-open, or write permission requests", async () => {
    for (const operation of ["readFile", "promiseOpen", "write"] as const) {
      const sandbox = createSandbox();
      sandbox.makeProbe()(gitPath);
      if (operation === "promiseOpen") {
        await expect(sandbox.fs.promises.open(gitPath, "r")).rejects.toThrow(/EACCES/);
      } else if (operation === "readFile") {
        expect(() => sandbox.fs.readFileSync(gitPath)).toThrow(/EACCES/);
      } else {
        expect(() => sandbox.fs.writeFileSync(gitPath, "modified")).toThrow(/EACCES/);
      }
      expect(sandbox.requests).toHaveLength(1);
      expect(sandbox.rawPromiseOpen).not.toHaveBeenCalled();
      expect(sandbox.rawWrite).not.toHaveBeenCalled();
      // IPC responses are the only authorized readFileSync calls.
      expect(sandbox.rawReadFile.mock.calls.every(([file]) => file !== gitPath)).toBe(true);
    }
  });

  it("recognizes ESM file URLs, including encoded package paths", () => {
    const sandbox = createSandbox({ entry: entryPath.replace("sandbox-test", "sandbox user") });
    const caller = pathToFileURL(commandFile.replace("sandbox-test", "sandbox user"), {
      windows: true,
    }).href;
    sandbox.makeProbe(caller)(gitPath);
    expect(sandbox.errors).toEqual(["EACCES"]);
    expect(sandbox.requests).toEqual([]);
  });

  it("recognizes the dist entry point used by older OpenClaw installations", () => {
    const sandbox = createSandbox({ entry: winPath.join(packageRoot, "dist", "index.js") });
    sandbox.makeProbe()(gitPath);
    expect(sandbox.errors).toEqual(["EACCES"]);
    expect(sandbox.requests).toEqual([]);
  });

  it.each([{ platform: "linux" }, { entry: "C:\\untrusted\\agent.js" }])(
    "does not apply to another runtime: %j",
    (options) => {
      const sandbox = createSandbox(options);
      sandbox.makeProbe()(gitPath);
      expect(sandbox.requests).toHaveLength(1);
      expect(sandbox.rawOpen).not.toHaveBeenCalled();
    },
  );
});
