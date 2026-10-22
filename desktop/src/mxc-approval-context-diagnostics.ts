import { createHash } from "node:crypto";
import type { WeixinRemoteDeliveryReason } from "./windows-node-mxc-weixin-remote-approval-delivery";

export const WEIXIN_DELIVERY_DIAGNOSTIC_CONTRACT = "microclaw.weixin-delivery-diagnostic.v1";
export type WeixinDeliveryKind =
  | "prompt"
  | "fallback"
  | "terminal"
  | "reminder"
  | "acknowledgement"
  | "notification";
const deliveryKinds = new Set([
  "prompt",
  "fallback",
  "terminal",
  "reminder",
  "acknowledgement",
  "notification",
]);
const deliveryProviderCodes = new Set([
  "context-unavailable",
  "owner-changed",
  "http-rejected",
  "request-timeout",
  "request-failed",
  "provider-response-invalid",
  "provider-rejected",
  "provider-accepted",
  "provider-result-invalid",
]);
const deliveryPipeCodes = new Set([
  "delivery-dispatched",
  "delivery-timeout",
  "transport-closed",
  "transport-disconnected",
  "transport-unavailable",
]);
const deliveryHashFields = new Set([
  "deliveryHash",
  "providerClientHash",
  "challengeHash",
  "inboundHash",
  "approvalHash",
  "sessionHash",
]);

function isSafeWeixinDeliveryFrame(text: string): boolean {
  if (text.length > 4096) return false;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("contract" in value) ||
    value.contract !== WEIXIN_DELIVERY_DIAGNOSTIC_CONTRACT ||
    !("stage" in value) ||
    (value.stage !== "pipe" && value.stage !== "provider") ||
    !("kind" in value) ||
    typeof value.kind !== "string" ||
    !deliveryKinds.has(value.kind) ||
    !("code" in value) ||
    typeof value.code !== "string" ||
    !(value.stage === "pipe" ? deliveryPipeCodes : deliveryProviderCodes).has(value.code)
  )
    return false;
  let hashes = 0;
  for (const [key, field] of Object.entries(value)) {
    if (["contract", "stage", "kind", "code"].includes(key)) continue;
    if (deliveryHashFields.has(key)) {
      if (typeof field !== "string" || !/^[a-f0-9]{16}$/.test(field)) return false;
      hashes++;
    } else if (key === "httpStatus") {
      if (
        value.stage !== "provider" ||
        typeof field !== "number" ||
        !Number.isSafeInteger(field) ||
        field < 100 ||
        field > 599
      )
        return false;
    } else if (key === "providerRet") {
      if (value.stage !== "provider" || !Number.isSafeInteger(field)) return false;
    } else return false;
  }
  return hashes > 0;
}

export function extractSafeMxcApprovalMetadataLine(line: string): string | null {
  for (const marker of [
    "[mxc-approval-context]",
    "[weixin-remote-approval-context]",
    "[weixin-remote-approval-delivery]",
    "weixin-remote-approval-delivery ",
  ]) {
    const index = line.indexOf(marker);
    if (index < 0) continue;
    const frame = line.slice(index + marker.length).trim();
    try {
      JSON.parse(frame);
    } catch {
      continue;
    }
    if (isSafeMxcApprovalMetadataFrame(frame)) return frame;
  }
  return null;
}

type WeixinDiagnosticStage =
  | "weixin-source-cached"
  | "weixin-run-registration"
  | "weixin-main-delivery";
type WeixinDiagnosticReason =
  | WeixinRemoteDeliveryReason
  | "source-cached"
  | "source-run-bound"
  | "source-run-binding-rejected"
  | "prompt-delivered";
const weixinReasons: Record<WeixinDiagnosticReason, true> = {
  disabled: true,
  "source-not-direct": true,
  "source-identity-mismatch": true,
  "source-owner-unavailable": true,
  "source-metadata-invalid": true,
  "source-session-mismatch": true,
  "source-agent-mismatch": true,
  "source-origin-unavailable": true,
  "source-run-mismatch": true,
  "source-provider-mismatch": true,
  "ambiguous-request-set": true,
  "presentation-sensitive": true,
  "presentation-unsupported": true,
  "presentation-too-long": true,
  "security-binding-invalid": true,
  "source-unavailable": true,
  "security-unavailable": true,
  "transport-unavailable": true,
  "delivery-unconfirmed": true,
  "approval-queued": true,
  "approval-no-longer-pending": true,
  "source-cached": true,
  "source-run-bound": true,
  "source-run-binding-rejected": true,
  "prompt-delivered": true,
};
const weixinStages = new Set([
  "weixin-source-cached",
  "weixin-run-registration",
  "weixin-main-delivery",
]);

