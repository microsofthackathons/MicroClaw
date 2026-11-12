import { Buffer } from "node:buffer";
import { createHash, createHmac, createPublicKey, randomUUID, verify } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

// Keep real-path checks on every load. Windows' native implementation avoids
// repeatedly walking each path component in JavaScript without caching identity.
const canonicalPath = process.platform === "win32" ? realpathSync.native : realpathSync;

const EXPECTED_VERSION = "2026.10.10";
const EXPECTED_NODE_GATEWAY_MODULE = "nodes-Cl-Air2F.mjs";
const EXPECTED_NODE_GATEWAY_SHA256 =
  "b9a4037588bbf8405a6f9149cb85f7750ae58fa777bd1dc675fc8eb857d5a978";
const EXPECTED_NODE_INVOKE_PLUGIN_POLICY_MODULE = "node-invoke-plugin-policy-GeGCY71G.mjs";
const EXPECTED_NODE_INVOKE_PLUGIN_POLICY_SHA256 =
  "29e2ad3edc93dc39ce03bffae28926f53bd7f432bbf417accc79302997603a27";
const EXPECTED_NODE_REGISTRY_PRIVATE_MODULE = "node-registry-private-CyaYRwVd.mjs";
const EXPECTED_NODE_REGISTRY_PRIVATE_SHA256 =
  "31510d11a6f80614e8c1d3d3b3c44eec42a61feb17cb05e051ad613ce6475228";
const EXPECTED_SYSTEM_RUN_MODULE = "system-run-approval-plan-Cu-Ftdkp.mjs";
const EXPECTED_SYSTEM_RUN_SHA256 =
  "c0df5badb2a8cc6adfdfb8bac48e5379e0825005e0dec827d01b2fb3e223820e";
const EXPECTED_EXEC_APPROVAL_MODULE = "exec-approval-BKqqOMdp.mjs";
const EXPECTED_EXEC_APPROVAL_SHA256 =
  "8090cab45823ea945c7ee3852e5751c60c2743a0e5edd63424dbc8c0cd882c9b";
const EXPECTED_BASH_TOOLS_MODULE = "bash-tools-DQS9-f8q.mjs";
const EXPECTED_BASH_TOOLS_SHA256 =
  "eee02a0bf16cbe6608b48e740cd4f2021b6f353b63eb324eb3ba224df77cfb2e";
const EXPECTED_WEB_TOOLS_MODULE = "openclaw-tools-BA3mvtXt.mjs";
const EXPECTED_WEB_TOOLS_SHA256 =
  "cb69cd89f05f264a3258970c9b1e14c8fb5ba84966030841f0f5e116965ad270";
const EXPECTED_CRON_SERVICE_MODULE = "service-B3JlUlHg.mjs";
const EXPECTED_CRON_SERVICE_SHA256 =
  "80b7e584751b1b260377c9e856d5b97c3d4540e525a5f29d7b7309ac8e1d9320";
const PINNED_RELEASE_MODULES = {
  "2026.10.10": {
    nodeGateway: [
      "nodes-CXMBO_AM.mjs",
      "a971b49d721744aa67ddf75ea1987dae3bd3b3a6ce0252db1c60a4dacd3148b6",
    ],
    nodeInvokePluginPolicy: [
      "node-invoke-plugin-policy-D_JIgmYG.mjs",
      "962c4b863074d9af2e8209fa26f9e461a38195af43ebbd0db63d538008c8e568",
    ],
    nodeRegistryPrivate: [
      "node-registry-private-Cf6NE86i.mjs",
      "a7939fb5b4d2af4b98062b0066c3cacb0f8f65be5dde5132d2671648e4fe52f7",
    ],
    systemRun: [
      "system-run-approval-plan-BzxkNWfX.mjs",
      "415423cd70f85dd1fcae87483f2f55736d5b0e6deab0678e22264bb6e75bbb32",
    ],
    execApproval: [
      "exec-approval-DuJx32oo.mjs",
      "0164e3cc9ba4d5a7b87c7f5acd179875b378aaeace30c717954164d442fd0be5",
    ],
    bashTools: [
      "bash-tools-B7jTXO_k.mjs",
      "5f7519f943413182a9e49c480514829d37e8789d8060c12105ac87d86b99ed45",
    ],
    webTools: [
      "openclaw-tools-Wz412ubE.mjs",
      "0ee2c670fb12aec4f4fc25629c9139813f5d71c15e98748db63ecb6dc46c064d",
    ],
    cronService: [
      "service-pOwE_Xvo.mjs",
      "fb2429daf982d836ad1d7c147bf6ba73f121d65a3cb48205cef8822e12474a57",
    ],
  },
  "2026.10.3": {
    nodeGateway: [EXPECTED_NODE_GATEWAY_MODULE, EXPECTED_NODE_GATEWAY_SHA256],
    nodeInvokePluginPolicy: [
      EXPECTED_NODE_INVOKE_PLUGIN_POLICY_MODULE,
      EXPECTED_NODE_INVOKE_PLUGIN_POLICY_SHA256,
    ],
    nodeRegistryPrivate: [
      EXPECTED_NODE_REGISTRY_PRIVATE_MODULE,
      EXPECTED_NODE_REGISTRY_PRIVATE_SHA256,
    ],
    systemRun: [EXPECTED_SYSTEM_RUN_MODULE, EXPECTED_SYSTEM_RUN_SHA256],
    execApproval: [EXPECTED_EXEC_APPROVAL_MODULE, EXPECTED_EXEC_APPROVAL_SHA256],
    bashTools: [EXPECTED_BASH_TOOLS_MODULE, EXPECTED_BASH_TOOLS_SHA256],
    webTools: [EXPECTED_WEB_TOOLS_MODULE, EXPECTED_WEB_TOOLS_SHA256],
    cronService: [EXPECTED_CRON_SERVICE_MODULE, EXPECTED_CRON_SERVICE_SHA256],
  },
  "2026.10.5": {
    nodeGateway: [
      "nodes-50M4rpyG.mjs",
      "36df67f03cdb38c108abf1b8d806596deeab12a5cd8d2b493da6b6d8070684de",
    ],
    nodeInvokePluginPolicy: [
      "node-invoke-plugin-policy-C3OHtaj0.mjs",
      "5fb041bbf5b92197b1a0bee62a8833a00910506c443cd0b1dcf0f95af37a9bc3",
    ],
    nodeRegistryPrivate: [
      "node-registry-private-Cy7k5cze.mjs",
      "93cdf5cdcc30b97741fd4057418f64658f0e515ad92536a6d3e15c38828cdb03",
    ],
    systemRun: [
      "system-run-approval-plan-B2O_CKga.mjs",
      "6dc1d895e06ccc1ce656895185be69522711606bf9ccf8475373ac5d0b4e5e08",
    ],
    execApproval: [
      "exec-approval-DbnOAIQO.mjs",
      "bb78df7f275897a9fe37c916290bab76d3901205fa7a43124111a458108ff9b9",
    ],
    bashTools: [
      "bash-tools-BpD5km6h.mjs",
      "2aa533524662ac2e205f1ded47be742fa22c955efb9fc87b6f190a6b843aa73a",
    ],
    webTools: [
      "openclaw-tools-BzG0r_Mx.mjs",
      "892e8dc378297ee04528b2dabf654d9fbe4f71dab01a42b2e2c392aececfd218",
    ],
    cronService: [
      "service-BlXGdNfC.mjs",
      "811e2fac7e3dc0c3ddf647d8407afd180a7d3e65c43f6e1ed87f9b8133761633",
    ],
  },
};
export const APPROVAL_PROOF_CONTRACT = "microclaw.windows-node-approval.v2";
export const APPROVAL_PROOF_PLAN_CONTRACT = "microclaw.windows-node-approval-plan.v2";
export const APPROVAL_PROOF_TTL_MS = 30_000;
const APPROVAL_PROOF_MINTER_SYMBOL = Symbol.for("microclaw.windows-node-mxc.approval-proof.v1");
const PRELOAD_INITIALIZED_ENV = "MICROCLAW_MXC_APPROVAL_PRELOAD_INITIALIZED";

export function buildMxcApprovalContextDiagnostic(stage, context, hashString) {
  if (
    ![
      "gateway-approval-requested",
      "exec-defaults",
      "node-prepare-input",
      "node-prepare-output",
    ].includes(stage)
  ) {
    throw new Error("Unsupported MXC approval diagnostic stage");
  }
  function descriptor(record, key) {
    return record && typeof record === "object" && !Array.isArray(record)
      ? Object.getOwnPropertyDescriptor(record, key)
      : undefined;
  }
  function read(record, key) {
    const field = descriptor(record, key);
    return field && "value" in field ? field.value : undefined;
  }
  function describe(record, key) {
    const field = descriptor(record, key);
    if (!field) return { present: false, type: "missing" };
    if (!("value" in field)) return { present: true, type: "accessor" };
    const value = field.value;
    return {
      present: true,
      type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
      ...(typeof value === "string" ? { hash: hashString(value), length: value.length } : {}),
    };
  }
  function fields(record, keys) {
    return Object.fromEntries(keys.map((key) => [key, describe(record, key)]));
  }
  const envelope = read(context, "envelope");
  const request =
    stage === "gateway-approval-requested" ? read(envelope, "request") : read(context, "request");
  const plan =
    stage === "gateway-approval-requested" ? read(request, "systemRunPlan") : read(context, "plan");
  const defaults = read(context, "defaults");
  const origin =
    stage === "gateway-approval-requested" ? read(envelope, "origin") : read(context, "origin");
  return {
    contract: "microclaw.mxc-approval-context-diagnostic.v1",
    stage,
    envelope: fields(envelope, [
      "id",
      "sessionKey",
      "agentId",
      "runId",
      "toolCallId",
      "originatingClientId",
    ]),
    request: fields(request, [
      "sessionKey",
      "agentId",
      "runId",
      "toolCallId",
      "origin",
      "originatingClientId",
      "originatingDeviceId",
      "turnSourceChannel",
      "turnSourceTo",
      "turnSourceAccountId",
      "turnSourceThreadId",
    ]),
    plan: fields(plan, ["sessionKey", "agentId", "runId", "toolCallId"]),
    defaults: fields(defaults, [
      "sessionKey",
      "runSessionKey",
      "notifySessionKey",
      "sessionId",
      "agentId",
      "runId",
      "messageProvider",
      "currentChannelId",
      "accountId",
    ]),
    origin: fields(origin, [
      "kind",
      "channel",
      "sessionKey",
      "agentId",
      "runId",
      "toolCallId",
      "turnSourceChannel",
      "turnSourceTo",
      "turnSourceAccountId",
      "turnSourceThreadId",
    ]),
  };
}

export function describeMxcApprovalContext(stage, context) {
  return buildMxcApprovalContextDiagnostic(stage, context, (value) =>
    createHash("sha256").update(value).digest("hex").slice(0, 16),
  );
}

const MXC_APPROVAL_CONTEXT_DIAGNOSTIC_SOURCE = `${buildMxcApprovalContextDiagnostic.toString()}
function logMicroclawMxcApprovalContext(stage, context) {
\tif (process.env.MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT !== "1") return;
\tconsole.info("[weixin-remote-approval-context]", buildMxcApprovalContextDiagnostic(stage, context, (value) => crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)));
}`;

