import type { GetUpdatesResp, WeixinMessage } from "./types.js";

export interface ProviderFieldShape {
  present: boolean;
  type: string;
  safeInteger: boolean;
}

export interface ProviderMetadataShape {
  metadataProvenance: "wire" | "decoded";
  messageId: ProviderFieldShape;
  seq: ProviderFieldShape;
}

const wireShapes = new WeakMap<object, Partial<Record<"message_id" | "seq", ProviderFieldShape>>>();
const wireNumbers = new WeakMap<object, Partial<Record<"message_id" | "seq", string>>>();

export function normalizeProviderInteger(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    value = String(value);
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return null;
  if (value.length === 20 && value > "18446744073709551615") return null;
  return value;
}

function fieldShape(value: unknown, present: boolean): ProviderFieldShape {
  return {
    present,
    type: value === null ? "null" : typeof value,
    safeInteger: typeof value === "number" && Number.isSafeInteger(value),
  };
}

export function providerMetadataShape(message: WeixinMessage): ProviderMetadataShape {
  const captured = wireShapes.get(message);
  return {
    metadataProvenance: captured ? "wire" : "decoded",
    messageId:
      captured?.message_id ?? fieldShape(message.message_id, Object.hasOwn(message, "message_id")),
    seq: captured?.seq ?? fieldShape(message.seq, Object.hasOwn(message, "seq")),
  };
}

/** OpenClaw's pinned Node 24.16+ preserves numeric JSON source lexemes in reviver context. */
export function parseWeixinUpdatesJson(rawText: string): GetUpdatesResp {
  const response: GetUpdatesResp = JSON.parse(
    rawText,
    function (
      this: Record<string, unknown>,
      key: string,
      value: unknown,
      context?: { source?: string },
    ) {
      if (key !== "message_id" && key !== "seq") return value;
      const shapes = wireShapes.get(this) ?? {};
      shapes[key] = fieldShape(value, true);
      wireShapes.set(this, shapes);
      if (typeof value === "number" && typeof context?.source === "string") {
        const numbers = wireNumbers.get(this) ?? {};
        numbers[key] = context.source;
        wireNumbers.set(this, numbers);
      }
      return value;
    },
  );
  if (
    !response ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    (response.msgs !== undefined &&
      (!Array.isArray(response.msgs) ||
        response.msgs.some(
          (message) => !message || typeof message !== "object" || Array.isArray(message),
        )))
  ) {
    throw new Error("Invalid WeChat updates response");
  }
  for (const message of response.msgs ?? []) {
    wireShapes.set(message, wireShapes.get(message) ?? {});
    for (const key of ["message_id", "seq"] as const) {
      if (typeof message[key] !== "number") continue;
      const source = wireNumbers.get(message)?.[key];
      if (source === undefined)
        throw new Error("WeChat provider integer lexemes require the supported Node runtime");
      message[key] = source;
    }
  }
  return response;
}
