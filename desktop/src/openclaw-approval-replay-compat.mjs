import { Buffer } from "node:buffer";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

const EXPECTED_VERSION = "2026.10.2";
const EXPECTED_NODE_GATEWAY_MODULE = "nodes-CUbe_1MQ.mjs";
const EXPECTED_NODE_GATEWAY_SHA256 =
  "3bc901af8f195d8b5d7ed41b2c50656f3da2ff160938d94d97d0c2fa8e42e676";
const EXPECTED_NODE_INVOKE_PLUGIN_POLICY_MODULE = "node-invoke-plugin-policy-DLQRKKVA.mjs";
const EXPECTED_NODE_INVOKE_PLUGIN_POLICY_SHA256 =
  "6da4ee5c889ad2c236265b7f3290b4fd9c0ee1bcaa91bde0bd8f5a3c1ff532e9";
const EXPECTED_NODE_REGISTRY_PRIVATE_MODULE = "node-registry-private-CyaYRwVd.mjs";
const EXPECTED_NODE_REGISTRY_PRIVATE_SHA256 =
  "31510d11a6f80614e8c1d3d3b3c44eec42a61feb17cb05e051ad613ce6475228";
const EXPECTED_SYSTEM_RUN_MODULE = "system-run-approval-plan-Cu-Ftdkp.mjs";
const EXPECTED_SYSTEM_RUN_SHA256 =
  "c0df5badb2a8cc6adfdfb8bac48e5379e0825005e0dec827d01b2fb3e223820e";
const EXPECTED_EXEC_APPROVAL_MODULE = "exec-approval-mGU7M4-K.mjs";
const EXPECTED_EXEC_APPROVAL_SHA256 =
  "aacf6a38e1ea77a9ce02fc4f60069230eec6b9c0a2e7123d35032eb105253267";
const EXPECTED_BASH_TOOLS_MODULE = "bash-tools-Bl8Bd3CR.mjs";
const EXPECTED_BASH_TOOLS_SHA256 =
  "e5fd9fdfb6815da55188856b7215c406337f45d21b89fb87bb7a8a6ca48c0c90";
const EXPECTED_WEB_TOOLS_MODULE = "openclaw-tools-Dxfbrtff.mjs";
const EXPECTED_WEB_TOOLS_SHA256 =
  "181c5f9673480fbdacfa3ff88ae83686d8d1cb6402f583c3546d87b6e468d53e";
const EXPECTED_CRON_SERVICE_MODULE = "service-31u04axN.mjs";
const EXPECTED_CRON_SERVICE_SHA256 =
  "5f3fda2b466273f79606dbccb53e2952d3c33e198d32c8a0eed30f7be5cda3ab";
const EXPECTED_CRON_HANDLERS_MODULE = "cron-D3Bd3ZFt.mjs";
const EXPECTED_CRON_HANDLERS_SHA256 =
  "3dd84c2aebf7cfe326f1ae4d3f40e5c68e4c897a623d834c60a613888c1f6ea1";
const EXPECTED_HOOKS_SERVER_MODULE = "server-start-DfGddYU-.mjs";
const EXPECTED_HOOKS_SERVER_SHA256 =
  "86b9912a5458cd617e22dcdb24cc8ba757ea2206b298bf8831b22cd874e5efae";
const EXPECTED_INTERNAL_HOOKS_MODULE = "internal-hooks-DfVqU7ax.mjs";
const EXPECTED_INTERNAL_HOOKS_SHA256 =
  "3e0200cbe95b537ac5c4fc36509197b2d13700a72688e26839620248c6c967d0";
const EXPECTED_CANVAS_EXTENSION_MODULE = "extensions/canvas/index.js";
const EXPECTED_CANVAS_EXTENSION_SHA256 =
  "81a8476cf4bdf208710f7be014aa2bb72321399d2b46f3d8101826223182b9df";
const EXPECTED_CANVAS_TOOL_MODULE = "tool-CpRzQ0s7.mjs";
const EXPECTED_CANVAS_TOOL_SHA256 =
  "2e45e3320ec6f3e8eb6005b06b90a29f1e620541079cf2b0f14d4342be60056a";
const EXPECTED_CANVAS_ELIGIBILITY_MODULE = "node-eligibility-UXb9xB0F.mjs";
const EXPECTED_CANVAS_ELIGIBILITY_SHA256 =
  "4e80d6add8a2cd46f315e1698b65001fe837d1b16056a8255d34f546358c6431";
export const APPROVAL_PROOF_CONTRACT = "microclaw.windows-node-approval.v1";
export const APPROVAL_PROOF_PLAN_CONTRACT = "microclaw.windows-node-approval-plan.v2";
export const APPROVAL_PROOF_TTL_MS = 30_000;
const APPROVAL_PROOF_MINTER_SYMBOL = Symbol.for("microclaw.windows-node-mxc.approval-proof.v1");
const HOOKS_GATE_SYMBOL = Symbol.for("microclaw.windows-node-mxc.hooks-gate.v1");
const PRELOAD_INITIALIZED_ENV = "MICROCLAW_MXC_APPROVAL_PRELOAD_INITIALIZED";

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
    typeof details?.nodeCommandDispatched === "boolean"
      ? details.nodeCommandDispatched
      : undefined;
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