export function classifyWindowsNodeMxcInvokeFailure(error) {
  const asRecord = (value) =>
    value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const normalizeString = (value) =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  const errorRecord = asRecord(error);
  const details = asRecord(errorRecord?.details);
  const nodeError = asRecord(details?.nodeError);
  const nodeErrorDetails = asRecord(nodeError?.details);
  const code = normalizeString(nodeError?.code);
  const message =
    normalizeString(nodeError?.message) ??
    (error instanceof Error ? error.message : normalizeString(error)) ??
    "node invoke failed";
  const nodeCommandDispatched =
    typeof details?.nodeCommandDispatched === "boolean" ? details.nodeCommandDispatched : undefined;
  const requestSent =
    typeof errorRecord?.requestSent === "boolean" ? errorRecord.requestSent : undefined;
  if (
    code === "SYSTEM_RUN_DENIED" ||
    nodeErrorDetails?.executionState === "rejectedBeforeExecution"
  ) {
    return {
      reason: "policy-denied",
      retrySafe: false,
      ...(code ? { code } : {}),
      message,
    };
  }
  if (code === "NOT_CONNECTED" && nodeCommandDispatched === false) {
    return {
      reason: "not-dispatched",
      retrySafe: true,
      code,
      message,
      nodeCommandDispatched,
      ...(requestSent !== undefined ? { requestSent } : {}),
    };
  }
  return {
    reason: "outcome-unknown",
    retrySafe: false,
    ...(code ? { code } : {}),
    message,
    ...(nodeCommandDispatched !== undefined ? { nodeCommandDispatched } : {}),
    ...(requestSent !== undefined ? { requestSent } : {}),
  };
}

export function normalizeWindowsNodeSystemRunResponse(raw) {
  const asRecord = (value) =>
    value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const jsonEqual = (left, right) => {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
      return (
        Array.isArray(left) &&
        Array.isArray(right) &&
        left.length === right.length &&
        left.every((value, index) => jsonEqual(value, right[index]))
      );
    }
    const leftRecord = asRecord(left);
    const rightRecord = asRecord(right);
    if (!leftRecord || !rightRecord) return false;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) => key === rightKeys[index] && jsonEqual(leftRecord[key], rightRecord[key]),
      )
    );
  };

  const outer = asRecord(raw);
  const nested = asRecord(outer?.payload);
  const response =
    outer?.command === "system.run"
      ? outer
      : outer?.ok === true &&
          (outer.type === undefined || outer.type === "res") &&
          outer.error == null &&
          outer.command === undefined &&
          outer.nodeId === undefined &&
          outer.payloadJSON === undefined &&
          nested?.command === "system.run"
        ? nested
        : null;
  const payload = asRecord(response?.payload);
  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  if (
    response?.ok !== true ||
    response.command !== "system.run" ||
    typeof payload?.success !== "boolean" ||
    hasOwn(payload, "payload") ||
    hasOwn(payload, "payloadJSON") ||
    hasOwn(payload, "ok") ||
    hasOwn(payload, "command")
  ) {
    return null;
  }
  const rejectedBeforeExecution =
    payload.success === false &&
    payload.executionState === "rejectedBeforeExecution" &&
    payload.exitCode == null &&
    payload.timedOut === false &&
    typeof payload.error === "string" &&
    payload.error.length > 0 &&
    typeof payload.errorCode === "string" &&
    payload.errorCode.length > 0;
  const completed =
    payload.executionState === undefined &&
    typeof payload.stdout === "string" &&
    typeof payload.stderr === "string" &&
    typeof payload.exitCode === "number" &&
    Number.isSafeInteger(payload.exitCode) &&
    typeof payload.timedOut === "boolean" &&
    typeof payload.durationMs === "number" &&
    Number.isFinite(payload.durationMs) &&
    payload.durationMs >= 0 &&
    payload.success === (payload.exitCode === 0 && !payload.timedOut);
  if (!rejectedBeforeExecution && !completed) return null;
  if (response.payloadJSON !== undefined && response.payloadJSON !== null) {
    if (typeof response.payloadJSON !== "string") return null;
    let serializedPayload;
    try {
      serializedPayload = JSON.parse(response.payloadJSON);
    } catch {
      return null;
    }
    if (!jsonEqual(payload, serializedPayload)) return null;
  }
  return { raw: response, payload };
}

export function describeWindowsNodeSystemRunResponseShape(raw) {
  const describe = (value) => {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    if (typeof value !== "object") return typeof value;
    return Object.keys(value).sort().join(",");
  };
  const outer = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  const outerPayload =
    outer?.payload && typeof outer.payload === "object" && !Array.isArray(outer.payload)
      ? outer.payload
      : null;
  const nestedPayload =
    outerPayload?.payload &&
    typeof outerPayload.payload === "object" &&
    !Array.isArray(outerPayload.payload)
      ? outerPayload.payload
      : null;
  return [
    `outer=${describe(raw)}`,
    `outerPayload=${describe(outer?.payload)}`,
    `nestedPayload=${describe(nestedPayload)}`,
    `payloadJSON=${describe(outer?.payloadJSON ?? outerPayload?.payloadJSON)}`,
  ].join(" ");
}

export const PINNED_WEB_FETCH_HTTP_ONLY_SOURCE =
  'if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("Invalid URL: must be http or https");';
export const PINNED_WEB_FETCH_HTTP_ONLY_10_5_SOURCE =
  'if (!parsedUrl || !["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("Invalid URL: must be http or https");';

export function attestPinnedOpenClawWebFetchHttpOnly(source) {
  if (
    !source.includes(PINNED_WEB_FETCH_HTTP_ONLY_SOURCE) &&
    !source.includes(PINNED_WEB_FETCH_HTTP_ONLY_10_5_SOURCE)
  ) {
    throw new Error("Pinned OpenClaw web_fetch no longer rejects non-HTTP URL schemes");
  }
  return source;
}

export const PINNED_NODE_GATEWAY_MINT_INSERT_SOURCE =
  "async function sanitizeSystemRunParamsForForwarding(opts) {";
const PATCHED_NODE_GATEWAY_MINT_INSERT_SOURCE = `function mintMicroclawNodeApprovalProof(params) {
\tconst minter = globalThis[Symbol.for("microclaw.windows-node-mxc.approval-proof.v1")];
\tif (!minter || typeof minter.mint !== "function") throw new Error("MicroClaw node approval proof minter is unavailable");
\treturn minter.mint(params);
}
function attachMicroclawNodeApprovalProof(params, request) {
\tif (!request) return;
\tconst proof = mintMicroclawNodeApprovalProof(request);
\t// The native proof binds the full argv command text, not the upstream display preview.
\tparams.rawCommand = request.plan.commandText;
\tparams.microclawApprovalProof = proof;
\tconst forwardedAtUnixMs = Date.now();
\tconst decisionAtUnixMs = Number.isFinite(request.decisionAtUnixMs) ? request.decisionAtUnixMs : proof.issuedAtUnixMs;
\tconsole.error(\`[microclaw-approval-timing] stage=proof-mint decisionAtUnixMs=\${decisionAtUnixMs} proofIssuedAtUnixMs=\${proof.issuedAtUnixMs} decisionToMintMs=\${Math.max(0, proof.issuedAtUnixMs - decisionAtUnixMs)}\`);
\tconsole.error(\`[microclaw-approval-timing] stage=gateway-forward forwardAtUnixMs=\${forwardedAtUnixMs} proofAgeMs=\${Math.max(0, forwardedAtUnixMs - proof.issuedAtUnixMs)}\`);
}
async function sanitizeSystemRunParamsForForwarding(opts) {`;

export const PINNED_NODE_GATEWAY_APPROVAL_SOURCE = `\tconst approvalDecision = snapshot.decision;
\tif (approvalDecision === "allow-once" || approvalDecision === "allow-always") {
\t\tif (approvalSource !== null) return systemRunApprovalGuardError({
\t\t\tcode: "APPROVAL_SOURCE_MISMATCH",
\t\t\tmessage: "approval source does not match approval record",
\t\t\tdetails: { runId }
\t\t});
\t\tif (approvalDecision === "allow-once" && recordedResolutionSource === "auto-review" && !runtimeContext.plan) return systemRunApprovalGuardError({
\t\t\tcode: "APPROVAL_PLAN_REQUIRED",
\t\t\tmessage: "auto-review approval requires an approved execution plan",
\t\t\tdetails: { runId }
\t\t});
\t\tif (approvalDecision === "allow-once" && (typeof manager.consumeAllowOnce !== "function" || !await manager.consumeAllowOnce(runId))) return systemRunApprovalRequired(runId);
\t\tif (approvalDecision === "allow-once" && recordedResolutionSource === "auto-review") next.approvalSource = "auto-review";
\t\telse {
\t\t\tnext.approved = true;
\t\t\tnext.approvalDecision = approvalDecision;
\t\t}
\t\treturn {
\t\t\tok: true,
\t\t\tparams: next,
\t\t\tapprovalAuthority: {
\t\t\t\trecordId: runId,
\t\t\t\tdecision: approvalDecision
\t\t\t}
\t\t};
\t}`;
const PATCHED_NODE_GATEWAY_APPROVAL_SOURCE = `\tconst approvalDecision = snapshot.decision;
\tif (approvalDecision === "allow-once" || approvalDecision === "allow-always") {
\t\tif (approvalSource !== null) return systemRunApprovalGuardError({
\t\t\tcode: "APPROVAL_SOURCE_MISMATCH",
\t\t\tmessage: "approval source does not match approval record",
\t\t\tdetails: { runId }
\t\t});
\t\tif (approvalDecision !== "allow-once" || recordedResolutionSource !== "operator") return systemRunApprovalRequired(runId);
\t\tif (!runtimeContext.plan) return systemRunApprovalGuardError({
\t\t\tcode: "APPROVAL_PLAN_REQUIRED",
\t\t\tmessage: "operator approval requires an approved execution plan",
\t\t\tdetails: { runId }
\t\t});
\t\tif (typeof manager.consumeAllowOnce !== "function" || !await manager.consumeAllowOnce(runId)) return systemRunApprovalRequired(runId);
\t\tnext.approved = true;
\t\tnext.approvalDecision = "allow-once";
\t\treturn {
\t\t\tok: true,
\t\t\tparams: next,
\t\t\tapprovalAuthority: {
\t\t\t\trecordId: runId,
\t\t\t\tdecision: "allow-once"
\t\t\t},
\t\t\tmicroclawApprovalProofRequest: {
\t\t\t\tapprovalId: runId,
\t\t\t\tnodeId: targetNodeId,
\t\t\t\tplan: runtimeContext.plan,
\t\t\t\tdecisionAtUnixMs: snapshot.resolvedAtMs ?? nowMs
\t\t\t}
\t\t};
\t}`;

export const PINNED_NODE_GATEWAY_PLUGIN_DISPATCH_SOURCE = `\t\t\t\t\tonNodeCommandDispatched: () => {
\t\t\t\t\t\tnodeCommandDispatched = true;
\t\t\t\t\t},`;
const PATCHED_NODE_GATEWAY_PLUGIN_DISPATCH_SOURCE = `\t\t\t\t\tonNodeCommandDispatched: () => {
\t\t\t\t\t\tnodeCommandDispatched = true;
\t\t\t\t\t},
\t\t\t\t\tonNodeCommandDispatchPreparing: (dispatchParams) => {
\t\t\t\t\t\tattachMicroclawNodeApprovalProof(dispatchParams, forwardedParams.microclawApprovalProofRequest);
\t\t\t\t\t},`;

