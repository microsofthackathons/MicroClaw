import { describe, expect, it, vi } from "vitest";
import { describeWeixinSessionBinding, resolveWeixinSessionRoute } from "./weixin-session-routing";

describe("authoritative WeChat source routing", () => {
  const source = { sessionKey: "agent:main:main", agentId: "main" };
  it("reports only hashed binding shape, not identifiers or a guessed equivalence", () => {
    expect(describeWeixinSessionBinding(source.sessionKey)).toMatchObject({
      kind: "agent-route",
      components: 3,
      hasPadding: false,
    });
    expect(describeWeixinSessionBinding("12345678-1234-1234-1234-123456789abc").kind).toBe("uuid");
    expect(JSON.stringify(describeWeixinSessionBinding("private-session-test-only"))).not.toContain(
      "private-session-test-only",
    );
  });
  it("uses only the exact Gateway-resolved route", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ ok: true, key: "agent:main:canonical", agentId: "main" });
    await expect(resolveWeixinSessionRoute(source, request)).resolves.toEqual({
      sessionKey: "agent:main:canonical",
      agentId: "main",
    });
    expect(request).toHaveBeenCalledWith("sessions.resolve", {
      key: source.sessionKey,
      agentId: source.agentId,
      includeGlobal: false,
      includeUnknown: false,
    });
  });
  it.each([
    null,
    { ok: false },
    { ok: true, key: "", agentId: "main" },
    { ok: true, key: source.sessionKey, agentId: "other" },
  ])("does not guess a fallback for %j", async (result) => {
    await expect(resolveWeixinSessionRoute(source, async () => result)).rejects.toThrow(
      "exact WeChat",
    );
  });
});
