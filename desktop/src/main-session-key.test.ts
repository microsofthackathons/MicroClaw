import { describe, expect, it } from "vitest";
import { isMainSessionKey } from "./main-session-key";

describe("main session identity", () => {
  it.each(["agent:main:main", "agent:writer:main", "main"])(
    "recognizes the main session %s",
    (key) => expect(isMainSessionKey(key, "agent:main:main")).toBe(true),
  );

  it("uses the canonical main name for other agents", () => {
    expect(isMainSessionKey("agent:writer:home", "agent:painter:home")).toBe(true);
    expect(isMainSessionKey("agent:writer:main", "agent:painter:home")).toBe(false);
    expect(isMainSessionKey("agent:writer:custom:home", "agent:painter:custom:home")).toBe(true);
  });

  it("recognizes the exact global main session", () => {
    expect(isMainSessionKey("global", "global")).toBe(true);
    expect(isMainSessionKey("global", "agent:main:main")).toBe(false);
  });

  it.each(["agent:main:session-123", "agent:writer:channel:main", "session-main", ""])(
    "does not treat an ordinary session as main: %s",
    (key) => expect(isMainSessionKey(key, "agent:main:main")).toBe(false),
  );
});
