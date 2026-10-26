import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { GatewayClient } from "./gateway-client";
import { LocalModelService } from "./local-model-service";
import type { LocalModelReceipt } from "./local-model-types";

const entry = process.env.MICROCLAW_TEST_OPENCLAW_ENTRY;
const installProvider = process.env.MICROCLAW_TEST_INSTALL_LOCAL_PROVIDER === "1";
const selectionPluginDir = process.env.MICROCLAW_TEST_LOCAL_PLUGIN_DIR;

it.skipIf(!entry)(
  "checks local model RPCs against an isolated installed Gateway",
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "microclaw-local-model-integration-"));
    const configPath = path.join(root, "openclaw.json");
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Could not reserve a test port");
    const port = address.port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const token = randomUUID();
    const selectedModel = "microclaw-selection-only";
    let inferenceRequests = 0;
    const modelServer = selectionPluginDir
      ? createHttpServer((request, response) => {
          if (request.method === "POST") inferenceRequests++;
          response.setHeader("Content-Type", "application/json");
          if (request.url?.includes("models")) {
            response.end(
              JSON.stringify({ object: "list", data: [{ id: selectedModel, object: "model" }] }),
            );
          } else if (request.method === "POST") {
            response.writeHead(500);
            response.end(
              JSON.stringify({ error: "Inference is forbidden in this selection test" }),
            );
          } else response.end(JSON.stringify({ status: "ok" }));
        })
      : undefined;
    if (modelServer)
      await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
    const modelAddress = modelServer?.address();
    const localModels =
      modelAddress && typeof modelAddress !== "string"
        ? {
            mode: "merge",
            providers: {
              "llama-cpp": {
                baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
                api: "openai-completions",
                models: [
                  {
                    id: selectedModel,
                    name: "Selection-only fixture",
                    reasoning: false,
                    input: ["text"],
                    contextWindow: 16384,
                    maxTokens: 256,
                  },
                ],
              },
            },
          }
        : undefined;
    writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
        agents: {
          defaults: { workspace: path.join(root, "workspace"), heartbeat: { every: "0m" } },
          ...(installProvider
            ? { ownership: "explicit", entries: { secondary: {}, main: {} } }
            : {}),
        },
        plugins: selectionPluginDir
          ? {
              allow: ["llama-cpp"],
              entries: { "llama-cpp": { enabled: true } },
              load: { paths: [selectionPluginDir] },
            }
          : { allow: [] },
        ...(localModels ? { models: localModels } : {}),
        skills: { allowBundled: [] },
      }),
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const processEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_DISABLE_BONJOUR: "1",
      MICROCLAW_FS_SAFE_COMPAT: "1",
      MICROCLAW_OPENCLAW_PACKAGE_DIR: path.dirname(entry!),
      MICROCLAW_EXACT_LOCAL_MODELS: "1",
      MICROCLAW_LOCAL_MODEL_PLUGIN_DIR: path.join(root, "extensions", "llama-cpp"),
    };
    let log = "";
    function startGateway() {
      const process = spawn(
        global.process.execPath,
        [
          "--import",
          pathToFileURL(path.join(__dirname, "openclaw-fs-safe-compat.mjs")).href,
          "--import",
          pathToFileURL(path.join(__dirname, "openclaw-local-model-compat.mjs")).href,
          entry!,
          "gateway",
          "run",
          "--port",
          String(port),
        ],
        {
          env: processEnv,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      process.stdout.on("data", (chunk: Buffer) => {
        log = (log + chunk.toString()).slice(-12_000);
      });
      process.stderr.on("data", (chunk: Buffer) => {
        log = (log + chunk.toString()).slice(-12_000);
      });
      return process;
    }
    let child = startGateway();
    let client = new GatewayClient({ port, token });
    async function stopGateway() {
      client.stop();
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        } else {
          child.kill("SIGTERM");
        }
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once("exit", () => resolve());
        });
      }
    }
    try {
      client.start();
      await vi.waitFor(() => expect(client.connected).toBe(true), {
        timeout: 90_000,
        interval: 500,
      });
      let receipt: LocalModelReceipt | undefined;
      const service = new LocalModelService({
        gateway: () => client,
        identity: () => "isolated-integration",
        assertMutable: () => {},
        readConfig: () => JSON.parse(readFileSync(configPath, "utf8")),
        readReceipt: () => receipt,
        saveReceipt: (value) => {
          receipt = value ?? undefined;
        },
        restartGateway: async () => {
          if (!installProvider && !selectionPluginDir)
            throw new Error("Plugin installation was not opted into");
          await stopGateway();
          child = startGateway();
          client = new GatewayClient({ port, token });
          client.start();
          await vi.waitFor(() => expect(client.connected).toBe(true), {
            timeout: 90_000,
            interval: 500,
          });
        },
        onChange: () => {},
      });
      const capabilities = await service.getCapabilities();
      expect(capabilities.supported, capabilities.blockers.join("\n")).toBe(true);
      expect(
        capabilities.plugin.installed || capabilities.plugin.canInstall,
        JSON.stringify(capabilities),
      ).toBe(true);
      const review = await service.inspectProvider();
      expect(review.pluginId).toBe("llama-cpp");
      expect(review.source).toBeTruthy();
      if (capabilities.plugin.installed)
        expect(review.capabilities.providers).toContain("llama-cpp");
      expect(service.getOperation()).toBeNull();
      if (selectionPluginDir) {
        const request = vi.spyOn(client, "request");
        const before = JSON.parse(readFileSync(configPath, "utf8"));
        await service.activate({ kind: "existing-model", modelRef: `llama-cpp/${selectedModel}` });
        await vi.waitFor(
          () => {
            const operation = service.getOperation();
            expect(operation?.phase, operation?.error).toBe("ready");
          },
          { timeout: 60_000, interval: 250 },
        );
        const after = JSON.parse(readFileSync(configPath, "utf8"));
        expect(after.agents.defaults.model.primary).toBe(`llama-cpp/${selectedModel}`);
        expect(after.models).toEqual(before.models);
        expect(after.plugins).toEqual(before.plugins);
        expect(inferenceRequests).toBe(0);
        expect(
          request.mock.calls.some(
            ([method]) =>
              method === "openclaw.setup.activate.start" ||
              method === "openclaw.setup.verify" ||
              method === "chat.send",
          ),
        ).toBe(false);
        request.mockRestore();
      }
      if (installProvider) {
        try {
          await service.installProvider({ confirmed: true, reviewToken: review.reviewToken });
        } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith("Plugin capability review"))
            throw error;
          const stagedReview = await service.inspectProvider();
          await service.installProvider({ confirmed: true, reviewToken: stagedReview.reviewToken });
        }
        const installed = await service.getCapabilities();
        expect(installed.plugin.installed).toBe(true);
        expect(installed.plugin.enabled).toBe(true);
        const operation = await service.prepare({
          authChoice: "llama-cpp",
          modelRef: "llama-cpp/qwen3.5-4b-q4_k_m",
          agentId: "main",
        });
        for (let stepCount = 0; stepCount < 10; stepCount++) {
          await vi.waitFor(
            () => expect(["step", "error"]).toContain(service.getOperation()?.phase),
            {
              timeout: 90_000,
              interval: 200,
            },
          );
          const state = service.getOperation()!;
          expect(state.phase, state.error).toBe("step");
          if (state.step?.type === "confirm") break;
          expect(state.step?.type).toBe("note");
          await service.answer({ operationId: operation.id, stepId: state.step!.id });
        }
        expect(service.getOperation()?.step?.type).toBe("confirm");
        expect(service.getOperation()?.download?.modelRef).toBe("llama-cpp/qwen3.5-4b-q4_k_m");
        expect(service.getOperation()?.download?.modelBytes).toBe(2740937888);
        expect(service.getOperation()?.step?.initialValue).not.toBe(true);
        await service.cancel(operation.id);
        await vi.waitFor(() => expect(service.busy).toBe(false));
        expect(service.getOperation()?.phase).toBe("cancelled");
        const second = await service.prepare({
          authChoice: "llama-cpp",
          modelRef: "llama-cpp/qwen3.5-9b-q4_k_m",
          agentId: "main",
        });
        await vi.waitFor(
          () => {
            expect(service.getOperation()?.phase, service.getOperation()?.error).toBe("step");
            expect(service.getOperation()?.step?.type).toBe("confirm");
          },
          { timeout: 90_000, interval: 200 },
        );
        expect(service.getOperation()?.download?.modelRef).toBe("llama-cpp/qwen3.5-9b-q4_k_m");
        expect(service.getOperation()?.download?.modelBytes).toBe(5680522464);
        await service.cancel(second.id);
        await vi.waitFor(() => expect(service.busy).toBe(false));
        expect(
          JSON.parse(readFileSync(configPath, "utf8")).models?.providers?.["llama-cpp"],
        ).toBeUndefined();
      }
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : error}\n${log.split(token).join("[redacted]")}`,
        { cause: error },
      );
    } finally {
      await stopGateway();
      if (modelServer)
        await new Promise<void>((resolve, reject) =>
          modelServer.close((error) => (error ? reject(error) : resolve())),
        );
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  },
  300_000,
);
