import { createHash } from "node:crypto";

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
