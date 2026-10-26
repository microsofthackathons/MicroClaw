import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const hostRuntime = createRequire(__filename)("../../appcontainer/sandbox-host-runtime.js");
const systemRoot = path.resolve("system-root");
const args = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "(Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
];

describe("OpenClaw internal boot identity probe", () => {
  it("recognizes only the fixed read-only operation", () => {
    expect(hostRuntime.isBootIdentityInvocation("powershell.exe", args)).toBe(true);
  });

  it.each(
    [
      [...args, "extra"],
      [...args.slice(0, 3), `${args[3]}; Remove-Item C:\\Users -Recurse`],
      [...args.slice(0, 3), `& { ${args[3]} }`],
      ["-Command", args[3]],
    ].map((candidate) => ({ candidate })),
  )("does not exempt modified query arguments $candidate", ({ candidate }) => {
    expect(hostRuntime.isBootIdentityInvocation("powershell.exe", candidate)).toBe(false);
  });

  it("rejects alternate executables and shell wrapping", () => {
    for (const command of ["pwsh.exe", "C:\\attacker\\powershell.exe", "cmd.exe"]) {
      expect(hostRuntime.isBootIdentityInvocation(command, args)).toBe(false);
    }
    expect(
      hostRuntime.isBootIdentityInvocation("powershell.exe", args, {
        shell: true,
      }),
    ).toBe(false);
  });

  it("uses the system executable and a fixed environment rather than caller overrides", () => {
    const invocation = hostRuntime.buildBootIdentityInvocation({
      SystemRoot: systemRoot,
      PSModulePath: "C:\\attacker",
      NODE_OPTIONS: "--require attacker.js",
      NODE_PATH: "C:\\attacker",
      Path: "C:\\attacker",
    });
    expect(invocation.command).toBe(
      path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    );
    expect(invocation.options.cwd).toBe(path.dirname(invocation.command));
    expect(invocation.options.env.PSModulePath).toBe(
      path.join(path.dirname(invocation.command), "Modules"),
    );
    expect(invocation.options.env.NODE_OPTIONS).toBeUndefined();
    expect(invocation.options.env.NODE_PATH).toBeUndefined();
    expect(invocation.options.env.Path).toBeUndefined();
    expect(invocation.options.windowsVerbatimArguments).toBe(false);
    expect(invocation.options.shell).toBe(false);
    expect(invocation.options.encoding).toBe("utf8");
    expect(invocation.args).toEqual(args);
    expect(invocation.options.timeout).toBe(5000);
  });

  it.each(["2026.9.3", "2026.10.3", "2026.10.5", "2030.1.1", undefined])(
    "does not gate host bridge initialization on runtime version %s",
    (version) => {
      const root = mkdtempSync(path.join(tmpdir(), "microclaw-host-bridge-"));
      try {
        writeFileSync(
          path.join(root, "package.json"),
          JSON.stringify({ name: "openclaw", version }),
        );
        expect(() => hostRuntime.createControlPlaneHooks(root)).not.toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("still rejects a different package", () => {
    const root = mkdtempSync(path.join(tmpdir(), "microclaw-host-bridge-"));
    try {
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "untrusted-plugin" }));
      expect(() => hostRuntime.createControlPlaneHooks(root)).toThrow(/trusted OpenClaw package/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects modified control-plane modules regardless of the runtime version", () => {
    const root = mkdtempSync(path.join(tmpdir(), "microclaw-host-bridge-"));
    try {
      const metadata = path.join(root, "package.json");
      writeFileSync(metadata, JSON.stringify({ name: "openclaw", version: "2030.1.1" }));
      const hooks = hostRuntime.createControlPlaneHooks(root);
      for (const relative of Object.keys(hostRuntime.PINNED_MODULES)) {
        const file = path.join(root, relative);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, "export const malicious = true;");
        const url = pathToFileURL(file).href;
        expect(() => hooks.load(url, {}, () => ({ source: readFileSync(file) }))).toThrow(
          /control-plane module changed/,
        );
        const unchanged = { url: "node:child_process" };
        expect(hooks.resolve("node:child_process", { parentURL: url }, () => unchanged)).toBe(
          unchanged,
        );
        expect(() => hooks.load(url, {}, () => ({ source: null }))).toThrow(/changed/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects control-plane modules redirected outside the trusted package", () => {
    const root = mkdtempSync(path.join(tmpdir(), "microclaw-host-bridge-"));
    try {
      const packageRoot = path.join(root, "openclaw");
      const outside = path.join(root, "outside");
      mkdirSync(packageRoot);
      mkdirSync(outside);
      writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "openclaw" }));
      const relative = Object.keys(hostRuntime.PINNED_MODULES)[0];
      writeFileSync(path.join(outside, path.basename(relative)), "export const redirected = true;");
      symlinkSync(outside, path.join(packageRoot, "dist"), "junction");
      const hooks = hostRuntime.createControlPlaneHooks(packageRoot);
      const file = path.join(packageRoot, relative);
      const url = pathToFileURL(file).href;
      expect(() => hooks.load(url, {}, () => ({ source: readFileSync(file) }))).toThrow(
        /resolves outside its trusted path/,
      );
      const unchanged = { url: "node:child_process" };
      expect(hooks.resolve("node:child_process", { parentURL: url }, () => unchanged)).toBe(
        unchanged,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("limits process identity probes to the fixed script and a valid numeric PID", () => {
    const command = hostRuntime.buildBootIdentityInvocation(process.env).command;
    const request = hostRuntime.processIdentityArguments(12345);
    expect(hostRuntime.processIdentityRequest(command, request)).toBe(12345);
    expect(hostRuntime.processIdentityRequest(command, request, { shell: true })).toBeNull();
    expect(hostRuntime.processIdentityRequest("C:\\attacker\\powershell.exe", request)).toBeNull();
    for (const candidate of [
      [...request, "extra"],
      [...request.slice(0, 3), `${request[3]}; Write-Output injected`],
      [...request.slice(0, 3), request[3].replace("12345", "0012345")],
      [...request.slice(0, 3), request[3].replace("12345", "0")],
    ]) {
      expect(hostRuntime.processIdentityRequest(command, candidate)).toBeNull();
    }
    for (const pid of [0, -1, 1.5, 4294967296, NaN, "12345"]) {
      expect(() => hostRuntime.processIdentityArguments(pid)).toThrow(/Invalid/);
    }
    expect(
      hostRuntime.processIdentityRequest(command, hostRuntime.processIdentityArguments(4294967295)),
    ).toBe(4294967295);
  });
});

const publishedPackage = process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR
  ? realpathSync.native(process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR)
  : undefined;
it.skipIf(!publishedPackage)(
  "grants the host capability only to verified official control-plane bundles",
  () => {
    const root = realpathSync(publishedPackage!);
    const hooks = hostRuntime.createControlPlaneHooks(root);
    const unchanged = { url: "node:child_process" };
    const files = Object.keys(hostRuntime.PINNED_MODULES).filter((file) =>
      existsSync(path.join(root, file)),
    );
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const url = pathToFileURL(path.join(root, file)).href;
      expect(hooks.resolve("node:child_process", { parentURL: url }, () => unchanged)).toBe(
        unchanged,
      );
      const result = { source: readFileSync(path.join(root, file)) };
      expect(hooks.load(url, {}, () => result)).toBe(result);
      const resolution = hooks.resolve("node:child_process", { parentURL: url }, () => unchanged);
      expect(resolution.shortCircuit).toBe(true);
      expect(resolution.url).toMatch(/^data:text\/javascript,/);
      expect(() =>
        hooks.load(url, {}, () => ({ source: "export const modified = true;" })),
      ).toThrow(/control-plane module changed/);
      expect(hooks.resolve("node:child_process", { parentURL: url }, () => unchanged)).toBe(
        unchanged,
      );
    }
    for (const file of ["dist/plugin.mjs", "../other/dist/gateway-state-owner-C3Vdziw8.mjs"]) {
      const url = pathToFileURL(path.join(root, file)).href;
      expect(hooks.resolve("node:child_process", { parentURL: url }, () => unchanged)).toBe(
        unchanged,
      );
    }
  },
);
it.skipIf(!publishedPackage)(
  "authorizes identical official module contents without consulting the package version",
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "microclaw-host-bridge-"));
    try {
      const relative = Object.keys(hostRuntime.PINNED_MODULES).find((file) =>
        existsSync(path.join(publishedPackage!, file)),
      )!;
      const source = readFileSync(path.join(publishedPackage!, relative));
      const file = path.join(root, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, source);
      const url = pathToFileURL(file).href;
      for (const version of ["2026.10.5", "2030.1.1", undefined]) {
        writeFileSync(
          path.join(root, "package.json"),
          JSON.stringify({ name: "openclaw", version }),
        );
        const hooks = hostRuntime.createControlPlaneHooks(root);
        hooks.load(url, {}, () => ({ source }));
        for (const specifier of ["node:child_process", "child_process"]) {
          expect(hooks.resolve(specifier, { parentURL: url }, () => undefined).shortCircuit).toBe(
            true,
          );
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
it.skipIf(!publishedPackage || process.platform !== "win32")(
  "reads the real boot identity on the host while keeping tool commands sandboxed",
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "microclaw-boot-probe-"));
    try {
      const stateDir = path.join(root, ".openclaw");
      const tempDir = path.join(root, "temp");
      for (const directory of [stateDir, tempDir]) mkdirSync(directory, { recursive: true });
      const script = path.join(root, "probe.mjs");
      writeFileSync(
        script,
        `
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
process.argv[1] = path.join(process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR, "openclaw.mjs");
createRequire(import.meta.url)(${JSON.stringify(path.resolve(__dirname, "../../appcontainer/sandbox-preload.js"))});
syncBuiltinESMExports();
const require = createRequire(import.meta.url);
const packageRoot = process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR;
const owner = [
  { file: "dist/gateway-state-owner-DZeVbzO0.mjs", reader: "E" },
  { file: "dist/gateway-state-owner-C3Vdziw8.mjs", reader: "S" },
  { file: "dist/windows-process-start-zFVtrrwG.mjs", reader: "n", legacy: true },
].find(({ file }) => require("node:fs").existsSync(path.join(packageRoot, file)));
assert.ok(owner, "Official control-plane fixture is unavailable");
const legacy = owner.legacy;
const ownerPath = path.join(packageRoot, owner.file);
const runtime = await import(pathToFileURL(ownerPath).href);
const started = Date.now();
const processStartedAt = legacy ? runtime.n(process.pid) : undefined;
if (legacy) assert.ok(Number.isFinite(processStartedAt) && processStartedAt > 946684800000);
const namespace = legacy ? { platform: "win32", identity: new Date(processStartedAt).toISOString() } : runtime[owner.reader]();
assert.equal(namespace?.platform, "win32");
assert.match(namespace.identity, /^\\d{4}-\\d{2}-\\d{2}T/);
console.log(JSON.stringify({ namespace, elapsedMs: Date.now() - started }));
const childProcess = require("node:child_process");
const hostRuntime = require(${JSON.stringify(path.resolve(__dirname, "../../appcontainer/sandbox-host-runtime.js"))});
const commandArgs = ${JSON.stringify(args)};
const ownerUrl = pathToFileURL(ownerPath).href;
const hooks = hostRuntime.createControlPlaneHooks(packageRoot);
hooks.load(ownerUrl, {}, () => ({ source: require("node:fs").readFileSync(ownerPath) }));
const resolution = hooks.resolve("node:child_process", { parentURL: ownerUrl }, () => assert.fail("bridge missing"));
const adapter = await import(resolution.url);
if (legacy) {
  const bootResult = adapter.spawnSync("powershell.exe", commandArgs);
  assert.equal(bootResult.status, 0);
  assert.ok(Number.isFinite(Date.parse(bootResult.stdout.trim())));
}
console.error("[probe] testing tool commands");
const agentResult = childProcess.spawnSync("powershell.exe", commandArgs, { timeout: 1000 });
assert.equal(agentResult.error?.code, "ENOENT");
const identityArgs = hostRuntime.processIdentityArguments(process.pid);
const identityCommand = hostRuntime.buildBootIdentityInvocation(process.env).command;
const identityResult = adapter.spawnSync(identityCommand, identityArgs);
assert.equal(identityResult.status, 0);
assert.ok(Number.isFinite(Date.parse(identityResult.stdout.trim())));
const processAgentResult = childProcess.spawnSync(identityCommand, identityArgs, { timeout: 1000 });
assert.equal(processAgentResult.error?.code, "ENOENT");
for (const method of ["spawn", "exec", "execFile", "execSync", "execFileSync", "fork"]) {
  assert.equal(adapter[method], childProcess[method]);
}
const toolResult = adapter.spawnSync("powershell.exe", ["-NoProfile", "-Command", "Write-Output tool-probe"], { timeout: 1000 });
assert.equal(toolResult.error?.code, "ENOENT");
assert.equal(require(${JSON.stringify(path.resolve(__dirname, "../../appcontainer/sandbox-state.js"))}).state.sandboxActive, true);
console.log("Agent and unrelated control-plane commands stayed sandboxed");
`,
      );
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !/(?:API_KEY|TOKEN|SECRET|PASSWORD|OPENCLAW|NODE_OPTIONS|MICROCLAW)/i.test(key),
        ),
      );
      Object.assign(env, {
        HOME: root,
        USERPROFILE: root,
        APPDATA: path.join(root, "roaming"),
        LOCALAPPDATA: path.join(root, "local"),
        TEMP: tempDir,
        TMP: tempDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_SANDBOX_DIRS_RW: [stateDir, tempDir].join(","),
        OPENCLAW_SANDBOX_DIRS_RO: [publishedPackage!, path.dirname(process.execPath)].join(","),
        MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR: publishedPackage,
        MICROCLAW_OPENCLAW_PACKAGE_DIR: publishedPackage,
        COMSPEC: path.join(root, "AppContainerLauncher.exe"),
        ComSpec: path.join(root, "AppContainerLauncher.exe"),
      });
      const result = spawnSync(process.execPath, [script], {
        env,
        cwd: root,
        windowsHide: true,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("[host-runtime] boot identity probe");
      const [startupLog, toolLog] = result.stderr.split("[probe] testing tool commands");
      expect(startupLog).not.toMatch(
        /sandbox-exec-command|Pre-block: cmd=powershell|powershell.exe -> AC/,
      );
      expect(toolLog.match(/powershell.exe -> AC/g)).toHaveLength(3);
      expect(toolLog).not.toContain("[host-runtime] boot identity");
      expect(toolLog).toContain("[host-runtime] process identity");
      expect(result.stdout).toContain(
        "Agent and unrelated control-plane commands stayed sandboxed",
      );
      console.log(`Boot identity probe: ${result.stdout.trim()}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  40_000,
);
