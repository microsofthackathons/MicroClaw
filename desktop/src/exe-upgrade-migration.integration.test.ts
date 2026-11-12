import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { GatewayClient } from "./gateway-client";

const fixture = process.env.MICROCLAW_TEST_UPGRADE_FIXTURE;
const targetPayload = process.env.MICROCLAW_TEST_UPGRADE_TARGET_PAYLOAD;

type Installation = {
  target: string;
  desktopRuntimeEntry: string;
  node: string;
  state: string;
  officialUpdateCommands: string[];
};

it.skipIf(!fixture || !targetPayload)(
  "migrates an installed 10.5 EXE payload to 10.10 and preserves history across restart and same-version repair",
  async () => {
    const root = path.resolve(fixture!);
    expect(existsSync(path.join(root, ".microclaw-upgrade-fixture"))).toBe(true);
    const baseline = JSON.parse(
      readFileSync(path.join(root, "installed-2026.10.5.json"), "utf8"),
    ) as Installation;
    const state = baseline.state;
    expect(path.relative(root, state).startsWith("..")).toBe(false);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No isolated Gateway port");
    const port = address.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const token = randomUUID();
    const sessionKey = "agent:main:exe-upgrade-migration";
    const message = "This message was persisted by the installed OpenClaw 2026.10.5.";
    const configPath = path.join(state, "openclaw.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.gateway = {
      ...config.gateway,
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "token", token },
    };
    config.agents ??= {};
    config.agents.defaults ??= {};
    config.agents.defaults.heartbeat = { every: "0m" };
    config.agents.defaults.workspace = path.join(state, "workspace-migration");
    config.skills = { ...config.skills, allowBundled: [] };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const preserved = new Map<string, string>([
      [path.join(config.agents.defaults.workspace, "README.md"), "workspace from MicroClaw 10.5\n"],
      [path.join(state, "media/attachments/migration.txt"), "attachment from MicroClaw 10.5\n"],
      [path.join(state, "models/migration-fixture.gguf"), "existing model cache fixture\n"],
      [
        path.join(state, "credentials/migration-fixture.json"),
        JSON.stringify({ fixture: true, token: "not-a-real-credential" }),
      ],
    ]);
    for (const [file, contents] of preserved) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, contents);
    }
    vi.stubEnv("OPENCLAW_STATE_DIR", state);
    let child: ReturnType<typeof spawn> | undefined;
    let client: GatewayClient | undefined;
    let gatewayLog = "";
    async function stopGateway() {
      client?.stop();
      client = undefined;
      if (child?.pid && child.exitCode === null) {
        const stopped = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
        if (process.platform === "win32")
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
        else child.kill("SIGTERM");
        await Promise.race([stopped, new Promise<void>((resolve) => setTimeout(resolve, 10_000))]);
        if (child.exitCode === null) throw new Error("Fixture Gateway did not stop");
      }
      child = undefined;
    }
    async function startGateway(installation: Installation, resumeFence = false) {
      gatewayLog = "";
      const home = path.join(root, "home");
      const resources = path.join(home, ".microclaw/resources");
      const environment: NodeJS.ProcessEnv = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !/(?:API_KEY|TOKEN|SECRET|PASSWORD|OPENCLAW|MICROCLAW|NODE_OPTIONS|NODE_ENV|VITEST)/i.test(
                key,
              ),
          ),
        ),
        USERPROFILE: home,
        HOME: home,
        APPDATA: path.join(home, "AppData/Roaming"),
        LOCALAPPDATA: path.join(home, "AppData/Local"),
        TEMP: path.join(root, "temp"),
        TMP: path.join(root, "temp"),
        OPENCLAW_HOME: home,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_GATEWAY_TOKEN: token,
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        OPENCLAW_TEST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_DISABLE_BONJOUR: "1",
        MICROCLAW_FS_SAFE_COMPAT: "1",
        MICROCLAW_OPENCLAW_PACKAGE_DIR: path.dirname(installation.desktopRuntimeEntry),
      };
      const imports = [path.join(resources, "openclaw-fs-safe-compat.mjs")];
      if (resumeFence) {
        imports.push(path.join(resources, "openclaw-approval-replay-compat.mjs"));
        Object.assign(environment, {
          MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT: "1",
          MICROCLAW_MXC_CANVAS_PHASE1: "1",
          MICROCLAW_OPENCLAW_PACKAGE_DIR: path.dirname(installation.desktopRuntimeEntry),
          MICROCLAW_MXC_APPROVAL_PROOF_SECRET: randomBytes(32).toString("base64"),
          MICROCLAW_MXC_APPROVAL_PROOF_GATEWAY_GENERATION: randomUUID(),
          MICROCLAW_MXC_APPROVAL_PROOF_POLICY_FINGERPRINT: "a".repeat(64),
          MICROCLAW_MXC_APPROVAL_PROOF_NODE_ID: "b".repeat(64),
          MICROCLAW_MXC_CRON_RESUME_FENCE_UNIX_MS: String(Date.now() - 1),
          MICROCLAW_MXC_CRON_RESUME_ACK_PATH: path.join(root, "cron-resume-ack.json"),
          MICROCLAW_MXC_CRON_RESUME_ACK_TOKEN: "migration-fixture-ack",
        });
      }
      child = spawn(
        installation.node,
        [
          ...imports.flatMap((file) => ["--import", pathToFileURL(file).href]),
          installation.desktopRuntimeEntry,
          "gateway",
          "run",
          "--port",
          String(port),
          "--bind",
          "loopback",
        ],
        { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      child.stdout?.on("data", (value) => {
        gatewayLog = (gatewayLog + value.toString()).slice(-40_000);
        writeFileSync(path.join(root, `gateway-${installation.target}.log`), gatewayLog);
      });
      child.stderr?.on("data", (value) => {
        gatewayLog = (gatewayLog + value.toString()).slice(-40_000);
        writeFileSync(path.join(root, `gateway-${installation.target}.log`), gatewayLog);
      });
      client = new GatewayClient({ port, token });
      client.start();
      try {
        const deadline = Date.now() + 600_000;
        while (!client.connected) {
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(`Gateway exited: ${gatewayLog}`);
          if (Date.now() > deadline) throw new Error("Gateway connection deadline exceeded");
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
        }
      } catch (error) {
        throw new Error(`Gateway ${installation.target} failed: ${gatewayLog}`, { cause: error });
      }
      expect(client.serverVersion).toMatch(
        new RegExp(`^${installation.target.replaceAll(".", "\\.")}(?:\\+|$)`),
      );
    }
    async function runTargetInstaller(extraArguments: string[] = []) {
      const repository = path.resolve(__dirname, "../..");
      const python =
        process.env.MICROCLAW_TEST_PYTHON || path.join(repository, ".venv/Scripts/python.exe");
      const output = await new Promise<string>((resolve, reject) => {
        const installer = spawn(
          python,
          [
            path.join(repository, "scripts/verify_exe_upgrade_stage.py"),
            "--payload",
            path.resolve(targetPayload!),
            "--fixture",
            root,
            "--version",
            "2026.10.10",
            "--port",
            String(port),
            "--node",
            process.execPath,
            ...extraArguments,
          ],
          {
            cwd: repository,
            env: process.env,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let log = "";
        installer.stdout.on("data", (value) => {
          log += value.toString();
        });
        installer.stderr.on("data", (value) => {
          log += value.toString();
        });
        installer.once("error", reject);
        installer.once("exit", (code) => (code === 0 ? resolve(log) : reject(new Error(log))));
      });
      writeFileSync(path.join(root, `install-target-${Date.now()}.log`), output);
      return output;
    }
    async function installTarget() {
      await runTargetInstaller();
      return JSON.parse(
        readFileSync(path.join(root, "installed-2026.10.10.json"), "utf8"),
      ) as Installation;
    }
    async function assertHistory() {
      const history = await client!.request("chat.history", { sessionKey, limit: 20 });
      expect(JSON.stringify(history)).toContain(message);
      const sessions = await client!.request("sessions.list", { limit: 100 });
      expect(JSON.stringify(sessions)).toContain(sessionKey);
      for (const [file, contents] of preserved) expect(readFileSync(file, "utf8")).toBe(contents);
      const snapshot = (await client!.request("config.get", {})) as {
        config: typeof config;
      };
      expect(snapshot.config.agents.defaults.workspace).toBe(config.agents.defaults.workspace);
      expect(snapshot.config.agents.defaults.heartbeat.every).toBe("0m");
      expect(snapshot.config.skills.entries["security-practice"].enabled).toBe(false);
      const jobs = await client!.request("cron.list", { includeDisabled: true });
      expect(JSON.stringify(jobs)).toContain("EXE migration disabled reminder");
      expect(JSON.stringify(jobs)).toContain(
        "Preserve this disabled reminder without executing it.",
      );
    }
    try {
      await startGateway(baseline);
      await client!.request("sessions.patch", { key: sessionKey, label: "EXE upgrade migration" });
      await client!.request("chat.inject", { sessionKey, message, label: "10.5 fixture" });
      await client!.request("cron.add", {
        name: "EXE migration disabled reminder",
        enabled: false,
        schedule: { kind: "every", everyMs: 86_400_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "systemEvent",
          text: "Preserve this disabled reminder without executing it.",
        },
      });
      await assertHistory();
      await stopGateway();
      await runTargetInstaller(["--inject-validation-failure"]);
      const injected = JSON.parse(
        readFileSync(path.join(root, "validation-failure-injection.json"), "utf8"),
      );
      expect(injected.injectedValidationFailure).toBe(true);
      expect(injected.officialUpdateCommands).toEqual(["backup", "npm"]);
      const recordPath = path.join(root, "home/.microclaw/upgrade/openclaw-package-upgrade.json");
      const failed = JSON.parse(readFileSync(recordPath, "utf8"));
      expect(failed.phase).toBe("verifying");
      expect(failed.packageReady).toBe(true);
      const upgraded = await installTarget();
      expect(upgraded.officialUpdateCommands).toEqual([]);
      const record = JSON.parse(readFileSync(recordPath, "utf8"));
      expect(record.archiveSha256).toBe(failed.archiveSha256);
      expect(record.sourceVersion).toBe("2026.10.5");
      expect(record.targetVersion).toBe("2026.10.10");
      expect(record.phase).toBe("complete");
      expect(record.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
      const backup = path.join(
        root,
        "home/.microclaw/backups/openclaw-package",
        record.id,
        "state.tar.gz",
      );
      expect(createHash("sha256").update(readFileSync(backup)).digest("hex")).toBe(
        record.archiveSha256,
      );
      await startGateway(upgraded, true);
      await assertHistory();
      await client!.request("chat.inject", {
        sessionKey,
        message: "New write after migration.",
        label: "10.10 fixture",
      });
      await vi.waitFor(
        () => expect(existsSync(path.join(root, "cron-resume-ack.json"))).toBe(true),
        { timeout: 30_000 },
      );
      await stopGateway();
      await startGateway(upgraded);
      await assertHistory();
      expect(
        JSON.stringify(await client!.request("chat.history", { sessionKey, limit: 20 })),
      ).toContain("New write after migration.");
      await stopGateway();
      await installTarget();
      await startGateway(upgraded);
      await assertHistory();
      expect(
        JSON.stringify(await client!.request("chat.history", { sessionKey, limit: 20 })),
      ).toContain("New write after migration.");
      expect(JSON.parse(readFileSync(recordPath, "utf8")).archiveSha256).toBe(record.archiveSha256);
      const report = {
        source: "2026.10.5",
        target: "2026.10.10",
        gatewayVersion: client!.serverVersion,
        historyPreserved: true,
        configurationPreserved: true,
        cronPreserved: true,
        versionValidationFailureRecovery: true,
        automaticDoctorSkipped: true,
        postMigrationWrite: true,
        restart: true,
        sameVersionRepair: true,
        preservedFileHashes: [...preserved.keys()].map((file) => ({
          file,
          sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
        })),
        backupSha256: record.archiveSha256,
        scope:
          "real EXE payload modules, npm without Doctor, installed desktop runtime; host registry/Defender/UI steps excluded",
      };
      writeFileSync(path.join(root, "migration-result.json"), JSON.stringify(report, null, 2));
    } finally {
      writeFileSync(path.join(root, "last-gateway.log"), gatewayLog);
      await stopGateway();
      vi.unstubAllEnvs();
    }
  },
  1_800_000,
);