interface FieldDiagnostic {
  present: boolean;
  type: string;
  hash?: string;
  length?: number;
}

function descriptor(record: unknown, key: string): PropertyDescriptor | undefined {
  return record && typeof record === "object" && !Array.isArray(record)
    ? Object.getOwnPropertyDescriptor(record, key)
    : undefined;
}

function read(record: unknown, key: string): unknown {
  const field = descriptor(record, key);
  return field && "value" in field ? field.value : undefined;
}

function describe(record: unknown, key: string): FieldDiagnostic {
  const field = descriptor(record, key);
  if (!field) return { present: false, type: "missing" };
  if (!("value" in field)) return { present: true, type: "accessor" };
  const value: unknown = field.value;
  return {
    present: true,
    type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
    ...(typeof value === "string"
      ? {
          hash: createHash("sha256").update(value).digest("hex").slice(0, 16),
          length: value.length,
        }
      : {}),
  };
}

function fields(record: unknown, keys: readonly string[]): Record<string, FieldDiagnostic> {
  return Object.fromEntries(keys.map((key) => [key, describe(record, key)]));
}

export function describeWeixinApprovalDecision(
  stage: WeixinDiagnosticStage,
  reason: WeixinDiagnosticReason,
  approval?: unknown,
  source?: unknown,
  boundRunId?: string,
) {
  if (!weixinStages.has(stage) || !Object.hasOwn(weixinReasons, reason))
    throw new Error("Unsupported WeChat approval diagnostic");
  return {
    contract: "microclaw.mxc-approval-context-diagnostic.v1",
    stage,
    reason,
    approvedOriginPresent: read(approval, "origin") !== undefined,
    approval: fields(approval, ["id", "sessionKey", "agent"]),
    source: fields(source, [
      "sessionKey",
      "agentId",
      "messageId",
      "cursor",
      "runId",
      "gatewayGeneration",
    ]),
    origin: fields(read(approval, "origin"), [
      "runId",
      "runSessionKey",
      "executionSessionKey",
      "channel",
      "accountId",
      "to",
      "toolCallId",
    ]),
    boundRun: describe(boundRunId === undefined ? undefined : { runId: boundRunId }, "runId"),
  };
}

// Shared by the detached collector; arbitrary stdout/stderr never reaches its metadata log.
export function isSafeMxcApprovalMetadataFrame(text: string): boolean {
  if (text.includes(WEIXIN_DELIVERY_DIAGNOSTIC_CONTRACT)) return isSafeWeixinDeliveryFrame(text);
  const words = new Set(
    "contract stage envelope request plan defaults origin id sessionKey agentId runId toolCallId originatingClientId originatingDeviceId turnSourceChannel turnSourceTo turnSourceAccountId turnSourceThreadId runSessionKey notifySessionKey sessionId messageProvider currentChannelId accountId kind channel present type hash length true false null undefined reason approvedOriginPresent approval source agent messageId cursor gatewayGeneration executionSessionKey to boundRun".split(
      " ",
    ),
  );
  const strings = new Set([
    "microclaw.mxc-approval-context-diagnostic.v1",
    "gateway-approval-requested",
    "exec-defaults",
    "node-prepare-input",
    "node-prepare-output",
    ...weixinStages,
    ...Object.keys(weixinReasons),
    "missing",
    "accessor",
    "null",
    "array",
    "string",
    "object",
    "number",
    "undefined",
    "bigint",
    "function",
    "boolean",
    "symbol",
  ]);
  let valid = text.length <= 32768;
  const stripped = text.replace(/(['"])(.*?)\1/g, (_match, _quote, value: string) => {
    if (!strings.has(value) && !words.has(value) && !/^[a-f0-9]{16}$/.test(value)) valid = false;
    return "";
  });
  for (const word of stripped.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [])
    if (!words.has(word)) valid = false;
  return valid && /^[A-Za-z0-9_$\s{}[\]:,.-]*$/.test(stripped);
}

// Main is CommonJS; contract tests keep this field list aligned with the external ESM preload.
export function describeGatewayApprovalContext(envelope: unknown) {
  const request = read(envelope, "request");
  const plan = read(request, "systemRunPlan");
  const origin = read(envelope, "origin");
  return {
    contract: "microclaw.mxc-approval-context-diagnostic.v1",
    stage: "gateway-approval-requested",
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
    defaults: fields(undefined, [
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
