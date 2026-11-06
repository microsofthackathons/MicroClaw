import { describe, expect, it } from "vitest";
import { assertConfigWriteAllowed } from "./config-write-policy";

describe("assertConfigWriteAllowed", () => {
  it("preserves unchanged OpenClaw sections that are newer than MicroClaw's allowlist", () => {
    const existing = {
      gateway: { port: 18789 },
      wizard: { lastRunAt: "2026-07-30T00:00:00.000Z" },
      auth: { profiles: { github: { provider: "github-copilot" } } },
      messages: { responsePrefix: "MicroClaw" },
    };
    const next = {
      ...existing,
      agents: {
        defaults: {
          model: { primary: "github-copilot/claude-opus-4.8" },
        },
      },
    };

    expect(() => assertConfigWriteAllowed(next, existing)).not.toThrow();
  });

  it("rejects changes to an unknown top-level section", () => {
    const existing = {
      gateway: { port: 18789 },
      futureSection: { enabled: false },
    };
    const next = {
      ...existing,
      futureSection: { enabled: true },
    };

    expect(() => assertConfigWriteAllowed(next, existing)).toThrow(
      "config:write — disallowed top-level keys: futureSection",
    );
  });

  it("rejects a newly introduced unknown top-level section", () => {
    const existing = { gateway: { port: 18789 } };
    const next = {
      ...existing,
      futureSection: { enabled: true },
    };

    expect(() => assertConfigWriteAllowed(next, existing)).toThrow(
      "config:write — disallowed top-level keys: futureSection",
    );
  });

  it("rejects removing an unknown top-level section", () => {
    const existing = {
      gateway: { port: 18789 },
      futureSection: { enabled: true },
    };
    const next = { gateway: { port: 18789 } };

    expect(() => assertConfigWriteAllowed(next, existing)).toThrow(
      "config:write — disallowed top-level keys: futureSection",
    );
  });
});
