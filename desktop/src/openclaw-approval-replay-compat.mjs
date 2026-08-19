import { Buffer } from "node:buffer";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

const EXPECTED_VERSION = "2026.7.1-1";
const EXPECTED_MODULE = "gateway-tPQsEkmF.js";
const EXPECTED_SHA256 = "6eed85ef8b377cffa593578227758443b37fc98f87c74848f9ddb4ad8db46bb5";
const EXPECTED_NODE_GATEWAY_MODULE = "nodes-H4LZVTsZ.js";
const EXPECTED_NODE_GATEWAY_SHA256 =
  "d97bf2d9452179d8e63d8e2a197622ad753bc024f6e7978fb7fa389368821952";
export const APPROVAL_PROOF_CONTRACT = "microclaw.windows-node-approval.v1";
export const APPROVAL_PROOF_PLAN_CONTRACT = "microclaw.windows-node-approval-plan.v1";
export const APPROVAL_PROOF_TTL_MS = 15_000;
const APPROVAL_PROOF_MINTER_SYMBOL = Symbol.for(
  "microclaw.windows-node-mxc.approval-proof.v1",
);
const PRELOAD_INITIALIZED_ENV = "MICROCLAW_MXC_APPROVAL_PRELOAD_INITIALIZED";

export const PINNED_FUNCTION_SOURCE = `function resolveApprovalRequesterDeviceIdentityForGatewayTool(params) {
\tif (!APPROVAL_RUNTIME_METHODS.has(params.method)) return;
\tif (trimToUndefined(params.opts.gatewayUrl) !== void 0) return;
\ttry {
\t\tconst identity = loadOrCreateDeviceIdentity();
\t\tif (loadDeviceIdentityIfPresent()?.deviceId !== identity.deviceId) throw new Error("device identity is not persisted");
\t\treturn identity;
\t} catch (error) {
\t\tif (params.target === "local") return;
\t\tthrow new Error(["remote approval gateway calls require a stable device identity.", "Fix the OpenClaw state directory permissions or use the local approval-runtime gateway."].join(" "), { cause: error });
\t}
}`;

const PATCHED_FUNCTION_SOURCE = `function isApprovalReplayNodeSystemRun(method, callParams) {
\tconst invoke = method === "node.invoke" && callParams && typeof callParams === "object" && !Array.isArray(callParams) ? callParams : null;
\tconst run = invoke?.command === "system.run" && invoke.params && typeof invoke.params === "object" && !Array.isArray(invoke.params) ? invoke.params : null;
\tconst decision = normalizeOptionalString(run?.approvalDecision);
\treturn run?.approved === true || decision === "allow-once" || decision === "allow-always";
}
function resolveApprovalRequesterDeviceIdentityForGatewayTool(params) {
\tconst isApprovalRuntimeMethod = APPROVAL_RUNTIME_METHODS.has(params.method);
\tconst isNodeApprovalReplay = isApprovalReplayNodeSystemRun(params.method, params.callParams);
\tif (!isApprovalRuntimeMethod && !isNodeApprovalReplay) return;
\tif (isApprovalRuntimeMethod && trimToUndefined(params.opts.gatewayUrl) !== void 0) return;
\ttry {
\t\tif (isNodeApprovalReplay) {
\t\t\tconst identity = loadDeviceIdentityIfPresent();
\t\t\tif (!identity) throw new Error("device identity is not persisted");
\t\t\treturn identity;
\t\t}
\t\tconst identity = loadOrCreateDeviceIdentity();
\t\tif (loadDeviceIdentityIfPresent()?.deviceId !== identity.deviceId) throw new Error("device identity is not persisted");
\t\treturn identity;
\t} catch (error) {
\t\tif (isNodeApprovalReplay) throw new Error(["approved node gateway calls require a stable device identity.", "Fix the OpenClaw state directory permissions and retry the approval."].join(" "), { cause: error });
\t\tif (params.target === "local") return;
\t\tthrow new Error(["remote approval gateway calls require a stable device identity.", "Fix the OpenClaw state directory permissions or use the local approval-runtime gateway."].join(" "), { cause: error });
\t}
}`;

