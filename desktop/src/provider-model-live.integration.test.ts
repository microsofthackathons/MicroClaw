import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { GatewayClient, type ChatEventPayload } from "./gateway-client";
import { SessionModelService } from "./session-model-service";
import { selectDefaultModel } from "./default-model-selection";
import { resolveModelApiKey } from "./model-connection";

const entry = process.env.MICROCLAW_TEST_OPENCLAW_ENTRY;
const sourcePath = process.env.MICROCLAW_TEST_LIVE_QWEN_CONFIG;

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return typeof row.text === "string" ? row.text : text(row.content);
  }
  return "";
}

it.skipIf(!entry || !sourcePath)(
  "verifies real Qwen replies after isolated default/session hot switches without desktop input",
  async () => {
    const sourceBytes = readFileSync(sourcePath!, "utf8");
    const provider = JSON.parse(sourceBytes).models?.providers?.qwen;
    if (typeof provider?.apiKey !== "string")
      throw new Error("The explicitly supplied configuration needs a Qwen API key");
    const key = resolveModelApiKey(provider.apiKey, process.env);
    if (!key.ok || !key.value || typeof provider?.baseUrl !== "string")
      throw new Error("The explicitly supplied configuration needs a usable Qwen connection");
    const apiKey = key.value;
    const root = mkdtempSync(path.join(tmpdir(), "microclaw-live-model-e2e-"));
    const configPath = path.join(root, "openclaw.json");
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("No isolated Gateway port");
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
          entries: { main: {}, writer: { model: "qwen/qwen3.8-max" } },
          defaults: {
            workspace: path.join(root, "workspace"),
            heartbeat: { every: "0m" },
            model: { primary: "qwen/qwen3.8-max" },
            thinkingDefault: "off",
            modelSelectionScope: "session",
            modelPolicy: { allow: ["qwen/*"] },
          },
        },
        models: {
          providers: {
            qwen: {
              baseUrl: provider.baseUrl,
              api: "openai-completions",
              apiKey,
              models: ["qwen3.8-max", "qwen3.8-flash"].map((id) => ({
                id,
                name: id,
                input: ["text"],
                reasoning: false,
                contextWindow: 32768,
                maxTokens: 512,
              })),
            },
          },
        },
        tools: { profile: "minimal" },
        plugins: { allow: [] },
        skills: { allowBundled: [] },
      }),
      { mode: 0o600 },
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/(?:API_KEY|TOKEN|SECRET|PASSWORD|OPENCLAW|NODE_OPTIONS)/i.test(name),
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
    let log = "";
    const capture = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-6000);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const replies = new Map<
      string,
      { resolve(value: string): void; reject(error: Error): void; delta: string }
    >();
    const client = new GatewayClient({
      port,
      token,
      onEvent: (event) => {
        if (event.event !== "chat") return;
        const payload = event.payload as ChatEventPayload;
        const pending = replies.get(payload.sessionKey);
        if (!pending) return;
        if (payload.state === "delta" && payload.deltaText)
          pending.delta = payload.replace ? payload.deltaText : pending.delta + payload.deltaText;
        if (payload.state === "error" || payload.state === "aborted") {
          const message = (payload.errorMessage ?? payload.state)
            .replaceAll(apiKey, "[credential]")
            .replaceAll(token, "[gateway-token]");
          pending.reject(new Error(`Real request for ${payload.sessionKey} failed: ${message}`));
        }
        if (payload.state === "final") pending.resolve(text(payload.message) || pending.delta);
      },
    });
    async function verifyReply(sessionKey: string, expected: string) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const response = new Promise<string>((resolve, reject) => {
        replies.set(sessionKey, { resolve, reject, delta: "" });
        timer = setTimeout(() => reject(new Error("Real provider reply timed out")), 60000);
      });
      void response.catch(() => {});
      try {
        await client.sendChat(sessionKey, `Do not use tools. Reply exactly ${expected}.`);
        expect(await response).toContain(expected);
      } catch (error) {
        const history = await client.loadHistory(sessionKey);
        console.warn(
          JSON.stringify({
            assistantDiagnostics: history.messages
              ?.filter(
                (message) =>
                  message &&
                  typeof message === "object" &&
                  (message as Record<string, unknown>).role === "assistant",
              )
              .map((message) => {
                const row = message as Record<string, unknown>;
                return {
                  stopReason: row.stopReason,
                  usage: row.usage,
                  textLength: text(row.content).length,
                };
              }),
          }),
        );
        const logPath = path.join(root, "gateway.log");
        const diagnostics = (existsSync(logPath) ? readFileSync(logPath, "utf8") : log)
          .split("\n")
          .filter((line) => /error|warn|model-fetch/i.test(line))
          .slice(-12)
          .join("\n")
          .replaceAll(apiKey, "[credential]")
          .replaceAll(token, "[gateway-token]");
        console.warn(diagnostics);
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        replies.delete(sessionKey);
      }
    }
    try {
      client.start();
      await vi.waitFor(
        () => {
          if (child.exitCode !== null)
            throw new Error(
              `Isolated Gateway exited: ${log.replaceAll(apiKey, "[credential]").replaceAll(token, "[gateway-token]")}`,
            );
          expect(client.connected).toBe(true);
        },
        { timeout: 90000, interval: 500 },
      );
      const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"));
      const before = readConfig();
      const generation = client.connectionGeneration;
      const sessions = new SessionModelService({
        gateway: () => client,
        readConfig,
        assertMutable: () => {},
        runtime: () => ({
          identity: root,
          generation: "one",
          isStopped: () => child.exitCode !== null || child.signalCode !== null,
        }),
        restartGateway: async () => {
          throw new Error("Unexpected restart");
        },
        onRecoveryChanged: () => {},
      });
      const selected = "agent:main:scope-test";
      await sessions.select({ sessionKey: selected, modelRef: "qwen/qwen3.8-flash" });
      for (const modelRef of ["qwen/qwen3.8-flash", "qwen/qwen3.8-max"]) {
        await selectDefaultModel(
          { gateway: () => client, readConfig, assertMutable: () => {} },
          { modelRef, expectedConfig: readConfig() },
        );
        expect((await sessions.get(selected)).modelRef).toBe("qwen/qwen3.8-flash");
      }
      expect(readConfig().agents.entries).toEqual(before.agents.entries);
      expect(readConfig().agents.defaults.modelPolicy).toEqual(before.agents.defaults.modelPolicy);
      expect((await sessions.get("agent:main:inherited-test")).modelRef).toBe("qwen/qwen3.8-max");
      await verifyReply(selected, "MC_SCOPE_FLASH_OK");
      await verifyReply("agent:main:inherited-test", "MC_SCOPE_MAX_OK");
      expect(client.connectionGeneration).toBe(generation);
      expect(child.exitCode).toBeNull();
      expect(readFileSync(sourcePath!, "utf8")).toBe(sourceBytes);
      console.info(
        "[live-model-e2e] real Max and Flash replies passed; default/session scopes preserved; no restart, desktop input, or source config writes",
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
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  },
  240000,
);