export const PINNED_WEB_FETCH_HTTP_ONLY_SOURCE =
  'if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("Invalid URL: must be http or https");';

export function attestPinnedOpenClawWebFetchHttpOnly(source) {
  if (!source.includes(PINNED_WEB_FETCH_HTTP_ONLY_SOURCE)) {
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

const PATCHED_SYSTEM_RUN_PLAN_SOURCE = `function normalizeMicroclawSystemRunDeclaredAccess(value) {
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
\tconst argv = normalizeStringArray(candidate.argv);
\tif (argv.length === 0) return null;
\tconst mutableFileOperand = normalizeSystemRunApprovalFileOperand(candidate.mutableFileOperand);
\tif (candidate.mutableFileOperand !== void 0 && mutableFileOperand === null) return null;
\tconst policySnapshot = normalizeExecApprovalPolicySnapshot(candidate.policySnapshot);
\tif (candidate.policySnapshot !== void 0 && policySnapshot === null) return null;
\tconst commandText = normalizeNullableString(candidate.commandText) ?? normalizeNullableString(candidate.rawCommand);
\tif (!commandText) return null;
\tconst hasMicroclawIdentity = candidate.executablePath !== void 0 || candidate.executableSha256 !== void 0 || candidate.cwdBinding !== void 0 || candidate.declaredAccess !== void 0;
\tconst executablePath = normalizeNullableString(candidate.executablePath);
\tconst executableSha256 = normalizeNullableString(candidate.executableSha256);
\tconst cwdBinding = normalizeNullableString(candidate.cwdBinding);
\tconst declaredAccess = normalizeMicroclawSystemRunDeclaredAccess(candidate.declaredAccess);
\tif (hasMicroclawIdentity && (!executablePath || !/^[a-z]:\\\\/i.test(executablePath) || !executableSha256 || !/^[a-f0-9]{64}$/i.test(executableSha256) || !cwdBinding || declaredAccess === null)) return null;
\treturn {
\t\targv,
\t\tcwd: normalizeNullableString(candidate.cwd),
\t\tcommandText,
\t\tcommandPreview: normalizeNullableString(candidate.commandPreview),
\t\tagentId: normalizeNullableString(candidate.agentId),
\t\tsessionKey: normalizeNullableString(candidate.sessionKey),
\t\t...policySnapshot ? { policySnapshot } : {},
\t\tmutableFileOperand: mutableFileOperand ?? void 0,
\t\t...hasMicroclawIdentity ? {
\t\t\texecutablePath,
\t\t\texecutableSha256: executableSha256.toLowerCase(),
\t\t\tcwdBinding,
\t\t\tdeclaredAccess
\t\t} : {}
\t};
}`;

export const PINNED_EXEC_APPROVAL_VALIDATION_SOURCE = `\t\t"exec.approval.request": async ({ params, respond, context, client }) => {
\t\t\tif (!assertValidParams(params, validateExecApprovalRequestParams, "exec.approval.request", respond)) return;
\t\t\tconst p = params;`;

const PATCHED_EXEC_APPROVAL_VALIDATION_SOURCE = `\t\t"exec.approval.request": async ({ params, respond, context, client }) => {
\t\t\tconst rawPlan = params && typeof params === "object" && !Array.isArray(params) && params.systemRunPlan && typeof params.systemRunPlan === "object" && !Array.isArray(params.systemRunPlan) ? params.systemRunPlan : null;
\t\t\tconst validationParams = rawPlan ? {
\t\t\t\t...params,
\t\t\t\tsystemRunPlan: Object.fromEntries(Object.entries(rawPlan).filter(([name]) => name !== "executablePath" && name !== "executableSha256" && name !== "cwdBinding" && name !== "declaredAccess"))
\t\t\t} : params;
\t\t\tif (!assertValidParams(validationParams, validateExecApprovalRequestParams, "exec.approval.request", respond)) return;
\t\t\tconst p = params;`;

function replaceExactlyOnce(source, expected, replacement, label) {
  const first = source.indexOf(expected);
  if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`Pinned OpenClaw ${label} did not match exactly once`);
  }
  return source.slice(0, first) + replacement + source.slice(first + expected.length);
}

