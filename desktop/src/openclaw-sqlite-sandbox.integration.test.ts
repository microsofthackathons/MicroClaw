import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const publishedPackage = process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR;

describe.skipIf(!publishedPackage || process.platform !== "win32")(
  "official OpenClaw SQLite sandbox integration",
  () => {
    it("starts and restarts the real gateway with sandbox enforcement enabled", async () => {
      const root = mkdtempSync(path.join(tmpdir(), "microclaw-gateway-sandbox-"));
      try {
        const home = path.join(root, "home");
        const stateDir = path.join(home, ".openclaw");
        const localAppData = path.join(home, "AppData", "Local");
        const tempDir = path.join(localAppData, "Temp");
        for (const directory of [stateDir, tempDir, path.join(localAppData, "openclaw")]) {
          mkdirSync(directory, { recursive: true });
        }
        const listener = createServer();
        await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
        const port = address.port;
        await new Promise<void>((resolve) => listener.close(() => resolve()));
        const configPath = path.join(stateDir, "openclaw.json");
        writeFileSync(
          configPath,
          JSON.stringify({
            gateway: {
              mode: "local",
              bind: "loopback",
              port,
              auth: { mode: "token", token: randomUUID() },
            },
            agents: {
              defaults: { workspace: path.join(stateDir, "workspace"), heartbeat: { every: "0m" } },
            },
            logging: { file: path.join(tempDir, "gateway.log") },
            plugins: { allow: [] },
            skills: { allowBundled: [] },
          }),
        );
        const startupDurations: Record<string, number> = {};
        const preload = path.resolve(__dirname, "..", "..", "appcontainer", "sandbox-preload.js");
        const stateOwnerPreload = pathToFileURL(
          path.join(__dirname, "openclaw-state-owner-compat.mjs"),
        ).href;
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !/(?:API_KEY|TOKEN|SECRET|PASSWORD|OPENCLAW|NODE_OPTIONS|MICROCLAW|VITEST)/i.test(
                key,
              ),
          ),
        );
        Object.assign(env, {
          HOME: home,
          USERPROFILE: home,
          APPDATA: path.join(home, "AppData", "Roaming"),
          LOCALAPPDATA: localAppData,
          TEMP: tempDir,
          TMP: tempDir,
          XDG_CACHE_HOME: "",
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_NO_AUTO_UPDATE: "1",
          OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: "1",
          OPENCLAW_DISABLE_BONJOUR: "1",
          OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
          OPENCLAW_SANDBOX_DIRS_RW: [stateDir, tempDir].join(","),
          OPENCLAW_SANDBOX_DIRS_RO: [
            publishedPackage!,
            path.dirname(process.execPath),
            __dirname,
          ].join(","),
          COMSPEC: path.join(root, "AppContainerLauncher.exe"),
          ComSpec: path.join(root, "AppContainerLauncher.exe"),
          NODE_OPTIONS: `--require "${preload.replace(/\\/g, "/")}" --import "${stateOwnerPreload}" --disable-warning=ExperimentalWarning`,
          NODE_COMPILE_CACHE: path.join(stateDir, "compile-cache"),
          NODE_ENV: "production",
          MICROCLAW_OPENCLAW_PACKAGE_DIR: publishedPackage,
          MICROCLAW_WINDOWS_STATE_OWNER_COMPAT: "1",
        });
        for (const generation of ["fresh", "existing-state"]) {
          writeFileSync(path.join(tempDir, "gateway.log"), "");
          const started = Date.now();
          const child = spawn(
            process.execPath,
            [
              path.join(publishedPackage!, "openclaw.mjs"),
              "gateway",
              "run",
              "--port",
              String(port),
            ],
            { env, cwd: stateDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
          );
          let log = "";
          const capture = (data: Buffer) => {
            log += data.toString();
          };
          child.stdout.on("data", capture);
          child.stderr.on("data", capture);
          child.on("error", (error) => {
            log += String(error);
          });
          let ready = false;
          let lastReadyProbe = "unreachable";
          try {
            const deadline = Date.now() + 90_000;
            while (Date.now() < deadline && child.exitCode === null) {
              try {
                const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
                  signal: AbortSignal.timeout(1000),
                });
                lastReadyProbe = `${response.status}: ${await response.text()}`;
                if (response.ok) {
                  ready = true;
                  break;
                }
              } catch {}
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
            try {
              log += readFileSync(path.join(tempDir, "gateway.log"), "utf8");
            } catch {}
            writeFileSync(
              path.resolve(__dirname, "../../build", `host-runtime-gateway-${generation}.log`),
              log,
            );
            expect(
              ready,
              `${generation} gateway startup failed (${lastReadyProbe}):\n${log.slice(-12_000)}`,
            ).toBe(true);
            expect(child.exitCode).toBeNull();
            expect(log).toContain("sandbox active immediately");
            expect(log, generation).toContain("[host-runtime] boot identity probe");
            expect(log, generation).not.toMatch(/-> AC|Pre-block:/);
            expect(log).not.toMatch(/Pre-block: cmd=powershell|powershell.exe -> AC/);
            expect(log).not.toMatch(
              /BLOCKED \(permission\)|File permission timeout|startup failed/i,
            );
            startupDurations[generation] = Date.now() - started;
          } finally {
            if (child.exitCode === null) {
              await new Promise<void>((resolve) => {
                child.once("close", () => resolve());
                child.kill();
              });
            }
          }
        }
        console.log(`Isolated Gateway startup timings: ${JSON.stringify(startupDurations)}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 190_000);

    it("runs real v2 snapshot workers and enforces session database scope", () => {
      const root = mkdtempSync(path.join(tmpdir(), "microclaw-sqlite-sandbox-"));
      try {
        const metadata = JSON.parse(
          readFileSync(path.join(publishedPackage!, "package.json"), "utf8"),
        );
        expect(metadata.version).toBe("2026.10.3");
        const stateDir = path.join(root, "state");
        const localAppData = path.join(root, "local");
        const tempDir = path.join(root, "temp");
        for (const directory of [stateDir, tempDir, path.join(localAppData, "openclaw")]) {
          mkdirSync(directory, { recursive: true });
        }
        const script = path.join(root, "probe.mjs");
        const sourceDir = path.resolve(__dirname, "..", "..", "appcontainer");
        writeFileSync(
          script,
          `
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
const packageRoot = process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR;
const databasePath = path.join(process.env.OPENCLAW_STATE_DIR, "probe.sqlite");
const database = new DatabaseSync(databasePath);
database.exec("CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('snapshot verified');");
database.close();
process.argv[1] = path.join(packageRoot, "openclaw.mjs");
const require = createRequire(import.meta.url);
require(${JSON.stringify(path.join(sourceDir, "sandbox-preload.js"))});
syncBuiltinESMExports();
const sandbox = require(${JSON.stringify(path.join(sourceDir, "sandbox-state.js"))});
const hooks = require(${JSON.stringify(path.join(sourceDir, "sandbox-cp-hooks.js"))});
const invocation = hooks.buildInternalSqliteWorkerInvocation([], {
  env: { NODE_COMPILE_CACHE: path.join(process.env.TEMP, "caller-controlled-cache"), NODE_OPTIONS: "--require attacker.js" },
});
assert.equal(invocation.options.env.NODE_COMPILE_CACHE, process.env.NODE_COMPILE_CACHE);
assert.equal(invocation.options.env.NODE_OPTIONS, undefined);
assert.equal(sandbox.state.sandboxActive, true);
const worker = await import(pathToFileURL(path.join(packageRoot, "dist", "sqlite-readonly-worker-DPlfD0t8.mjs")).href);
const stagingRuntime = await import(pathToFileURL(path.join(packageRoot, "dist", "sqlite-snapshot-staging-DxUHqJpO.mjs")).href);
const cleanupRuntime = await import(pathToFileURL(path.join(packageRoot, "dist", "sqlite-readonly-location-cleanup-CPS8QEIp.mjs")).href);
for (const mode of ["sync", "async", "session"]) {
  const staging = stagingRuntime.r(path.join(process.env.LOCALAPPDATA, "openclaw"));
  assert.match(path.basename(staging), /^openclaw-sqlite-readonly-v2-/);
  const location = mode === "sync"
    ? worker.runSqliteReadOnlyWorkerSync(databasePath, staging)
    : mode === "async"
      ? await worker.runSqliteReadOnlyWorker(databasePath, { mode, stagingRoot: staging })
      : await worker.withSqliteReadOnlyWorkerScope(() => worker.runSqliteReadOnlyWorker(databasePath, { mode: "sync", stagingRoot: staging }));
  assert.equal(typeof location, "string");
  const snapshot = new DatabaseSync(location, { readOnly: true });
  assert.equal(snapshot.prepare("SELECT value FROM probe").get().value, "snapshot verified");
  snapshot.close();
  fs.readdirSync(staging);
  assert.equal(cleanupRuntime.c(staging), true);
}
const outsideDatabasePath = path.join(process.env.TEMP, "outside.sqlite");
const outsideDatabase = new DatabaseSync(outsideDatabasePath);
outsideDatabase.exec("CREATE TABLE secret (value TEXT);");
outsideDatabase.close();
const session = worker.createScopedSqliteReadOnlyWorker(worker.captureSqliteReadOnlyWorkerLaunch());
await assert.rejects(session.run(outsideDatabasePath, { mode: "sync" }), /outside trusted state scope/);
await session.close();
assert.equal(sandbox.isBlockedPath(path.join(process.env.LOCALAPPDATA, "openclaw", "credentials.json")), true);
console.log("SQLite sync/async snapshots and cleanup verified with sandbox active");
`,
        );
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !/(?:API_KEY|TOKEN|SECRET|PASSWORD|OPENCLAW|NODE_OPTIONS)/i.test(key),
          ),
        );
        Object.assign(env, {
          HOME: root,
          USERPROFILE: root,
          APPDATA: path.join(root, "roaming"),
          LOCALAPPDATA: localAppData,
          TEMP: tempDir,
          TMP: tempDir,
          XDG_CACHE_HOME: "",
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_SANDBOX_DIRS_RW: stateDir,
          NODE_COMPILE_CACHE: path.join(stateDir, "compile-cache"),
          OPENCLAW_SANDBOX_DIRS_RO: publishedPackage,
          COMSPEC: path.join(root, "AppContainerLauncher.exe"),
          ComSpec: path.join(root, "AppContainerLauncher.exe"),
          MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR: publishedPackage,
        });
        const result = spawnSync(process.execPath, [script], {
          env,
          windowsHide: true,
          encoding: "utf8",
          timeout: 60_000,
        });
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("spawnSync: OpenClaw SQLite worker -> BYPASS (internal)");
        expect(result.stderr).toContain("execFile: OpenClaw SQLite worker -> BYPASS (internal)");
        expect(result.stderr).toContain("spawn: OpenClaw SQLite worker -> BYPASS (internal)");
        expect(result.stderr).not.toMatch(/permission requested|BLOCKED \(permission\)/i);
        expect(result.stdout).toContain("SQLite sync/async snapshots and cleanup verified");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 70_000);
  },
);
