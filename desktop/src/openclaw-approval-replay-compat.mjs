import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const EXPECTED_VERSION = "2026.7.1-1";
const EXPECTED_MODULE = "gateway-tPQsEkmF.js";
const EXPECTED_SHA256 = "6eed85ef8b377cffa593578227758443b37fc98f87c74848f9ddb4ad8db46bb5";

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

  const targetPath = realpathSync(join(canonicalPackageDir, "dist", EXPECTED_MODULE));
  const targetRelative = relative(canonicalPackageDir, targetPath);
  if (targetRelative.startsWith("..") || isAbsolute(targetRelative)) {
    throw new Error("Pinned OpenClaw approval module escaped its package directory");
  }
  const original = readFileSync(targetPath);
  const hash = createHash("sha256").update(original).digest("hex");
  if (hash !== EXPECTED_SHA256) {
    throw new Error(`Pinned OpenClaw approval module hash mismatch: ${hash}`);
  }

  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      const loadedPath = url.startsWith("file:") ? realpathSync(fileURLToPath(url)) : null;
      if (loadedPath === targetPath) {
        const source =
          typeof result.source === "string"
            ? result.source
            : Buffer.from(result.source ?? original).toString("utf8");
        return { ...result, source: patchPinnedOpenClawGateway(source) };
      }
      return result;
    },
  });
  globalThis.console.log(
    "[microclaw-openclaw-compat] enabled approval replay identity backport openclaw/openclaw#103886",
  );
}

if (process.env.MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT === "1") {
  initialize();
}
