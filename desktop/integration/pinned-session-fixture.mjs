import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export function createPinnedAgentRunStartNotifier(callback, runId) {
  const packageDir = process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR;
  if (!packageDir) throw new Error("MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR is required");
  const filename = path.join(packageDir, "dist", "agent-runner-run-A-6vq8xD.mjs");
  const ast = ts.createSourceFile(
    filename,
    readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "notifyAgentRunStart")
      initializer = node.initializer?.getText(ast);
    if (!initializer) ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!initializer) throw new Error("Pinned SDK run-start notifier missing");
  return new Function(
    "params",
    "runId",
    "admittedRunContext",
    "markReplyOperationExecutionStarted",
    `let active = true; let preparedTranscriptStart = null; let didNotifyAgentRunStart = false; return ${initializer};`,
  )(
    { opts: { onAgentRunStart: callback }, followupRun: { run: {} } },
    runId,
    { current: { executionIdentityToken: "test-only-sdk-execution-identity" } },
    () => {},
  );
}

export function runPinnedSessionFixture() {
  const packageDir = process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR;
  if (!packageDir) throw new Error("MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR is required");
  const filename = path.join(packageDir, "dist", "sessions-subscriptions-Dzf50guT.mjs");
  const source = readFileSync(filename, "utf8");
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (entry) => entry.name.getText(ast) === "sessionSubscriptionHandlers",
      ),
  );
  if (!declaration) throw new Error("Pinned session subscription handlers missing");
  const url = (module) => pathToFileURL(path.join(packageDir, "dist", module)).href;
  const script = `
    import assert from "node:assert/strict";
    const schema = await import(${JSON.stringify(url("src-yRoHchex.mjs"))});
    const validation = await import(${JSON.stringify(url("validation-CX4u4B7f.mjs"))});
    const targets = await import(${JSON.stringify(url("session-store-key-DWRWEBC7.mjs"))});
    const subscription = await import(${JSON.stringify(url("session-request-agent-DL158H5j.mjs"))});
    const shared = await import(${JSON.stringify(url("sessions-shared-Dr0eLQJX.mjs"))});
    const errors = await import(${JSON.stringify(url("session-mutation-authorization-error-Cdqn6r49.mjs"))});
    const { t: snapshot } = await import(${JSON.stringify(url("session-event-payload-CH4svjwS.mjs"))});
    const { t: message } = await import(${JSON.stringify(url("session-transcript-message-e1G8Akuv.mjs"))});
    const factory = new Function(
      "defineValidatedGatewayHandler", "validateSessionsMessagesSubscribeParams",
      "validateSessionsMessagesUnsubscribeParams", "validateSessionsViewerPresenceSetParams",
      "assertValidParams", "validateSessionsListParams", "resolveRequestedSessionStoreTarget",
      "resolveSessionSubscriptionKey", "requireSessionKey", "retainSessionScopedRead",
      "readGatewayRequestMutationAuthority", "SessionMutationAuthorizationChangedError",
      ${JSON.stringify(declaration.getText(ast) + "; return sessionSubscriptionHandlers;")}
    );
    const handlers = factory(
      validation.n, schema.ea, schema.ta, schema.xa, validation.t, schema.$i,
      targets.n, subscription.c, shared.o,
      () => ({ assertCurrent() {}, release() {} }),
      () => ({ sessionScope: "operator.sessions.read" }), errors.t
    );
    const calls = [];
    const context = {
      getRuntimeConfig: () => ({ agents: { list: [{ id: "main" }] } }),
      subscribeSessionEvents: conn => calls.push({ method: "catalog", conn }),
      subscribeSessionMessageEvents: (conn, key, options) => {
        calls.push({ method: "messages", conn, key, options });
        const rollback = () => calls.push({ method: "rollback" });
        rollback.commit = () => calls.push({ method: "commit" });
        return rollback;
      },
    };
    async function invoke(method, params) {
      let reply;
      await handlers[method]({
        params, context, client: { connId: "fixture-connection" },
        respond: (ok, payload, error) => { reply = { ok, payload, error }; },
      });
      return reply;
    }
    const params = { key: "agent:main:main", agentId: "main", subscriptionId: "microclaw-desktop-chat" };
    const catalog = await invoke("sessions.subscribe", {});
    const ack = await invoke("sessions.messages.subscribe", params);
    assert.equal(ack.ok, true);
    const malformed = await invoke("sessions.messages.subscribe", { sessionKey: params.key });
    assert.equal(malformed.ok, false);
    const sessionRow = { key: params.key, sessionId: "fixture-session", status: "running" };
    const activeRunState = { active: true, status: "running", runIds: ["external-phone-run"] };
    const sessionSnapshot = snapshot({ sessionRow, agentId: "main", includeSession: true, activeRunState });
    const user = { role: "user", content: [{ type: "text", text: "Phone folder request" }], timestamp: 1000 };
    const projected = message({
      sessionKey: params.key, agentId: "main", message: user,
      messageId: "phone-message", messageSeq: 1, runId: "external-phone-run",
      sessionSnapshot, projectCurrentUserProfile: value => value,
      resolveCronJobName: () => undefined,
    });
    assert.ok(projected.payload);
    const events = [
      { type: "event", event: "session.message", payload: projected.payload },
      { type: "event", event: "sessions.changed", payload: {
        sessionKey: params.key, agentId: "main", reason: "run-capacity",
        ts: 1001, ...sessionSnapshot,
      } },
    ];
    console.log("PINNED_SESSION_RESULT=" + JSON.stringify({ params, catalog, ack, malformed, calls, events,
      history: { sessionKey: params.key, messages: [projected.payload.message], sessionInfo: {
        key: params.key, hasActiveRun: sessionSnapshot.hasActiveRun, activeRunIds: sessionSnapshot.activeRunIds,
      } },
    }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (child.error || child.status !== 0)
    throw new Error(`Pinned session execution failed: ${child.error ?? child.stderr}`);
  const result = child.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("PINNED_SESSION_RESULT="));
  if (!result) throw new Error("Pinned session execution returned no fixture");
  return JSON.parse(result.slice("PINNED_SESSION_RESULT=".length));
}
