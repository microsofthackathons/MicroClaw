import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
const compatibility = createRequire(__filename)("./openclaw-state-owner-compat.mjs");

const {
  isWindowsPidDefinitelyAbsent,
  readWindowsProcessIds,
  patchPinnedWindowsPidSource,
  validatePinnedWindowsPidPackage,
  PINNED_PID_MODULE,
  patchPinnedWindowsNativePluginSource,
  validatePinnedWindowsNativePluginPackage,
  PINNED_NATIVE_PLUGIN_MODULE,
} = compatibility;
const roots: string[] = [];
const publishedPackage = process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR;
const preload = pathToFileURL(resolve(__dirname, "openclaw-state-owner-compat.mjs")).href;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Windows state owner compatibility", () => {
  it("opens only the new native snapshot before recording identities without weakening admission", () => {
    const copied =
      "\t\t\t\tcopyPluginSourceFile(member.source, member.boundary, target);\n" +
      "\t\t\t\tfs.chmodSync(target, 384 | Number(member.stat.mode & 64n));";
    const strictCheck =
      'if (content.sizeBytes !== member.sizeBytes || pluginSourceStatIdentity(fs.statSync(filename, { bigint: true })) !== member.capturedIdentity) throw new Error("Native plugin companion changed before admission completed");';
    const original = copied + "\nconst captured = inspectDirectory(directory);\n" + strictCheck;
    const patched = patchPinnedWindowsNativePluginSource(original);
    expect(patched).toBe(
      copied +
        "\n\t\t\t\twithPluginSourceFile(target, capturedRoot, () => {});\n" +
        "const captured = inspectDirectory(directory);\n" +
        strictCheck,
    );
    expect(() => patchPinnedWindowsNativePluginSource("")).toThrow(/exactly once/);
    expect(() => patchPinnedWindowsNativePluginSource(original + copied)).toThrow(/exactly once/);
  });

  it("pins the native admission module and does not apply to other OpenClaw versions", () => {
    const root = mkdtempSync(join(tmpdir(), "microclaw-native-package-"));
    roots.push(root);
    mkdirSync(join(root, "dist"));
    const metadata = join(root, "package.json");
    writeFileSync(metadata, JSON.stringify({ name: "openclaw", version: "2026.10.3" }));
    writeFileSync(join(root, "dist", PINNED_NATIVE_PLUGIN_MODULE), "changed source");
    expect(() => validatePinnedWindowsNativePluginPackage(root)).toThrow(/pinned source/);
    writeFileSync(metadata, JSON.stringify({ name: "openclaw", version: "2026.9.3" }));
    expect(validatePinnedWindowsNativePluginPackage(root)).toBeNull();
    writeFileSync(metadata, JSON.stringify({ name: "other-package", version: "2026.10.3" }));
    expect(() => validatePinnedWindowsNativePluginPackage(root)).toThrow(/package identity/);
    expect(() => validatePinnedWindowsNativePluginPackage("relative")).toThrow(/absolute/);
  });

  it("requires a complete native snapshot proving that the owner is absent", () => {
    expect(isWindowsPidDefinitelyAbsent(13088, () => [0, 4, process.pid])).toBe(true);
    expect(isWindowsPidDefinitelyAbsent(13088, () => [4, 13088])).toBe(false);
    expect(isWindowsPidDefinitelyAbsent(13088, () => [])).toBe(false);
    expect(isWindowsPidDefinitelyAbsent(13088, () => [0, 4])).toBe(false);
    expect(isWindowsPidDefinitelyAbsent(13088, () => null)).toBe(false);
    expect(
      isWindowsPidDefinitelyAbsent(13088, () => {
        throw new Error("denied");
      }),
    ).toBe(false);
    for (const invalid of [0, -1, 1.5, NaN, Infinity, 4294967296, true, "13088"]) {
      expect(isWindowsPidDefinitelyAbsent(invalid, () => [])).toBe(false);
    }
  });

  it("grows a truncated process snapshot before deciding", () => {
    const capacities: number[] = [];
    const ids = readWindowsProcessIds((buffer: Buffer, capacity: number, count: Buffer) => {
      capacities.push(capacity);
      if (capacity === 4096) count.writeUInt32LE(capacity);
      else {
        buffer.writeUInt32LE(4, 0);
        buffer.writeUInt32LE(13088, 4);
        count.writeUInt32LE(8);
      }
      return 1;
    });
    expect(capacities).toEqual([4096, 8192]);
    expect(ids).toEqual([4, 13088]);
  });

  it("fails closed for failed, malformed, and unbounded snapshots", () => {
    expect(readWindowsProcessIds(() => 0)).toBeNull();
    for (const length of [3, 4097]) {
      expect(
        readWindowsProcessIds((_buffer: Buffer, _capacity: number, count: Buffer) => {
          count.writeUInt32LE(length);
          return 1;
        }),
      ).toBeNull();
    }
    const capacities: number[] = [];
    expect(
      readWindowsProcessIds((_buffer: Buffer, capacity: number, count: Buffer) => {
        capacities.push(capacity);
        count.writeUInt32LE(capacity);
        return 1;
      }),
    ).toBeNull();
    expect(capacities).toHaveLength(7);
    expect(capacities.at(-1)).toBe(262144);
  });

  it("patches both pinned owner decisions together or rejects the source", () => {
    const live =
      'function isPidAlive(pid) { try { process.kill(pid, 0); } catch (err) { if (err.code !== "EPERM") return false; } return true; }';
    const dead =
      'function isPidDefinitelyDead(pid) { try { process.kill(pid, 0); } catch (err) { return err.code === "ESRCH"; } return false; }';
    const source = live + "\n" + dead;
    const patched = patchPinnedWindowsPidSource(source);
    expect(patched).toContain(
      'if (err.code !== "EPERM" || microclawIsWindowsPidDefinitelyAbsent(pid)) return false;',
    );
    expect(patched).toContain(
      'err.code === "ESRCH" || (err.code === "EPERM" && microclawIsWindowsPidDefinitelyAbsent(pid))',
    );
    expect(() => patchPinnedWindowsPidSource("unrecognized")).toThrow(/exactly once/);
    expect(() => patchPinnedWindowsPidSource(live)).toThrow(/exactly once/);
    expect(() => patchPinnedWindowsPidSource(dead)).toThrow(/exactly once/);
    expect(() => patchPinnedWindowsPidSource(source + live)).toThrow(/exactly once/);
    expect(() => patchPinnedWindowsPidSource(source + dead)).toThrow(/exactly once/);
    expect(() => patchPinnedWindowsPidSource(source + source)).toThrow(/exactly once/);
  });

  it("rejects changed pinned source and skips other official runtime versions", () => {
    const root = mkdtempSync(join(tmpdir(), "microclaw-owner-package-"));
    roots.push(root);
    mkdirSync(join(root, "dist"));
    const metadata = join(root, "package.json");
    writeFileSync(metadata, JSON.stringify({ name: "openclaw", version: "2026.10.3" }));
    writeFileSync(join(root, "dist", PINNED_PID_MODULE), 'return err.code === "ESRCH";');
    expect(() => validatePinnedWindowsPidPackage(root)).toThrow(/pinned source/);
    writeFileSync(metadata, JSON.stringify({ name: "other", version: "2026.10.3" }));
    expect(() => validatePinnedWindowsPidPackage(root)).toThrow(/identity/);
    for (const version of ["2026.10.2", "2026.10.4"]) {
      writeFileSync(metadata, JSON.stringify({ name: "openclaw", version }));
      expect(validatePinnedWindowsPidPackage(root)).toBeNull();
    }
    expect(() => validatePinnedWindowsPidPackage("relative")).toThrow(/absolute/);
  });
});

