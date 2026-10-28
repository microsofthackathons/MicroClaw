import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  prepareWeixinPluginResource,
  WEIXIN_RUNTIME_MANIFEST_CONTRACT,
} from "./prepare-weixin-plugin-resource.mjs";
import { stageWeixinRuntime } from "./stage-weixin-runtime.mjs";

const sourceDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "plugins",
  "openclaw-weixin",
);
const retiredSdkPaths = new Set([
  "infra-runtime",
  "config-runtime",
  "channel-runtime",
  "command-auth",
]);
const supportedSdkPaths = new Set([
  "plugin-entry",
  "channel-config-schema",
  "account-id",
  "temp-path",
  "file-lock",
  "command-auth-native",
  "config-mutation",
  "hook-runtime",
  "plugin-runtime",
  "channel-outbound",
  "reply-runtime",
]);
let tempDir;
let stageDir;
let compiledCount;
const previousStateDir = process.env.OPENCLAW_STATE_DIR;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-weixin-sdk-"));
  process.env.OPENCLAW_STATE_DIR = path.join(tempDir, "state");
  stageDir = path.join(tempDir, "plugin");
  fs.mkdirSync(stageDir);
  const archive = path.join(sourceDir, "vendor", "tencent-weixin-openclaw-weixin-2.4.6.tgz");
  assert.equal(
    createHash("sha256").update(fs.readFileSync(archive)).digest("hex"),
    "ef1c3600ca2fc0ee9076c1327af1e0d5d2e8e19fbb61e9f56c961fcde0bd07f6",
  );
  execFileSync("tar", ["-xzf", archive, "-C", stageDir, "--strip-components=1"]);
  compiledCount = stageWeixinRuntime(sourceDir, stageDir);

  // These narrow SDK test doubles exercise the emitted plugin modules without
  // starting a Gateway, accessing the user's state, or depending on a registry.
  const sdkDir = path.join(stageDir, "node_modules", "openclaw");
  fs.mkdirSync(sdkDir, { recursive: true });
  const modules = {
    "channel-config-schema": "export const buildChannelConfigSchema = (schema) => schema;",
    "account-id": "export const normalizeAccountId = (id) => id.trim();",
    "temp-path": `export const resolvePreferredOpenClawTmpDir = () => ${JSON.stringify(path.join(tempDir, "logs"))};`,
    "file-lock": "export const withFileLock = async (_path, _options, fn) => await fn();",
    "command-auth-native": `
      export const shouldComputeCommandAuthorized = (body) => body.startsWith("/");
      export const resolveCommandAuthorizedFromAuthorizers = ({useAccessGroups, authorizers}) =>
        !useAccessGroups || authorizers.some((entry) => entry.configured && entry.allowed);
    `,
    "config-mutation": `
      export let config = {};
      export let failure;
      export const reset = (value, error) => { config = value; failure = error; };
      export async function mutateConfigFile({mutate}) {
        if (failure) throw failure;
        const draft = structuredClone(config);
        await mutate(draft, {attempt: 1});
        config = draft;
      }
    `,
  };
  const exports = {};
  for (const [name, content] of Object.entries(modules)) {
    exports[`./plugin-sdk/${name}`] = `./${name}.js`;
    fs.writeFileSync(path.join(sdkDir, `${name}.js`), content);
  }
  fs.writeFileSync(
    path.join(sdkDir, "package.json"),
    JSON.stringify({ name: "openclaw", type: "module", exports }),
  );
});

