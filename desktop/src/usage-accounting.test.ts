import { describe, expect, it } from "vitest";
import {
  mergeBackgroundUsage,
  parseBackgroundUsageLog,
  usageLogFingerprint,
  type BackgroundUsageEntry,
} from "./usage-accounting";

function completion(
  overrides: Record<string, unknown> = {},
  time = "2026-10-26T03:00:33.386+08:00",
) {
  return JSON.stringify({
    "0": '{"capability":"runtime.llm"}',
    "1": {
      caller: { kind: "plugin", id: "memory-core" },
      provider: "qwen",
      model: "qwen3.8-27b",
      agentId: "main",
      executionMode: "isolated-agent-runtime",
      usage: { inputTokens: 466, outputTokens: 1592, totalTokens: 2058 },
      ...overrides,
    },
    "2": "plugin llm completion",
    time,
  });
}

function entry(line = completion(), ordinal = 1): BackgroundUsageEntry {
  return { ...parseBackgroundUsageLog(line)!, id: `${usageLogFingerprint(line)}:${ordinal}` };
}

describe("independent background usage parsing", () => {
  it("reads the memory provider's real counters without adding reasoning output twice", () => {
    const parsed = parseBackgroundUsageLog(
      completion({
        usage: { inputTokens: 466, outputTokens: 1592, totalTokens: 2058, reasoningTokens: 1500 },
      }),
    );
    expect(parsed).toMatchObject({
      source: "memory",
      timestamp: "2026-10-25T19:00:33.386Z",
      totals: { input: 466, output: 1592, totalTokens: 2058 },
    });
  });

  it("counts cache buckets once and retains reported cost", () => {
    expect(
      parseBackgroundUsageLog(
        completion({
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 30,
            cacheWriteTokens: 40,
            totalTokens: 100,
            costUsd: 0.25,
          },
        }),
      )?.totals,
    ).toEqual({
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 100,
      totalCost: 0.25,
    });
  });

  it("derives total tokens when the runtime did not report a total", () => {
    expect(
      parseBackgroundUsageLog(completion({ usage: { inputTokens: 3, outputTokens: 4 } }))?.totals
        .totalTokens,
    ).toBe(7);
  });

  it("counts direct-provider calls even when attributed to a session", () => {
    expect(
      parseBackgroundUsageLog(
        completion({
          caller: { kind: "plugin", id: "other-plugin" },
          executionMode: "direct-provider",
          sessionKey: "agent:main:main",
        }),
      )?.source,
    ).toBe("background");
  });

  it("rejects ordinary agent runs, zero-usage schedules, broken records, and embedded log text", () => {
    for (const line of [
      completion({ executionMode: "session-agent-runtime" }),
      completion({ usage: { totalTokens: 0 } }),
      completion({}, "invalid-date"),
      '{"message":"plugin llm completion"}',
      JSON.stringify({ "0": completion() }),
      "plugin llm completion: malformed",
      completion({ usage: { totalTokens: "2058" } }),
    ])
      expect(parseBackgroundUsageLog(line)).toBeNull();
  });

  it("persists only accounting metadata, not prompts, credentials, or arbitrary attributes", () => {
    const parsed = parseBackgroundUsageLog(
      completion({ apiKey: "sk-private", prompt: "private text", response: "private response" }),
    );
    expect(JSON.stringify(parsed)).not.toMatch(
      /sk-private|private text|private response|apiKey|prompt|response/,
    );
  });
});

describe("merged session and independent usage", () => {
  it("adds the three overnight calls to 36,109 session tokens without inventing sessions or messages", () => {
    const original = {
      totals: { input: 35_661, output: 448, totalTokens: 36_109, totalCost: 1 },
      sessions: [{ key: "agent:main:main" }],
      aggregates: {
        daily: [{ date: "2026-10-24", tokens: 36_109 }],
        byModel: [
          { model: "qwen3.8-27b", provider: "qwen", count: 3, totals: { totalTokens: 36_109 } },
        ],
        messages: { total: 7, assistant: 3 },
        tools: { totalCalls: 2 },
      },
    };
    const saved = structuredClone(original);
    const overnight = [
      entry(
        completion(
          { usage: { inputTokens: 466, outputTokens: 1030, totalTokens: 1496 } },
          "2026-10-25T03:00:47+08:00",
        ),
      ),
      entry(
        completion(
          { usage: { inputTokens: 457, outputTokens: 1847, totalTokens: 2304 } },
          "2026-10-25T03:00:47.348+08:00",
        ),
      ),
      entry(),
    ];
    const merged = mergeBackgroundUsage(original, overnight, "2026-10-01", "2026-10-26");
    expect(merged.totals.totalTokens).toBe(41_967);
    expect(merged.usageSources).toEqual([
      { source: "session", tokens: 36_109 },
      { source: "memory", tokens: 5858 },
      { source: "background", tokens: 0 },
    ]);
    expect(merged.backgroundRequests).toBe(3);
    expect(merged.requestCount).toBe(6);
    expect(merged.aggregates.byModel[0]).toMatchObject({
      count: 6,
      totals: { totalTokens: 41_967 },
    });
    expect(merged.aggregates.byAgent[0]).toMatchObject({
      agentId: "main",
      count: 3,
      totals: { totalTokens: 5858 },
    });
    expect(merged.aggregates.daily).toEqual([
      expect.objectContaining({ date: "2026-10-24", tokens: 39_909 }),
      expect.objectContaining({ date: "2026-10-25", tokens: 2058 }),
    ]);
    expect(merged.sessions).toEqual(original.sessions);
    expect(merged.aggregates.messages).toEqual(original.aggregates.messages);
    expect(merged.aggregates.tools).toEqual(original.aggregates.tools);
    expect(original).toEqual(saved);
  });

  it("de-duplicates record identities and applies inclusive UTC date boundaries", () => {
    const included = entry();
    const outside = entry(completion({}, "2026-10-27T00:00:00Z"));
    const merged = mergeBackgroundUsage(
      {},
      [included, included, outside],
      "2026-10-25",
      "2026-10-25",
    );
    expect(merged.totals.totalTokens).toBe(2058);
    expect(merged.backgroundRequests).toBe(1);
    expect(
      mergeBackgroundUsage({}, [included], "2026-10-26", "2026-10-26").totals.totalTokens,
    ).toBe(0);
  });

  it("keeps models with identical names but different providers separate", () => {
    const entries = [entry(), entry(completion({ provider: "other", agentId: "worker" }))];
    const merged = mergeBackgroundUsage({}, entries, "2026-10-01", "2026-10-26", false);
    expect(merged.aggregates.byModel).toHaveLength(2);
    expect(merged.aggregates.byProvider).toHaveLength(2);
    expect(merged.aggregates.byAgent).toHaveLength(2);
    expect(merged.backgroundUsageAvailable).toBe(false);
  });

  it("uses assistant counts when historical model counts are absent without treating user messages as requests", () => {
    const merged = mergeBackgroundUsage(
      { aggregates: { messages: { assistant: 4 } } },
      [entry()],
      "2026-10-01",
      "2026-10-26",
    );
    expect(merged.requestCount).toBe(5);
  });
});
