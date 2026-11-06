import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import * as deviceIdentity from "./device-identity";
import { GatewayClient } from "./gateway-client";
import { installAgentOwnedSkills } from "./agent-owned-skills";
import {
  applyAgentRosterConfig,
  assertAgentRosterHotReloadAvailable,
  waitForAgentRuntimeApplied,
} from "./agent-roster-application";

interface FixtureConfig {
  agents: { entries: Record<string, { skills: string[] }> };
  skills: { entries: Record<string, { enabled: boolean }> };
}

describe.skipIf(
  !process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR || !process.env.MICROCLAW_GATEWAY_E2E_PARENT,
)("isolated pinned Gateway agent catalog", () => {
  it("adds, removes and re-adds agents without restarting, even with skill watching disabled", async () => {
    const packageDir = process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR!;
    const parent = path.resolve(process.env.MICROCLAW_GATEWAY_E2E_PARENT!);
    const root = fs.mkdtempSync(path.join(parent, "agent-hot-reload-"));
    const relative = path.relative(parent, root);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Refusing to remove a fixture outside its parent directory");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    for (const directory of [stateDir, "home", "app-data", "local-app-data", "temp", "workspace"])
      fs.mkdirSync(path.isAbsolute(directory) ? directory : path.join(root, directory), {
        recursive: true,
      });
    const listener = net.createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    const token = randomUUID();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
        agents: {
          ownership: "explicit",
          defaults: { workspace: path.join(root, "workspace"), heartbeat: { every: "0m" } },
          entries: { main: { skills: [] } },
        },
        plugins: { enabled: false },
        skills: {
          allowBundled: [],
          load: { watch: false },
          entries: { "rednote-publisher": { enabled: false } },
        },
      }),
    );
    const keys = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    const publicKey = keys.publicKey.subarray(-32);
    const identity = vi.spyOn(deviceIdentity, "loadOrCreateDeviceIdentity").mockReturnValue({
      deviceId: createHash("sha256").update(publicKey).digest("hex"),
      publicKey: publicKey.toString("base64url"),
      privateKey: keys.privateKey.subarray(-32).toString("base64url"),
    });
    const environment: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|^MICROCLAW_|^OPENCLAW_|^NODE_OPTIONS$|^ELECTRON_/i.test(
            key,
          ),
      ),
    );
    Object.assign(environment, {
      HOME: path.join(root, "home"),
      USERPROFILE: path.join(root, "home"),
      APPDATA: path.join(root, "app-data"),
      LOCALAPPDATA: path.join(root, "local-app-data"),
      TEMP: path.join(root, "temp"),
      TMP: path.join(root, "temp"),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_NO_AUTO_UPDATE: "1",
      OPENCLAW_GATEWAY_HOST_LIFELINE: "stdin",
    });
    const gateway = spawn(
      process.execPath,
      [
        path.join(packageDir, "openclaw.mjs"),
        "gateway",
        "run",
        "--port",
        String(port),
        "--bind",
        "loopback",
        "--allow-unconfigured",
      ],
      { cwd: packageDir, env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let log = "";
    gateway.stdout.on("data", (data) => {
      log += String(data);
    });
    gateway.stderr.on("data", (data) => {
      log += String(data);
    });
    const onDisconnected = vi.fn();
    const onAuthError = vi.fn();
    const client = new GatewayClient({ port, token, onDisconnected, onAuthError });
    try {
      const deadline = Date.now() + 60_000;
      while (true) {
        if (gateway.exitCode !== null) throw new Error(`Fixture Gateway exited: ${log}`);
        try {
          if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
        } catch {}
        if (Date.now() >= deadline) throw new Error(`Fixture Gateway did not start: ${log}`);
        await delay(250);
      }
      client.start();
      await vi.waitFor(() => expect(client.connected).toBe(true), { timeout: 15_000 });
      onDisconnected.mockClear();
      onAuthError.mockClear();
      const generation = client.connectionGeneration;
      const pid = gateway.pid;
      const change = async (agentId: string, mutate: (config: FixtureConfig) => void) => {
        const originalText = fs.readFileSync(configPath, "utf8");
        const config: FixtureConfig = JSON.parse(originalText);
        mutate(config);
        assertAgentRosterHotReloadAvailable(config, client);
        await applyAgentRosterConfig({
          originalText,
          config,
          readText: () => fs.readFileSync(configPath, "utf8"),
          writeText: (text) => {
            fs.writeFileSync(`${configPath}.tmp`, text);
            fs.renameSync(`${configPath}.tmp`, configPath);
          },
          waitForApplied: (expected) =>
            waitForAgentRuntimeApplied({
              gateway: client,
              isCurrent: () => true,
              config: expected,
              agentId,
              stateDir,
              verifyOwnedSkills: expected === config,
            }),
        });
        expect(gateway.pid).toBe(pid);
        expect(gateway.exitCode).toBeNull();
        expect(client.connectionGeneration).toBe(generation);
        expect(onDisconnected).not.toHaveBeenCalled();
        expect(onAuthError).not.toHaveBeenCalled();
      };
      await change("code-geek", (config) => {
        config.agents.entries["code-geek"] = { skills: [] };
      });
      const installs = installAgentOwnedSkills(
        "creative-muse",
        stateDir,
        path.resolve("..", "skills"),
      );
      await change("creative-muse", (config) => {
        config.agents.entries["creative-muse"] = { skills: ["Rednote Publisher"] };
        config.skills.entries["rednote-publisher"].enabled = true;
      });
      await change("creative-muse", (config) => {
        delete config.agents.entries["creative-muse"];
        config.skills.entries["rednote-publisher"].enabled = false;
      });
      expect(fs.existsSync(path.join(installs[0].destination, "SKILL.md"))).toBe(true);
      await change("creative-muse", (config) => {
        config.agents.entries["creative-muse"] = { skills: ["Rednote Publisher"] };
        config.skills.entries["rednote-publisher"].enabled = true;
      });
      await change("code-geek", (config) => {
        delete config.agents.entries["code-geek"];
      });
    } finally {
      client.stop();
      gateway.stdin.end();
      if (gateway.exitCode === null) {
        const exited = once(gateway, "exit");
        const timer = setTimeout(() => gateway.kill(), 15_000);
        await exited;
        clearTimeout(timer);
      }
      identity.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