after(() => {
  if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = previousStateDir;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function stagedImport(relative) {
  return import(pathToFileURL(path.join(stageDir, relative)).href);
}

test("hook runtimes are not imported during registration and load only for outbound work", async () => {
  const hooks = await stagedImport("dist/src/messaging/outbound-hooks.js");
  assert.equal(typeof hooks.emitWeixinMessageSent, "function");
  assert.deepEqual(await hooks.applyWeixinMessageSendingHook({ to: "owner", text: "hello" }), {
    cancelled: false,
    text: "hello",
  });
  const source = fs.readFileSync(
    path.join(stageDir, "dist/src/messaging/outbound-hooks.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /from ["']openclaw\/plugin-sdk\/(?:hook-runtime|plugin-runtime)["']/);
  assert.match(source, /await import\("openclaw\/plugin-sdk\/plugin-runtime"\)/);
});

test("native logout clears all account artifacts and the index without touching another channel", async () => {
  const accounts = await stagedImport("dist/src/auth/accounts.js");
  accounts.replaceWeixinAccount({
    accountId: "owner",
    token: "fake-token",
    userId: "owner@im.wechat",
  });
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  const accountDir = path.join(stateDir, "openclaw-weixin/accounts");
  fs.writeFileSync(path.join(accountDir, "owner.sync.json"), "sync");
  fs.writeFileSync(path.join(accountDir, "owner.context-tokens.json"), "context");
  const other = path.join(stateDir, "credentials/another-channel.json");
  fs.writeFileSync(other, "untouched");
  const cleared = [];
  assert.deepEqual(
    accounts.disconnectWeixinAccount("owner", (accountId) => cleared.push(accountId)),
    {
      cleared: true,
      loggedOut: true,
    },
  );
  assert.deepEqual(accounts.listIndexedWeixinAccountIds(), []);
  assert.equal(fs.existsSync(path.join(accountDir, "owner.json")), false);
  assert.equal(fs.existsSync(path.join(accountDir, "owner.sync.json")), false);
  assert.equal(fs.existsSync(path.join(accountDir, "owner.context-tokens.json")), false);
  assert.equal(
    fs.existsSync(path.join(stateDir, "credentials/openclaw-weixin-owner-allowFrom.json")),
    false,
  );
  assert.deepEqual(cleared, ["owner"]);
  assert.equal(fs.readFileSync(other, "utf8"), "untouched");
  assert.throws(() => accounts.disconnectWeixinAccount("../outside"), /safe WeChat account ID/);
});

test("logout restores the token and index if artifact cleanup fails", async (context) => {
  const accounts = await stagedImport("dist/src/auth/accounts.js");
  accounts.replaceWeixinAccount({
    accountId: "owner",
    token: "fake-token",
    userId: "owner@im.wechat",
  });
  const accountDir = path.join(process.env.OPENCLAW_STATE_DIR, "openclaw-weixin/accounts");
  fs.writeFileSync(path.join(accountDir, "owner.sync.json"), "sync");
  const unlink = fs.unlinkSync;
  const mock = context.mock.method(fs, "unlinkSync", (target) => {
    if (target === path.join(accountDir, "owner.sync.json")) throw new Error("Cleanup denied");
    return unlink(target);
  });
  try {
    assert.throws(() => accounts.disconnectWeixinAccount("owner"), /Cleanup denied/);
    assert.equal(accounts.loadWeixinAccount("owner").token, "fake-token");
    assert.deepEqual(accounts.listIndexedWeixinAccountIds(), ["owner"]);
  } finally {
    mock.mock.restore();
  }
});

test("a short QR wait returns pending and the same session can subsequently confirm", async (context) => {
  const login = await stagedImport("dist/src/auth/login-qr.js");
  let now = 1_000;
  let polls = 0;
  context.mock.method(Date, "now", () => now);
  context.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("get_bot_qrcode")) {
      return new Response(
        JSON.stringify({ qrcode: "fake-code", qrcode_img_content: "https://example.test/qr" }),
      );
    }
    polls++;
    now += 1_100;
    return new Response(
      JSON.stringify(
        polls === 1
          ? { status: "wait" }
          : {
              status: "confirmed",
              bot_token: "fake-token",
              ilink_bot_id: "owner",
              ilink_user_id: "owner@im.wechat",
            },
      ),
    );
  });
  const start = await login.startWeixinLoginWithQr({ apiBaseUrl: "https://example.test" });
  const first = await login.waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: "https://example.test",
    timeoutMs: 1_000,
    polling: true,
  });
  assert.equal(first.pending, true);
  assert.equal(first.qrDataUrl, "https://example.test/qr");
  const second = await login.waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: "https://example.test",
    timeoutMs: 1_000,
    polling: true,
  });
  assert.equal(second.connected, true);
  assert.equal(second.accountId, "owner");
  assert.equal(polls, 2);
});

