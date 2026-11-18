import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import * as deviceIdentity from "./device-identity";
import { GatewayClient } from "./gateway-client";
import { selectDefaultModel } from "./default-model-selection";
import { prepareDefaultModelWrite } from "./default-model-write";
import { buildLocalModelSelectionPatch } from "./local-model-service";
import { createProviderModelCatalog } from "./provider-model-catalog";
import { waitForDefaultModelApplied } from "./model-setup";

describe.skipIf(
  !process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR || !process.env.MICROCLAW_GATEWAY_E2E_PARENT,
)("isolated default model switching", () => {
  it("compares verified patch/set selections without inference or loss of other settings", async () => {
    const packageDir = process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR!;
    const parent = path.resolve(process.env.MICROCLAW_GATEWAY_E2E_PARENT!);
    const root = fs.mkdtempSync(path.join(parent, "default-selection-"));
    const relative = path.relative(parent, root);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Unsafe fixture root");
    for (const name of ["state", "home", "app-data", "local-app-data", "temp", "workspace"])
      fs.mkdirSync(path.join(root, name));
    const configPath = path.join(root, "state", "openclaw.json");
    const providerRequests: string[] = [];
    const api = createServer((request, response) => {
      providerRequests.push(`${request.method} ${request.url}`);
      if (request.method !== "GET" || request.url !== "/v1/models") {
        response.writeHead(500).end("Inference forbidden");
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }));
    });
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const apiAddress = api.address();
    if (!apiAddress || typeof apiAddress === "string") throw new Error("Missing API port");
    const reservation = net.createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("Missing Gateway port");
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const token = randomUUID();
    const providers = Object.fromEntries(
      ["qwen", "minimax", "llama-cpp"].map((id) => [
        id,
        {
          api: "openai-completions",
          apiKey: `fixture-${id}`,
          baseUrl: `http://127.0.0.1:${apiAddress.port}/v1`,
          models: (id === "llama-cpp" ? ["model-a", "model-b"] : ["model-a"]).map((model) => ({
            id: model,
            name: model,
            input: ["text"],
            contextWindow: 16384,
            maxTokens: 256,
          })),
        },
      ]),
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
        logging: { file: path.join(root, "gateway.log") },
        agents: {
          ownership: "explicit",
          entries: { main: {}, writer: { model: "qwen/model-a" } },
          defaults: {
            workspace: path.join(root, "workspace"),
            heartbeat: { every: "0m" },
            model: { primary: "qwen/model-a", fallbacks: ["qwen/model-a"] },
            models: { "qwen/model-a": { alias: "keep" } },
            modelPolicy: { allow: ["qwen/*", "minimax/*", "llama-cpp/*"] },
          },
        },
        models: { mode: "merge", providers },
        plugins: { allow: [] },
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
      { cwd: packageDir, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    const capture = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const client = new GatewayClient({ port, token });
    const samples: Array<{
      provider: string;
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
        if (Date.now() >= deadline) throw new Error("Gateway startup timed out");
        await delay(250);
      }
      client.start();
      await vi.waitFor(() => expect(client.connected).toBe(true), { timeout: 20_000 });
      expect(client.serverVersion).toBe("2026.10.10");
      const readConfig = () => JSON.parse(fs.readFileSync(configPath, "utf8"));
      const catalog = createProviderModelCatalog();
      const generation = client.connectionGeneration;
      for (const provider of ["qwen", "minimax", "llama-cpp"]) {
        const first = provider === "minimax" ? "config.set" : "config.patch";
        const order = [
          first,
          first === "config.set" ? "config.patch" : "config.set",
          "config.set",
          "config.patch",
          "config.patch",
          "config.set",
        ];
        for (const [index, method] of order.entries()) {
          const ref = `${provider}/model-${index % 2 === 0 ? "b" : "a"}`;
          const before = readConfig();
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
                : client.methods.filter((item) => item !== "config.set"),
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
          if (provider === "llama-cpp") {
            // External loopback models exercise the shared write path, not GGUF loading or provider startup.
            const snapshot = await client.request<{ hash: string; config: unknown }>(
              "config.get",
              {},
            );
            const patch = buildLocalModelSelectionPatch(snapshot.config, ref);
            const write = prepareDefaultModelWrite({
              gateway,
              originalConfig: before,
              modelRef: ref,
              baseHash: snapshot.hash,
              patch,
            });
            await gateway.request(write.method, write.params);
            expect(
              await waitForDefaultModelApplied(ref, (timeoutMs) =>
                gateway.request("config.get", {}, timeoutMs),
              ),
            ).toBe(true);
          } else {
            await selectDefaultModel(
              {
                gateway: () => gateway,
                readConfig,
                assertMutable: () => {},
                discover: (input) => catalog(input, {}),
              },
              { modelRef: ref, expectedConfig: before },
            );
          }
          samples.push({
            provider,
            method,
            elapsedMs: Math.round(performance.now() - started),
            rpcMs: Math.round(rpcMs),
            polls,
            warmup: index < 2,
          });
          expect(rpcMs).toBeGreaterThan(0);
          const after = readConfig();
          expect(after.agents.defaults.model.primary).toBe(ref);
          expect(after.agents.defaults.model.fallbacks).toEqual(
            before.agents.defaults.model.fallbacks,
          );
          expect(after.agents.entries).toEqual(before.agents.entries);
          expect(after.agents.defaults.modelPolicy).toEqual(before.agents.defaults.modelPolicy);
          expect(after.gateway).toEqual(before.gateway);
          for (const id of Object.keys(providers))
            expect(after.models.providers[id].apiKey).toBe(`fixture-${id}`);
          expect(client.connectionGeneration).toBe(generation);
          expect(child.exitCode).toBeNull();
        }
      }
      expect(providerRequests.every((request) => request === "GET /v1/models")).toBe(true);
      const report = {
        gatewayVersion: client.serverVersion,
        scope:
          "isolated configuration application; local row excludes GGUF/provider preparation; no real credentials, inference or MXC",
        samples,
      };
      console.info(`[default-model-benchmark] ${JSON.stringify(report)}`);
      if (process.env.MICROCLAW_DEFAULT_MODEL_REPORT) {
        const reportPath = path.resolve(process.env.MICROCLAW_DEFAULT_MODEL_REPORT);
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
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
      api.closeAllConnections();
      await new Promise<void>((resolve) => api.close(() => resolve()));
      identity.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});
