import { describe, expect, it } from "vitest";
import { requiresPostSpawnChannelRestart } from "./post-spawn-restart";

describe("requiresPostSpawnChannelRestart", () => {
  it("skips the compatibility restart when WeChat is absent or disabled", () => {
    expect(requiresPostSpawnChannelRestart(null)).toBe(false);
    expect(
      requiresPostSpawnChannelRestart({
        plugins: { entries: { "openclaw-weixin": { enabled: false } } },
      }),
    ).toBe(false);
  });

  it("keeps the compatibility restart for an enabled WeChat channel", () => {
    expect(
      requiresPostSpawnChannelRestart({
        plugins: { entries: { "openclaw-weixin": { enabled: true } } },
      }),
    ).toBe(true);
  });
});