export const PINNED_CALL_SOURCE = `const deviceIdentity = resolveApprovalRequesterDeviceIdentityForGatewayTool({
\t\tmethod,
\t\topts,
\t\ttarget: gateway.target
\t});`;

const PATCHED_CALL_SOURCE = `const deviceIdentity = resolveApprovalRequesterDeviceIdentityForGatewayTool({
\t\tmethod,
\t\tcallParams: params,
\t\topts,
\t\ttarget: gateway.target
\t});`;

export const PINNED_NODE_GATEWAY_MINT_INSERT_SOURCE =
  "function sanitizeSystemRunParamsForForwarding(opts) {";
const PATCHED_NODE_GATEWAY_MINT_INSERT_SOURCE = `function mintMicroclawNodeApprovalProof(params) {
\tconst minter = globalThis[Symbol.for("microclaw.windows-node-mxc.approval-proof.v1")];
\tif (!minter || typeof minter.mint !== "function") throw new Error("MicroClaw node approval proof minter is unavailable");
\treturn minter.mint(params);
}
function sanitizeSystemRunParamsForForwarding(opts) {`;

export const PINNED_NODE_GATEWAY_ALLOW_ONCE_SOURCE = `\tif (snapshot.decision === "allow-once") {
\t\tif (typeof manager.consumeAllowOnce !== "function" || !manager.consumeAllowOnce(runId)) return systemRunApprovalRequired(runId);
\t\tnext.approved = true;
\t\tnext.approvalDecision = "allow-once";
\t\treturn {
\t\t\tok: true,
\t\t\tparams: next
\t\t};
\t}`;
const PATCHED_NODE_GATEWAY_ALLOW_ONCE_SOURCE = `\tif (snapshot.decision === "allow-once") {
\t\tif (typeof manager.consumeAllowOnce !== "function" || !manager.consumeAllowOnce(runId)) return systemRunApprovalRequired(runId);
\t\tnext.approved = true;
\t\tnext.approvalDecision = "allow-once";
\t\tnext.microclawApprovalProof = mintMicroclawNodeApprovalProof({
\t\t\tapprovalId: runId,
\t\t\tnodeId: targetNodeId,
\t\t\tplan: runtimeContext.plan
\t\t});
\t\treturn {
\t\t\tok: true,
\t\t\tparams: next
\t\t};
\t}`;

export const PINNED_NODE_GATEWAY_ALLOW_ALWAYS_SOURCE = `\tif (snapshot.decision === "allow-always") {
\t\tnext.approved = true;
\t\tnext.approvalDecision = "allow-always";
\t\treturn {
\t\t\tok: true,
\t\t\tparams: next
\t\t};
\t}`;
const PATCHED_NODE_GATEWAY_ALLOW_ALWAYS_SOURCE = `\tif (snapshot.decision === "allow-always") {
\t\tnext.approved = true;
\t\tnext.approvalDecision = "allow-always";
\t\tnext.microclawApprovalProof = mintMicroclawNodeApprovalProof({
\t\t\tapprovalId: runId,
\t\t\tnodeId: targetNodeId,
\t\t\tplan: runtimeContext.plan
\t\t});
\t\treturn {
\t\t\tok: true,
\t\t\tparams: next
\t\t};
\t}`;

export const PINNED_NODE_GATEWAY_BRIDGED_ALLOW_ONCE_SOURCE = `\tif (snapshot.resolvedAtMs !== void 0 && snapshot.decision === void 0 && snapshot.resolvedBy === null && approved && requestedDecision === "allow-once" && clientHasApprovals(opts.client)) {
\t\tnext.approved = true;
\t\tnext.approvalDecision = "allow-once";
\t\treturn {
\t\t\tok: true,
\t\t\tparams: next
\t\t};
\t}`;
const PATCHED_NODE_GATEWAY_BRIDGED_ALLOW_ONCE_SOURCE = `\tif (snapshot.resolvedAtMs !== void 0 && snapshot.decision === void 0 && snapshot.resolvedBy === null && approved && requestedDecision === "allow-once" && clientHasApprovals(opts.client)) {
\t\treturn systemRunApprovalRequired(runId);
\t}`;

