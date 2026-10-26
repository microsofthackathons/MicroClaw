import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { GatewayClient } from "./gateway-client";
import { SessionModelService } from "./session-model-service";
import { selectDefaultModel } from "./default-model-selection";

const entry = process.env.MICROCLAW_TEST_OPENCLAW_ENTRY;

it.skipIf(!entry).each(["single", "legacy-multiple", "explicit-multiple"] as const)(
  "verifies session/default metadata RPCs against isolated OpenClaw 2026.9.3 (%s)",
  async (mode) => {
    const multipleAgents = mode !== "single";
    const root = path.resolve(`.session-model-fixture-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
    const configPath = path.join(root, "openclaw.json");
    let endpointRequests = 0;
    const endpoint = createHttpServer((_request, res) => {
      endpointRequests++;
      res.writeHead(500);
      res.end("Provider requests are forbidden in this session metadata fixture");
    });
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const endpointAddress = endpoint.address();
    if (!endpointAddress || typeof endpointAddress === "string")
      throw new Error("Fixture endpoint unavailable");
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
    const port = address.port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const token = randomUUID();
    const model = (id: string) => ({
      id,
      name: id,
      contextWindow: 16384,
      maxTokens: 256,
      input: ["text"],
      reasoning: false,
    });
    const config = {
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
      logging: { file: path.join(root, "gateway.log") },
      agents: {
        defaults: {
          workspace: path.join(root, "workspace"),
          heartbeat: { every: "0m" },
          model: { primary: "fixture-cloud/a", fallbacks: ["fixture-cloud/b"] },
          models: { "llama-cpp/local": {} },
          modelSelectionScope: "session",
        },
        ...(mode === "explicit-multiple"
          ? {
              ownership: "explicit",
              entries: {
                main: {},
                writer: { model: { primary: "fixture-cloud/b" } },
              },
            }
          : {
              list: [
                { id: "main", default: true },
                ...(multipleAgents
                  ? [{ id: "writer", model: { primary: "fixture-cloud/b" } }]
                  : []),
              ],
            }),
      },
      models: {
        providers: {
          "fixture-cloud": {
            baseUrl: `http://127.0.0.1:${endpointAddress.port}/v1`,
            api: "openai-completions",
            apiKey: "fixture-only",
            models: [model("a"), model("b")],
          },
          "llama-cpp": {
            baseUrl: `http://127.0.0.1:${endpointAddress.port}/v1`,
            api: "openai-completions",
            models: [model("local")],
          },
        },
      },
      plugins: { allow: [] },
      skills: { allowBundled: [] },
    };
    writeFileSync(configPath, JSON.stringify(config));
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const env: NodeJS.ProcessEnv = Object.fromEntries(
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
    const capture = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-12_000);
    };
    function startFixtureGateway() {
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
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      return child;
    }
    let child = startFixtureGateway();
    let processGeneration = 1;
    const client = new GatewayClient({ port, token });
    const realRequest = client.request.bind(client);
    const request = vi.spyOn(client, "request");
    async function stopFixtureGateway() {
      client.stop();
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        if (process.platform === "win32") {
          spawnSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-Command",
              `Stop-Process -Id ${child.pid} -Force -ErrorAction SilentlyContinue`,
            ],
            { windowsHide: true, stdio: "ignore" },
          );
        } else child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once("exit", () => resolve());
        });
      }
    }
    try {
      client.start();
      await vi.waitFor(
        () => {
          if (child.exitCode !== null)
            throw new Error(`Fixture Gateway exited: ${log.replaceAll(token, "[fixture-token]")}`);
          expect(client.connected).toBe(true);
        },
        { timeout: 90_000, interval: 500 },
      );
      expect(client.serverVersion).toBe("2026.9.3");
      const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"));
      const service = new SessionModelService({
        gateway: () => client,
        readConfig,
        assertMutable: () => {},
        runtime: () => {
          const currentChild = child;
          return {
            identity: root,
            generation: String(processGeneration),
            isStopped: () => currentChild.exitCode !== null || currentChild.signalCode !== null,
          };
        },
        restartGateway: async () => {
          await stopFixtureGateway();
          child = startFixtureGateway();
          processGeneration++;
          client.start();
          await vi.waitFor(() => expect(client.connected).toBe(true), {
            timeout: 90_000,
            interval: 500,
          });
        },
        onRecoveryChanged: () => {},
      });
      // Startup config migrations are outside the selection API; compare the settled config.
      const baseline = readConfig();
      const main = multipleAgents ? "agent:main:main" : "main";
      if (multipleAgents) await expect(service.get("main")).rejects.toThrow(/no explicit owner/);
      await expect(service.get(main)).resolves.toEqual({
        sessionKey: "agent:main:main",
        modelRef: "fixture-cloud/a",
        overridden: false,
      });
      await expect(client.request("sessions.describe", { key: main })).resolves.toEqual({
        session: null,
      });
      if (multipleAgents) {
        const draftKey = `agent:main:session-${Date.now()}-draft`;
        await expect(service.get(draftKey)).resolves.toEqual({
          sessionKey: draftKey,
          modelRef: "fixture-cloud/a",
          overridden: false,
        });
        await expect(client.request("sessions.describe", { key: draftKey })).resolves.toEqual({
          session: null,
        });
        await expect(
          service.select({ sessionKey: draftKey, modelRef: "llama-cpp/local" }),
        ).resolves.toEqual({
          sessionKey: draftKey,
          modelRef: "llama-cpp/local",
          overridden: true,
        });
        await expect(service.get(main)).resolves.toMatchObject({
          modelRef: "fixture-cloud/a",
          overridden: false,
        });
        await expect(service.get("agent:writer:Fresh")).resolves.toEqual({
          sessionKey: "agent:writer:fresh",
          modelRef: "fixture-cloud/b",
          overridden: false,
        });
        await expect(
          service.select({ sessionKey: "agent:writer:Fresh", modelRef: "llama-cpp/local" }),
        ).resolves.toEqual({
          sessionKey: "agent:writer:fresh",
          modelRef: "llama-cpp/local",
          overridden: true,
        });
        await expect(service.get("agent:writer:fresh")).resolves.toMatchObject({
          modelRef: "llama-cpp/local",
          overridden: true,
        });
        await expect(
          service.select({ sessionKey: "agent:writer:fresh", modelRef: null }),
        ).resolves.toMatchObject({ modelRef: "fixture-cloud/b", overridden: false });
        await expect(
          service.select({ sessionKey: "agent:writer:fresh", modelRef: "fixture-cloud/b" }),
        ).resolves.toMatchObject({ modelRef: "fixture-cloud/b", overridden: false });
        await expect(
          service.select({ sessionKey: "agent:writer:fresh", modelRef: "fixture-cloud/a" }),
        ).rejects.toThrow(/allowlist/);
      }
      await expect(
        service.select({ sessionKey: main, modelRef: "llama-cpp/local" }),
      ).resolves.toMatchObject({
        sessionKey: "agent:main:main",
        modelRef: "llama-cpp/local",
        overridden: true,
      });
      await expect(service.select({ sessionKey: main, modelRef: null })).resolves.toMatchObject({
        modelRef: "fixture-cloud/a",
        overridden: false,
      });
      await expect(
        service.select({ sessionKey: main, modelRef: "fixture-cloud/a" }),
      ).resolves.toMatchObject({ modelRef: "fixture-cloud/a", overridden: false });
      await expect(
        service.select({ sessionKey: main, modelRef: "fixture-cloud/b" }),
      ).rejects.toThrow(/allowlist/);
      // Confirm the primary exception and fallback rejection are upstream policy,
      // not just the client's precheck.
      await expect(
        client.request("sessions.patch", { key: "agent:main:main", model: "fixture-cloud/b" }),
      ).rejects.toThrow(/model not allowed/);
      expect(readConfig()).toEqual(baseline);
      const generation = client.connectionGeneration;
      const started = performance.now();
      const defaultSelection = selectDefaultModel(
        {
          gateway: () => client,
          readConfig,
          assertMutable: () => {},
        },
        {
          modelRef: "fixture-cloud/b",
          expectedConfig: baseline,
        },
      );
      if (mode === "legacy-multiple") {
        // Metadata reads still support this legacy roster. A config write must
        // surface upstream's migration requirement, not rewrite agent ownership.
        await expect(defaultSelection).rejects.toThrow(/agents.ownership/);
        expect(readConfig()).toEqual(baseline);
      } else {
        await expect(defaultSelection).resolves.toEqual({ modelRef: "fixture-cloud/b" });
        const elapsed = Math.round(performance.now() - started);
        console.info(`[default-model-selection] ${mode}: ${elapsed}ms, no restart or inference`);
        expect(elapsed).toBeLessThan(10_000);
        const afterDefault = readConfig();
        expect(afterDefault.agents.defaults.model).toEqual({
          ...baseline.agents.defaults.model,
          primary: "fixture-cloud/b",
        });
        expect(afterDefault.agents.defaults.models).toEqual(baseline.agents.defaults.models);
        expect(afterDefault.agents.defaults.modelPolicy).toEqual(
          baseline.agents.defaults.modelPolicy ?? {
            allow: Object.keys(baseline.agents.defaults.models),
          },
        );
        expect(afterDefault.agents.entries).toEqual(baseline.agents.entries);
        expect(afterDefault.agents.list).toEqual(baseline.agents.list);
        expect(afterDefault.models).toEqual(baseline.models);
      }
      expect(client.connectionGeneration).toBe(generation);
      expect(client.connected).toBe(true);
      expect(child.exitCode).toBeNull();
      if (mode === "explicit-multiple") {
        for (const failure of ["before-delivery", "after-commit"] as const) {
          const savedBefore = await service.get(main);
          const configBefore = readConfig();
          const patchesBefore = request.mock.calls.filter(
            ([method]) => method === "sessions.patch",
          ).length;
          let inject = true;
          request.mockImplementation(
            async <T = unknown>(
              method: string,
              params?: unknown,
              timeout?: number | null,
            ): Promise<T> => {
              if (method === "sessions.patch" && inject) {
                inject = false;
                if (failure === "after-commit") await realRequest(method, params, timeout);
                throw new Error("Simulated lost response");
              }
              return realRequest<T>(method, params, timeout);
            },
          );
          await expect(
            service.select({ sessionKey: main, modelRef: "llama-cpp/local" }),
          ).rejects.toThrow(/may have been saved/);
          await service.get(main);
          expect(service.busy).toBe(true);
          const recovery = service.getRecovery()!;
          expect(recovery.requiresRestart).toBe(true);
          const previous = child;
          await service.recover({ recoveryId: recovery.id, confirmed: true, restart: true });
          expect(previous.exitCode !== null || previous.signalCode !== null).toBe(true);
          expect(service.busy).toBe(false);
          expect(service.getRecovery()).toBeNull();
          expect((await service.get(main)).modelRef).toBe(
            failure === "after-commit" ? "llama-cpp/local" : savedBefore.modelRef,
          );
          expect(readConfig()).toEqual(configBefore);
          expect(request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(
            patchesBefore + 1,
          );
        }
      }
      expect(endpointRequests).toBe(0);
      expect(
        request.mock.calls.every(([method]) =>
          [
            "connect",
            "sessions.describe",
            "sessions.list",
            "sessions.patch",
            "config.get",
            "config.patch",
          ].includes(method),
        ),
      ).toBe(true);
    } finally {
      await stopFixtureGateway();
      await new Promise<void>((resolve) => endpoint.close(() => resolve()));
      request.mockRestore();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
  150_000,
);