export function patchPinnedOpenClawNodeGateway(source) {
  let patched = replaceExactlyOnce(
    source,
    PINNED_NODE_GATEWAY_MINT_INSERT_SOURCE,
    PATCHED_NODE_GATEWAY_MINT_INSERT_SOURCE,
    "node approval proof insertion point",
  );
  patched = replaceExactlyOnce(
    patched,
    PINNED_NODE_GATEWAY_APPROVAL_SOURCE,
    PATCHED_NODE_GATEWAY_APPROVAL_SOURCE,
    "node approval proof handoff",
  );
  patched = replaceExactlyOnce(
    patched,
    PINNED_NODE_GATEWAY_ASK_FALLBACK_SOURCE,
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
  let patched = replaceExactlyOnce(
    source,
    PINNED_NODE_REGISTRY_SERIALIZATION_SOURCE,
    PATCHED_NODE_REGISTRY_SERIALIZATION_SOURCE,
    "node registry deferred serialization",
  );
  return replaceExactlyOnce(
    patched,
    PINNED_NODE_REGISTRY_PRE_DISPATCH_SOURCE,
    PATCHED_NODE_REGISTRY_PRE_DISPATCH_SOURCE,
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
  return replaceExactlyOnce(
    source,
    PINNED_EXEC_APPROVAL_VALIDATION_SOURCE,
    PATCHED_EXEC_APPROVAL_VALIDATION_SOURCE,
    "exec approval schema projection",
  );
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

const PATCHED_BASH_TOOLS_PREPARED_SOURCE = `\tconst prepared = await prepareNodeSystemRun({
\t\trequest: {
\t\t\t...params,
\t\t\tsecurity: hostSecurity,
\t\t\task: hostAsk
\t\t},
\t\ttarget
\t});
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

const PATCHED_BASH_TOOLS_INVOKE_RESULT_SOURCE = `\t\tconst raw = await callGatewayTool("node.invoke", { timeoutMs: params.invokeWaitMs }, params.invoke, callOptions);
\t\tconst payload = asNullableRecord(asNullableRecord(raw)?.payload);
\t\tif (typeof payload?.success !== "boolean") return {
\t\t\tok: false,
\t\t\tfailure: {
\t\t\t\treason: "outcome-unknown",
\t\t\t\tretrySafe: false,
\t\t\t\tmessage: "malformed node invoke response"
\t\t\t}
\t\t};
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
\t\t\traw
\t\t};`;

export function patchPinnedOpenClawBashTools(source) {
  let patched = replaceExactlyOnce(
    source,
    PINNED_BASH_TOOLS_FAILURE_CLASSIFIER_SOURCE,
    PATCHED_BASH_TOOLS_FAILURE_CLASSIFIER_SOURCE,
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
    PINNED_BASH_TOOLS_FINAL_DISPATCH_SOURCE,
    PATCHED_BASH_TOOLS_FINAL_DISPATCH_SOURCE,
    "node unresolved-outcome dispatch identity",
  );
  return replaceExactlyOnce(
    patched,
    PINNED_BASH_TOOLS_HOST_SELECTION_SOURCE,
    PATCHED_BASH_TOOLS_HOST_SELECTION_SOURCE,
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

export const PINNED_CRON_HANDLER_MAP_SOURCE = "const cronHandlers = {";
const PATCHED_CRON_HANDLER_MAP_SOURCE = `function rejectMicroclawMxcPausedCronMutation(method, respond) {
\tif (process.env.MICROCLAW_MXC_CRON_PAUSED !== "1") return false;
\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, \`\${method} is paused while MicroClaw MXC is enabled\`));
\treturn true;
}
const cronHandlers = {`;
export const PINNED_CRON_MUTATION_HANDLER_SOURCES = [
  '\t"cron.scratch.set": scopedCronJobHandler("cron.scratch.set", validateCronScratchSetParams, async ({ params, respond, context, client, sessionMutationCommitGuard, hasCurrentClientAuthority }, { jobId, callerScope }) => {',
  '\t"cron.add": async ({ params, respond, context, client, sessionMutationCommitGuard, hasCurrentClientAuthority }) => {',
  '\t"cron.update": async ({ params, respond, context, client, sessionMutationCommitGuard, hasCurrentClientAuthority }) => {',
  '\t"cron.remove": scopedCronJobHandler("cron.remove", validateCronRemoveParams, async ({ respond, context, client, sessionMutationCommitGuard, hasCurrentClientAuthority }, { jobId, callerScope, job }) => {',
  '\t"cron.run": scopedCronJobHandler("cron.run", validateCronRunParams, async (options, { jobId, callerScope, job }) => {',
];

export function patchPinnedOpenClawCronHandlers(source) {
  let patched = replaceExactlyOnce(
    source,
    PINNED_CRON_HANDLER_MAP_SOURCE,
    PATCHED_CRON_HANDLER_MAP_SOURCE,
    "Cron handler map",
  );
  for (const handlerSource of PINNED_CRON_MUTATION_HANDLER_SOURCES) {
    const method = handlerSource.match(/"([^"]+)"/)?.[1];
    if (!method) throw new Error("Pinned OpenClaw Cron mutation handler name is invalid");
    const respondExpression = method === "cron.run" ? "options.respond" : "respond";
    patched = replaceExactlyOnce(
      patched,
      handlerSource,
      `${handlerSource}\n\t\tif (rejectMicroclawMxcPausedCronMutation("${method}", ${respondExpression})) return;`,
      `${method} MXC pause fence`,
    );
  }
  return patched;
}

export const PINNED_EXTERNAL_HOOK_HANDLER_SOURCE = `\tconst handleHooksRequest = async (req, res) => {
\t\tconst hooksConfig = params.hooksConfig();`;
const PATCHED_EXTERNAL_HOOK_HANDLER_SOURCE = `\tconst handleHooksRequest = async (req, res) => {
\t\tconst microclawMxcHooksGate = globalThis[Symbol.for("microclaw.windows-node-mxc.hooks-gate.v1")];
\t\tif (microclawMxcHooksGate?.rejectExternal(req, res)) return true;
\t\tconst hooksConfig = params.hooksConfig();`;

export function patchPinnedOpenClawExternalHooks(source) {
  return replaceExactlyOnce(
    source,
    PINNED_EXTERNAL_HOOK_HANDLER_SOURCE,
    PATCHED_EXTERNAL_HOOK_HANDLER_SOURCE,
    "external Hooks admission gate",
  );
}

export const PINNED_INTERNAL_HOOK_TRIGGER_SOURCE = `async function triggerInternalHook(event) {
\tif (!internalHooksEnabledState.enabled) return;`;
const PATCHED_INTERNAL_HOOK_TRIGGER_SOURCE = `async function triggerInternalHook(event) {
\tconst microclawMxcHooksGate = globalThis[Symbol.for("microclaw.windows-node-mxc.hooks-gate.v1")];
\tif (microclawMxcHooksGate?.dropInternal(event)) return;
\tif (!internalHooksEnabledState.enabled) return;`;

export function patchPinnedOpenClawInternalHooks(source) {
  return replaceExactlyOnce(
    source,
    PINNED_INTERNAL_HOOK_TRIGGER_SOURCE,
    PATCHED_INTERNAL_HOOK_TRIGGER_SOURCE,
    "internal Hooks dispatch gate",
  );
}

const PINNED_CANVAS_EXTENSION_COMMANDS = `const CANVAS_NODE_COMMANDS = [
\t"canvas.present",
\t"canvas.hide",
\t"canvas.navigate"
];`;
const PATCHED_CANVAS_EXTENSION_COMMANDS = `const CANVAS_NODE_COMMANDS = [
\t"canvas.present",
\t"canvas.hide",
\t"canvas.snapshot",
\t"canvas.caps",
\t"canvas.a2ui.push",
\t"canvas.a2ui.pushJSONL",
\t"canvas.a2ui.reset",
\t"canvas.a2ui.dump"
];`;

export function patchPinnedOpenClawCanvasExtension(source) {
  let patched = replaceExactlyOnce(
    source,
    PINNED_CANVAS_EXTENSION_COMMANDS,
    PATCHED_CANVAS_EXTENSION_COMMANDS,
    "Canvas Phase 1 command registration",
  );
  patched = replaceExactlyOnce(
    patched,
    'description: "Presents hosted widget documents on paired macOS panels.",',
    'description: "Presents the managed native A2UI Canvas on paired MicroClaw Windows nodes.",',
    "Canvas Phase 1 plugin description",
  );
  return replaceExactlyOnce(
    patched,
    'defaultPlatforms: ["macos"],',
    'defaultPlatforms: ["windows"],',
    "Canvas Windows platform registration",
  );
}

const PINNED_CANVAS_TOOL_PRESENT_CASE = `\t\t\t\tcase "present": {
\t\t\t\t\tconst placement = {
\t\t\t\t\t\tx: readFiniteNumberParam(params, "x"),
\t\t\t\t\t\ty: readFiniteNumberParam(params, "y"),
\t\t\t\t\t\twidth: readFiniteNumberParam(params, "width"),
\t\t\t\t\t\theight: readFiniteNumberParam(params, "height")
\t\t\t\t\t};
\t\t\t\t\tconst invokeParams = {};
\t\t\t\t\tconst presentTarget = readToolStringParam(params, "target", { trim: true }) ?? readToolStringParam(params, "url", { trim: true });
\t\t\t\t\tif (presentTarget) invokeParams.url = presentTarget;
\t\t\t\t\tif (Object.values(placement).some(Number.isFinite)) invokeParams.placement = placement;
\t\t\t\t\tconst node = await invoke(CANVAS_PRESENT_COMMAND, invokeParams);
\t\t\t\t\treturn jsonResult({
\t\t\t\t\t\tok: true,
\t\t\t\t\t\tnode,
\t\t\t\t\t\t...presentTarget ? { url: presentTarget } : {}
\t\t\t\t\t});
\t\t\t\t}`;
const PATCHED_CANVAS_TOOL_PRESENT_CASE = `\t\t\t\tcase "present": {
\t\t\t\t\tconst { node } = await invoke(CANVAS_PRESENT_COMMAND, {});
\t\t\t\t\treturn jsonResult({
\t\t\t\t\t\tok: true,
\t\t\t\t\t\tnode
\t\t\t\t\t});
\t\t\t\t}`;
const PINNED_CANVAS_TOOL_NAVIGATE_CASE = `\t\t\t\tcase "navigate": {
\t\t\t\t\tconst url = readToolStringParam(params, "url", { trim: true }) ?? readToolStringParam(params, "target", {
\t\t\t\t\t\trequired: true,
\t\t\t\t\t\ttrim: true,
\t\t\t\t\t\tlabel: "url"
\t\t\t\t\t});
\t\t\t\t\tconst node = await invoke("canvas.navigate", { url });
\t\t\t\t\treturn jsonResult({
\t\t\t\t\t\tok: true,
\t\t\t\t\t\tnode,
\t\t\t\t\t\turl
\t\t\t\t\t});
\t\t\t\t}`;

export function patchPinnedOpenClawCanvasTool(source) {
  let patched = replaceExactlyOnce(
    source,
    '\t\t\t\tawait callGatewayTool("node.invoke", {',
    '\t\t\t\tconst result = await callGatewayTool("node.invoke", {',
    "Canvas invocation result capture",
  );
  patched = replaceExactlyOnce(
    patched,
    "\t\t\t\treturn nodeId;\n\t\t\t};",
    "\t\t\t\treturn { node: nodeId, result };\n\t\t\t};",
    "Canvas invocation result projection",
  );
  patched = replaceExactlyOnce(
    patched,
    PINNED_CANVAS_TOOL_PRESENT_CASE,
    PATCHED_CANVAS_TOOL_PRESENT_CASE,
    "Canvas present target removal",
  );
  patched = replaceExactlyOnce(
    patched,
    PINNED_CANVAS_TOOL_NAVIGATE_CASE,
    "",
    "Canvas navigate removal",
  );
  patched = replaceExactlyOnce(
    patched,
    'const node = await invoke("canvas.hide");',
    'const { node } = await invoke("canvas.hide");',
    "Canvas hide result projection",
  );
  return replaceExactlyOnce(
    patched,
    "\t\t\t\tdefault: throw new Error(`Unknown action: ${action}`);",
    `\t\t\t\tcase "snapshot": {
\t\t\t\t\tconst format = readToolStringParam(params, "format", { trim: true });
\t\t\t\t\tconst { node, result } = await invoke("canvas.snapshot", format ? { format } : {});
\t\t\t\t\treturn jsonResult({ ok: true, node, result });
\t\t\t\t}
\t\t\t\tcase "caps": {
\t\t\t\t\tconst { node, result } = await invoke("canvas.caps", {});
\t\t\t\t\treturn jsonResult({ ok: true, node, result });
\t\t\t\t}
\t\t\t\tcase "a2ui_push":
\t\t\t\tcase "a2ui_push_jsonl": {
\t\t\t\t\tconst jsonl = readToolStringParam(params, "jsonl", { required: true });
\t\t\t\t\tconst command = action === "a2ui_push" ? "canvas.a2ui.push" : "canvas.a2ui.pushJSONL";
\t\t\t\t\tconst { node, result } = await invoke(command, {
\t\t\t\t\t\tjsonl,
\t\t\t\t\t\tprops: options?.agentSessionKey ? { sessionKey: options.agentSessionKey } : {}
\t\t\t\t\t});
\t\t\t\t\treturn jsonResult({ ok: true, node, result });
\t\t\t\t}
\t\t\t\tcase "a2ui_reset": {
\t\t\t\t\tconst { node, result } = await invoke("canvas.a2ui.reset", {});
\t\t\t\t\treturn jsonResult({ ok: true, node, result });
\t\t\t\t}
\t\t\t\tcase "a2ui_dump": {
\t\t\t\t\tconst { node, result } = await invoke("canvas.a2ui.dump", {});
\t\t\t\t\treturn jsonResult({ ok: true, node, result });
\t\t\t\t}
\t\t\t\tdefault: throw new Error(\`Unknown action: \${action}\`);`,
    "Canvas Phase 1 safe tool actions",
  );
}

const PINNED_CANVAS_TOOL_SCHEMA = `parameters: Type.Object({
\t\taction: stringEnum([
\t\t\t"present",
\t\t\t"hide",
\t\t\t"navigate"
\t\t]),
\t\tgatewayUrl: Type.Optional(Type.String()),
\t\tgatewayToken: Type.Optional(Type.String()),
\t\ttimeoutMs: optionalPositiveIntegerSchema(),
\t\tnode: Type.Optional(Type.String()),
\t\ttarget: Type.Optional(Type.String()),
\t\tx: optionalFiniteNumberSchema(),
\t\ty: optionalFiniteNumberSchema(),
\t\twidth: optionalFiniteNumberSchema(),
\t\theight: optionalFiniteNumberSchema(),
\t\turl: Type.Optional(Type.String())
\t})`;
const PATCHED_CANVAS_TOOL_SCHEMA = `parameters: Type.Object({
\t\taction: stringEnum([
\t\t\t"present",
\t\t\t"hide",
\t\t\t"snapshot",
\t\t\t"caps",
\t\t\t"a2ui_push",
\t\t\t"a2ui_push_jsonl",
\t\t\t"a2ui_reset",
\t\t\t"a2ui_dump"
\t\t]),
\t\tgatewayUrl: Type.Optional(Type.String()),
\t\tgatewayToken: Type.Optional(Type.String()),
\t\ttimeoutMs: optionalPositiveIntegerSchema(),
\t\tnode: Type.Optional(Type.String()),
\t\tjsonl: Type.Optional(Type.String()),
\t\tformat: Type.Optional(Type.String())
\t})`;
const PINNED_CANVAS_ELIGIBILITY = `function isEligibleCanvasNode(node) {
\tconst commands = node.invocableCommands ?? node.commands ?? [];
\treturn /^macos(?:\\s|$)/i.test(node.platform ?? "") && node.connected === true && commands.includes("canvas.present");
}
const CANVAS_NODE_MESSAGES = {
\tineligibleExact: (query, eligibleIds) => \`node "\${query}" is not an eligible Canvas panel (requires a connected macOS node advertising \${CANVAS_PRESENT_COMMAND}; eligible node ids: \${eligibleIds})\`,
\tnameResolveFailed: (reason, eligibleIds) => \`\${reason} (eligible Canvas panel node ids: \${eligibleIds})\`,
\tnoneEligible: () => \`no eligible Canvas panel (requires a connected macOS node advertising \${CANVAS_PRESENT_COMMAND})\`,
\tmultipleEligible: (eligible) => \`multiple eligible Canvas panels connected; pass node explicitly: \${eligible.map((node) => node.nodeId).join(", ")}\`
};`;
const PATCHED_CANVAS_ELIGIBILITY = `function isEligibleCanvasNode(node) {
\tconst commands = node.invocableCommands ?? node.commands ?? [];
\treturn /^windows(?:\\s|$)/i.test(node.platform ?? "") && node.connected === true && commands.includes("canvas.present");
}
const CANVAS_NODE_MESSAGES = {
\tineligibleExact: (query, eligibleIds) => \`node "\${query}" is not an eligible MicroClaw Canvas (requires a connected Windows node advertising \${CANVAS_PRESENT_COMMAND}; eligible node ids: \${eligibleIds})\`,
\tnameResolveFailed: (reason, eligibleIds) => \`\${reason} (eligible MicroClaw Canvas node ids: \${eligibleIds})\`,
\tnoneEligible: () => \`no eligible MicroClaw Canvas (requires a connected Windows node advertising \${CANVAS_PRESENT_COMMAND})\`,
\tmultipleEligible: (eligible) => \`multiple eligible MicroClaw Canvas nodes connected; pass node explicitly: \${eligible.map((node) => node.nodeId).join(", ")}\`
};`;

export function patchPinnedOpenClawCanvasEligibility(source) {
  let patched = replaceExactlyOnce(
    source,
    'description: "Present, hide, or navigate the widget panel on a paired macOS node.",',
    'description: "Present, update, inspect, snapshot, or hide the managed native A2UI Canvas on a paired MicroClaw Windows node.",',
    "Canvas Phase 1 tool description",
  );
  patched = replaceExactlyOnce(
    patched,
    PINNED_CANVAS_TOOL_SCHEMA,
    PATCHED_CANVAS_TOOL_SCHEMA,
    "Canvas Phase 1 tool schema",
  );
  return replaceExactlyOnce(
    patched,
    PINNED_CANVAS_ELIGIBILITY,
    PATCHED_CANVAS_ELIGIBILITY,
    "Canvas Windows node eligibility",
  );
}

function encodeField(name, value) {
  return `${name}=${Buffer.byteLength(value, "utf8")}:${value}`;
}

function encodeNullableField(name, value) {
  return value === null ? `${name}=-1:` : encodeField(name, value);
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
  return createHash("sha256").update(fields.join("\n"), "utf8").digest("hex");
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
      const proof = {
        contract: APPROVAL_PROOF_CONTRACT,
        approvalId,
        nonce: createNonce(),
        gatewayGeneration: config.gatewayGeneration,
        policyFingerprint: config.policyFingerprint.toLowerCase(),
        nodeId: config.nodeId.toLowerCase(),
        planSha256: computeWindowsNodeMxcApprovalPlanSha256(plan),
        issuedAtUnixMs,
        expiresAtUnixMs: issuedAtUnixMs + APPROVAL_PROOF_TTL_MS,
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
  const minter = createWindowsNodeMxcApprovalProofMinter({
    secretBase64: readRequiredEnvironment("MICROCLAW_MXC_APPROVAL_PROOF_SECRET", true),
    gatewayGeneration: readRequiredEnvironment("MICROCLAW_MXC_APPROVAL_PROOF_GATEWAY_GENERATION"),
    policyFingerprint: readRequiredEnvironment("MICROCLAW_MXC_APPROVAL_PROOF_POLICY_FINGERPRINT"),
    nodeId: readRequiredEnvironment("MICROCLAW_MXC_APPROVAL_PROOF_NODE_ID"),
  });
  Object.defineProperty(globalThis, APPROVAL_PROOF_MINTER_SYMBOL, {
    value: minter,
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

export function isWindowsNodeMxcProtectedHooksPath(rawUrl, basePath) {
  let pathname;
  try {
    pathname = new URL(rawUrl ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return false;
  }
  const candidates = new Set();
  const addCandidate = (candidate) => {
    candidates.add(candidate);
    candidates.add(candidate.replaceAll("\\", "/"));
  };
  addCandidate(pathname);
  let decoded = pathname;
  for (let depth = 0; depth < 3; depth += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      addCandidate(next);
      decoded = next;
    } catch {
      break;
    }
  }
  return [...candidates].some(
    (candidate) => candidate === basePath || candidate.startsWith(`${basePath}/`),
  );
}

export function createWindowsNodeMxcHooksGate(policy) {
  if (
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    policy.contract !== "microclaw.windows-node-mxc.hooks-gate.v1" ||
    typeof policy.gatewayGeneration !== "string" ||
    !policy.gatewayGeneration ||
    !/^[a-f0-9]{64}$/i.test(policy.policyFingerprint ?? "") ||
    (policy.requestedMode !== "full" && policy.requestedMode !== "limited-dacl") ||
    typeof policy.externalRequested !== "boolean" ||
    typeof policy.internalRequested !== "boolean" ||
    typeof policy.basePath !== "string" ||
    !policy.basePath.startsWith("/") ||
    policy.basePath === "/" ||
    policy.basePath.endsWith("/") ||
    /[%?#\\]/.test(policy.basePath) ||
    policy.basePath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("MicroClaw MXC Hooks gate policy is invalid");
  }
  const immutablePolicy = Object.freeze({ ...policy });
  return Object.freeze({
    policy: immutablePolicy,
    rejectExternal(req, res) {
      if (!isWindowsNodeMxcProtectedHooksPath(req?.url, immutablePolicy.basePath)) {
        return false;
      }
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(
        JSON.stringify({
          ok: false,
          error: "Hooks and webhooks are paused while MicroClaw MXC is enabled",
          code: "MXC_HOOKS_PAUSED",
        }),
      );
      return true;
    },
    dropInternal() {
      return true;
    },
  });
}

function installWindowsNodeMxcHooksGate() {
  const encoded = readRequiredEnvironment("MICROCLAW_MXC_HOOKS_GATE_POLICY_BASE64", true);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new Error("MicroClaw MXC Hooks gate policy encoding is invalid");
  }
  let policy;
  try {
    policy = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("MicroClaw MXC Hooks gate policy JSON is invalid");
  }
  Object.defineProperty(globalThis, HOOKS_GATE_SYMBOL, {
    value: createWindowsNodeMxcHooksGate(policy),
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

export function validatePinnedOpenClawApprovalPackage(
  packageDir,
  capabilities = {
    approval: true,
    cronPause: false,
    cronResume: false,
    hooksPause: false,
    canvasPhase1: false,
  },
) {
  if (!packageDir || !isAbsolute(packageDir)) {
    throw new Error("MICROCLAW_OPENCLAW_PACKAGE_DIR must be an absolute path");
  }

  const canonicalPackageDir = realpathSync(packageDir);
  const packageJson = JSON.parse(readFileSync(join(canonicalPackageDir, "package.json"), "utf8"));
  if (packageJson.version !== EXPECTED_VERSION) {
    throw new Error(
      `Windows Node + MXC approval compatibility requires OpenClaw ${EXPECTED_VERSION}; found ${packageJson.version ?? "unknown"}`,
    );
  }

  const requestedTargets = [];
  if (capabilities.approval) {
    requestedTargets.push(
      {
        module: EXPECTED_NODE_GATEWAY_MODULE,
        sha256: EXPECTED_NODE_GATEWAY_SHA256,
        patch: patchPinnedOpenClawNodeGateway,
      },
      {
        module: EXPECTED_NODE_INVOKE_PLUGIN_POLICY_MODULE,
        sha256: EXPECTED_NODE_INVOKE_PLUGIN_POLICY_SHA256,
        patch: patchPinnedOpenClawNodeInvokePluginPolicy,
      },
      {
        module: EXPECTED_NODE_REGISTRY_PRIVATE_MODULE,
        sha256: EXPECTED_NODE_REGISTRY_PRIVATE_SHA256,
        patch: patchPinnedOpenClawNodeRegistryPrivate,
      },
      {
        module: EXPECTED_SYSTEM_RUN_MODULE,
        sha256: EXPECTED_SYSTEM_RUN_SHA256,
        patch: patchPinnedOpenClawSystemRun,
      },
      {
        module: EXPECTED_EXEC_APPROVAL_MODULE,
        sha256: EXPECTED_EXEC_APPROVAL_SHA256,
        patch: patchPinnedOpenClawExecApproval,
      },
      {
        module: EXPECTED_BASH_TOOLS_MODULE,
        sha256: EXPECTED_BASH_TOOLS_SHA256,
        patch: patchPinnedOpenClawBashTools,
      },
      {
        module: EXPECTED_WEB_TOOLS_MODULE,
        sha256: EXPECTED_WEB_TOOLS_SHA256,
        patch: attestPinnedOpenClawWebFetchHttpOnly,
      },
    );
  }
  if (capabilities.cronResume) {
    requestedTargets.push({
      module: EXPECTED_CRON_SERVICE_MODULE,
      sha256: EXPECTED_CRON_SERVICE_SHA256,
      patch: patchPinnedOpenClawCronService,
    });
  }
  if (capabilities.cronPause) {
    requestedTargets.push({
      module: EXPECTED_CRON_HANDLERS_MODULE,
      sha256: EXPECTED_CRON_HANDLERS_SHA256,
      patch: patchPinnedOpenClawCronHandlers,
    });
  }
  if (capabilities.hooksPause) {
    requestedTargets.push(
      {
        module: EXPECTED_HOOKS_SERVER_MODULE,
        sha256: EXPECTED_HOOKS_SERVER_SHA256,
        patch: patchPinnedOpenClawExternalHooks,
      },
      {
        module: EXPECTED_INTERNAL_HOOKS_MODULE,
        sha256: EXPECTED_INTERNAL_HOOKS_SHA256,
        patch: patchPinnedOpenClawInternalHooks,
      },
    );
  }
  if (capabilities.canvasPhase1) {
    requestedTargets.push(
      {
        module: EXPECTED_CANVAS_EXTENSION_MODULE,
        sha256: EXPECTED_CANVAS_EXTENSION_SHA256,
        patch: patchPinnedOpenClawCanvasExtension,
      },
      {
        module: EXPECTED_CANVAS_TOOL_MODULE,
        sha256: EXPECTED_CANVAS_TOOL_SHA256,
        patch: patchPinnedOpenClawCanvasTool,
      },
      {
        module: EXPECTED_CANVAS_ELIGIBILITY_MODULE,
        sha256: EXPECTED_CANVAS_ELIGIBILITY_SHA256,
        patch: patchPinnedOpenClawCanvasEligibility,
      },
    );
  }

  return requestedTargets.map((target) => {
    const modulePath = join(canonicalPackageDir, "dist", target.module);
    const targetPath = realpathSync(modulePath);
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

function initialize() {
  const approvalEnabled = process.env.MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT === "1";
  const cronPauseEnabled = process.env.MICROCLAW_MXC_CRON_PAUSED === "1";
  const cronResumeFence = process.env.MICROCLAW_MXC_CRON_RESUME_FENCE_UNIX_MS;
  const cronResumeEnabled = cronResumeFence !== void 0;
  const hooksPauseEnabled = process.env.MICROCLAW_MXC_HOOKS_GATE_POLICY_BASE64 !== void 0;
  const canvasPhase1Enabled = process.env.MICROCLAW_MXC_CANVAS_PHASE1 === "1";
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
      cronPause: cronPauseEnabled,
      cronResume: cronResumeEnabled,
      hooksPause: hooksPauseEnabled,
      canvasPhase1: canvasPhase1Enabled,
    },
  );
  if (approvalEnabled) installApprovalProofMinter();
  if (hooksPauseEnabled) installWindowsNodeMxcHooksGate();

  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      const requestedPath = url.startsWith("file:") ? resolve(fileURLToPath(url)) : null;
      const lexicalTarget = targets.find(
        (candidate) => resolve(candidate.modulePath) === requestedPath,
      );
      const loadedPath = requestedPath ? realpathSync(requestedPath) : null;
      if (lexicalTarget && lexicalTarget.targetPath !== loadedPath) {
        throw new Error(
          `Pinned OpenClaw module changed after validation (${lexicalTarget.module})`,
        );
      }
      const target =
        lexicalTarget ?? targets.find((candidate) => candidate.targetPath === loadedPath);
      if (target) {
        return { ...result, source: target.patch(target.original.toString("utf8")) };
      }
      return result;
    },
  });
  globalThis.console.log(
    `[microclaw-openclaw-compat] enabled ${[
      approvalEnabled ? "one-use node proof and prepared-plan backports" : null,
      cronPauseEnabled ? "MXC Cron mutation pause fence" : null,
      cronResumeEnabled ? "MXC Cron no-catch-up resume fence" : null,
      hooksPauseEnabled ? "MXC Hooks/Webhooks admission and dispatch pause" : null,
      canvasPhase1Enabled ? "MXC Canvas Phase 1 exact tool and command surface" : null,
    ]
      .filter(Boolean)
      .join("; ")}`,
  );
}

export function shouldInitializeApprovalPreload(environment, mainThread) {
  if (
    environment.MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT !== "1" &&
    environment.MICROCLAW_MXC_CRON_PAUSED !== "1" &&
    environment.MICROCLAW_MXC_CRON_RESUME_FENCE_UNIX_MS === void 0 &&
    environment.MICROCLAW_MXC_HOOKS_GATE_POLICY_BASE64 === void 0 &&
    environment.MICROCLAW_MXC_CANVAS_PHASE1 !== "1"
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
