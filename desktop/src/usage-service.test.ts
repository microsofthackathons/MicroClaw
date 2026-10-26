import { describe, expect, it, vi } from "vitest";
import { queryAccountedUsage } from "./usage-service";
import { parseBackgroundUsageLog } from "./usage-accounting";

function storedEntry() {
  return {
    id: `${"a".repeat(64)}:1`,
    ...parseBackgroundUsageLog(
      JSON.stringify({
        "1": {
          caller: { kind: "plugin", id: "memory-core" },
          executionMode: "isolated-agent-runtime",
          usage: { totalTokens: 2058 },
        },
        "2": "plugin llm completion",
        time: "2026-10-26T03:00:33+08:00",
      }),
    )!,
  };
}

const range = { startDate: "2026-10-01", endDate: "2026-10-26", limit: 1000 };

describe("shared desktop usage query", () => {
  it("queries all agents and uses the active Gateway log path for supplementation", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ totals: { totalTokens: 100 } })
      .mockResolvedValueOnce({ file: "C:/logs/openclaw-2026-10-26.log" });
    const ledger = {
      synchronize: vi.fn().mockResolvedValue([storedEntry()]),
      readSnapshot: vi.fn(),
    };
    const result = await queryAccountedUsage(request, ledger, range);
    expect(request).toHaveBeenNthCalledWith(1, "sessions.usage", {
      ...range,
      agentScope: "all",
      includeContextWeight: true,
    });
    expect(ledger.synchronize).toHaveBeenCalledWith("C:/logs/openclaw-2026-10-26.log");
    expect(result.totals.totalTokens).toBe(2158);
    expect(result.backgroundUsageAvailable).toBe(true);
  });

  it("keeps cached background usage and flags incomplete coverage when logs are unavailable", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ totals: { totalTokens: 100 } })
      .mockRejectedValueOnce(new Error("secret diagnostic"));
    const ledger = {
      synchronize: vi.fn(),
      readSnapshot: vi.fn().mockResolvedValue([storedEntry()]),
    };
    const warn = vi.fn();
    const result = await queryAccountedUsage(request, ledger, range, warn);
    expect(result.totals.totalTokens).toBe(2158);
    expect(result.backgroundUsageAvailable).toBe(false);
    expect(warn).toHaveBeenCalledWith();
  });

  it("does not hide a session usage failure behind a background-only success", async () => {
    const request = vi.fn().mockRejectedValue(new Error("Gateway disconnected"));
    const ledger = { synchronize: vi.fn(), readSnapshot: vi.fn() };
    await expect(queryAccountedUsage(request, ledger, range)).rejects.toThrow(
      "Gateway disconnected",
    );
    expect(ledger.synchronize).not.toHaveBeenCalled();
  });

  it("preserves session usage if neither logs nor the cached ledger can be read", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ totals: { totalTokens: 100 } })
      .mockResolvedValueOnce({});
    const ledger = {
      synchronize: vi.fn(),
      readSnapshot: vi.fn().mockRejectedValue(new Error("damaged")),
    };
    const result = await queryAccountedUsage(request, ledger, range);
    expect(result.totals.totalTokens).toBe(100);
    expect(result.backgroundUsageAvailable).toBe(false);
  });
});
