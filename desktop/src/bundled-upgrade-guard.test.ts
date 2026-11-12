import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  assertBundledUpgradeComplete,
  assertRuntimeReplacementAllowed,
} from "./bundled-upgrade-guard";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(phase: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-upgrade-guard-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "upgrade"));
  fs.writeFileSync(
    path.join(root, "upgrade", "bundled-upgrade.json"),
    JSON.stringify({ schema: 1, desktop: root, phase }),
  );
  return root;
}
it.each(["installing", "validating", "rolling-back", "failed", "backing-up", "unknown"])(
  "blocks normal startup during %s",
  (phase) => {
    expect(() => assertBundledUpgradeComplete(fixture(phase))).toThrow("Run the installer again");
  },
);
it.each(["committed", "rolled-back"])("allows startup after %s", (phase) => {
  expect(() => assertBundledUpgradeComplete(fixture(phase))).not.toThrow();
});
it("fails closed for malformed records", () => {
  const root = fixture("committed");
  fs.writeFileSync(path.join(root, "upgrade", "bundled-upgrade.json"), "{");
  expect(() => assertBundledUpgradeComplete(root)).toThrow("unreadable");
});

it("requires an installer recovery point before changing runtime versions", () => {
  const desktop = fixture("installing");
  const runtime = path.join(desktop, "test-runtime");
  fs.mkdirSync(path.join(runtime, "node_modules", "openclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(runtime, "node_modules", "openclaw", "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.10.5" }),
  );
  expect(() => assertRuntimeReplacementAllowed(runtime, "2026.10.10", desktop, false)).toThrow(
    "requires the installer",
  );
  expect(() => assertRuntimeReplacementAllowed(runtime, "2026.10.5", desktop, false)).not.toThrow();
  expect(() => assertRuntimeReplacementAllowed(runtime, "2026.10.10", desktop, true)).toThrow();
  fs.writeFileSync(
    path.join(desktop, "upgrade", "bundled-upgrade.json"),
    JSON.stringify({
      schema: 1,
      phase: "installing",
      desktop,
      runtime,
      targetVersion: "2026.10.10",
      archiveSha256: "a".repeat(64),
    }),
  );
  expect(() => assertRuntimeReplacementAllowed(runtime, "2026.10.10", desktop, true)).not.toThrow();
});