test("desktop expiry stops at the first QR and waits for an explicit new start", async (context) => {
  const login = await stagedImport("dist/src/auth/login-qr.js");
  let starts = 0;
  let polls = 0;
  context.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("get_bot_qrcode")) {
      starts++;
      return new Response(
        JSON.stringify({
          qrcode: `code-${starts}`,
          qrcode_img_content: `https://example.test/qr-${starts}`,
        }),
      );
    }
    polls++;
    return new Response(JSON.stringify({ status: "expired" }));
  });
  const start = await login.startWeixinLoginWithQr({ apiBaseUrl: "https://example.test" });
  const expired = await login.waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: "https://example.test",
    polling: true,
  });
  assert.equal(expired.expired, true);
  assert.equal(expired.pending, undefined);
  assert.equal(expired.qrDataUrl, "https://example.test/qr-1");
  assert.equal(starts, 1);
  const stopped = await login.waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: "https://example.test",
    polling: true,
  });
  assert.equal(stopped.connected, false);
  assert.equal(polls, 1);
  const refreshed = await login.startWeixinLoginWithQr({ apiBaseUrl: "https://example.test" });
  assert.equal(starts, 2);
  assert.notEqual(refreshed.sessionKey, start.sessionKey);
  login.cancelWeixinLogin(refreshed.sessionKey);
});

test("cancelling a QR aborts its network long poll immediately", async (context) => {
  const login = await stagedImport("dist/src/auth/login-qr.js");
  let pollingSignal;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).includes("get_bot_qrcode")) {
      return new Response(
        JSON.stringify({
          qrcode: "cancel-code",
          qrcode_img_content: "https://example.test/cancel",
        }),
      );
    }
    pollingSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(new DOMException("Cancelled", "AbortError")),
        { once: true },
      );
    });
  });
  const start = await login.startWeixinLoginWithQr({ apiBaseUrl: "https://example.test" });
  const waiting = login.waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: "https://example.test",
    polling: true,
  });
  assert.equal(pollingSignal.aborted, false);
  login.cancelWeixinLogin(start.sessionKey);
  assert.equal(pollingSignal.aborted, true);
  const result = await waiting;
  assert.equal(result.cancelled, true);
  assert.equal(result.connected, false);
});

test("a cancelled QR cannot return credentials even if the request completes late", async (context) => {
  const login = await stagedImport("dist/src/auth/login-qr.js");
  let complete;
  context.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("get_bot_qrcode")) {
      return new Response(
        JSON.stringify({ qrcode: "late-code", qrcode_img_content: "https://example.test/late" }),
      );
    }
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const start = await login.startWeixinLoginWithQr({ apiBaseUrl: "https://example.test" });
  const waiting = login.waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: "https://example.test",
    polling: true,
  });
  login.cancelWeixinLogin(start.sessionKey);
  complete(
    new Response(
      JSON.stringify({ status: "confirmed", ilink_bot_id: "late-owner", bot_token: "late-token" }),
    ),
  );
  const result = await waiting;
  assert.equal(result.cancelled, true);
  assert.equal(result.connected, false);
  assert.equal(result.botToken, undefined);
});

test("an updates timeout cannot masquerade as an authenticated response", async (context) => {
  const api = await stagedImport("dist/src/api/api.js");
  context.mock.method(globalThis, "fetch", async () => {
    throw new DOMException("Timed out", "AbortError");
  });
  let timeouts = 0;
  await api.getUpdates({
    baseUrl: "https://example.test",
    onPollTimeout: () => {
      timeouts++;
    },
  });
  assert.equal(timeouts, 1);
  const abort = new AbortController();
  abort.abort();
  await api.getUpdates({
    baseUrl: "https://example.test",
    abortSignal: abort.signal,
    onPollTimeout: () => {
      timeouts++;
    },
  });
  assert.equal(timeouts, 1);
});

