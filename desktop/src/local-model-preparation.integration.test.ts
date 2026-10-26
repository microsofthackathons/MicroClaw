import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { writeFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { GatewayClient } from "./gateway-client";
import { LocalModelService } from "./local-model-service";
import { LOCAL_MODEL_PRESETS } from "./local-model-catalog";
import type { LocalModelOperation, LocalModelReceipt } from "./local-model-types";
import { parseManagedModelPaths } from "./local-model-files";

const entry = process.env.MICROCLAW_TEST_OPENCLAW_ENTRY;
const cache = process.env.MICROCLAW_TEST_LOCAL_CACHE;
const plugin = process.env.MICROCLAW_TEST_LOCAL_PLUGIN_DIR;
it.skipIf(!entry || !plugin)(
  cache
    ? "completes confirmed exact-model preparation using copied cached weights without inference or changing defaults"
    : "reaches exact-model download consent through the real provider loader without downloading or changing defaults",
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "microclaw-complete-local-"));
    const configPath = path.join(root, "openclaw.json");
    const isolatedCache = path.join(root, "models", "llama.cpp");
    const token = randomUUID();
    const model = LOCAL_MODEL_PRESETS[0];
    let child: ReturnType<typeof spawn> | undefined;
    let client: GatewayClient | undefined;
    let log = "";
    try {
      mkdirSync(isolatedCache, { recursive: true });
      const weightFiles = [model.cacheFile, "hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf"];
      const originals = new Map(
        cache ? weightFiles.map((file) => [file, path.join(cache, file)]) : [],
      );
      for (const [file, original] of originals) {
        copyFileSync(original, path.join(isolatedCache, file));
      }
      cpSync(plugin!, path.join(root, "extensions", "llama-cpp"), {
        recursive: true,
        verbatimSymlinks: true,
      });
      const listener = createServer();
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("Cannot reserve Gateway port");
      const port = address.port;
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      const before = {
        gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
        agents: {
          ownership: "explicit",
          entries: { main: {}, other: {} },
          defaults: {
            model: { primary: "cloud/keep" },
            workspace: path.join(root, "workspace"),
            heartbeat: { every: "0m" },
          },
        },
        plugins: { allow: ["llama-cpp"], entries: { "llama-cpp": { enabled: true } } },
        skills: { allowBundled: [] },
      };
      await writeFile(configPath, JSON.stringify(before));
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      child = spawn(
        process.execPath,
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
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: root,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_NO_RESPAWN: "1",
            OPENCLAW_DISABLE_BONJOUR: "1",
            MICROCLAW_FS_SAFE_COMPAT: "1",
            MICROCLAW_OPENCLAW_PACKAGE_DIR: path.dirname(entry!),
            MICROCLAW_EXACT_LOCAL_MODELS: "1",
            MICROCLAW_LOCAL_MODEL_PLUGIN_DIR: path.join(root, "extensions", "llama-cpp"),
          },
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout?.on("data", (chunk) => {
        log = (log + chunk.toString()).slice(-20_000);
      });
      child.stderr?.on("data", (chunk) => {
        log = (log + chunk.toString()).slice(-20_000);
      });
      client = new GatewayClient({ port, token });
      client.start();
      await vi.waitFor(() => expect(client!.connected).toBe(true), {
        timeout: 100_000,
        interval: 500,
      });
      const events: LocalModelOperation[] = [];
      let receipt: LocalModelReceipt | undefined;
      const service = new LocalModelService({
        gateway: () => client!,
        identity: () => "disposable-complete-setup",
        assertMutable: () => {},
        readConfig: () => JSON.parse(readFileSync(configPath, "utf8")),
        stateDir: () => root,
        readReceipt: () => receipt,
        saveReceipt: (value) => {
          receipt = value ?? undefined;
        },
        restartGateway: async () => {
          throw new Error("Preparation must not require an application restart");
        },
        onChange: (value) => events.push(value),
      });
      const request = vi.spyOn(client, "request");
      const started = await service.prepare({
        authChoice: "llama-cpp",
        modelRef: model.modelRef,
        agentId: "main",
      });
      await vi.waitFor(
        () => {
          expect(["step", "error"]).toContain(service.getOperation()?.phase);
        },
        { timeout: 90_000, interval: 200 },
      );
      const consent = service.getOperation()!;
      expect(consent.phase, consent.error).toBe("step");
      expect(consent.step?.type, consent.error).toBe("confirm");
      expect(consent.download).toMatchObject({
        modelRef: model.modelRef,
      });
      if (!cache) {
        expect(
          request.mock.calls.some(
            ([method, params]) =>
              method === "wizard.next" &&
              (params as { answer?: { value?: unknown } }).answer?.value === true,
          ),
        ).toBe(false);
        await service.cancel(started.id);
        expect(JSON.parse(readFileSync(configPath, "utf8")).agents.defaults.model).toEqual(
          before.agents.defaults.model,
        );
        return;
      }
      expect(consent.download).toMatchObject({ modelBytes: 0, embeddingBytes: 0 });
      await service.answer({ operationId: started.id, stepId: consent.step!.id, value: true });
      await vi.waitFor(
        () => {
          expect(service.getOperation()?.phase, service.getOperation()?.error).toBe("prepared");
        },
        { timeout: 180_000, interval: 500 },
      );
      expect(service.getOperation()?.preparedModelRef).toBe(model.modelRef);
      expect(
        events.some((value) => value.phase === "step" && value.step?.type === "progress"),
      ).toBe(true);
      expect(
        request.mock.calls.some(([method]) =>
          [
            "chat.send",
            "openclaw.setup.verify",
            "openclaw.setup.activate.start",
            "config.patch",
          ].includes(method),
        ),
      ).toBe(false);
      const after = JSON.parse(readFileSync(configPath, "utf8"));
      expect(after.agents.defaults.model).toEqual(before.agents.defaults.model);
      expect(after.agents.entries).toEqual(before.agents.entries);
      const provider = after.models.providers["llama-cpp"];
      expect(
        provider.models.some((item: { id: string }) => `llama-cpp/${item.id}` === model.modelRef),
      ).toBe(true);
      expect(existsSync(provider.localService.command)).toBe(true);
      const version = spawnSync(provider.localService.command, ["--version"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 20_000,
      });
      expect(version.status, version.stderr).toBe(0);
      expect(version.stdout + version.stderr).toContain("10809");
      const args: string[] = provider.localService.args;
      const presetPath = args[args.indexOf("--models-preset") + 1];
      const paths = parseManagedModelPaths(readFileSync(presetPath, "utf8"));
      expect(paths.get(model.modelRef.slice("llama-cpp/".length))).toBe(
        path.join(isolatedCache, model.cacheFile),
      );
      for (const [file, original] of originals) {
        expect((await stat(path.join(isolatedCache, file))).size).toBe((await stat(original)).size);
      }
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : error}\n${log.split(token).join("[redacted]")}`,
        { cause: error },
      );
    } finally {
      client?.stop();
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        } else child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          if (child!.exitCode !== null || child!.signalCode !== null) resolve();
          else child!.once("exit", () => resolve());
        });
      }
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  },
  360_000,
);
