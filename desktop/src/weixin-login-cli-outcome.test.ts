import { describe, expect, it } from "vitest";
import { createWeixinLoginCliOutcomeParser } from "./weixin-login-cli-outcome";

describe("Weixin login CLI activation outcome", () => {
  it("captures and removes a marker split across output chunks", () => {
    const token = "test-token-1234";
    const parser = createWeixinLoginCliOutcomeParser(token);

    expect(parser.push(`QR output\n[microclaw-weixin-activation:${token}] reload-`)).toBe(
      "QR output\n",
    );
    expect(parser.push("requested\nDone\n")).toBe("Done\n");
    expect(parser.finish()).toBe("");
    expect(parser.outcome).toBe("reload-requested");
  });

  it("keeps ordinary output and records an already-active login", () => {
    const token = "test-token-5678";
    const parser = createWeixinLoginCliOutcomeParser(token);

    expect(
      parser.push(
        `[microclaw-weixin-activation:${token}] already-active\nExisting account remains active`,
      ),
    ).toBe("");
    expect(parser.finish()).toBe("Existing account remains active");
    expect(parser.outcome).toBe("already-active");
  });

  it("does not interpret similar untrusted output as an activation marker", () => {
    const parser = createWeixinLoginCliOutcomeParser("expected-token");
    const text = "[microclaw-weixin-activation:attacker-token] reload-failed\n";

    expect(parser.push(text)).toBe(text);
    expect(parser.outcome).toBeNull();
  });
});