describe.skipIf(!publishedPackage || process.platform !== "win32")(
  "official OpenClaw Windows state owner integration",
  () => {
    it("loads the pinned native snapshot fix and still rejects edits after admission starts", () => {
      const home = mkdtempSync(join(tmpdir(), "microclaw-native-snapshot-"));
      roots.push(home);
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/OPENCLAW|NODE_OPTIONS|MICROCLAW/i.test(key),
        ),
      );
      Object.assign(env, {
        HOME: home,
        USERPROFILE: home,
        OPENCLAW_STATE_DIR: join(home, ".openclaw"),
        MICROCLAW_OPENCLAW_PACKAGE_DIR: publishedPackage,
        MICROCLAW_WINDOWS_STATE_OWNER_COMPAT: "1",
        MICROCLAW_SNAPSHOT_TEST_ROOT: home,
      });
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          preload,
          "--input-type=module",
          "-e",
          `
          import assert from "node:assert/strict";
          import fs from "node:fs";
          import path from "node:path";
          import { registerHooks } from "node:module";
          import { pathToFileURL } from "node:url";
          const filename = path.join(process.env.MICROCLAW_OPENCLAW_PACKAGE_DIR, "dist", ${JSON.stringify(PINNED_NATIVE_PLUGIN_MODULE)});
          const moduleUrl = pathToFileURL(filename).href;
          registerHooks({ load(url, context, nextLoad) {
            const result = nextLoad(url, context);
            return url === moduleUrl ? { ...result, source: result.source + "\\nexport { capturePluginNativeNamespace, finishPluginNativeNamespace };" } : result;
          }});
          const native = await import(moduleUrl);
          for (const mutation of ["none", "append", "replace", "hardlink"]) {
            const root = path.join(process.env.MICROCLAW_SNAPSHOT_TEST_ROOT, mutation);
            const sourceDirectory = path.join(root, "source");
            const capturedRoot = path.join(root, "snapshot");
            fs.mkdirSync(sourceDirectory, { recursive: true });
            fs.mkdirSync(capturedRoot);
            fs.writeFileSync(path.join(sourceDirectory, "package.json"), JSON.stringify({ name: "snapshot-fixture", version: "1.0.0" }));
            fs.writeFileSync(path.join(sourceDirectory, "fixture.node"), "MZ fixture, never executed");
            const { fact } = native.capturePluginNativeNamespace({ sourceDirectory, boundary: sourceDirectory, capturedRoot, managed: true });
            const captured = path.join(capturedRoot, "content", "package.json");
            if (mutation !== "none") {
              if (mutation === "append") fs.appendFileSync(captured, "changed");
              if (mutation === "replace") {
                const bytes = fs.readFileSync(captured);
                fs.renameSync(captured, path.join(root, "original.json"));
                fs.writeFileSync(captured, bytes);
              }
              if (mutation === "hardlink") {
                fs.linkSync(captured, path.join(root, "second.json"));
                const stat = fs.statSync(captured, { bigint: true });
                const current = [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
                const expected = fact.members["package.json"].capturedIdentity;
                assert.equal(current.slice(0, current.lastIndexOf(":")), expected.slice(0, expected.lastIndexOf(":")));
                assert.notEqual(current, expected);
              }
              assert.throws(() => native.finishPluginNativeNamespace(fact), /Native plugin companion changed before admission completed/);
            } else {
              native.finishPluginNativeNamespace(fact);
              assert.match(fact.members["package.json"].contentHash, /^[a-f0-9]{64}$/);
            }
          }
          process.stdout.write(JSON.stringify({ snapshotVerified: true, tamperingRejected: true }));
          `,
        ],
        { env, cwd: home, encoding: "utf8", timeout: 60000, windowsHide: true },
      );
      expect(result.status, result.stderr || result.error?.message).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        snapshotVerified: true,
        tamperingRejected: true,
      });
    });

    it("completes the real Doctor CLI after recovering both dead owner records without a reboot", async () => {
      const home = mkdtempSync(join(tmpdir(), "microclaw-doctor-cli-"));
      roots.push(home);
      const stateDir = join(home, ".openclaw");
      const tempDir = join(home, "AppData", "Local", "Temp");
      mkdirSync(stateDir);
      mkdirSync(tempDir, { recursive: true });
      const listener = createServer();
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      const configPath = join(stateDir, "openclaw.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          gateway: {
            mode: "local",
            bind: "loopback",
            port: address.port,
            auth: { mode: "token", token: randomUUID() },
          },
          agents: { defaults: { workspace: join(stateDir, "workspace") } },
          plugins: { allow: [] },
          skills: { allowBundled: [] },
          logging: { file: join(tempDir, "doctor.log") },
        }),
      );
      const deniedPidPreload = join(home, "denied-pid.mjs");
      writeFileSync(
        deniedPidPreload,
        `
        const originalKill = process.kill;
        process.kill = (pid, signal) => {
          if (pid === 4294967295 && signal === 0) {
            throw Object.assign(new Error("Access denied"), { code: "EPERM" });
          }
          return originalKill(pid, signal);
        };
      `,
      );
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !/(?:API_KEY|TOKEN|SECRET|PASSWORD|OPENCLAW|NODE_OPTIONS|MICROCLAW)/i.test(key),
        ),
      );
      Object.assign(env, {
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, "AppData", "Roaming"),
        LOCALAPPDATA: join(home, "AppData", "Local"),
        TEMP: tempDir,
        TMP: tempDir,
        XDG_CACHE_HOME: join(home, "cache"),
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_DISABLE_BONJOUR: "1",
        OPENCLAW_SUPERVISOR_MODE: "external",
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        NODE_COMPILE_CACHE: join(home, "compile-cache"),
        MICROCLAW_OPENCLAW_PACKAGE_DIR: publishedPackage,
      });
      const seed = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import fs from "node:fs";
        import path from "node:path";
        import { pathToFileURL } from "node:url";
        const packageDir = process.env.MICROCLAW_OPENCLAW_PACKAGE_DIR;
        const owner = await import(pathToFileURL(path.join(packageDir, "dist", "gateway-state-owner-C3Vdziw8.mjs")));
        const gateway = await import(pathToFileURL(path.join(packageDir, "dist", "gateway-lock-B9T5eGBw.mjs")));
        const paths = gateway.u(process.env);
        for (const recordPath of [paths.ownerLockPath, paths.stateLockPath, paths.configLockPath]) {
          fs.mkdirSync(path.dirname(recordPath), { recursive: true });
          fs.writeFileSync(recordPath, JSON.stringify({
            pid: 4294967295, ownerId: "dead-doctor-fixture", role: "gateway",
            createdAt: "2026-10-14T13:48:35.242Z", configPath: paths.configPath,
            stateDir: paths.stateDir, processNamespace: owner.S(), port: ${address.port}
          }));
        }
      `,
        ],
        { env, cwd: home, encoding: "utf8", timeout: 60000, windowsHide: true },
      );
      expect(seed.status, seed.stderr || seed.error?.message).toBe(0);
      for (const enabled of [false, true]) {
        Object.assign(env, {
          MICROCLAW_WINDOWS_STATE_OWNER_COMPAT: enabled ? "1" : "0",
          NODE_OPTIONS:
            `--import "${pathToFileURL(deniedPidPreload).href}"` +
            (enabled ? ` --import "${preload}"` : ""),
        });
        const result = spawnSync(
          process.execPath,
          [join(publishedPackage!, "openclaw.mjs"), "doctor", "--fix", "--non-interactive"],
          { env, cwd: home, encoding: "utf8", timeout: 180000, windowsHide: true },
        );
        const output = result.stdout + result.stderr;
        if (enabled) {
          expect(result.status, output || result.error?.message).toBe(0);
          expect(output).toContain("Doctor complete.");
          expect(output).not.toContain("Doctor could not enter maintenance");
        } else {
          expect(result.status).not.toBe(0);
          expect(output).toContain("GatewayStateOwnerContentionError");
        }
      }
    }, 300000);

    it("admits Doctor maintenance past dead canonical and historical owners without admitting live owners", () => {
      const root = mkdtempSync(join(tmpdir(), "microclaw-maintenance-owner-"));
      roots.push(root);
      const script = `
        import fs from "node:fs";
        import path from "node:path";
        import { pathToFileURL } from "node:url";
        const originalKill = process.kill;
        process.kill = (pid, signal) => {
          if (signal === 0 && (pid === 4294967295 || pid === process.pid)) {
            throw Object.assign(new Error("Access denied"), { code: "EPERM" });
          }
          return originalKill(pid, signal);
        };
        const packageDir = process.env.MICROCLAW_OPENCLAW_PACKAGE_DIR;
        const owner = await import(pathToFileURL(path.join(packageDir, "dist", "gateway-state-owner-C3Vdziw8.mjs")));
        const gateway = await import(pathToFileURL(path.join(packageDir, "dist", "gateway-lock-B9T5eGBw.mjs")));
        const pid = await import(pathToFileURL(path.join(packageDir, "dist", "${PINNED_PID_MODULE}")));
        const paths = gateway.u(process.env);
        const legacyPaths = [paths.stateLockPath, paths.configLockPath];
        const recordPaths = process.env.TEST_CANONICAL_OWNER === "1"
          ? [paths.ownerLockPath, ...legacyPaths] : legacyPaths;
        const payload = {
          pid: 4294967295, ownerId: "historical-dead-owner",
          createdAt: "2026-10-14T13:48:35.242Z", stateDir: paths.stateDir,
          configPath: paths.configPath, role: "gateway", port: 18789,
          processNamespace: owner.S()
        };
        for (const recordPath of recordPaths) {
          fs.mkdirSync(path.dirname(recordPath), { recursive: true });
          fs.writeFileSync(recordPath, JSON.stringify(payload));
        }
        const options = {
          env: process.env, role: "sqlite-maintenance", allowInTests: true,
          readProcessStartTime: () => null, readProcessCmdline: () => null
        };
        let admitted = false;
        let error;
        try {
          const lease = await gateway.r(options);
          lease.assertCurrent();
          admitted = true;
          await lease.release();
        } catch (failure) { error = String(failure.cause ?? failure); }
        for (const recordPath of [paths.ownerLockPath, ...legacyPaths]) {
          fs.rmSync(recordPath, { force: true });
        }
        const protectedPayload = JSON.stringify({ ...payload, pid: process.pid, ownerId: "live-protected-owner" });
        for (const recordPath of legacyPaths) fs.writeFileSync(recordPath, protectedPayload);
        let liveBlocked = false;
        try { await (await gateway.r(options)).release(); } catch { liveBlocked = true; }
        console.log(JSON.stringify({ admitted, error, liveBlocked,
          absentAlive: pid.a(4294967295), liveAlive: pid.a(process.pid),
          liveDead: pid.o(process.pid),
          preserved: legacyPaths.every(recordPath => fs.readFileSync(recordPath, "utf8") === protectedPayload)
        }));
      `;
      for (const canonical of [false, true]) {
        for (const enabled of [false, true]) {
          const home = join(root, `${canonical}-${enabled}`);
          mkdirSync(home);
          const env = Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) =>
                !/(?:API_KEY|TOKEN|SECRET|PASSWORD|OPENCLAW|NODE_OPTIONS|MICROCLAW)/i.test(key),
            ),
          );
          Object.assign(env, {
            USERPROFILE: home,
            HOME: home,
            LOCALAPPDATA: join(home, "AppData", "Local"),
            OPENCLAW_STATE_DIR: join(home, ".openclaw"),
            NODE_COMPILE_CACHE: join(home, "compile-cache"),
            MICROCLAW_OPENCLAW_PACKAGE_DIR: publishedPackage,
            MICROCLAW_WINDOWS_STATE_OWNER_COMPAT: enabled ? "1" : "0",
            TEST_CANONICAL_OWNER: canonical ? "1" : "0",
          });
          const result = spawnSync(
            process.execPath,
            [...(enabled ? ["--import", preload] : []), "--input-type=module", "-e", script],
            { env, encoding: "utf8", timeout: 60000, windowsHide: true },
          );
          expect(result.status, result.stderr || result.error?.message).toBe(0);
          const facts = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
          expect(facts, JSON.stringify({ canonical, enabled, facts })).toMatchObject({
            admitted: enabled,
            absentAlive: !enabled,
            liveBlocked: true,
            liveAlive: true,
            liveDead: false,
            preserved: true,
          });
        }
      }
    }, 180000);

    it("reclaims only kernel-confirmed dead owners through the official lease protocol", () => {
      const root = mkdtempSync(join(tmpdir(), "microclaw-owner-integration-"));
      roots.push(root);
      const script = `
        import fs from "node:fs";
        import path from "node:path";
        import { pathToFileURL } from "node:url";
        const kill = process.kill;
        process.kill = (pid, signal) => {
          if (signal === 0 && (pid === 4294967295 || pid === process.pid)) {
            throw Object.assign(new Error("Access denied"), { code: "EPERM" });
          }
          return kill(pid, signal);
        };
        const packageDir = process.env.MICROCLAW_OPENCLAW_PACKAGE_DIR;
        const owner = await import(pathToFileURL(path.join(packageDir, "dist", "gateway-state-owner-C3Vdziw8.mjs")));
        const pid = await import(pathToFileURL(path.join(packageDir, "dist", "${PINNED_PID_MODULE}")));
        const stateDir = path.join(process.env.USERPROFILE, ".openclaw");
        const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        const lockPath = owner.u(databasePath);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        const payload = {
          pid: 4294967295, ownerId: "old-dead-owner", createdAt: "2026-10-14T13:48:35.242Z",
          stateDir, configPath: path.join(stateDir, "openclaw.json"), role: "gateway",
          startTime: 1791985683134, processNamespace: owner.S()
        };
        fs.writeFileSync(lockPath, JSON.stringify(payload));
        let reclaimed = false;
        let error;
        try {
          const lease = owner.n({ databasePath });
          lease.assertCurrent();
          lease.release();
          reclaimed = true;
        } catch (failure) { error = failure.name; }
        const deadSnapshot = pid.o(4294967295);
        fs.writeFileSync(lockPath, JSON.stringify({ ...payload, pid: process.pid, startTime: pid.n(process.pid) }));
        const before = fs.readFileSync(lockPath, "utf8");
        let liveBlocked = false;
        try { owner.n({ databasePath }).release(); } catch { liveBlocked = true; }
        console.log(JSON.stringify({ reclaimed, error, deadSnapshot, liveBlocked,
          liveDefinitelyDead: pid.o(process.pid), preserved: before === fs.readFileSync(lockPath, "utf8") }));
      `;
      for (const enabled of [false, true]) {
        const home = join(root, enabled ? "patched" : "unpatched");
        mkdirSync(home);
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !/(?:API_KEY|TOKEN|SECRET|PASSWORD|OPENCLAW|NODE_OPTIONS|MICROCLAW)/i.test(key),
          ),
        );
        Object.assign(env, {
          USERPROFILE: home,
          HOME: home,
          LOCALAPPDATA: join(home, "AppData", "Local"),
          OPENCLAW_STATE_DIR: join(home, ".openclaw"),
          MICROCLAW_OPENCLAW_PACKAGE_DIR: publishedPackage,
          MICROCLAW_WINDOWS_STATE_OWNER_COMPAT: enabled ? "1" : "0",
        });
        const result = spawnSync(
          process.execPath,
          [...(enabled ? ["--import", preload] : []), "--input-type=module", "-e", script],
          { env, encoding: "utf8", timeout: 60000, windowsHide: true },
        );
        expect(result.status, result.stderr || result.error?.message).toBe(0);
        const facts = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
        expect(facts).toMatchObject({
          reclaimed: enabled,
          deadSnapshot: enabled,
          liveBlocked: true,
          liveDefinitelyDead: false,
          preserved: true,
        });
      }
    }, 150000);
  },
);