export const PINNED_NODE_GATEWAY_DIRECT_DISPATCH_SOURCE = `\t\t\t\t\tonDispatchReady: (invokeId) => {
\t\t\t\t\t\tnodeCommandDispatched = true;
\t\t\t\t\t\tnodeInvokeStream?.onDispatchReady(invokeId);
\t\t\t\t\t}`;
const PATCHED_NODE_GATEWAY_DIRECT_DISPATCH_SOURCE = `\t\t\t\t\tonDispatchReady: (invokeId) => {
\t\t\t\t\t\tnodeCommandDispatched = true;
\t\t\t\t\t\tnodeInvokeStream?.onDispatchReady(invokeId);
\t\t\t\t\t},
\t\t\t\t\tonDispatchPreparing: (dispatchParams) => {
\t\t\t\t\t\tattachMicroclawNodeApprovalProof(dispatchParams, forwardedParams.microclawApprovalProofRequest);
\t\t\t\t\t}`;

export const PINNED_NODE_INVOKE_PLUGIN_REQUEST_SOURCE = `\t\tconst request = {
\t\t\tnodeId: params.nodeSession.nodeId,
\t\t\texpectedConnId: params.nodeSession.connId,
\t\t\t...params.nodeSession.pairingGeneration ? { expectedPairingGeneration: params.nodeSession.pairingGeneration } : {},
\t\t\tcommand: params.command,
\t\t\tparams: override.params ?? params.params,`;
const PATCHED_NODE_INVOKE_PLUGIN_REQUEST_SOURCE = `\t\tconst requestParams = override.params ?? params.params;
\t\tconst request = {
\t\t\tnodeId: params.nodeSession.nodeId,
\t\t\texpectedConnId: params.nodeSession.connId,
\t\t\t...params.nodeSession.pairingGeneration ? { expectedPairingGeneration: params.nodeSession.pairingGeneration } : {},
\t\t\tcommand: params.command,
\t\t\tparams: requestParams,`;

export const PINNED_NODE_INVOKE_PLUGIN_DISPATCH_SOURCE = `\t\t\tonDispatchReady: (invokeId) => {
\t\t\t\tnodeCommandDispatched = true;
\t\t\t\tparams.onNodeCommandDispatched?.();
\t\t\t\tparams.nodeInvokeStream?.onDispatchReady(invokeId);
\t\t\t}
\t\t};
\t\tconst res = params.privateTransport ? await params.privateTransport.invoke(request) : await invokeNodeWithReadinessRetry(params.context.nodeRegistry, {
\t\t\t...request,
\t\t\tdeadlineAtMs
\t\t});`;
const PATCHED_NODE_INVOKE_PLUGIN_DISPATCH_SOURCE = `\t\t\tonDispatchReady: (invokeId) => {
\t\t\t\tnodeCommandDispatched = true;
\t\t\t\tparams.onNodeCommandDispatched?.();
\t\t\t\tparams.nodeInvokeStream?.onDispatchReady(invokeId);
\t\t\t},
\t\t\tonDispatchPreparing: () => {
\t\t\t\tparams.onNodeCommandDispatchPreparing?.(requestParams);
\t\t\t}
\t\t};
\t\tif (params.privateTransport) request.onDispatchPreparing();
\t\tconst res = params.privateTransport ? await params.privateTransport.invoke(request) : await invokeNodeWithReadinessRetry(params.context.nodeRegistry, {
\t\t\t...request,
\t\t\tdeadlineAtMs
\t\t});`;

export const PINNED_NODE_REGISTRY_SERIALIZATION_SOURCE = `\tconst requestId = randomUUID();
\tconst invokeParams = normalizeSystemRunInvokeParams({
\t\tcommand: params.command,
\t\tparams: params.params
\t});
\tconst payload = buildNodeInvokeRequest({
\t\tid: requestId,
\t\tnodeId: params.nodeId,
\t\tcommand: params.command,
\t\tparams: "params" in params ? invokeParams : void 0,
\t\ttimeoutMs,
\t\tidempotencyKey: params.idempotencyKey,
\t\tsessionKey: params.sessionKey
\t});
\tif (params.command === "worker.launch.v1" && Buffer.byteLength(serializeNodeEvent("node.invoke.request", payload), "utf8") > 26214400) return {
\t\tok: false,
\t\terror: {
\t\t\tcode: "INVALID_REQUEST",
\t\t\tmessage: "worker launch exceeds the node payload limit"
\t\t}
\t};
\tconst systemRunEvent = resolvePendingSystemRunEvent({
\t\tcommand: params.command,
\t\tparams: invokeParams
\t});`;
export const PINNED_NODE_REGISTRY_SERIALIZATION_10_5_SOURCE =
  PINNED_NODE_REGISTRY_SERIALIZATION_SOURCE.replace(
    "\t\tparams: invokeParams\n",
    "\t\tparams: invokeParams,\n\t\tturnSource\n",
  );
const NODE_REGISTRY_WORKER_LIMIT_SOURCE = `\tif (params.command === "worker.launch.v1" && Buffer.byteLength(serializeNodeEvent("node.invoke.request", payload), "utf8") > 26214400) return {
\t\tok: false,
\t\terror: {
\t\t\tcode: "INVALID_REQUEST",
\t\t\tmessage: "worker launch exceeds the node payload limit"
\t\t}
\t};`;
export const PINNED_NODE_REGISTRY_SERIALIZATION_10_10_SOURCE =
  PINNED_NODE_REGISTRY_SERIALIZATION_10_5_SOURCE.replace(
    NODE_REGISTRY_WORKER_LIMIT_SOURCE,
    '\tif (params.command === "worker.launch.v1" && Buffer.byteLength(serializeNodeEvent("node.invoke.request", payload), "utf8") > 26214400) return nodeInvokeError("INVALID_REQUEST", "worker launch exceeds the node payload limit");',
  );
const PATCHED_NODE_REGISTRY_SERIALIZATION_SOURCE = `\tconst requestId = randomUUID();
\tlet payloadTimeoutMs = timeoutMs;
\tlet invokeParams;
\tlet payload;
\tlet systemRunEvent;`;

export const PINNED_NODE_REGISTRY_PRE_DISPATCH_SOURCE = `\t\tpayload.timeoutMs = Math.ceil(timeoutMs);
\t}
\tconst result = new Promise((resolve, reject) => {`;
const PATCHED_NODE_REGISTRY_PRE_DISPATCH_SOURCE = `\t\tpayloadTimeoutMs = Math.ceil(timeoutMs);
\t}
\tparams.onDispatchPreparing?.(params.params);
\tinvokeParams = normalizeSystemRunInvokeParams({
\t\tcommand: params.command,
\t\tparams: params.params
\t});
\tpayload = buildNodeInvokeRequest({
\t\tid: requestId,
\t\tnodeId: params.nodeId,
\t\tcommand: params.command,
\t\tparams: "params" in params ? invokeParams : void 0,
\t\ttimeoutMs: payloadTimeoutMs,
\t\tidempotencyKey: params.idempotencyKey,
\t\tsessionKey: params.sessionKey
\t});
\tif (params.command === "worker.launch.v1" && Buffer.byteLength(serializeNodeEvent("node.invoke.request", payload), "utf8") > 26214400) return {
\t\tok: false,
\t\terror: {
\t\t\tcode: "INVALID_REQUEST",
\t\t\tmessage: "worker launch exceeds the node payload limit"
\t\t}
\t};
\tsystemRunEvent = resolvePendingSystemRunEvent({
\t\tcommand: params.command,
\t\tparams: invokeParams
\t});
\tconst result = new Promise((resolve, reject) => {`;

export const PINNED_NODE_GATEWAY_ASK_FALLBACK_SOURCE = `\tif (timedOut && approvalSource === "ask-fallback" && !approved && requestedDecision === null && clientHasApprovals(opts.client)) {
\t\tif (!runtimeContext.plan) return systemRunApprovalGuardError({
\t\t\tcode: "APPROVAL_PLAN_REQUIRED",
\t\t\tmessage: "ask fallback requires an approved execution plan",
\t\t\tdetails: { runId }
\t\t});
\t\tif (typeof manager.consumeAskFallback !== "function" || !manager.consumeAskFallback(runId)) return systemRunApprovalRequired(runId);
\t\tnext.approvalSource = "ask-fallback";
\t\treturn {
\t\t\tok: true,
\t\t\tparams: next,
\t\t\tapprovalAuthority: {
\t\t\t\trecordId: runId,
\t\t\t\tdecision: "allow-once"
\t\t\t}
\t\t};
\t}`;
const PATCHED_NODE_GATEWAY_ASK_FALLBACK_SOURCE = `\tif (timedOut && approvalSource === "ask-fallback" && !approved && requestedDecision === null && clientHasApprovals(opts.client)) {
\t\treturn systemRunApprovalRequired(runId);
\t}`;

export const PINNED_SYSTEM_RUN_PLAN_SOURCE = `function normalizeSystemRunApprovalPlan(candidate) {
\tif (!isRecord(candidate)) return null;
\tconst argv = normalizeStringArray(candidate.argv);
\tif (argv.length === 0) return null;
\tconst mutableFileOperand = normalizeSystemRunApprovalFileOperand(candidate.mutableFileOperand);
\tif (candidate.mutableFileOperand !== void 0 && mutableFileOperand === null) return null;
\tconst policySnapshot = normalizeExecApprovalPolicySnapshot(candidate.policySnapshot);
\tif (candidate.policySnapshot !== void 0 && policySnapshot === null) return null;
\tconst commandText = normalizeNullableString(candidate.commandText) ?? normalizeNullableString(candidate.rawCommand);
\tif (!commandText) return null;
\treturn {
\t\targv,
\t\tcwd: normalizeNullableString(candidate.cwd),
\t\tcommandText,
\t\tcommandPreview: normalizeNullableString(candidate.commandPreview),
\t\tagentId: normalizeNullableString(candidate.agentId),
\t\tsessionKey: normalizeNullableString(candidate.sessionKey),
\t\t...policySnapshot ? { policySnapshot } : {},
\t\tmutableFileOperand: mutableFileOperand ?? void 0
\t};
}`;

