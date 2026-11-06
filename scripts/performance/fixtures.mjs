import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

export async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function createFixture(
  root,
  { baseUrl, model, baseEnvironment = process.env, secretEnvironmentKeys = [] },
) {
  await mkdir(root, { recursive: false });
  for (const name of [
    "home",
    "appData",
    "userData",
    "sessionData",
    "temp",
    "localAppData",
    "state",
  ]) {
    await mkdir(path.join(root, name));
  }
  const gatewayPort = await reservePort();
  const token = randomUUID();
  const config = {
    gateway: { mode: "local", bind: "loopback", port: gatewayPort, auth: { mode: "token", token } },
    agents: {
      defaults: {
        workspace: path.join(root, "state", "workspace"),
        model: { primary: `microclaw-perf/${model}` },
        heartbeat: { every: "0m" },
      },
    },
    models: {
      mode: "merge",
      providers: {
        "microclaw-perf": {
          baseUrl,
          api: "openai-completions",
          apiKey: "performance-fixture-only",
          models: [
            {
              id: model,
              name: "Performance fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 32768,
              maxTokens: 256,
            },
          ],
        },
      },
    },
    skills: { allowBundled: [] },
    tools: { profile: "minimal", deny: ["*"] },
    plugins: { allow: [] },
  };
  await writeFile(path.join(root, "state", "openclaw.json"), JSON.stringify(config, null, 2));
  await writeFile(
    path.join(root, "userData", "settings.json"),
    JSON.stringify({ autoStart: false, minimizeToTray: false, language: "en-US" }),
  );
  const marker = path.join(root, "fixture.json");
  await writeFile(
    marker,
    JSON.stringify(
      { kind: "microclaw.performance.fixture.v1", disposable: true, token, gatewayPort },
      null,
      2,
    ),
  );
  const environment = Object.fromEntries(
    Object.entries(baseEnvironment).filter(
      ([key]) =>
        !/TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|^MICROCLAW_|^OPENCLAW_|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$/i.test(
          key,
        ) && !secretEnvironmentKeys.some((name) => name?.toLowerCase() === key.toLowerCase()),
    ),
  );
  Object.assign(environment, {
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    APPDATA: path.join(root, "appData"),
    LOCALAPPDATA: path.join(root, "localAppData"),
    TEMP: path.join(root, "temp"),
    TMP: path.join(root, "temp"),
    TMPDIR: path.join(root, "temp"),
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
    MICROCLAW_PERF_FIXTURE: marker,
    MICROCLAW_PERF_TOKEN: token,
  });
  return { root, token, gatewayPort, environment };
}

export function sanitizeError(error, secrets = []) {
  let text = String(error?.message ?? error);
  for (const secret of secrets.filter(Boolean)) text = text.replaceAll(secret, "[redacted]");
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(token|secret|api[-_]?key|authorization)(["'\s:=]+)[^\s,}\]]+/gi, "$1$2[redacted]")
    .slice(0, 2048);
}
