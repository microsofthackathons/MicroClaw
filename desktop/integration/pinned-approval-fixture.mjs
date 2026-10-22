import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { URL, pathToFileURL } from "node:url";
import ts from "typescript";

export function runPinnedApprovalRequests(plan, recipient = "owner@im.wechat") {
  const packageDir = process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR;
  if (!packageDir) throw new Error("MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR is required");
  const filename = path.join(packageDir, "dist", "bash-tools.exec-approval-request-BhOTs75A.mjs");
  const source = readFileSync(filename, "utf8");
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  function declaration(name) {
    const node = ast.statements.find(
      (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    );
    if (!node) throw new Error(`Pinned approval builder missing: ${name}`);
    return node.getText(ast);
  }
  const builder = [
    declaration("buildExecApprovalTurnSourceContext"),
    declaration("buildHostApprovalDecisionParams"),
  ].join("\n");
  function sdkFunction(module, name) {
    const filename = path.join(packageDir, "dist", module);
    const ast = ts.createSourceFile(
      filename,
      readFileSync(filename, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const node = ast.statements.find(
      (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    );
    if (!node) throw new Error(`Pinned producer missing: ${module}:${name}`);
    return node.getText(ast);
  }
  const producers = {
    attempt: sdkFunction("embedded-agent-gW15apSG.mjs", "withPreparedEmbeddedGatewayTools"),
    caller: sdkFunction(
      "gateway-caller-context-DWr-fdGt.mjs",
      "createAdmittedGatewayToolCallerIdentity",
    ),
    receipt: sdkFunction("gateway-caller-context-DWr-fdGt.mjs", "composeReceiptAuthority"),
    runtime: sdkFunction("gateway-DijOw8Pm.mjs", "resolveAgentRuntimeIdentityForGatewayTool"),
    client: sdkFunction(
      "server-plugin-runtime-client-woXKGHqY.mjs",
      "projectPluginRuntimeClientExecution",
    ),
  };
  const identityModuleUrl = pathToFileURL(
    path.join(packageDir, "dist", "agent-runtime-identity-token-BDLmOOL-.mjs"),
  ).href;
  const modulePath = path.join(packageDir, "dist", "exec-approval-mGU7M4-K.mjs");
  const handlerSource = readFileSync(modulePath, "utf8");
  const alias =
    /createExecApprovalHandlers as (\w+)/.exec(handlerSource)?.[1] ??
    (/export \{ createExecApprovalHandlers \}/.test(handlerSource)
      ? "createExecApprovalHandlers"
      : undefined);
  if (!alias) throw new Error("Pinned approval handler export missing");
  const preload = new URL("../src/openclaw-approval-replay-compat.mjs", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    const DEFAULT_APPROVAL_TIMEOUT_MS = 120000;
    ${builder}
    const plan = ${JSON.stringify(plan)};
    const recipient = ${JSON.stringify(recipient)};
    const module = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
    const producer = ${JSON.stringify(producers)};
    const vm = await import("node:vm");
    const fs = await import("node:fs/promises");
    const authority = { operationalRunInstance: { runId: "actual-run", instanceId: "actual-instance" },
      lifecycleGeneration: "test-only-lifecycle", claimId: "test-only-admission-claim" };
    // Only admission authority lookup is stubbed; constructor/schema/field projection are actual SDK source.
    const identityModule = new vm.SourceTextModule(await fs.readFile(new URL(${JSON.stringify(identityModuleUrl)}), "utf8"), {
      identifier: ${JSON.stringify(identityModuleUrl)},
    });
    await identityModule.link(async (specifier) => {
      const url = specifier.startsWith(".") ? new URL(specifier, identityModule.identifier).href : specifier;
      const imported = await import(url);
      const values = { ...imported, ...(specifier.includes("agent-run-registry-") ? {
        c: () => authority, A: value => value.claimId === authority.claimId,
      } : {}) };
      return new vm.SyntheticModule(Object.keys(values), function() {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      });
    });
    await identityModule.evaluate();
    const evaluate = (source, name, deps) =>
      new Function(...Object.keys(deps), source + "; return " + name)(...Object.values(deps));
    async function produceIdentity(source = {}) {
      let caller;
      const admitted = evaluate(producer.receipt + "\\n" + producer.caller,
        "createAdmittedGatewayToolCallerIdentity", {
          getAdmittedRunDelegatedAuthority: () => authority,
          readAdmittedRunOperatorAuthority: () => undefined,
          getGatewayContextResolver: () => undefined,
          bindGatewayToolContextResolver: value => value,
        });
      const run = evaluate(producer.attempt, "withPreparedEmbeddedGatewayTools", {
        createAdmittedGatewayToolCallerIdentity: admitted,
        withGatewayToolCallerIdentity: async (identity, run) => { caller = identity; return run(); },
        getGatewayContextResolver: () => undefined,
      });
      await run({
        disableTools: true, agentId: "main", sessionKey: "agent:main:main",
        admittedRunContext: { operationalRunInstance: authority.operationalRunInstance },
        messageProvider: "openclaw-weixin", agentAccountId: "bot", currentChannelId: recipient,
        ...source,
      }, () => true, async () => undefined);
      const resolve = evaluate(producer.runtime, "resolveAgentRuntimeIdentityForGatewayTool", {
        OPTIONAL_LOCAL_AGENT_RUNTIME_IDENTITY_METHODS: new Set(),
        AGENT_RUNTIME_IDENTITY_METHODS: new Set(["exec.approval.request"]),
        getGatewayToolCallerIdentity: () => caller,
        trimToUndefined: value => value?.trim() || undefined,
        getGatewaySessionSpawnContext: () => undefined,
        getGatewaySessionSpawnParentExecutionIdentityToken: () => undefined,
        readAgentRuntimeExecutionLineage: () => undefined,
        getActiveAgentRunDelegatedAuthority: () => authority,
        createAgentRuntimeIdentity: identityModule.namespace.t,
      });
      const runtime = await resolve({ method: "exec.approval.request", opts: {}, target: "local", inProcess: true });
      const project = evaluate(producer.client, "projectPluginRuntimeClientExecution", {});
      return project({ identity: runtime, client: { internal: {}, connect: { scopes: [] } } })
        .internal.agentRuntimeIdentity;
    }
    const identity = await produceIdentity();
    assert.equal(identity.kind, "agentRuntime");
    assert.equal(identity.turnSourceChannel, "openclaw-weixin");
    assert.equal(identity.turnSourceAccountId, "bot");
    assert.equal(identity.turnSourceTo, recipient);
    const stop = new Error("test-record-captured");
    let captured;
    const manager = {
      getSnapshot: async () => undefined,
      create: request => { captured = request; throw stop; },
    };
    const handlers = module[${JSON.stringify(alias)}](manager);
    const results = [];
    for (const kind of ["trusted", "caller-forgery", "untrusted", "cross-agent", "cross-run",
      "valid-other-run", "valid-other-channel", "valid-other-account", "valid-other-recipient",
      "producer-without-channel", "producer-without-account", "producer-without-recipient"]) {
      captured = undefined;
      let response;
      const params = await buildHostApprovalDecisionParams({
        approvalId: "fixture-" + kind, host: "node", nodeId: "test-node",
        systemRunPlan: plan, sessionKey: plan.sessionKey, agentId: "main",
        toolCallId: "actual-tool", runId: "caller-forged-run",
        turnSourceChannel: "openclaw-weixin",
      });
      if (kind === "caller-forgery") params.remoteApprovalOrigin = {
        contract: "microclaw.gateway-approval-origin.v1", runSessionKey: "agent:main:main",
      };
      const runtime = kind.startsWith("producer-without-") ? await produceIdentity({
        ...(kind === "producer-without-channel" ? { messageProvider: undefined } : {}),
        ...(kind === "producer-without-account" ? { agentAccountId: undefined } : {}),
        ...(kind === "producer-without-recipient" ? { currentChannelId: undefined } : {}),
      }) : kind === "untrusted" ? undefined : {
        ...identity,
        ...(kind === "cross-agent" ? { agentId: "other" } : {}),
        ...(kind === "cross-run" ? { operationalRunInstance: {
          runId: "stale-run", instanceId: "stale-instance",
        } } : {}),
        ...(kind === "valid-other-run" ? { operationalRunInstance: {
          runId: "independent-desktop-run", instanceId: "independent-instance",
        } } : {}),
        ...(kind === "valid-other-channel" ? { turnSourceChannel: "webchat" } : {}),
        ...(kind === "valid-other-account" ? { turnSourceAccountId: "other-bot" } : {}),
        ...(kind === "valid-other-recipient" ? { turnSourceTo: "other@im.wechat" } : {}),
      };
      const authorizedIdentity = kind.startsWith("valid-other-") ? runtime : identity;
      try {
        await handlers["exec.approval.request"]({
          params,
          client: runtime ? { internal: { agentRuntimeIdentity: runtime } } : {},
          context: {
            validateAgentRuntimeApprovalAuthority: value =>
              value.agentId === authorizedIdentity.agentId &&
              value.operationalRunInstance.runId === authorizedIdentity.operationalRunInstance.runId &&
              value.operationalRunInstance.instanceId === authorizedIdentity.operationalRunInstance.instanceId,
            chatRunState: { hasAbortMarker: () => false },
            getRuntimeConfig: () => ({}),
          },
          respond: (ok, payload, error) => { response = { ok, error }; },
        });
      } catch (error) { if (error !== stop) throw error; }
      results.push({ kind, request: captured ?? null, response: response ?? null });
    }
    console.log("PINNED_APPROVAL_RESULT=" + JSON.stringify(results));
  `;
  const child = spawnSync(
    process.execPath,
    ["--experimental-vm-modules", "--import", preload, "--input-type=module", "-e", script],
    {
      env: {
        ...process.env,
        MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT: "1",
        MICROCLAW_MXC_APPROVAL_PRELOAD_INITIALIZED: "",
        MICROCLAW_OPENCLAW_PACKAGE_DIR: packageDir,
        MICROCLAW_MXC_APPROVAL_PROOF_SECRET: Buffer.alloc(32, 1).toString("base64"),
        MICROCLAW_MXC_APPROVAL_PROOF_GATEWAY_GENERATION: "test-generation",
        MICROCLAW_MXC_APPROVAL_PROOF_POLICY_FINGERPRINT: "b".repeat(64),
        MICROCLAW_MXC_APPROVAL_PROOF_NODE_ID: "a".repeat(64),
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  if (child.error || child.status !== 0)
    throw new Error(`Pinned approval execution failed: ${child.error ?? child.stderr}`);
  const result = child.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("PINNED_APPROVAL_RESULT="));
  if (!result) throw new Error("Pinned approval execution returned no fixture");
  return JSON.parse(result.slice("PINNED_APPROVAL_RESULT=".length));
}