const PATCHED_SYSTEM_RUN_PLAN_SOURCE = `${normalizePowerShellProviderInitialization.toString()}
function normalizeMicroclawSystemRunDeclaredAccess(value) {
\tif (!Array.isArray(value)) return null;
\tconst entries = [];
\tfor (const item of value) {
\t\tif (!item || typeof item !== "object" || Array.isArray(item)) return null;
\t\tconst access = item.access;
\t\tconst folderPath = normalizeNullableString(item.path);
\t\tif ((access !== "ro" && access !== "rw") || !folderPath) return null;
\t\tentries.push({ access, path: folderPath });
\t}
\treturn entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}
function normalizeSystemRunApprovalPlan(candidate) {
\tif (!isRecord(candidate)) return null;
\tconst argv = candidate.executablePath !== void 0
\t\t? Array.isArray(candidate.argv) && candidate.argv.every(value => typeof value === "string" && value.length > 0) ? [...candidate.argv] : []
\t\t: normalizeStringArray(candidate.argv);
\tif (argv.length === 0) return null;
\tconst mutableFileOperand = normalizeSystemRunApprovalFileOperand(candidate.mutableFileOperand);
\tif (candidate.mutableFileOperand !== void 0 && mutableFileOperand === null) return null;
\tconst policySnapshot = normalizeExecApprovalPolicySnapshot(candidate.policySnapshot);
\tif (candidate.policySnapshot !== void 0 && policySnapshot === null) return null;
\tconst commandText = normalizeNullableString(candidate.commandText) ?? normalizeNullableString(candidate.rawCommand);
\tif (!commandText) return null;
\tconst hasMicroclawIdentity = candidate.executablePath !== void 0 || candidate.executableSha256 !== void 0 || candidate.cwdBinding !== void 0 || candidate.declaredAccess !== void 0;
\tif (candidate.policyFingerprint !== void 0 && (!hasMicroclawIdentity || typeof candidate.policyFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(candidate.policyFingerprint))) return null;
\tconst executablePath = normalizeNullableString(candidate.executablePath);
\tconst executableSha256 = normalizeNullableString(candidate.executableSha256);
\tconst cwdBinding = normalizeNullableString(candidate.cwdBinding);
\tconst declaredAccess = normalizeMicroclawSystemRunDeclaredAccess(candidate.declaredAccess);
\tconst providerInitialization = candidate.providerInitialization === void 0 ? void 0 : normalizePowerShellProviderInitialization(candidate.providerInitialization);
\tconst commandConsent = candidate.commandConsent;
\tif (commandConsent !== void 0 && (!hasMicroclawIdentity || !commandConsent || typeof commandConsent.required !== "boolean" || typeof commandConsent.allowAlwaysAvailable !== "boolean" || (!commandConsent.required && commandConsent.allowAlwaysAvailable))) return null;
\tif (candidate.providerInitialization !== void 0 && !providerInitialization) return null;
\tif (providerInitialization && !hasMicroclawIdentity) return null;
\tif (argv.some(argument => argument.includes("[void]'microclaw.powershell-filesystem-scope.")) && !providerInitialization) return null;
\tif (providerInitialization && (providerInitialization.finalArgv.length !== argv.length || providerInitialization.finalArgv.some((argument, index) => argument !== argv[index]))) return null;
\tif (hasMicroclawIdentity && (!executablePath || !/^[a-z]:\\\\/i.test(executablePath) || !executableSha256 || !/^[a-f0-9]{64}$/i.test(executableSha256) || !cwdBinding || declaredAccess === null)) return null;
\treturn {
\t\targv,
\t\tcwd: normalizeNullableString(candidate.cwd),
\t\tcommandText,
\t\tcommandPreview: providerInitialization && typeof candidate.commandPreview === "string" ? candidate.commandPreview : normalizeNullableString(candidate.commandPreview),
\t\tagentId: normalizeNullableString(candidate.agentId),
\t\tsessionKey: normalizeNullableString(candidate.sessionKey),
\t\t...policySnapshot ? { policySnapshot } : {},
\t\tmutableFileOperand: mutableFileOperand ?? void 0,
\t\t...hasMicroclawIdentity ? {
\t\t\texecutablePath,
\t\t\texecutableSha256: executableSha256.toLowerCase(),
\t\t\tcwdBinding,
\t\t\tdeclaredAccess,
\t\t\t...(commandConsent ? { commandConsent: { required: commandConsent.required, allowAlwaysAvailable: commandConsent.allowAlwaysAvailable } } : {}),
\t\t\t...(typeof candidate.policyFingerprint === "string" && /^[a-f0-9]{64}$/.test(candidate.policyFingerprint) ? { policyFingerprint: candidate.policyFingerprint } : {}),
\t\t\t...providerInitialization ? { providerInitialization } : {}
\t\t} : {}
\t};
}`;

export const PINNED_EXEC_APPROVAL_VALIDATION_SOURCE = `\t\t"exec.approval.request": async ({ params, respond, context, client }) => {
\t\t\tif (!assertValidParams(params, validateExecApprovalRequestParams, "exec.approval.request", respond)) return;`;

export function buildGatewayApprovalOrigin(identity, request, gatewayGeneration) {
  const nonempty = (value) => typeof value === "string" && value.length > 0;
  if (
    request.host !== "node" ||
    !identity ||
    identity.agentId !== request.agentId ||
    identity.operationalRunInstance?.runId !== request.runId ||
    ![
      identity.sessionKey,
      identity.operationalRunInstance?.instanceId,
      request.agentId,
      request.sessionKey,
      request.runId,
      request.toolCallId,
      request.nodeId,
      gatewayGeneration,
      identity.turnSourceChannel,
      identity.turnSourceAccountId,
      identity.turnSourceTo,
    ].every(nonempty)
  )
    return undefined;
  return {
    contract: "microclaw.gateway-approval-origin.v1",
    gatewayGeneration,
    agentId: request.agentId,
    runSessionKey: identity.sessionKey,
    executionSessionKey: request.sessionKey,
    runId: request.runId,
    toolCallId: request.toolCallId,
    nodeId: request.nodeId,
    channel: identity.turnSourceChannel,
    accountId: identity.turnSourceAccountId,
    to: identity.turnSourceTo,
  };
}

const PINNED_EXEC_APPROVAL_ORIGIN_SOURCE = `\t\t\tif (requestRunId && context.chatRunState.hasAbortMarker(requestRunId)) {`;
const PATCHED_EXEC_APPROVAL_ORIGIN_SOURCE = `\t\t\t// Only the already-validated internal runtime identity supplies conversation lineage.
\t\t\tconst remoteApprovalOrigin = buildGatewayApprovalOrigin(trustedAgentRuntime, request, process.env.MICROCLAW_MXC_APPROVAL_PROOF_GATEWAY_GENERATION);
\t\t\tif (remoteApprovalOrigin) request.remoteApprovalOrigin = remoteApprovalOrigin;
${PINNED_EXEC_APPROVAL_ORIGIN_SOURCE}`;

const PATCHED_EXEC_APPROVAL_VALIDATION_SOURCE = `\t\t"exec.approval.request": async ({ params, respond, context, client }) => {
\t\t\tconst rawPlan = params && typeof params === "object" && !Array.isArray(params) && params.systemRunPlan && typeof params.systemRunPlan === "object" && !Array.isArray(params.systemRunPlan) ? params.systemRunPlan : null;
\t\t\tconst validationParams = rawPlan ? {
\t\t\t\t...params,
\t\t\t\tsystemRunPlan: Object.fromEntries(Object.entries(rawPlan).filter(([name]) => name !== "executablePath" && name !== "executableSha256" && name !== "cwdBinding" && name !== "declaredAccess" && name !== "providerInitialization" && name !== "policyFingerprint" && name !== "commandConsent"))
\t\t\t} : params;
\t\t\tif (!assertValidParams(validationParams, validateExecApprovalRequestParams, "exec.approval.request", respond)) return;`;

function withPositionalApprovalGuards(source) {
  return source.replaceAll(
    /systemRunApprovalGuardError\(\{\n\t+code: ("[^"]+"),\n\t+message: ("[^"]+"),\n\t+details: \{ runId \}\n\t+\}\)/g,
    "systemRunApprovalGuardError($1, $2, runId)",
  );
}

function replaceExactlyOnce(source, expected, replacement, label) {
  const first = source.indexOf(expected);
  if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`Pinned OpenClaw ${label} did not match exactly once`);
  }
  return source.slice(0, first) + replacement + source.slice(first + expected.length);
}

export function patchPinnedOpenClawNodeGateway(source) {
  const approvalGuards = source.includes(
    "function systemRunApprovalGuardError(code, message, runId) {",
  )
    ? withPositionalApprovalGuards
    : (snippet) => snippet;
  let patched = replaceExactlyOnce(
    source,
    PINNED_NODE_GATEWAY_MINT_INSERT_SOURCE,
    PATCHED_NODE_GATEWAY_MINT_INSERT_SOURCE,
    "node approval proof insertion point",
  );
  patched = replaceExactlyOnce(
    patched,
    approvalGuards(PINNED_NODE_GATEWAY_APPROVAL_SOURCE),
    approvalGuards(PATCHED_NODE_GATEWAY_APPROVAL_SOURCE),
    "node approval proof handoff",
  );
  patched = replaceExactlyOnce(
    patched,
    approvalGuards(PINNED_NODE_GATEWAY_ASK_FALLBACK_SOURCE),
    PATCHED_NODE_GATEWAY_ASK_FALLBACK_SOURCE,
    "node ask-fallback approval proof handoff",
  );
  patched = replaceExactlyOnce(
    patched,
    PINNED_NODE_GATEWAY_PLUGIN_DISPATCH_SOURCE,
    PATCHED_NODE_GATEWAY_PLUGIN_DISPATCH_SOURCE,
    "plugin node approval proof dispatch boundary",
  );
  return replaceExactlyOnce(
    patched,
    PINNED_NODE_GATEWAY_DIRECT_DISPATCH_SOURCE,
    PATCHED_NODE_GATEWAY_DIRECT_DISPATCH_SOURCE,
    "direct node approval proof dispatch boundary",
  );
}

export function patchPinnedOpenClawNodeInvokePluginPolicy(source) {
  let patched = replaceExactlyOnce(
    source,
    PINNED_NODE_INVOKE_PLUGIN_REQUEST_SOURCE,
    PATCHED_NODE_INVOKE_PLUGIN_REQUEST_SOURCE,
    "plugin final node invoke params",
  );
  return replaceExactlyOnce(
    patched,
    PINNED_NODE_INVOKE_PLUGIN_DISPATCH_SOURCE,
    PATCHED_NODE_INVOKE_PLUGIN_DISPATCH_SOURCE,
    "plugin pre-serialization node dispatch callback",
  );
}

export function patchPinnedOpenClawNodeRegistryPrivate(source) {
  if (source.includes(PINNED_NODE_REGISTRY_SERIALIZATION_10_10_SOURCE)) {
    const patched = replaceExactlyOnce(
      source,
      PINNED_NODE_REGISTRY_SERIALIZATION_10_10_SOURCE,
      PATCHED_NODE_REGISTRY_SERIALIZATION_SOURCE,
      "node registry scoped deferred serialization",
    );
    const dispatch = PATCHED_NODE_REGISTRY_PRE_DISPATCH_SOURCE.replace(
      "\t\tparams: invokeParams\n",
      "\t\tparams: invokeParams,\n\t\tturnSource\n",
    ).replace(
      NODE_REGISTRY_WORKER_LIMIT_SOURCE,
      '\tif (params.command === "worker.launch.v1" && Buffer.byteLength(serializeNodeEvent("node.invoke.request", payload), "utf8") > 26214400) return { result: nodeInvokeError("INVALID_REQUEST", "worker launch exceeds the node payload limit") };',
    );
    return replaceExactlyOnce(
      patched,
      "\t" + PINNED_NODE_REGISTRY_PRE_DISPATCH_SOURCE.replaceAll("\n", "\n\t"),
      "\t" + dispatch.replaceAll("\n", "\n\t"),
      "node registry scoped pre-serialization dispatch callback",
    );
  }
  const hasTurnSource = source.includes(PINNED_NODE_REGISTRY_SERIALIZATION_10_5_SOURCE);
  let patched = replaceExactlyOnce(
    source,
    hasTurnSource
      ? PINNED_NODE_REGISTRY_SERIALIZATION_10_5_SOURCE
      : PINNED_NODE_REGISTRY_SERIALIZATION_SOURCE,
    PATCHED_NODE_REGISTRY_SERIALIZATION_SOURCE,
    "node registry deferred serialization",
  );
  return replaceExactlyOnce(
    patched,
    PINNED_NODE_REGISTRY_PRE_DISPATCH_SOURCE,
    hasTurnSource
      ? PATCHED_NODE_REGISTRY_PRE_DISPATCH_SOURCE.replace(
          "\t\tparams: invokeParams\n",
          "\t\tparams: invokeParams,\n\t\tturnSource\n",
        )
      : PATCHED_NODE_REGISTRY_PRE_DISPATCH_SOURCE,
    "node registry pre-serialization dispatch callback",
  );
}