test("desktop QR polling never blocks on terminal-only numeric verification", async (context) => {
  const login = await stagedImport("dist/src/auth/login-qr.js");
  context.mock.method(
    globalThis,
    "fetch",
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes("get_bot_qrcode")
            ? { qrcode: "fake-code", qrcode_img_content: "https://example.test/qr" }
            : { status: "need_verifycode" },
        ),
      ),
  );
  const start = await login.startWeixinLoginWithQr({ apiBaseUrl: "https://example.test" });
  const result = await login.waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: "https://example.test",
    polling: true,
  });
  assert.equal(result.connected, false);
  assert.match(result.message, /配对数字/);
  assert.equal(result.pending, undefined);
});

test("staged source and JavaScript use only the retained 10.2 SDK subpaths", () => {
  const runtimeFiles = fs
    .readdirSync(path.join(stageDir, "dist"), { recursive: true })
    .filter((file) => file.endsWith(".js"));
  assert.equal(runtimeFiles.length, compiledCount);
  const used = new Set();
  for (const relative of runtimeFiles) {
    const runtime = fs.readFileSync(path.join(stageDir, "dist", relative), "utf8");
    for (const match of runtime.matchAll(
      /(?:from\s*|import\()\s*["']openclaw\/plugin-sdk\/([^"']+)["']/g,
    )) {
      assert.ok(!retiredSdkPaths.has(match[1]), `${relative} still imports ${match[1]}`);
      assert.ok(supportedSdkPaths.has(match[1]), `Review SDK subpath ${match[1]} in ${relative}`);
      used.add(match[1]);
    }
    const sourceRelative = relative.replace(/\.js$/, ".ts");
    assert.equal(
      fs.readFileSync(path.join(stageDir, sourceRelative), "utf8"),
      fs.readFileSync(path.join(sourceDir, sourceRelative), "utf8"),
    );
  }
  for (const required of [
    "command-auth-native",
    "config-mutation",
    "temp-path",
    "file-lock",
    "channel-outbound",
  ]) {
    assert.ok(used.has(required), `Missing migrated SDK import ${required}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(stageDir, "package.json"), "utf8"));
  assert.equal(pkg.peerDependencies.openclaw, ">=2026.10.2");
  assert.equal(pkg.microclaw.sdkCompatibility, "2026.10.5");
  assert.equal(pkg.engines.node, ">=24.16.0 <25 || >=26.1.0");
});

test("emitted authorization preserves pairing and fails closed without an allowlist", async () => {
  const { resolveWeixinCommandAuthorization: authorize } = await stagedImport(
    "dist/src/auth/authorization.js",
  );
  assert.deepEqual(authorize({}, "/status", "owner", ["owner"]), {
    senderAllowedForCommands: true,
    commandAuthorized: true,
  });

  assert.deepEqual(authorize({}, "/status", "stranger", ["owner"]), {
    senderAllowedForCommands: false,
    commandAuthorized: false,
  });
  assert.deepEqual(authorize({}, "hello", "owner", ["owner"]), {
    senderAllowedForCommands: true,
    commandAuthorized: undefined,
  });
  assert.deepEqual(authorize({}, "/status", "legacy", []), {
    senderAllowedForCommands: false,
    commandAuthorized: false,
  });
  assert.deepEqual(
    authorize({ commands: { useAccessGroups: false } }, "/status", "stranger", ["owner"]),
    {
      senderAllowedForCommands: false,
      commandAuthorized: true,
    },
  );
});

test("emitted dispatch aborts when the authenticated account generation changes", () => {
  const source = fs.readFileSync(
    path.join(stageDir, "dist", "src", "messaging", "process-message.js"),
    "utf8",
  );
  assert.match(source, /onWeixinAccountChanged/);
  assert.match(source, /watchWeixinAccountState/);
  assert.match(source, /setInterval\(abortIfAccountChanged,\s*50\)/);
  assert.match(source, /accountAbortController\.abort/);
  assert.match(source, /abortSignal:\s*accountAbortController\.signal/);
  assert.match(source, /assertAccountStillActive\(\);\s*await sendMessageWeixin/);
  assert.match(source, /assertAccountStillActive\(\);\s*await sendWeixinMediaFile/);
  assert.doesNotMatch(source, /legacyUserId/);

  const sendSource = fs.readFileSync(
    path.join(stageDir, "dist", "src", "messaging", "send.js"),
    "utf8",
  );
  assert.match(sendSource, /assertSendActive\(opts\);\s*await sendMessageApi/g);

  const mediaSource = fs.readFileSync(
    path.join(stageDir, "dist", "src", "messaging", "send-media.js"),
    "utf8",
  );
  assert.match(mediaSource, /await uploadVideoToWeixin[\s\S]*assertActive\(\)/);
  assert.match(mediaSource, /await uploadFileToWeixin[\s\S]*assertActive\(\)/);
  assert.match(mediaSource, /await uploadFileAttachmentToWeixin[\s\S]*assertActive\(\)/);

  const approvalSource = fs.readFileSync(
    path.join(stageDir, "dist", "src", "security", "remote-approval.js"),
    "utf8",
  );
  assert.match(approvalSource, /if \(!this\.isActiveAccount\(\)\)/);
  assert.match(approvalSource, /isActive:\s*\(\) => this\.isActiveAccount\(to\)/);
  assert.match(
    approvalSource,
    /isActiveWeixinAccount\(this\.options\.accountId, this\.options\.token, to\)/,
  );
});

test("emitted login reload atomically updates only the Weixin timestamp", async () => {
  const sdk = await stagedImport("node_modules/openclaw/config-mutation.js");
  const { triggerWeixinChannelReload } = await stagedImport("dist/src/auth/accounts.js");
  const original = {
    gateway: { port: 18789 },
    channels: {
      telegram: { enabled: false },
      "openclaw-weixin": { enabled: true, accounts: { owner: { name: "Owner" } } },
    },
  };
  sdk.reset(original);
  assert.equal(await triggerWeixinChannelReload(), true);
  assert.notEqual(sdk.config, original);
  const stamp = sdk.config.channels["openclaw-weixin"].channelConfigUpdatedAt;
  assert.ok(Number.isFinite(Date.parse(stamp)));
  const expected = structuredClone(original);
  expected.channels["openclaw-weixin"].channelConfigUpdatedAt = stamp;
  assert.deepEqual(sdk.config, expected);
  assert.equal(original.channels["openclaw-weixin"].channelConfigUpdatedAt, undefined);

  sdk.reset({});
  assert.equal(await triggerWeixinChannelReload(), true);
  assert.ok(sdk.config.channels["openclaw-weixin"].channelConfigUpdatedAt);
});

test("emitted CLI login reports structured activation outcomes", () => {
  const channel = fs.readFileSync(path.join(stageDir, "dist", "src", "channel.js"), "utf8");
  assert.match(channel, /MICROCLAW_WEIXIN_LOGIN_OUTCOME_TOKEN/);
  assert.match(channel, /\[microclaw-weixin-activation:/);
  assert.match(channel, /reload-requested/);
  assert.match(channel, /already-active/);
  assert.match(channel, /reload-failed/);
  assert.match(channel, /await triggerWeixinChannelReload\(\)/);
});

test("failed config mutation preserves configuration and logs the failure", async () => {
  const sdk = await stagedImport("node_modules/openclaw/config-mutation.js");
  const { triggerWeixinChannelReload } = await stagedImport("dist/src/auth/accounts.js");
  const original = { gateway: { port: 18789 } };
  sdk.reset(original, new Error("write denied"));
  assert.equal(await triggerWeixinChannelReload(), false);
  assert.equal(sdk.config, original);
  const logs = fs
    .readdirSync(path.join(tempDir, "logs"))
    .map((file) => fs.readFileSync(path.join(tempDir, "logs", file), "utf8"))
    .join("\n");
  assert.match(logs, /triggerWeixinChannelReload: failed to update config: Error: write denied/);
  sdk.reset({});
});

test("staging rejects mismatched upstream versions", () => {
  const mismatch = path.join(tempDir, "mismatch");
  fs.mkdirSync(mismatch);
  fs.writeFileSync(path.join(mismatch, "package.json"), JSON.stringify({ version: "0.0.0" }));
  assert.throws(() => stageWeixinRuntime(sourceDir, mismatch), /versions do not match/);
});

test("prepared package resource is provenance-pinned and excludes a nested OpenClaw core", () => {
  const destination = path.join(tempDir, "packaged-resource");
  const manifest = prepareWeixinPluginResource({ source: sourceDir, destination });
  assert.equal(manifest.contract, WEIXIN_RUNTIME_MANIFEST_CONTRACT);
  assert.equal(manifest.packageVersion, "2.4.6");
  assert.equal(manifest.sdkCompatibility, "2026.10.5");
  assert.ok(manifest.files.length > 0);
  assert.ok(manifest.requiredOpenClawExports.includes("./plugin-sdk/command-auth-native"));
  assert.ok(!manifest.requiredOpenClawExports.includes("./plugin-sdk/infra-runtime"));
  assert.equal(fs.existsSync(path.join(destination, "node_modules", "openclaw")), false);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(destination, "node_modules", "qrcode-terminal", "package.json")),
    ).version,
    "0.12.0",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(destination, "node_modules", "zod", "package.json")))
      .version,
    "4.4.3",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(destination, "microclaw-runtime.json"), "utf8"))
      .treeSha256,
    manifest.treeSha256,
  );
});

test("the packaged plugin registers an admin-only cancellation RPC without starting login", async (context) => {
  const destination = path.join(tempDir, "rpc-resource");
  prepareWeixinPluginResource({ source: sourceDir, destination });
  fs.cpSync(
    path.join(stageDir, "node_modules/openclaw"),
    path.join(destination, "node_modules/openclaw"),
    { recursive: true },
  );
  let fetches = 0;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    fetches++;
    if (String(url).includes("get_bot_qrcode")) {
      return new Response(
        JSON.stringify({ qrcode: "rpc-code", qrcode_img_content: "https://example.test/rpc" }),
      );
    }
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(new DOMException("Cancelled", "AbortError")),
        { once: true },
      );
    });
  });
  const entry = await import(pathToFileURL(path.join(destination, "dist/index.js")).href);
  let plugin;
  let cancel;
  entry.default.register({
    runtime: { version: "2026.10.5" },
    registerChannel: (registration) => {
      plugin = registration.plugin;
    },
    registerGatewayMethod: (method, handler, options) => {
      assert.equal(method, "weixin.login.cancel");
      assert.equal(options.scope, "operator.admin");
      cancel = handler;
    },
  });
  assert.equal(fetches, 0);
  const invalid = [];
  cancel({ params: {}, respond: (...args) => invalid.push(args) });
  assert.equal(invalid[0][0], false);
  assert.equal(invalid[0][2].code, "INVALID_REQUEST");
  const start = await plugin.gateway.loginWithQrStart({});
  const waiting = plugin.gateway.loginWithQrWait({ sessionKey: start.sessionKey });
  const responses = [];
  cancel({ params: { sessionKey: start.sessionKey }, respond: (...args) => responses.push(args) });
  assert.deepEqual(responses[0], [true, { cancelled: true }]);
  const result = await waiting;
  assert.equal(result.connected, false);
  assert.equal(result.cancelled, true);
  assert.equal(fetches, 2);
});
