import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { updateSignedWindowsNodeManifest } from "./update-signed-windows-node-manifest.mjs";

const require = createRequire(import.meta.url);
require("app-builder-lib");
const { WinPackager } = require("app-builder-lib/out/winPackager");
const { load } = require("js-yaml");
const builder = load(readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));
const shouldSign = (file) =>
  WinPackager.prototype.shouldSignFile.call(
    { platformSpecificBuildOptions: { signExts: builder.win.signExts } },
    file,
  );
const hash = (content) => createHash("sha256").update(content).digest("hex");
const fileHash = (file) => hash(readFileSync(file));

function createResources(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "microclaw-signed-resources-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = path.join(root, "host");
  mkdirSync(host);
  writeFileSync(path.join(host, "microclaw-windows-node-host.exe"), "host");
  const manifest = {
    runtimeIdentifier: "win-x64",
    contract: "microclaw.windows-node-exec.v2",
  };
  writeFileSync(path.join(root, "RUNTIME.json"), JSON.stringify(manifest));

  const workerFiles = {
    "OpenClaw.FileWorker.exe": "worker",
    "coreclr.dll": "coreclr",
    "createdump.exe": "createdump",
  };
  const payload = JSON.stringify({
    version: 1,
    rid: "win-x64",
    files: Object.fromEntries(
      Object.entries(workerFiles).map(([name, value]) => [name, hash(value)]),
    ),
  });
  const slot = path.join(host, "Workers", "FileWorker", "win-x64", hash(payload).slice(0, 32));
  mkdirSync(slot, { recursive: true });
  writeFileSync(path.join(slot, "payload-manifest.json"), payload);
  for (const [name, content] of Object.entries(workerFiles)) {
    writeFileSync(path.join(slot, name), content);
  }
  return { root, host, slot };
}

test("electron-builder signs MicroClaw hosts but not pinned upstream executables", () => {
  for (const name of [
    "OpenClaw.FileWorker.exe",
    "createdump.exe",
    "plm.exe",
    "wxc-wslc-daemon.exe",
  ]) {
    assert.equal(shouldSign(name), false, name);
  }
  assert.equal(shouldSign("microclaw-windows-node-host.exe"), true);
});

test("post-sign update preserves the worker and records signed host hashes", (t) => {
  const { root, host, slot } = createResources(t);
  const workerHash = fileHash(path.join(slot, "createdump.exe"));
  const hostExe = path.join(host, "microclaw-windows-node-host.exe");
  appendFileSync(hostExe, "-signed");
  updateSignedWindowsNodeManifest(root);
  const manifest = JSON.parse(readFileSync(path.join(root, "RUNTIME.json"), "utf8"));
  assert.equal(manifest.hostSha256, fileHash(hostExe));
  assert.equal(manifest.contract, "microclaw.windows-node-exec.v2");
  assert.equal(manifest.canvasHostSha256, undefined);
  assert.equal(manifest.packagedHashStage, "electron-builder-after-sign");
  assert.equal(fileHash(path.join(slot, "createdump.exe")), workerHash);
});

test("post-sign update rejects changed fixed-worker files and inventory", (t) => {
  const { root, slot } = createResources(t);
  appendFileSync(path.join(slot, "createdump.exe"), "-signed");
  assert.throws(() => updateSignedWindowsNodeManifest(root), /Fixed-worker payload changed/);
  writeFileSync(path.join(slot, "createdump.exe"), "createdump");
  writeFileSync(path.join(slot, "unexpected.exe"), "unexpected");
  assert.throws(
    () => updateSignedWindowsNodeManifest(root),
    /Fixed-worker payload inventory changed/,
  );
});

test("post-sign update rejects a changed fixed-worker manifest", (t) => {
  const { root, slot } = createResources(t);
  appendFileSync(path.join(slot, "payload-manifest.json"), " ");
  assert.throws(
    () => updateSignedWindowsNodeManifest(root),
    /Fixed-worker manifest does not match/,
  );
});

test("post-sign update rejects legacy Canvas-capable runtime manifests", (t) => {
  const { root } = createResources(t);
  const runtimePath = path.join(root, "RUNTIME.json");
  const manifest = JSON.parse(readFileSync(runtimePath, "utf8"));
  delete manifest.contract;
  writeFileSync(runtimePath, JSON.stringify(manifest));
  assert.throws(() => updateSignedWindowsNodeManifest(root), /runtime contract is unsupported/);
});
