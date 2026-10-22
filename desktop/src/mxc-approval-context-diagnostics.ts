import { createHash } from "node:crypto";
import type { WeixinRemoteDeliveryReason } from "./windows-node-mxc-weixin-remote-approval-delivery";

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
