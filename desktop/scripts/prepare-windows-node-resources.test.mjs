import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("both native publishes use the same isolated NuGet configuration", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "microclaw-native-restore-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, "desktop", "scripts");
  const host = path.join(root, "windows-node-host");
  const shared = path.join(
    root,
    "third_party",
    "openclaw-windows-node",
    "source",
    "src",
    "OpenClaw.Shared",
  );
  for (const directory of [scripts, host, shared]) mkdirSync(directory, { recursive: true });
  for (const name of ["prepare-windows-node-resources.mjs", "publish-prepared-resource.mjs"]) {
    copyFileSync(new URL(name, import.meta.url), path.join(scripts, name));
  }
  const configSource = new URL("../../windows-node-host/NuGet.Config", import.meta.url);
  if (existsSync(configSource)) copyFileSync(configSource, path.join(host, "NuGet.Config"));
  writeFileSync(path.join(shared, "OpenClaw.Shared.csproj"), "<Project />");
  writeFileSync(path.join(root, "desktop", "package.json"), '{"version":"1.0.1"}');
  const probe = path.join(root, "probe.cjs");
  const calls = path.join(root, "calls.json");
  writeFileSync(
    probe,
    `
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const calls = [];
Object.defineProperty(process, "platform", { value: "win32" });
childProcess.spawnSync = (command, args) => {
  if (command === "git") {
    return { status: 0, stdout: "f0592215f27100d9ecece33d3069daac76a4125c\\n" };
  }
  if (command === "dotnet") {
    calls.push(args);
    fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify(calls));
    return { status: calls.length === 2 ? 23 : 0 };
  }
  const output = args[args.indexOf("-PayloadDirectory") + 1];
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "payload-manifest.json"), "{}");
  return { status: 0 };
};
require("node:module").syncBuiltinESMExports();
`,
  );
  const result = spawnSync(
    process.execPath,
    ["--require", probe, path.join(scripts, "prepare-windows-node-resources.mjs"), "--arch=x64"],
    { encoding: "utf8", cwd: root },
  );
  assert.equal(result.status, 23, result.stdout + result.stderr);
  const publishes = JSON.parse(readFileSync(calls, "utf8"));
  assert.equal(publishes.length, 2);
  for (const args of publishes) {
    const config = args.find((argument) => argument.startsWith("-p:RestoreConfigFile="));
    assert.ok(config, "publish must not inherit upstream/user NuGet sources");
    const configPath = config.slice("-p:RestoreConfigFile=".length);
    assert.equal(configPath, path.join(host, "NuGet.Config"));
    assert.ok(existsSync(configPath));
    assert.equal(args[args.indexOf("--runtime") + 1], "win-x64");
    assert.equal(args[args.indexOf("--self-contained") + 1], "true");
    assert.ok(args.includes("-p:ImportDirectoryBuildProps=false"));
    assert.ok(args.includes("-p:ImportDirectoryBuildTargets=false"));
    assert.ok(!args.includes("--ignore-failed-sources"));
    assert.ok(!args.includes("--no-restore"));
  }
  assert.match(publishes[0][1], /OpenClaw\.FileWorker\.csproj$/);
  assert.match(publishes[1][1], /MicroClaw\.WindowsNodeHost\.csproj$/);
});