function replaceExactlyOnce(source, expected, replacement, label) {
  const first = source.indexOf(expected);
  if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`Pinned OpenClaw ${label} did not match exactly once`);
  }
  return source.slice(0, first) + replacement + source.slice(first + expected.length);
}

export function patchPinnedOpenClawGateway(source) {
  const functionPatched = replaceExactlyOnce(
    source,
    PINNED_FUNCTION_SOURCE,
    PATCHED_FUNCTION_SOURCE,
    "approval identity function",
  );
  return replaceExactlyOnce(
    functionPatched,
    PINNED_CALL_SOURCE,
    PATCHED_CALL_SOURCE,
    "approval identity call",
  );
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
    PINNED_NODE_GATEWAY_ALLOW_ONCE_SOURCE,
    PATCHED_NODE_GATEWAY_ALLOW_ONCE_SOURCE,
    "node allow-once approval proof handoff",
  );
  patched = replaceExactlyOnce(
    patched,
    PINNED_NODE_GATEWAY_ALLOW_ALWAYS_SOURCE,
    PATCHED_NODE_GATEWAY_ALLOW_ALWAYS_SOURCE,
    "node allow-always approval proof handoff",
  );
  return replaceExactlyOnce(
    patched,
    PINNED_NODE_GATEWAY_BRIDGED_ALLOW_ONCE_SOURCE,
    PATCHED_NODE_GATEWAY_BRIDGED_ALLOW_ONCE_SOURCE,
    "node bridged allow-once approval proof handoff",
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
  };
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
      if (
        typeof nodeId !== "string" ||
        nodeId.toLowerCase() !== config.nodeId.toLowerCase()
      ) {
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
    gatewayGeneration: readRequiredEnvironment(
      "MICROCLAW_MXC_APPROVAL_PROOF_GATEWAY_GENERATION",
    ),
    policyFingerprint: readRequiredEnvironment(
      "MICROCLAW_MXC_APPROVAL_PROOF_POLICY_FINGERPRINT",
    ),
    nodeId: readRequiredEnvironment("MICROCLAW_MXC_APPROVAL_PROOF_NODE_ID"),
  });
  Object.defineProperty(globalThis, APPROVAL_PROOF_MINTER_SYMBOL, {
    value: minter,
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

function initialize() {
  const packageDir = process.env.MICROCLAW_OPENCLAW_PACKAGE_DIR;
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

  const targets = [
    {
      module: EXPECTED_MODULE,
      sha256: EXPECTED_SHA256,
      patch: patchPinnedOpenClawGateway,
    },
    {
      module: EXPECTED_NODE_GATEWAY_MODULE,
      sha256: EXPECTED_NODE_GATEWAY_SHA256,
      patch: patchPinnedOpenClawNodeGateway,
    },
  ].map((target) => {
    const targetPath = realpathSync(join(canonicalPackageDir, "dist", target.module));
    const targetRelative = relative(canonicalPackageDir, targetPath);
    if (targetRelative.startsWith("..") || isAbsolute(targetRelative)) {
      throw new Error("Pinned OpenClaw approval module escaped its package directory");
    }
    const original = readFileSync(targetPath);
    const hash = createHash("sha256").update(original).digest("hex");
    if (hash !== target.sha256) {
      throw new Error(`Pinned OpenClaw approval module hash mismatch (${target.module}): ${hash}`);
    }
    return { ...target, targetPath, original };
  });
  installApprovalProofMinter();

  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      const loadedPath = url.startsWith("file:") ? realpathSync(fileURLToPath(url)) : null;
      const target = targets.find((candidate) => candidate.targetPath === loadedPath);
      if (target) {
        const source =
          typeof result.source === "string"
            ? result.source
            : Buffer.from(result.source ?? target.original).toString("utf8");
        return { ...result, source: target.patch(source) };
      }
      return result;
    },
  });
  globalThis.console.log(
    "[microclaw-openclaw-compat] enabled approval replay identity and one-use node proof backports",
  );
}

export function shouldInitializeApprovalPreload(environment, mainThread) {
  if (environment.MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT !== "1") return false;
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
