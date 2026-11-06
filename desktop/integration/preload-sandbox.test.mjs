import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ts from "typescript";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(desktop, "integration", "fixtures", "preload-sandbox-main.mjs");
describe.skipIf(process.platform !== "win32")(
  "actual emitted preload in native Electron sandbox",
  () => {
    let root;
    let emitted;
    beforeAll(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-preload-boundary-"));
      emitted = path.join(root, "code");
      const parsed = ts.getParsedCommandLineOfConfigFile(
        path.join(desktop, "tsconfig.json"),
        {
          outDir: emitted,
          noEmit: false,
          declaration: false,
          declarationMap: false,
          sourceMap: false,
          incremental: false,
          composite: false,
        },
        ts.sys,
      );
      assert.ok(parsed);
      const program = ts.createProgram(
        [
          path.join(desktop, "src", "preload.ts"),
          path.join(desktop, "src", "chat-session-update.ts"),
        ],
        parsed.options,
      );
      const errors = ts
        .getPreEmitDiagnostics(program)
        .filter((value) => value.category === ts.DiagnosticCategory.Error);
      assert.deepEqual(
        errors.map((value) => ts.flattenDiagnosticMessageText(value.messageText, "\n")),
        [],
      );
      assert.equal(program.emit().emitSkipped, false);
    }, 30000);
    afterAll(() => {
      if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    });
    function run(preload, name) {
      const result = path.join(root, `${name}.json`);
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      const child = spawnSync(
        path.join(desktop, "node_modules", "electron", "dist", "electron.exe"),
        [
          fixture,
          preload,
          path.join(emitted, "chat-session-update.js"),
          result,
          path.join(root, name),
        ],
        { env, encoding: "utf8", timeout: 25000 },
      );
      assert.equal(child.status, 0, child.error?.message ?? child.stderr);
      const evidence = JSON.parse(fs.readFileSync(result, "utf8"));
      if (process.env.MICROCLAW_PRELOAD_SANDBOX_EVIDENCE_DIR)
        fs.copyFileSync(
          result,
          path.join(
            process.env.MICROCLAW_PRELOAD_SANDBOX_EVIDENCE_DIR,
            `preload-native-${name}.json`,
          ),
        );
      return evidence;
    }
    it("exposes the real bridge and delivers/removes minimal session updates with native sandbox defaults", () => {
      const result = run(path.join(emitted, "preload.js"), "fixed");
      expect(result).toMatchObject({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        errors: [],
        bridge: { present: true, observeSession: "function", onSessionUpdate: "function" },
        observed: [{ sessionKey: "agent:main:fixture" }, { sessionKey: null }],
        received: [{ sessionKey: "agent:main:fixture" }],
      });
    }, 30000);
    it("reproduces bridge loss for a runtime relative import even when the local module exists", () => {
      const broken = path.join(emitted, "preload-with-local-import.js");
      fs.writeFileSync(
        broken,
        'require("./chat-session-update");\n' +
          fs.readFileSync(path.join(emitted, "preload.js"), "utf8"),
      );
      const result = run(broken, "relative-import-rejected");
      expect(result.sandbox).toBe(true);
      expect(result.errors).toContainEqual({
        name: "Error",
        message: "module not found: ./chat-session-update",
      });
      expect(result.bridge.present).toBe(false);
    }, 30000);
  },
);
