import { createHash } from "node:crypto";

export function describeWeixinSessionBinding(value: string): {
  hash: string;
  kind: "agent-route" | "uuid" | "opaque";
  length: number;
  components: number;
  hasPadding: boolean;
} {
  return {
    hash: createHash("sha256").update(value).digest("hex").slice(0, 16),
    kind: /^agent:[^:]+:.+/.test(value)
      ? "agent-route"
      : /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
        ? "uuid"
        : "opaque",
    length: value.length,
    components: value.split(":").length,
    hasPadding: value !== value.trim(),
  };
}

export interface WeixinSessionRoute {
  sessionKey: string;
  agentId: string;
}

export async function resolveWeixinSessionRoute(
  source: WeixinSessionRoute,
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<WeixinSessionRoute> {
  const result = await request("sessions.resolve", {
    key: source.sessionKey,
    agentId: source.agentId,
    includeGlobal: false,
    includeUnknown: false,
  });
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !("ok" in result) ||
    result.ok !== true ||
    !("key" in result) ||
    typeof result.key !== "string" ||
    !result.key.trim() ||
    !("agentId" in result) ||
    result.agentId !== source.agentId
  ) {
    throw new Error("Gateway did not resolve the exact WeChat agent/session route");
  }
  return { sessionKey: result.key, agentId: result.agentId };
}