export function patchPinnedOpenClawSystemRun(source) {
  return replaceExactlyOnce(
    source,
    PINNED_SYSTEM_RUN_PLAN_SOURCE,
    PATCHED_SYSTEM_RUN_PLAN_SOURCE,
    "system.run approval plan normalization",
  );
}

export function patchPinnedOpenClawExecApproval(source) {
  const patched = replaceExactlyOnce(
    source,
    PINNED_EXEC_APPROVAL_VALIDATION_SOURCE,
    PATCHED_EXEC_APPROVAL_VALIDATION_SOURCE,
    "exec approval schema projection",
  );
  return `${buildGatewayApprovalOrigin.toString()}\n${replaceExactlyOnce(
    patched,
    PINNED_EXEC_APPROVAL_ORIGIN_SOURCE,
    PATCHED_EXEC_APPROVAL_ORIGIN_SOURCE,
    "authenticated approval origin projection",
  )}`;
}

export const PINNED_BASH_TOOLS_FAILURE_CLASSIFIER_SOURCE = `/** Only NOT_CONNECTED plus explicit pre-dispatch provenance proves a retry cannot duplicate work. */
function classifyNodeInvokeFailure(error) {
\tconst errorRecord = asNullableRecord(error);
\tconst details = asNullableRecord(errorRecord?.details);
\tconst nodeError = asNullableRecord(details?.nodeError);
\tconst code = normalizeOptionalString(nodeError?.code);
\tconst message = normalizeOptionalString(nodeError?.message) ?? (error instanceof Error ? error.message : normalizeOptionalString(error)) ?? "node invoke failed";
\tconst nodeCommandDispatched = typeof details?.nodeCommandDispatched === "boolean" ? details.nodeCommandDispatched : void 0;
\tconst requestSent = typeof errorRecord?.requestSent === "boolean" ? errorRecord.requestSent : void 0;
\tif (code === "SYSTEM_RUN_DENIED") return {
\t\treason: "policy-denied",
\t\tretrySafe: false,
\t\tcode,
\t\tmessage
\t};
\tif (code === "NOT_CONNECTED" && nodeCommandDispatched === false) return {
\t\treason: "not-dispatched",
\t\tretrySafe: true,
\t\tcode,
\t\tmessage,
\t\tnodeCommandDispatched,
\t\t...requestSent !== void 0 ? { requestSent } : {}
\t};
\treturn {
\t\treason: "outcome-unknown",
\t\tretrySafe: false,
\t\t...code ? { code } : {},
\t\tmessage,
\t\t...nodeCommandDispatched !== void 0 ? { nodeCommandDispatched } : {},
\t\t...requestSent !== void 0 ? { requestSent } : {}
\t};
}`;

const PATCHED_BASH_TOOLS_FAILURE_CLASSIFIER_SOURCE = `/** Only explicit trusted provenance can prove that node execution did not begin. */
function classifyNodeInvokeFailure(error) {
\tconst errorRecord = asNullableRecord(error);
\tconst details = asNullableRecord(errorRecord?.details);
\tconst nodeError = asNullableRecord(details?.nodeError);
\tconst nodeErrorDetails = asNullableRecord(nodeError?.details);
\tconst code = normalizeOptionalString(nodeError?.code);
\tconst message = normalizeOptionalString(nodeError?.message) ?? (error instanceof Error ? error.message : normalizeOptionalString(error)) ?? "node invoke failed";
\tconst nodeCommandDispatched = typeof details?.nodeCommandDispatched === "boolean" ? details.nodeCommandDispatched : void 0;
\tconst requestSent = typeof errorRecord?.requestSent === "boolean" ? errorRecord.requestSent : void 0;
\tif (code === "SYSTEM_RUN_DENIED" || nodeErrorDetails?.executionState === "rejectedBeforeExecution") return {
\t\treason: "policy-denied",
\t\tretrySafe: false,
\t\t...code ? { code } : {},
\t\tmessage
\t};
\tif (code === "NOT_CONNECTED" && nodeCommandDispatched === false) return {
\t\treason: "not-dispatched",
\t\tretrySafe: true,
\t\tcode,
\t\tmessage,
\t\tnodeCommandDispatched,
\t\t...requestSent !== void 0 ? { requestSent } : {}
\t};
\treturn {
\t\treason: "outcome-unknown",
\t\tretrySafe: false,
\t\t...code ? { code } : {},
\t\tmessage,
\t\t...nodeCommandDispatched !== void 0 ? { nodeCommandDispatched } : {},
\t\t...requestSent !== void 0 ? { requestSent } : {}
\t};
}`;

export const PINNED_BASH_TOOLS_FAILURE_REGION_SOURCE = `//#region src/agents/bash-tools.exec-host-node-failure.ts
/** Only explicit trusted provenance can prove that node execution did not begin. */`;

const PATCHED_BASH_TOOLS_FAILURE_REGION_SOURCE = `//#region src/agents/bash-tools.exec-host-node-failure.ts
${MXC_APPROVAL_CONTEXT_DIAGNOSTIC_SOURCE}
const microclawUnresolvedNodeRuns = new Map();
function buildMicroclawUnresolvedNodeRunKey(nodeId, plan) {
\treturn crypto.createHash("sha256").update(JSON.stringify({
\t\tnodeId,
\t\tplan
\t})).digest("hex");
}
function findMicroclawUnresolvedNodeRun(key) {
\treturn microclawUnresolvedNodeRuns.get(key) ?? null;
}
function recordMicroclawUnresolvedNodeRun(key, failure) {
\tif (failure.reason !== "outcome-unknown") return;
\tmicroclawUnresolvedNodeRuns.set(key, {
\t\tmessage: failure.message
\t});
}
function formatMicroclawUnresolvedNodeRunResult(params) {
\tconst text = [
\t\t\`An earlier dispatch of this exact command to \${params.nodeId} still has an unresolved outcome.\`,
\t\t"MicroClaw blocked a duplicate approval and execution request. Reconcile the target state; do not retry automatically.",
\t\t"",
\t\t"Command:",
\t\tparams.command,
\t\t"",
\t\t\`Details: \${params.entry.message}\`
\t].join("\\n");
\treturn {
\t\tcontent: [{
\t\t\ttype: "text",
\t\t\ttext: renderExecUpdateText({
\t\t\t\ttailText: text,
\t\t\t\twarnings: params.warnings ?? []
\t\t\t})
\t\t}],
\t\tdetails: {
\t\t\tstatus: "failed",
\t\t\texitCode: null,
\t\t\tfailureKind: "outcome-unknown-deduplicated",
\t\t\treason: "outcome-unknown",
\t\t\tdurationMs: 0,
\t\t\taggregated: text,
\t\t\tcwd: params.cwd
\t\t}
\t};
}
/** Only explicit trusted provenance can prove that node execution did not begin. */`;

export const PINNED_BASH_TOOLS_POLICY_DENIED_GUIDANCE_SOURCE =
  'params.failure.reason === "policy-denied" ? [`Node command was denied before execution on ${params.nodeId}.`, "Resolve the reported refusal before retrying."]';
const PATCHED_BASH_TOOLS_POLICY_DENIED_GUIDANCE_SOURCE =
  'params.failure.reason === "policy-denied" ? [`Node command was denied before execution on ${params.nodeId}.`, "Do not retry this command automatically. Do not switch to gateway or sandbox execution. Surface the refusal to the user."]';

export const PINNED_BASH_TOOLS_HOST_SELECTION_SOURCE = `\t\t\tconst host = target.effectiveHost;
\t\t\tconst explicitSecurity = defaults?.security;`;
const PATCHED_BASH_TOOLS_HOST_SELECTION_SOURCE = `\t\t\tconst host = target.effectiveHost;
\t\t\tif (process.env.MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT === "1" && host !== "node") throw new Error("MicroClaw MXC execution is locked to host=node. Do not retry with gateway or sandbox host overrides.");
\t\t\tif (host === "node") logMicroclawMxcApprovalContext("exec-defaults", { defaults, origin: { agentId, toolCallId } });
\t\t\tconst explicitSecurity = defaults?.security;`;

export const PINNED_BASH_TOOLS_PREPARED_SOURCE = `\tconst prepared = await prepareNodeSystemRun({
\t\trequest: {
\t\t\t...params,
\t\t\tsecurity: hostSecurity,
\t\t\task: hostAsk
\t\t},
\t\ttarget
\t});
\tconst approvalAnalysis = await analyzeNodeApprovalRequirement({`;

const PATCHED_BASH_TOOLS_PREPARED_SOURCE = `\tlogMicroclawMxcApprovalContext("node-prepare-input", { request: params, origin: params });
\tconst prepared = await prepareNodeSystemRun({
\t\trequest: {
\t\t\t...params,
\t\t\tsecurity: hostSecurity,
\t\t\task: hostAsk
\t\t},
\t\ttarget
\t});
\tlogMicroclawMxcApprovalContext("node-prepare-output", { request: params, plan: prepared.plan, origin: params });
\tconst microclawUnresolvedRunKey = buildMicroclawUnresolvedNodeRunKey(target.nodeId, prepared.plan);
\tconst microclawUnresolvedRun = findMicroclawUnresolvedNodeRun(microclawUnresolvedRunKey);
\tif (microclawUnresolvedRun) return formatMicroclawUnresolvedNodeRunResult({
\t\tentry: microclawUnresolvedRun,
\t\tnodeId: target.nodeId,
\t\tcommand: params.command,
\t\tcwd: prepared.cwd,
\t\twarnings: params.warnings
\t});
\tconst approvalAnalysis = await analyzeNodeApprovalRequirement({`;

export const PINNED_BASH_TOOLS_DISPATCH_FAILURE_SOURCE = `\tif (!result.ok) return formatNodeInvokeFailureToolResult({
\t\tfailure: result.failure,
\t\tnodeId: params.target.nodeId,
\t\tcommand: params.request.command,
\t\tstartedAt,
\t\tcwd: params.request.workdir,
\t\twarnings: [...params.request.warnings, ...params.request.foregroundWarnings ?? []]
\t});`;

