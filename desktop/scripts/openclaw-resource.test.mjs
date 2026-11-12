import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPackage } from "@electron/asar";
import {
  readOpenClawTarget,
  verifyNodeVersion,
  verifyOpenClawArchive,
} from "./openclaw-resource.mjs";

async function fixture(context, version, { entry = true, name = "openclaw", engine } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "microclaw-core-resource-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source/node_modules/openclaw");
  mkdirSync(source, { recursive: true });
  writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({
      name,
      version,
      engines: { node: engine ?? ">=24.16.0 <25 || >=26.1.0" },
    }),
  );
  if (entry) writeFileSync(path.join(source, "openclaw.mjs"), "export {};\n");
  const archive = path.join(root, "openclaw.asar");
  await createPackage(path.join(root, "source"), archive);
  return archive;
}

test("release resources require the exact target, not a stale bundled core", async (context) => {
  const target = readOpenClawTarget();
  assert.equal(verifyOpenClawArchive(await fixture(context, target), target), target);
  const stale = await fixture(context, "2026.10.5");
  assert.throws(() => verifyOpenClawArchive(stale, "2026.10.10"), /mismatch/);
});

test("release resources reject missing entries, wrong packages and unknown engines", async (context) => {
  const target = readOpenClawTarget();
  for (const [options, message] of [
    [{ entry: false }, /missing openclaw.mjs/],
    [{ name: "not-openclaw" }, /mismatch/],
    [{ engine: ">=28" }, /Unaudited/],
  ]) {
    const archive = await fixture(context, target, options);
    assert.throws(() => verifyOpenClawArchive(archive, target), message);
  }
});

test("bundled Node follows the installer engine policy", () => {
  for (const version of ["24.16.0", "v24.18.0", "26.1.0", "26.13.0", "27.0.0"]) {
    assert.equal(verifyNodeVersion(version), version);
  }
  for (const version of [
    "24.15.9",
    "25.9.0",
    "26.0.9",
    "026.1.0",
    "26.1.0-beta.1",
    "26",
    "26.1.0\n",
  ]) {
    assert.throws(() => verifyNodeVersion(version));
  }
});
