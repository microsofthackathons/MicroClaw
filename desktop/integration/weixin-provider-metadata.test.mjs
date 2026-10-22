import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../plugins/openclaw-weixin/src/auth/accounts.js", () => ({
  loadConfigBotAgent: () => undefined,
  loadConfigRouteTag: () => undefined,
}));
vi.mock("../../plugins/openclaw-weixin/src/util/logger.js", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));
import { getUpdates } from "../../plugins/openclaw-weixin/src/api/api.js";
import {
  normalizeProviderInteger,
  parseWeixinUpdatesJson,
  providerMetadataShape,
} from "../../plugins/openclaw-weixin/src/api/provider-metadata.js";
import {
  normalizeWeixinProviderInteger,
  isLaterWeixinProviderCursor,
} from "../src/weixin-provider-integer";

afterEach(() => vi.unstubAllGlobals());

describe("lossless provider integer decoding (schema fixtures, not captured packets)", () => {
  it.each([
    ["0", "0"],
    ["42", "42"],
    ['"42"', "42"],
    ["9007199254740993", "9007199254740993"],
    ['"9007199254740993"', "9007199254740993"],
    ["18446744073709551615", "18446744073709551615"],
  ])("decodes message ID and cursor %s through the real getUpdates API", async (wire, expected) => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => `{"ret":0,"msgs":[{"message_id":${wire},"seq":${wire}}]}`,
    });
    vi.stubGlobal("fetch", fetch);
    const result = await getUpdates({
      baseUrl: "https://weixin.test.invalid",
      token: "test-only-token",
    });
    const message = result.msgs[0];
    expect(message.message_id).toBe(expected);
    expect(message.seq).toBe(expected);
    expect(normalizeProviderInteger(message.message_id)).toBe(expected);
    expect(normalizeWeixinProviderInteger(message.seq)).toBe(expected);
    expect(providerMetadataShape(message)).toEqual({
      metadataProvenance: "wire",
      messageId: {
        present: true,
        type: wire.startsWith('"') ? "string" : "number",
        safeInteger: !wire.startsWith('"') && Number.isSafeInteger(Number(wire)),
      },
      seq: {
        present: true,
        type: wire.startsWith('"') ? "string" : "number",
        safeInteger: !wire.startsWith('"') && Number.isSafeInteger(Number(wire)),
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    "-1",
    "1.5",
    "1e3",
    '"01"',
    '" 1"',
    '"1 "',
    '"1e3"',
    "null",
    "true",
    "{}",
    "[]",
    "18446744073709551616",
    '"18446744073709551616"',
  ])("fails closed on invalid decimal metadata %s", (wire) => {
    const message = parseWeixinUpdatesJson(`{"msgs":[{"message_id":${wire},"seq":${wire}}]}`)
      .msgs[0];
    expect(normalizeProviderInteger(message.message_id)).toBeNull();
    expect(normalizeWeixinProviderInteger(message.seq)).toBeNull();
  });

  it("does not reconstruct an unsafe number decoded outside the production parser", () => {
    const alreadyRounded = JSON.parse("9007199254740993");
    expect(normalizeProviderInteger(alreadyRounded)).toBeNull();
    expect(normalizeWeixinProviderInteger(alreadyRounded)).toBeNull();
  });
  it("preserves adjacent large cursors without a floating point comparison", () => {
    const messages = parseWeixinUpdatesJson(
      '{"msgs":[{"seq":9007199254740992},{"seq":9007199254740993}]}',
    ).msgs;
    expect(messages[0].seq).not.toBe(messages[1].seq);
    expect(isLaterWeixinProviderCursor(messages[1].seq, messages[0].seq)).toBe(true);
    expect(isLaterWeixinProviderCursor(messages[0].seq, messages[1].seq)).toBe(false);
    expect(isLaterWeixinProviderCursor("9", "10")).toBe(false);
    expect(isLaterWeixinProviderCursor("10", "9")).toBe(true);
  });
  it("diagnoses missing fields without serializing message values", () => {
    const message = parseWeixinUpdatesJson('{"msgs":[{"text":"secret-test-only"}]}').msgs[0];
    const shape = providerMetadataShape(message);
    expect(shape.metadataProvenance).toBe("wire");
    expect(shape.messageId).toEqual({ present: false, type: "undefined", safeInteger: false });
    expect(JSON.stringify(shape)).not.toContain("secret-test-only");
  });
  it("does not rewrite unrelated seq fields elsewhere in the provider response", () => {
    const response = parseWeixinUpdatesJson('{"seq":5,"msgs":[{"seq":7,"extra":{"seq":9}}]}');
    expect(response.seq).toBe(5);
    expect(response.msgs[0].seq).toBe("7");
    expect(response.msgs[0].extra.seq).toBe(9);
  });
  it.each(["{", "null", "[]", '{"msgs":{}}', '{"msgs":[null]}'])(
    "rejects malformed update envelopes %s",
    (wire) => {
      expect(() => parseWeixinUpdatesJson(wire)).toThrow();
    },
  );
});