const PATCHED_BASH_TOOLS_DISPATCH_FAILURE_SOURCE = `\tif (!result.ok) {
\t\trecordMicroclawUnresolvedNodeRun(params.microclawUnresolvedRunKey, result.failure);
\t\treturn formatNodeInvokeFailureToolResult({
\t\t\tfailure: result.failure,
\t\t\tnodeId: params.target.nodeId,
\t\t\tcommand: params.request.command,
\t\t\tstartedAt,
\t\t\tcwd: params.request.workdir,
\t\t\twarnings: [...params.request.warnings, ...params.request.foregroundWarnings ?? []]
\t\t});
\t}`;

export const PINNED_BASH_TOOLS_FOLLOWUP_FAILURE_SOURCE = `\t\t\t\t\t\tif (!invocation.ok) {
\t\t\t\t\t\t\tawait sendExecApprovalFollowupResult(followupTarget, formatNodeInvokeFailureFollowup({`;

const PATCHED_BASH_TOOLS_FOLLOWUP_FAILURE_SOURCE = `\t\t\t\t\t\tif (!invocation.ok) {
\t\t\t\t\t\t\trecordMicroclawUnresolvedNodeRun(microclawUnresolvedRunKey, invocation.failure);
\t\t\t\t\t\t\tawait sendExecApprovalFollowupResult(followupTarget, formatNodeInvokeFailureFollowup({`;

export const PINNED_BASH_TOOLS_FINAL_DISPATCH_SOURCE = `\treturn dispatchNodeSystemRun({
\t\trequest: params,
\t\ttarget,
\t\tinvoke,
\t\t...(inlineApprovedByAsk || inlineApprovalSource) && inlineApprovalId ? { scopes: APPROVED_NODE_INVOKE_SCOPES } : {}
\t});`;

const PATCHED_BASH_TOOLS_FINAL_DISPATCH_SOURCE = `\treturn dispatchNodeSystemRun({
\t\trequest: params,
\t\ttarget,
\t\tinvoke,
\t\tmicroclawUnresolvedRunKey,
\t\t...(inlineApprovedByAsk || inlineApprovalSource) && inlineApprovalId ? { scopes: APPROVED_NODE_INVOKE_SCOPES } : {}
\t});`;

export const PINNED_BASH_TOOLS_INVOKE_RESULT_SOURCE = `\t\tconst raw = await callGatewayTool("node.invoke", { timeoutMs: params.invokeWaitMs }, params.invoke, callOptions);
\t\tif (typeof asNullableRecord(asNullableRecord(raw)?.payload)?.success !== "boolean") return {
\t\t\tok: false,
\t\t\tfailure: {
\t\t\t\treason: "outcome-unknown",
\t\t\t\tretrySafe: false,
\t\t\t\tmessage: "malformed node invoke response"
\t\t\t}
\t\t};
\t\treturn {
\t\t\tok: true,
\t\t\traw
\t\t};`;

export const PINNED_BASH_TOOLS_WINDOWS_SHELL_SOURCE = `\tif (normalized.startsWith("win")) return [
\t\t"cmd.exe",
\t\t"/d",
\t\t"/s",
\t\t"/c",
\t\tcommand
\t];`;

const PATCHED_BASH_TOOLS_INVOKE_RESULT_SOURCE = `\t\tconst raw = await callGatewayTool("node.invoke", { timeoutMs: params.invokeWaitMs }, params.invoke, callOptions);
\t\tconst normalizeMicroclawNodeSystemRunResponse = ${normalizeWindowsNodeSystemRunResponse.toString()};
\t\tconst describeMicroclawNodeSystemRunResponseShape = ${describeWindowsNodeSystemRunResponseShape.toString()};
\t\tconst normalized = normalizeMicroclawNodeSystemRunResponse(raw);
\t\tif (!normalized) return {
\t\t\tok: false,
\t\t\tfailure: {
\t\t\t\treason: "outcome-unknown",
\t\t\t\tretrySafe: false,
\t\t\t\tmessage: \`malformed node invoke response (\${describeMicroclawNodeSystemRunResponseShape(raw)})\`
\t\t\t}
\t\t};
\t\tconst { payload } = normalized;
\t\tif (payload.success === false && payload.executionState === "rejectedBeforeExecution") return {
\t\t\tok: false,
\t\t\tfailure: {
\t\t\t\treason: "policy-denied",
\t\t\t\tretrySafe: false,
\t\t\t\t...normalizeOptionalString(payload.errorCode) ? { code: normalizeOptionalString(payload.errorCode) } : {},
\t\t\t\tmessage: normalizeOptionalString(payload.error) ?? "node command rejected before execution"
\t\t\t}
\t\t};
\t\treturn {
\t\t\tok: true,
\t\t\traw: normalized.raw
\t\t};`;

export function patchPinnedOpenClawBashTools(source) {
  const permissionFailure = `\tconst permissionMissing = readNodePermissionError(error);
\tif (code === "PERMISSION_MISSING" && permissionMissing) return {
\t\treason: "permission-missing",
\t\tretrySafe: false,
\t\tcode,
\t\tmessage: error instanceof Error ? error.message : message,
\t\tpermissionMissing,
\t\tnodeCommandDispatched,
\t\trequestSent
\t};
`;
  const hasPermissionFailure = source.includes(permissionFailure);
  const classifierSource = hasPermissionFailure
    ? PINNED_BASH_TOOLS_FAILURE_CLASSIFIER_SOURCE.replace(
        '\tif (code === "SYSTEM_RUN_DENIED")',
        permissionFailure + '\tif (code === "SYSTEM_RUN_DENIED")',
      )
    : PINNED_BASH_TOOLS_FAILURE_CLASSIFIER_SOURCE;
  const classifierReplacement = hasPermissionFailure
    ? PATCHED_BASH_TOOLS_FAILURE_CLASSIFIER_SOURCE.replace(
        '\tif (code === "SYSTEM_RUN_DENIED"',
        permissionFailure + '\tif (code === "SYSTEM_RUN_DENIED"',
      )
    : PATCHED_BASH_TOOLS_FAILURE_CLASSIFIER_SOURCE;
  let patched = replaceExactlyOnce(
    source,
    classifierSource,
    classifierReplacement,
    "node pre-execution failure classification",
  );
  patched = replaceExactlyOnce(
    patched,
    PINNED_BASH_TOOLS_FAILURE_REGION_SOURCE,
    PATCHED_BASH_TOOLS_FAILURE_REGION_SOURCE,
    "node unresolved-outcome cache insertion",
  );
  patched = replaceExactlyOnce(
    patched,
    PINNED_BASH_TOOLS_POLICY_DENIED_GUIDANCE_SOURCE,
    PATCHED_BASH_TOOLS_POLICY_DENIED_GUIDANCE_SOURCE,
    "node pre-execution retry guidance",
  );
  patched = replaceExactlyOnce(
    patched,
    PINNED_BASH_TOOLS_PREPARED_SOURCE,
    PATCHED_BASH_TOOLS_PREPARED_SOURCE,
    "node unresolved-outcome pre-approval deduplication",
  );
  patched = replaceExactlyOnce(
    patched,
    PINNED_BASH_TOOLS_DISPATCH_FAILURE_SOURCE,
    PATCHED_BASH_TOOLS_DISPATCH_FAILURE_SOURCE,
    "node synchronous unresolved-outcome recording",
  );
  patched = replaceExactlyOnce(
    patched,
    PINNED_BASH_TOOLS_FOLLOWUP_FAILURE_SOURCE,
    PATCHED_BASH_TOOLS_FOLLOWUP_FAILURE_SOURCE,
    "node approval follow-up unresolved-outcome recording",
  );
  patched = replaceExactlyOnce(
    patched,
    PINNED_BASH_TOOLS_INVOKE_RESULT_SOURCE,
    PATCHED_BASH_TOOLS_INVOKE_RESULT_SOURCE,
    "node semantic pre-execution rejection classification",
  );
  patched = replaceExactlyOnce(
    patched,
    hasPermissionFailure
      ? PINNED_BASH_TOOLS_FINAL_DISPATCH_SOURCE.replace(
          "\t\trequest: params,",
          "\t\tsource: assertSourceActive,\n\t\trequest: params,",
        )
      : PINNED_BASH_TOOLS_FINAL_DISPATCH_SOURCE,
    hasPermissionFailure
      ? PATCHED_BASH_TOOLS_FINAL_DISPATCH_SOURCE.replace(
          "\t\trequest: params,",
          "\t\tsource: assertSourceActive,\n\t\trequest: params,",
        )
      : PATCHED_BASH_TOOLS_FINAL_DISPATCH_SOURCE,
    "node unresolved-outcome dispatch identity",
  );
  return replaceExactlyOnce(
    patched,
    hasPermissionFailure
      ? "\t\t\tconst host = resolveHostForParams(params);"
      : PINNED_BASH_TOOLS_HOST_SELECTION_SOURCE,
    hasPermissionFailure
      ? PATCHED_BASH_TOOLS_HOST_SELECTION_SOURCE.replace(
          "const host = target.effectiveHost;",
          "const host = resolveHostForParams(params);",
        ).replace("\n\t\t\tconst explicitSecurity = defaults?.security;", "")
      : PATCHED_BASH_TOOLS_HOST_SELECTION_SOURCE,
    "MXC exec host lock",
  );
}

export const PINNED_CRON_STARTUP_MISSED_JOBS_SOURCE = `\t\tawait runMissedJobs(state, {
\t\t\tskipJobIds: skipJobIds.size > 0 ? skipJobIds : void 0,
\t\t\tdeferAgentWork: true
\t\t});`;
const PATCHED_CRON_STARTUP_MISSED_JOBS_SOURCE = `\t\tconst microclawCronResumeFenceRaw = process.env.MICROCLAW_MXC_CRON_RESUME_FENCE_UNIX_MS;
\t\tconst microclawCronResumeFenceUnixMs = microclawCronResumeFenceRaw === void 0 ? void 0 : Number(microclawCronResumeFenceRaw);
\t\tif (microclawCronResumeFenceUnixMs !== void 0 && Number.isSafeInteger(microclawCronResumeFenceUnixMs) && microclawCronResumeFenceUnixMs >= 0 && microclawCronResumeFenceUnixMs <= state.deps.nowMs()) {
\t\t\tawait recomputeUnownedCronSchedules(state, {
\t\t\t\trecomputeExpired: true,
\t\t\t\tnowMs: microclawCronResumeFenceUnixMs
\t\t\t});
\t\t\tstate.deps.log.info({
\t\t\t\tresumeFenceUnixMs: microclawCronResumeFenceUnixMs
\t\t\t}, "cron: advanced schedules missed during MXC pause");
\t\t}
\t\tawait runMissedJobs(state, {
\t\t\tskipJobIds: skipJobIds.size > 0 ? skipJobIds : void 0,
\t\t\tdeferAgentWork: true
\t\t});`;

