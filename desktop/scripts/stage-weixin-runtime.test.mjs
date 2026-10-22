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

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-weixin-sdk-"));
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
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function stagedImport(relative) {
  return import(pathToFileURL(path.join(stageDir, relative)).href);
}

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
  assert.equal(pkg.microclaw.sdkCompatibility, "2026.10.2");
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
  assert.equal(manifest.sdkCompatibility, "2026.10.2");
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
