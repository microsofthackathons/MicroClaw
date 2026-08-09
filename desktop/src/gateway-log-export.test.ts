import { describe, expect, it } from "vitest";
import { createGatewayLogExportFilename, formatGatewayLogExport } from "./gateway-log-export";

describe("Gateway log export", () => {
  it("writes UTF-8-friendly text with Windows line endings and a trailing newline", () => {
    expect(formatGatewayLogExport(["[info] started", "第二行\ncontinued"])).toBe(
      "[info] started\r\n第二行\r\ncontinued\r\n",
    );
  });

  it("rejects malformed and oversized payloads", () => {
    expect(() => formatGatewayLogExport("not-an-array")).toThrow(/must be an array/);
    expect(() => formatGatewayLogExport(["valid", 42])).toThrow(/must be a string/);
    expect(() => formatGatewayLogExport(Array.from({ length: 1_001 }, () => "line"))).toThrow(
      /cannot exceed 1000 lines/,
    );
    expect(() => formatGatewayLogExport(["x".repeat(5 * 1024 * 1024 + 1)])).toThrow(
      /cannot exceed 5 MB/,
    );
  });

  it("creates a filesystem-safe timestamped filename", () => {
    expect(createGatewayLogExportFilename(new Date("2026-08-09T12:34:56.789Z"))).toBe(
      "microclaw-gateway-logs-2026-08-09T12-34-56Z.log",
    );
  });
});