export function patchPinnedOpenClawCronService(source) {
  if (source.includes(PINNED_CRON_WORKER_START_SOURCE)) {
    const patched = replaceExactlyOnce(
      source,
      PINNED_CRON_WORKER_START_SOURCE,
      PATCHED_CRON_WORKER_START_SOURCE,
      "Cron worker startup missed-job fence",
    );
    const acknowledgement = PATCHED_CRON_STARTUP_ACK_SOURCE.slice(
      PATCHED_CRON_STARTUP_ACK_SOURCE.indexOf("\t\tconst microclawCronResumeAckPath"),
      PATCHED_CRON_STARTUP_ACK_SOURCE.lastIndexOf("\t\tstate.deps.log.info({"),
    ).replace(/^\t/gm, "");
    return replaceExactlyOnce(
      patched,
      PINNED_CRON_WORKER_ACK_SOURCE,
      acknowledgement + PINNED_CRON_WORKER_ACK_SOURCE,
      "Cron worker startup resume acknowledgement",
    );
  }
  let patched = replaceExactlyOnce(
    source,
    PINNED_CRON_STARTUP_MISSED_JOBS_SOURCE,
    PATCHED_CRON_STARTUP_MISSED_JOBS_SOURCE,
    "Cron startup missed-job fence",
  );
  patched = replaceExactlyOnce(
    patched,
    PINNED_CRON_STARTUP_ACK_SOURCE,
    PATCHED_CRON_STARTUP_ACK_SOURCE,
    "Cron startup resume acknowledgement",
  );
  return patched;
}

export const PINNED_CRON_WORKER_START_SOURCE = `\tif (state.stopped || state.lifecycleGeneration !== generation) return;
\tawait startCronScheduler(state, skipJobIds);`;
const PATCHED_CRON_WORKER_START_SOURCE = `\tif (state.stopped || state.lifecycleGeneration !== generation) return;
\tconst microclawCronWorkerResumeFenceRaw = process.env.MICROCLAW_MXC_CRON_RESUME_FENCE_UNIX_MS;
\tif (microclawCronWorkerResumeFenceRaw !== void 0) {
\t\tconst microclawCronResumeFenceUnixMs = Number(microclawCronWorkerResumeFenceRaw);
\t\tif (!Number.isSafeInteger(microclawCronResumeFenceUnixMs) || microclawCronResumeFenceUnixMs < 0 || microclawCronResumeFenceUnixMs > state.deps.nowMs()) throw new Error("Invalid MicroClaw Cron resume fence");
\t\tawait locked(state, () => recomputeUnownedCronSchedules(state, {
\t\t\trecomputeExpired: true,
\t\t\tnowMs: microclawCronResumeFenceUnixMs
\t\t}));
\t\tif (state.stopped || state.lifecycleGeneration !== generation) return;
\t}
\tawait startCronScheduler(state, skipJobIds);`;
export const PINNED_CRON_WORKER_ACK_SOURCE = `\tstate.deps.log.info({
\t\tenabled: state.deps.cronEnabled,
\t\tjobs: state.store?.jobs.length ?? 0
\t}, "cron: started");`;

export const PINNED_CRON_STARTUP_ACK_SOURCE = `\t\tarmTimer(state);
\t\tresumeForeignReceiptMonitor(state);
\t\tstate.deps.log.info({`;
const PATCHED_CRON_STARTUP_ACK_SOURCE = `\t\tarmTimer(state);
\t\tresumeForeignReceiptMonitor(state);
\t\tconst microclawCronResumeAckPath = process.env.MICROCLAW_MXC_CRON_RESUME_ACK_PATH;
\t\tconst microclawCronResumeAckToken = process.env.MICROCLAW_MXC_CRON_RESUME_ACK_TOKEN;
\t\tconst microclawCronResumeFenceRaw = process.env.MICROCLAW_MXC_CRON_RESUME_FENCE_UNIX_MS;
\t\tif (microclawCronResumeAckPath !== void 0 && microclawCronResumeAckToken !== void 0 && microclawCronResumeFenceRaw !== void 0) {
\t\t\tconst microclawCronResumeFenceUnixMs = Number(microclawCronResumeFenceRaw);
\t\t\tawait (await import("node:fs/promises")).writeFile(microclawCronResumeAckPath, JSON.stringify({
\t\t\t\tcontract: "microclaw.windows-node-mxc.cron-resume.v1",
\t\t\t\tresumeAfterUnixMs: microclawCronResumeFenceUnixMs,
\t\t\t\tacknowledgementToken: microclawCronResumeAckToken,
\t\t\t\tcompletedAtUnixMs: state.deps.nowMs()
\t\t\t}), { encoding: "utf8", flag: "wx" });
\t\t\tdelete process.env.MICROCLAW_MXC_CRON_RESUME_FENCE_UNIX_MS;
\t\t\tdelete process.env.MICROCLAW_MXC_CRON_RESUME_ACK_PATH;
\t\t\tdelete process.env.MICROCLAW_MXC_CRON_RESUME_ACK_TOKEN;
\t\t}
\t\tstate.deps.log.info({`;

function encodeField(name, value) {
  return `${name}=${Buffer.byteLength(value, "utf8")}:${value}`;
}

function encodeNullableField(name, value) {
  return value === null ? `${name}=-1:` : encodeField(name, value);
}

export function normalizePowerShellProviderInitialization(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 5
  )
    return null;
  const keys = ["contract", "form", "originalArgv", "originalCommandPreview", "finalArgv"];
  if (
    Object.keys(value).some((key) => !keys.includes(key)) ||
    value.contract !== "microclaw.powershell-filesystem-scope.v1" ||
    (value.form !== "direct" && value.form !== "nested" && value.form !== "cmd") ||
    typeof value.originalCommandPreview !== "string" ||
    !value.originalCommandPreview ||
    value.originalCommandPreview.length > 8192
  )
    return null;
  for (const argv of [value.originalArgv, value.finalArgv])
    if (
      !Array.isArray(argv) ||
      argv.length < 4 ||
      argv.length > 8 ||
      argv.some((argument) => typeof argument !== "string" || !argument || argument.length > 4096)
    )
      return null;
  return {
    contract: value.contract,
    form: value.form,
    originalArgv: [...value.originalArgv],
    originalCommandPreview: value.originalCommandPreview,
    finalArgv: [...value.finalArgv],
  };
}

function normalizeApprovalPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("MicroClaw approval proof requires a prepared system.run plan");
  }
  if (
    !Array.isArray(plan.argv) ||
    plan.argv.length === 0 ||
    plan.argv.some((argument) => typeof argument !== "string" || argument.length === 0)
  ) {
    throw new Error("MicroClaw approval proof plan argv is invalid");
  }
  const nullableString = (name, required) => {
    if (!Object.hasOwn(plan, name)) {
      if (!required) return null;
      throw new Error(`MicroClaw approval proof plan is missing ${name}`);
    }
    const value = plan[name];
    if (value === null) return null;
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`MicroClaw approval proof plan ${name} is invalid`);
    }
    return value;
  };
  const requiredString = (name) => {
    if (!Object.hasOwn(plan, name)) {
      throw new Error(`MicroClaw approval proof plan is missing ${name}`);
    }
    const value = plan[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`MicroClaw approval proof plan ${name} is invalid`);
    }
    return value;
  };
  const providerInitialization = Object.hasOwn(plan, "providerInitialization")
    ? normalizePowerShellProviderInitialization(plan.providerInitialization)
    : undefined;
  if (Object.hasOwn(plan, "providerInitialization") && !providerInitialization)
    throw new Error("MicroClaw approval proof provider initialization is invalid");
  return {
    argv: [...plan.argv],
    cwd: nullableString("cwd", true),
    commandText: requiredString("commandText"),
    commandPreview: nullableString("commandPreview", false),
    agentId: nullableString("agentId", true),
    sessionKey: requiredString("sessionKey"),
    executablePath: requiredString("executablePath"),
    executableSha256: requiredString("executableSha256").toLowerCase(),
    cwdBinding: requiredString("cwdBinding"),
    declaredAccess: normalizeDeclaredAccess(plan.declaredAccess),
    ...(plan.policyFingerprint !== undefined
      ? { policyFingerprint: requiredString("policyFingerprint") }
      : {}),
    ...(providerInitialization ? { providerInitialization } : {}),
  };
}

function normalizeDeclaredAccess(value) {
  if (!Array.isArray(value)) {
    throw new Error("MicroClaw approval proof plan declaredAccess is invalid");
  }
  return value
    .map((entry) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        (entry.access !== "ro" && entry.access !== "rw") ||
        typeof entry.path !== "string" ||
        !entry.path
      ) {
        throw new Error("MicroClaw approval proof plan declaredAccess is invalid");
      }
      return { access: entry.access, path: entry.path };
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export function computeWindowsNodeMxcApprovalPlanSha256(plan) {
  const normalized = normalizeApprovalPlan(plan);
  const fields = [
    APPROVAL_PROOF_PLAN_CONTRACT,
    `argv=${normalized.argv.length}`,
    ...normalized.argv.map((argument) => encodeField("arg", argument)),
    encodeNullableField("cwd", normalized.cwd),
    encodeField("commandText", normalized.commandText),
    encodeNullableField("commandPreview", normalized.commandPreview),
    encodeNullableField("agentId", normalized.agentId),
    encodeField("sessionKey", normalized.sessionKey),
    encodeField("executablePath", normalized.executablePath),
    encodeField("executableSha256", normalized.executableSha256),
    encodeField("cwdBinding", normalized.cwdBinding),
    `declaredAccess=${normalized.declaredAccess.length}`,
    ...normalized.declaredAccess.flatMap((entry) => [
      encodeField("access", entry.access),
      encodeField("path", entry.path),
    ]),
  ];
  const initialization = normalized.providerInitialization;
  if (initialization)
    fields.push(
      encodeField("providerInitialization.contract", initialization.contract),
      encodeField("providerInitialization.form", initialization.form),
      `providerInitialization.originalArgv=${initialization.originalArgv.length}`,
      ...initialization.originalArgv.map((argument) =>
        encodeField("providerInitialization.originalArg", argument),
      ),
      encodeField(
        "providerInitialization.originalCommandPreview",
        initialization.originalCommandPreview,
      ),
      `providerInitialization.finalArgv=${initialization.finalArgv.length}`,
      ...initialization.finalArgv.map((argument) =>
        encodeField("providerInitialization.finalArg", argument),
      ),
    );
  if (normalized.policyFingerprint !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(normalized.policyFingerprint))
      throw new Error("MicroClaw approval plan policy fingerprint is invalid");
    fields.push(encodeField("policyFingerprint", normalized.policyFingerprint));
  }
  return createHash("sha256").update(fields.join("\n"), "utf8").digest("hex");
}

export function createWindowsNodeMxcLivePolicyReader(config, read = readFileSync) {
  const key = createPublicKey({
    key: Buffer.from(config.publicKey, "base64"),
    format: "der",
    type: "spki",
  });
  let latest = null;
  let lastEnvelope = null;
  return () => {
    const text = read(config.path, "utf8");
    if (text === lastEnvelope) return latest;
    const envelope = JSON.parse(text);
    if (
      typeof envelope.payload !== "string" ||
      typeof envelope.signature !== "string" ||
      !verify(
        "sha256",
        Buffer.from(envelope.payload, "utf8"),
        { key, dsaEncoding: "ieee-p1363" },
        Buffer.from(envelope.signature, "base64"),
      )
    )
      throw new Error("MicroClaw live policy signature is invalid");
    const policy = JSON.parse(envelope.payload);
    if (
      policy.contract !== "microclaw.windows-node-live-policy.v1" ||
      policy.gatewayGeneration !== config.gatewayGeneration ||
      !Number.isSafeInteger(policy.revision) ||
      policy.revision <= (latest?.revision ?? 0) ||
      typeof policy.policyJson !== "string" ||
      createHash("sha256").update(policy.policyJson, "utf8").digest("hex") !==
        policy.policyFingerprint
    )
      throw new Error("MicroClaw live policy generation, revision or fingerprint is invalid");
    if (policy.approval && typeof policy.approval === "object") Object.freeze(policy.approval);
    latest = Object.freeze(policy);
    lastEnvelope = text;
    return policy;
  };
}

