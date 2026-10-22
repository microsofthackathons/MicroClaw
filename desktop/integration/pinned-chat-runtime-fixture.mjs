import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export function runPinnedChatRuntimeFixture() {
  const packageDir = process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR;
  if (!packageDir) throw new Error("MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR is required");
  const filename = path.join(packageDir, "dist", "chat-history-handler-Bl3TJIG1.mjs");
  const ast = ts.createSourceFile(
    filename,
    readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let producer;
  let projection;
  function visit(node) {
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (entry) =>
          entry.name.getText(ast) === "activeRunState" &&
          entry.initializer?.getText(ast).startsWith("resolveVisibleActiveSessionRunState("),
      )
    ) {
      assert.equal(producer, undefined, "Expected one pinned history runtime projection");
      producer = node.getText(ast);
      const statements = node.parent.statements;
      projection = statements[statements.indexOf(node) + 1].getText(ast);
      assert.ok(projection.startsWith("if (sessionInfo)"));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(producer && projection, "Pinned history runtime producer missing");
  const child = spawnSync(
    process.execPath,
    [
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "fixtures",
        "pinned-chat-runtime-worker.mjs",
      ),
    ],
    {
      encoding: "utf8",
      input: JSON.stringify({ producer, projection }),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (child.error || child.status !== 0)
    throw new Error(`Pinned runtime execution failed: ${child.error ?? child.stderr}`);
  const result = child.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("PINNED_RUNTIME_RESULT="));
  if (!result) throw new Error("Pinned runtime execution returned no fixture");
  return JSON.parse(result.slice("PINNED_RUNTIME_RESULT=".length));
}
