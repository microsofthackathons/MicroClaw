import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createListener } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { GatewayClient } from "./gateway-client";
import { registerProviderCatalogModel } from "./provider-model-registration";
import { discoverProviderModels } from "./provider-model-catalog";
import { selectDefaultModel } from "./default-model-selection";
import { SessionModelService } from "./session-model-service";

const entry = process.env.MICROCLAW_TEST_OPENCLAW_ENTRY;

it.skipIf(!entry)(
  "hot-registers and selects live provider models for sessions and defaults without inference or restart",
  async () => {
    const root = path.resolve(`.provider-catalog-fixture-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
    const configPath = path.join(root, "openclaw.json");
    const requests: string[] = [];
    const endpoint = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method !== "GET" || request.url !== "/v1/models") {
        response.writeHead(500);
        response.end("Inference forbidden");
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: ["old", "live-one", "live-two"].map((id) => ({ id })) }));
    });
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const endpointAddress = endpoint.address();
    if (!endpointAddress || typeof endpointAddress === "string")
      throw new Error("No endpoint port");
    const listener = createListener();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("No Gateway port");
    const port = address.port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const token = randomUUID();
    writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
        logging: { file: path.join(root, "gateway.log") },
        agents: {
          ownership: "explicit",
          entries: { main: {}, writer: { model: "qwen/old" } },
          defaults: {
            workspace: path.join(root, "workspace"),
            heartbeat: { every: "0m" },
            model: { primary: "qwen/old" },
            modelSelectionScope: "session",
            modelPolicy: { allow: ["qwen/*"] },
          },
        },
        models: {
          providers: {
            qwen: {
              baseUrl: `http://127.0.0.1:${endpointAddress.port}/v1`,
              api: "openai-completions",
              apiKey: "fixture-only",
              models: [
                { id: "old", name: "Old", input: ["text"], contextWindow: 16384, maxTokens: 256 },
              ],
            },
          },
        },
        plugins: { allow: [] },
        skills: { allowBundled: [] },
      }),
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/(?:API_KEY|TOKEN|SECRET|PASSWORD|OPENCLAW|NODE_OPTIONS)/i.test(key),
      ),
    );
    Object.assign(env, {
      HOME: root,
      USERPROFILE: root,
      APPDATA: root,
      LOCALAPPDATA: root,
      TEMP: root,
      TMP: root,
      TMPDIR: root,
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_DISABLE_BONJOUR: "1",
      MICROCLAW_FS_SAFE_COMPAT: "1",
      MICROCLAW_OPENCLAW_PACKAGE_DIR: path.dirname(entry!),
    });
    let log = "";
    const child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(path.join(__dirname, "openclaw-fs-safe-compat.mjs")).href,
        entry!,
        "gateway",
        "run",
        "--port",
        String(port),
      ],
      { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (chunk) => {
      log = (log + chunk.toString()).slice(-12000);
    });
    child.stderr.on("data", (chunk) => {
      log = (log + chunk.toString()).slice(-12000);
    });
    const client = new GatewayClient({ port, token });
    try {
      client.start();
      await vi.waitFor(
        () => {
          if (child.exitCode !== null) throw new Error(log.replaceAll(token, "[fixture-token]"));
          expect(client.connected).toBe(true);
        },
        { timeout: 90000, interval: 500 },
      );
      const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"));
      const before = readConfig();
      const generation = client.connectionGeneration;
      const deps = {
        gateway: () => client,
        readConfig,
        assertMutable: () => {},
        discover: (input: Parameters<typeof discoverProviderModels>[0]) =>
          discoverProviderModels(input, {}),
      };
      const restart = vi.fn(async () => {
        throw new Error("Unexpected Gateway restart");
      });
      const sessions = new SessionModelService({
        gateway: () => client,
        readConfig,
        assertMutable: () => {},
        prepareModel: async (ref) => {
          await registerProviderCatalogModel(deps, ref, readConfig());
        },
        runtime: () => ({
          identity: root,
          generation: "one",
          isStopped: () => child.exitCode !== null || child.signalCode !== null,
        }),
        restartGateway: restart,
        onRecoveryChanged: () => {},
      });
      const started = performance.now();
      await expect(
        sessions.select({ sessionKey: "agent:main:first", modelRef: "qwen/live-one" }),
      ).resolves.toMatchObject({
        modelRef: "qwen/live-one",
        overridden: true,
      });
      const sessionElapsed = performance.now() - started;
      expect(sessionElapsed).toBeLessThan(10000);
      expect(readConfig().agents).toEqual(before.agents);
      const defaultStarted = performance.now();
      await expect(
        selectDefaultModel(
          {
            ...deps,
            prepareModel: (ref, expected) => registerProviderCatalogModel(deps, ref, expected),
          },
          { modelRef: "qwen/live-two", expectedConfig: readConfig() },
        ),
      ).resolves.toEqual({ modelRef: "qwen/live-two" });
      const defaultElapsed = performance.now() - defaultStarted;
      expect(defaultElapsed).toBeLessThan(10000);
      expect(readConfig().agents.defaults.modelPolicy).toEqual(before.agents.defaults.modelPolicy);
      expect(readConfig().agents.entries).toEqual(before.agents.entries);
      await expect(sessions.get("agent:main:first")).resolves.toMatchObject({
        modelRef: "qwen/live-one",
      });
      expect(restart).not.toHaveBeenCalled();
      expect(client.connectionGeneration).toBe(generation);
      expect(child.exitCode).toBeNull();
      expect(requests).toEqual(["GET /v1/models", "GET /v1/models"]);
      console.info(
        `[provider-catalog] session: ${Math.round(sessionElapsed)}ms; default: ${Math.round(defaultElapsed)}ms; no restart or inference`,
      );
    } finally {
      client.stop();
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        if (process.platform === "win32")
          spawnSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-Command",
              `Stop-Process -Id ${child.pid} -Force -ErrorAction SilentlyContinue`,
            ],
            { windowsHide: true, stdio: "ignore" },
          );
        else child.kill("SIGTERM");
        if (child.exitCode === null && child.signalCode === null)
          await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }
      endpoint.closeAllConnections();
      await new Promise<void>((resolve) => endpoint.close(() => resolve()));
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  },
  180000,
);