export function computeWindowsNodeMxcApprovalProofSignature(secret, proof) {
  const fields = [
    APPROVAL_PROOF_CONTRACT,
    encodeField("approvalId", proof.approvalId),
    encodeField("nonce", proof.nonce),
    encodeField("gatewayGeneration", proof.gatewayGeneration),
    encodeField("policyFingerprint", proof.policyFingerprint),
    encodeField("nodeId", proof.nodeId.toLowerCase()),
    encodeField("planSha256", proof.planSha256.toLowerCase()),
    `issuedAtUnixMs=${proof.issuedAtUnixMs}`,
    `expiresAtUnixMs=${proof.expiresAtUnixMs}`,
    encodeField("consentDecision", proof.consentDecision ?? "allow-once"),
  ];
  return createHmac("sha256", secret).update(fields.join("\n"), "utf8").digest("hex");
}

export function createWindowsNodeMxcApprovalProofMinter(config, dependencies = {}) {
  const secret = Buffer.from(config.secretBase64 ?? "", "base64");
  if (secret.length !== 32 || secret.toString("base64") !== config.secretBase64) {
    throw new Error("MicroClaw approval proof secret must contain exactly 256 bits");
  }
  if (
    typeof config.gatewayGeneration !== "string" ||
    !config.gatewayGeneration ||
    !/^[a-f0-9]{64}$/i.test(config.policyFingerprint ?? "") ||
    !/^[a-f0-9]{64}$/i.test(config.nodeId ?? "")
  ) {
    throw new Error("MicroClaw approval proof generation context is invalid");
  }
  const now = dependencies.now ?? Date.now;
  const createNonce = dependencies.randomUUID ?? randomUUID;
  return Object.freeze({
    mint({ approvalId, nodeId, plan }) {
      if (typeof approvalId !== "string" || !approvalId.trim() || approvalId.length > 256) {
        throw new Error("MicroClaw approval proof ID is invalid");
      }
      if (typeof nodeId !== "string" || nodeId.toLowerCase() !== config.nodeId.toLowerCase()) {
        throw new Error("MicroClaw approval proof node binding is invalid");
      }
      const issuedAtUnixMs = Math.floor(now());
      const planSha256 = computeWindowsNodeMxcApprovalPlanSha256(plan);
      const policy = dependencies.readPolicy?.();
      if (policy && plan.policyFingerprint !== policy.policyFingerprint) {
        const approval = policy.approval;
        if (
          !approval ||
          approval.approvalId !== approvalId ||
          approval.planSha256 !== planSha256 ||
          !Number.isSafeInteger(approval.expiresAtUnixMs) ||
          approval.expiresAtUnixMs <= issuedAtUnixMs
        )
          throw new Error("MicroClaw approval plan belongs to a stale folder policy");
      }
      const proof = {
        contract: APPROVAL_PROOF_CONTRACT,
        approvalId,
        nonce: createNonce(),
        gatewayGeneration: config.gatewayGeneration,
        policyFingerprint: policy?.policyFingerprint ?? config.policyFingerprint.toLowerCase(),
        nodeId: config.nodeId.toLowerCase(),
        planSha256,
        issuedAtUnixMs,
        expiresAtUnixMs: issuedAtUnixMs + APPROVAL_PROOF_TTL_MS,
        consentDecision: plan.commandConsent?.required === false ? "policy" : "allow-once",
      };
      return {
        ...proof,
        signature: computeWindowsNodeMxcApprovalProofSignature(secret, proof),
      };
    },
  });
}

function readRequiredEnvironment(name, secret = false) {
  const value = process.env[name];
  if (secret) delete process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function installApprovalProofMinter() {
  const config = {
    secretBase64: readRequiredEnvironment("MICROCLAW_MXC_APPROVAL_PROOF_SECRET", true),
    gatewayGeneration: readRequiredEnvironment("MICROCLAW_MXC_APPROVAL_PROOF_GATEWAY_GENERATION"),
    policyFingerprint: readRequiredEnvironment("MICROCLAW_MXC_APPROVAL_PROOF_POLICY_FINGERPRINT"),
    nodeId: readRequiredEnvironment("MICROCLAW_MXC_APPROVAL_PROOF_NODE_ID"),
  };
  const livePath = process.env.MICROCLAW_MXC_LIVE_POLICY_PATH;
  const readPolicy = livePath
    ? createWindowsNodeMxcLivePolicyReader({
        path: livePath,
        publicKey: readRequiredEnvironment("MICROCLAW_MXC_LIVE_POLICY_PUBLIC_KEY"),
        gatewayGeneration: config.gatewayGeneration,
      })
    : undefined;
  if (readPolicy && readPolicy().policyFingerprint !== config.policyFingerprint)
    throw new Error("MicroClaw initial live policy does not match Gateway bootstrap");
  if (readPolicy) {
    Object.defineProperty(globalThis, Symbol.for("microclaw.windows-node-mxc.live-policy.v1"), {
      value: readPolicy,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
  const minter = createWindowsNodeMxcApprovalProofMinter(config, { readPolicy });
  Object.defineProperty(globalThis, APPROVAL_PROOF_MINTER_SYMBOL, {
    value: minter,
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

export function validatePinnedOpenClawApprovalPackage(
  packageDir,
  capabilities = {
    approval: true,
    cronResume: false,
  },
) {
  if (!packageDir || !isAbsolute(packageDir)) {
    throw new Error("MICROCLAW_OPENCLAW_PACKAGE_DIR must be an absolute path");
  }

  const canonicalPackageDir = canonicalPath(packageDir);
  const packageJson = JSON.parse(readFileSync(join(canonicalPackageDir, "package.json"), "utf8"));
  const modules = Object.hasOwn(PINNED_RELEASE_MODULES, packageJson.version)
    ? PINNED_RELEASE_MODULES[packageJson.version]
    : null;
  if (!modules) {
    throw new Error(
      `Windows Node + MXC approval compatibility requires OpenClaw ${EXPECTED_VERSION}; found ${packageJson.version ?? "unknown"}`,
    );
  }

  const createTarget = (name, patch) => {
    const [module, sha256] = modules[name];
    return { module, sha256, patch };
  };
  const requestedTargets = [];
  if (capabilities.approval) {
    requestedTargets.push(
      createTarget("nodeGateway", patchPinnedOpenClawNodeGateway),
      createTarget("nodeInvokePluginPolicy", patchPinnedOpenClawNodeInvokePluginPolicy),
      createTarget("nodeRegistryPrivate", patchPinnedOpenClawNodeRegistryPrivate),
      createTarget("systemRun", patchPinnedOpenClawSystemRun),
      createTarget("execApproval", patchPinnedOpenClawExecApproval),
      createTarget("bashTools", patchPinnedOpenClawBashTools),
      createTarget("webTools", attestPinnedOpenClawWebFetchHttpOnly),
    );
  }
  if (capabilities.cronResume) {
    requestedTargets.push(createTarget("cronService", patchPinnedOpenClawCronService));
  }
  return requestedTargets.map((target) => {
    const modulePath = join(canonicalPackageDir, "dist", target.module);
    const targetPath = canonicalPath(modulePath);
    const targetRelative = relative(canonicalPackageDir, targetPath);
    if (targetRelative.startsWith("..") || isAbsolute(targetRelative)) {
      throw new Error("Pinned OpenClaw approval module escaped its package directory");
    }
    const original = readFileSync(targetPath);
    const hash = createHash("sha256").update(original).digest("hex");
    if (hash !== target.sha256) {
      throw new Error(`Pinned OpenClaw approval module hash mismatch (${target.module}): ${hash}`);
    }
    target.patch(original.toString("utf8"));
    return { ...target, modulePath, targetPath, original };
  });
}

export function createPinnedApprovalLoadHook(targets) {
  const lexicalTargets = new Map();
  const canonicalTargets = new Map();
  for (const target of targets) {
    const lexical = resolve(target.modulePath);
    if (!lexicalTargets.has(lexical)) lexicalTargets.set(lexical, target);
    if (!canonicalTargets.has(target.targetPath)) canonicalTargets.set(target.targetPath, target);
  }
  return function load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith("file:")) return result;
    const requestedPath = resolve(fileURLToPath(url));
    const lexicalTarget = lexicalTargets.get(requestedPath);
    const loadedPath = canonicalPath(requestedPath);
    if (lexicalTarget && lexicalTarget.targetPath !== loadedPath) {
      throw new Error(`Pinned OpenClaw module changed after validation (${lexicalTarget.module})`);
    }
    const target = lexicalTarget ?? canonicalTargets.get(loadedPath);
    return target ? { ...result, source: target.patch(target.original.toString("utf8")) } : result;
  };
}

function initialize() {
  const approvalEnabled = process.env.MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT === "1";
  const cronResumeFence = process.env.MICROCLAW_MXC_CRON_RESUME_FENCE_UNIX_MS;
  const cronResumeEnabled = cronResumeFence !== void 0;
  if (cronResumeEnabled) {
    const parsedFence = Number(cronResumeFence);
    const acknowledgementPath = process.env.MICROCLAW_MXC_CRON_RESUME_ACK_PATH;
    const acknowledgementToken = process.env.MICROCLAW_MXC_CRON_RESUME_ACK_TOKEN;
    if (
      !Number.isSafeInteger(parsedFence) ||
      parsedFence < 0 ||
      parsedFence > Date.now() ||
      !acknowledgementPath ||
      !isAbsolute(acknowledgementPath) ||
      !acknowledgementToken
    ) {
      throw new Error("MICROCLAW_MXC_CRON_RESUME_FENCE_UNIX_MS is invalid");
    }
  }
  const targets = validatePinnedOpenClawApprovalPackage(
    process.env.MICROCLAW_OPENCLAW_PACKAGE_DIR,
    {
      approval: approvalEnabled,
      cronResume: cronResumeEnabled,
    },
  );
  if (approvalEnabled) installApprovalProofMinter();

  registerHooks({ load: createPinnedApprovalLoadHook(targets) });
  globalThis.console.log(
    `[microclaw-openclaw-compat] enabled ${[
      approvalEnabled ? "one-use node proof and prepared-plan backports" : null,
      cronResumeEnabled ? "MXC Cron no-catch-up resume fence" : null,
    ]
      .filter(Boolean)
      .join("; ")}`,
  );
}

export function shouldInitializeApprovalPreload(environment, mainThread) {
  if (
    environment.MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT !== "1" &&
    environment.MICROCLAW_MXC_CRON_RESUME_FENCE_UNIX_MS === void 0
  ) {
    return false;
  }
  if (environment[PRELOAD_INITIALIZED_ENV] === "1") return false;
  if (!mainThread) {
    throw new Error("MicroClaw approval preload must initialize on the Gateway main thread");
  }
  return true;
}

if (shouldInitializeApprovalPreload(process.env, isMainThread)) {
  try {
    initialize();
    process.env[PRELOAD_INITIALIZED_ENV] = "1";
  } catch (error) {
    globalThis.console.error("[microclaw-openclaw-compat] initialization failed", error);
    throw error;
  }
}
