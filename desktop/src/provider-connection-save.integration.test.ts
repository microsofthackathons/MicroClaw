import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import { createServer } from "node:http";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import * as deviceIdentity from "./device-identity";
import { GatewayClient } from "./gateway-client";
import { applyModelConfig } from "./model-config-application";
import { removeProviderConnectionConfig } from "./provider-connection-config";

describe.skipIf(
  !process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR || !process.env.MICROCLAW_GATEWAY_E2E_PARENT,
)("isolated provider connection saves", () => {
  it.each(["config.apply", "config.set"])(
    "compares first connection via %s and repeat saves",
    async (firstSaveMethod) => {
      const packageDir = process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR!;
      const parent = path.resolve(process.env.MICROCLAW_GATEWAY_E2E_PARENT!);
      const root = fs.mkdtempSync(path.join(parent, "provider-save-"));
      const relative = path.relative(parent, root);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("Fixture must stay inside its designated parent");
      for (const directory of ["state", "home", "app-data", "local-app-data", "temp", "workspace"])
        fs.mkdirSync(path.join(root, directory));
      const configPath = path.join(root, "state", "openclaw.json");
      const endpoint = createServer((_request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "MiniMax-M3" }] }));
      });
      endpoint.listen(0, "127.0.0.1");
      await once(endpoint, "listening");
      const apiAddress = endpoint.address();
      if (!apiAddress || typeof apiAddress === "string") throw new Error("Missing API port");
      const listener = net.createServer();
      listener.listen(0, "127.0.0.1");
      await once(listener, "listening");
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("Missing Gateway port");
      const port = address.port;
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      const token = randomUUID();
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
          logging: { file: path.join(root, "gateway.log") },
          agents: {
            ownership: "explicit",
            entries: { main: { skills: [] } },
            defaults: { workspace: path.join(root, "workspace"), heartbeat: { every: "0m" } },
          },
          models: {
            mode: "merge",
            providers: {},
          },
          plugins: { allow: ["minimax"], entries: {} },
          skills: { allowBundled: [], load: { watch: false } },
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
      const env: NodeJS.ProcessEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !/TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|^MICROCLAW_|^OPENCLAW_|^NODE_OPTIONS$|^ELECTRON_/i.test(
              key,
            ),
        ),
      );
      Object.assign(env, {
        HOME: path.join(root, "home"),
        USERPROFILE: path.join(root, "home"),
        APPDATA: path.join(root, "app-data"),
        LOCALAPPDATA: path.join(root, "local-app-data"),
        TEMP: path.join(root, "temp"),
        TMP: path.join(root, "temp"),
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_NO_AUTO_UPDATE: "1",
        OPENCLAW_DISABLE_BONJOUR: "1",
        OPENCLAW_GATEWAY_HOST_LIFELINE: "stdin",
      });
      const child = spawn(
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
        { cwd: packageDir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      let output = "";
      const capture = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8000);
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      const client = new GatewayClient({ port, token });
      const samples: Array<{
        method: string;
        elapsedMs: number;
        rpcMs: number;
        polls: number;
        warmup: boolean;
      }> = [];
      try {
        const deadline = Date.now() + 90_000;
        while (true) {
          if (child.exitCode !== null) throw new Error(output.replaceAll(token, "[fixture-token]"));
          try {
            if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
          } catch {}
          if (Date.now() >= deadline) throw new Error("Isolated Gateway startup timed out");
          await delay(250);
        }
        client.start();
        await vi.waitFor(() => expect(client.connected).toBe(true), { timeout: 20_000 });
        expect(client.serverVersion).toBe("2026.10.10");
        expect(client.methods).toContain("config.set");
        const generation = client.connectionGeneration;
        type FixtureConfig = {
          models: {
            providers: Record<
              string,
              { api: string; baseUrl: string; apiKey: string; models: unknown[] }
            >;
          };
          agents: unknown;
        };
        const readConfig = (): FixtureConfig => JSON.parse(fs.readFileSync(configPath, "utf8"));
        const measure = async (
          method: string,
          action: "provider-save" | "provider-remove",
          before: FixtureConfig,
          next: FixtureConfig,
        ) => {
          let rpcMs = 0;
          let polls = 0;
          const gateway = {
            get connected() {
              return client.connected;
            },
            get serverVersion() {
              return client.serverVersion;
            },
            get connectionGeneration() {
              return client.connectionGeneration;
            },
            methods:
              method === "config.set"
                ? client.methods
                : client.methods.filter((entry) => entry !== "config.set"),
            request: async (rpc: string, params?: Record<string, unknown>, timeoutMs?: number) => {
              if (rpc === "config.get") polls++;
              const started = performance.now();
              try {
                return await client.request(rpc, params, timeoutMs);
              } finally {
                if (rpc === method) rpcMs += performance.now() - started;
              }
            },
          };
          const started = performance.now();
          await applyModelConfig(
            { gateway: () => gateway, readConfig, assertMutable: () => {}, log: () => {} },
            {
              config: next,
              expectedConfig: before,
              action,
              providerKey: "minimax",
            },
          );
          const sample = {
            method,
            elapsedMs: Math.round(performance.now() - started),
            rpcMs: Math.round(rpcMs),
            polls,
          };
          expect(rpcMs).toBeGreaterThan(0);
          const confirmed = await client.request<{
            valid: boolean;
            configRevisionHash: string;
            appliedConfigHash: string;
          }>("config.get", {});
          expect(confirmed.valid).toBe(true);
          expect(confirmed.appliedConfigHash).toBe(confirmed.configRevisionHash);
          const saved = readConfig();
          expect(Object.hasOwn(saved.models.providers, "minimax")).toBe(
            Object.hasOwn(next.models.providers, "minimax"),
          );
          expect(saved.models.providers.minimax?.apiKey).toBe(
            next.models.providers.minimax?.apiKey,
          );
          expect(readConfig().agents).toEqual(next.agents);
          expect(client.connectionGeneration).toBe(generation);
          expect(child.exitCode).toBeNull();
          return sample;
        };
        const order = [
          firstSaveMethod,
          firstSaveMethod === "config.apply" ? "config.set" : "config.apply",
          "config.set",
          "config.apply",
          "config.apply",
          "config.set",
        ];
        for (const [index, method] of order.entries()) {
          const before = readConfig();
          const next = structuredClone(before);
          next.models.providers.minimax ??= {
            api: "openai-completions",
            baseUrl: `http://127.0.0.1:${apiAddress.port}/v1`,
            apiKey: "fixture-initial",
            models: [],
          };
          next.models.providers.minimax.apiKey = `fixture-${index}`;
          samples.push({
            ...(await measure(method, "provider-save", before, next)),
            warmup: index < 2,
          });
        }
        const removals: typeof samples = [];
        const connection = structuredClone(readConfig().models.providers.minimax);
        for (const [index, method] of [
          "config.apply",
          "config.set",
          "config.set",
          "config.apply",
        ].entries()) {
          const current = readConfig();
          if (!Object.hasOwn(current.models.providers, "minimax")) {
            const restored = structuredClone(current);
            restored.models.providers.minimax = structuredClone(connection);
            await measure("config.set", "provider-save", current, restored);
          }
          const before = readConfig();
          const next = structuredClone(before);
          delete next.models.providers.minimax;
          removals.push({
            ...(await measure(method, "provider-remove", before, next)),
            warmup: index < 2,
          });
        }
        const referencedRemovals: typeof samples = [];
        for (const [index, method] of [
          "config.apply",
          "config.set",
          "config.set",
          "config.apply",
        ].entries()) {
          // Prepare an active provider outside the measured interval. The UI's
          // removal also clears this default, fallback and model allowlist.
          const current = readConfig();
          const prepared = structuredClone(current);
          prepared.models.providers.minimax = {
            ...structuredClone(connection),
            models: [{ id: "MiniMax-M3", name: "Fixture MiniMax" }],
          };
          const agents = prepared.agents as Record<string, unknown>;
          agents.defaults = {
            ...(agents.defaults as Record<string, unknown>),
            model: { primary: "minimax/MiniMax-M3", fallbacks: ["minimax/MiniMax-M3"] },
            models: { "minimax/MiniMax-M3": {} },
          };
          const snapshot = await client.request<{ hash: string }>("config.get", {});
          await client.request("config.set", {
            baseHash: snapshot.hash,
            raw: JSON.stringify(prepared),
          });
          await vi.waitFor(
            async () => {
              const applied = await client.request<{
                configRevisionHash: string;
                appliedConfigHash: string;
              }>("config.get", {});
              expect(applied.configRevisionHash).toBeTruthy();
              expect(applied.appliedConfigHash).toBe(applied.configRevisionHash);
            },
            { timeout: 30_000, interval: 100 },
          );
          const before = readConfig();
          const next = removeProviderConnectionConfig(
            before as unknown as Record<string, unknown>,
            "minimax",
          ) as unknown as FixtureConfig;
          referencedRemovals.push({
            ...(await measure(method, "provider-remove", before, next)),
            warmup: index < 2,
          });
        }
        const report = {
          firstSaveMethod,
          gatewayVersion: client.serverVersion,
          scope:
            "isolated Gateway configuration write and applied-revision confirmation; excludes API validation and MXC",
          samples,
          removals,
          referencedRemovals,
        };
        console.info(`[provider-save-benchmark] ${JSON.stringify(report)}`);
        const reportPath = process.env.MICROCLAW_PROVIDER_SAVE_REPORT;
        if (reportPath) {
          fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
          fs.writeFileSync(
            `${reportPath}.${firstSaveMethod}.json`,
            JSON.stringify(report, null, 2),
          );
        }
      } finally {
        client.stop();
        child.stdin.end();
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          const timer = setTimeout(() => child.kill(), 15_000);
          await exited;
          clearTimeout(timer);
        }
        endpoint.closeAllConnections();
        await new Promise<void>((resolve) => endpoint.close(() => resolve()));
        identity.mockRestore();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    240_000,
  );
});
