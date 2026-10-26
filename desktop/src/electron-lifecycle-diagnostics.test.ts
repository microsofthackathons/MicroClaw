import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ElectronLifecycleDiagnostics,
  summarizeLifecycleError,
} from "./electron-lifecycle-diagnostics";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ElectronLifecycleDiagnostics", () => {
  it("flushes timestamped lifecycle context synchronously", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-lifecycle-"));
    tempDirs.push(dir);
    const file = path.join(dir, "electron-lifecycle.jsonl");
    const diagnostics = new ElectronLifecycleDiagnostics(
      () => file,
      () => ({
        lifecycleActive: true,
        lifecyclePhase: "starting-active",
        windowRecoveryActive: false,
        gatewayPid: 1234,
        gatewayGeneration: "generation-1",
        explicitQuitRequested: false,
      }),
    );

    diagnostics.log("renderer-gone", {
      reason: `crashed token=${"c".repeat(100)}`,
      exitCode: 9,
    });

    const record = JSON.parse(fs.readFileSync(file, "utf8").trim());
    expect(record).toMatchObject({
      event: "renderer-gone",
      lifecycleActive: true,
      lifecyclePhase: "starting-active",
      windowRecoveryActive: false,
      gatewayPid: 1234,
      gatewayGeneration: "generation-1",
      explicitQuitRequested: false,
      exitCode: 9,
    });
    expect(record.reason).toBe("crashed token=[redacted]");
    expect(record.timestamp).toMatch(/Z$/);
  });

  it("redacts credentials and preserves nested AggregateError structure", () => {
    const error = new AggregateError(
      [
        new Error(`token=${"a".repeat(100)} authorization:Bearer ${"b".repeat(100)}`),
        new Error("renderer disappeared", { cause: new Error("child exited") }),
      ],
      "active generation failed",
    );

    const summary = summarizeLifecycleError(error);

    expect(summary).toContain("active generation failed");
    expect(summary).toContain("token=[redacted]");
    expect(summary).toContain("authorization:[redacted]");
    expect(summary).toContain("cause=Error: child exited");
    expect(summary).not.toContain("a".repeat(100));
    expect(summary).not.toContain("b".repeat(100));
  });
});
