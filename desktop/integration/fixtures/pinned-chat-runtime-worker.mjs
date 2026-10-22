import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageDir = process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR;
assert.ok(packageDir);
assert.equal(
  JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")).version,
  "2026.10.2",
);
const root = mkdtempSync(path.join(os.tmpdir(), "microclaw-pinned-runtime-"));
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
process.env.OPENCLAW_AGENT_DIR = path.join(root, "agent");
process.env.VITEST = "true";
writeFileSync(process.env.OPENCLAW_CONFIG_PATH, "{}");
try {
  const { producer, projection } = JSON.parse(readFileSync(0, "utf8"));
  const project = new Function(
    "resolveVisibleActiveSessionRunState",
    "context",
    "sessionKey",
    "canonicalKey",
    "sessionId",
    "sessionAgentId",
    "compatibilityOwnerAgentId",
    "sessionInfo",
    `${producer}\n${projection}\nreturn { activeRunState, sessionInfo };`,
  );
  const load = (name) => import(pathToFileURL(path.join(packageDir, "dist", name)).href);
  const active = await load("session-active-runs-Du3LxqiP.mjs");
  const registry = await load("agent-run-registry-BaxMDLZF.mjs");
  const capacity = await load("agent-run-capacity-wait-DqF7E2c_.mjs");
  const embedded = await load("runs-Ma7YZr5h.mjs");
  const rows = await load("session-row-prepared-read-CPxnabxQ.mjs");
  const snapshot = await load("session-event-payload-q4CE5TPZ.mjs");
  const message = await load("session-transcript-message-1hd1eWEF.mjs");
  const key = "agent:main:main";
  const sessionId = "fixture-runtime";
  const cfg = {
    agents: { list: [{ id: "main" }], defaults: { model: { primary: "openai/gpt-4" } } },
  };
  const records = [];
  function capture(name, controllers = new Map()) {
    const entry = { sessionId, updatedAt: 1000 };
    const row = rows.P({
      cfg,
      storePath: path.join(root, "sessions.json"),
      store: { [key]: entry },
      key,
      entry,
      agentId: "main",
      lightweightListRow: true,
      skipTranscriptUsageFallback: true,
      now: 1000,
    });
    const { activeRunState, sessionInfo } = project(
      active.i,
      { chatAbortControllers: controllers },
      key,
      key,
      sessionId,
      "main",
      "main",
      row,
    );
    assert.equal(sessionInfo.key, key);
    const sessionSnapshot = snapshot.t({
      sessionRow: row,
      agentId: "main",
      includeSession: true,
      activeRunState,
    });
    const projected = message.t({
      sessionKey: key,
      agentId: "main",
      message: {
        role: "user",
        content: [{ type: "text", text: "Phone folder request" }],
        timestamp: 1000,
      },
      messageId: "fixture-phone-message",
      messageSeq: 1,
      runId: "fixture-phone-run",
      sessionSnapshot,
      projectCurrentUserProfile: (value) => value,
      resolveCronJobName: () => undefined,
    });
    assert.ok(projected.payload);
    records.push({
      name,
      activeRunState,
      history: { sessionKey: key, sessionInfo, messages: [projected.payload.message] },
      event: { type: "event", event: "session.message", payload: projected.payload },
    });
  }
  capture("idle");
  capture(
    "tracked-running",
    new Map([["fixture-known-run", { sessionKey: key, sessionId, agentId: "main" }]]),
  );
  capture(
    "terminal-persistence",
    new Map([
      [
        "fixture-terminal",
        {
          sessionKey: key,
          sessionId,
          agentId: "main",
          projectSessionActive: false,
          projectSessionTerminalPending: true,
        },
      ],
    ]),
  );
  registry.y("fixture-projected", {
    sessionKey: key,
    sessionId,
    agentId: "main",
    projectSessionActive: true,
  });
  capture("projected-running");
  const releaseCapacity = capacity.n("fixture-projected", registry.d());
  assert.equal(typeof releaseCapacity, "function");
  try {
    capture("projected-queued");
  } finally {
    releaseCapacity();
    registry.a("fixture-projected");
  }
  const handle = {
    runId: "fixture-embedded",
    isAborted: () => false,
    isStreaming: () => false,
    abort() {},
  };
  embedded.N(sessionId, handle, key, path.join(root, "transcript.jsonl"), "main");
  try {
    capture("embedded-running-or-approval-wait");
  } finally {
    embedded.i(sessionId, handle, key, path.join(root, "transcript.jsonl"));
  }
  capture("after-terminal-cleanup");
  process.stdout.write("PINNED_RUNTIME_RESULT=" + JSON.stringify({ key, records }) + "\n");
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
}
