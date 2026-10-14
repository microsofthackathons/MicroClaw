import { describe, expect, it } from "vitest";
import {
  WINDOWS_NODE_MXC_BLOCKED_CRON_METHODS,
  WINDOWS_NODE_MXC_CRON_RESUME_FENCE_CONTRACT,
  annotateWindowsNodeMxcPausedCronJobs,
  createWindowsNodeMxcCronResumeFence,
  getWindowsNodeMxcCronResumeEnvironment,
  isWindowsNodeMxcCronResumeAcknowledgement,
  parseWindowsNodeMxcCronResumeFence,
  shouldSuspendWindowsNodeMxcCronBeforePreflight,
} from "./windows-node-mxc-cron";

describe("Windows Node MXC Cron lifecycle", () => {
  it("suspends Cron before only Off-to-contained preflight transitions", () => {
    expect(shouldSuspendWindowsNodeMxcCronBeforePreflight("off", "full")).toBe(true);
    expect(shouldSuspendWindowsNodeMxcCronBeforePreflight("off", "limited-dacl")).toBe(true);
    expect(shouldSuspendWindowsNodeMxcCronBeforePreflight("full", "limited-dacl")).toBe(false);
    expect(shouldSuspendWindowsNodeMxcCronBeforePreflight("limited-dacl", "full")).toBe(false);
    expect(shouldSuspendWindowsNodeMxcCronBeforePreflight("full", "off")).toBe(false);
  });

  it("pins every Cron mutation and execution RPC as unavailable under MXC", () => {
    expect(WINDOWS_NODE_MXC_BLOCKED_CRON_METHODS).toEqual([
      "cron.scratch.set",
      "cron.add",
      "cron.update",
      "cron.remove",
      "cron.run",
    ]);
  });

  it("creates and validates a typed durable resume fence", () => {
    const fence = createWindowsNodeMxcCronResumeFence(
      "C:\\MicroClaw\\cron-resume.json",
      "token-1",
      1_735_689_600_000,
    );

    expect(fence).toEqual({
      contract: WINDOWS_NODE_MXC_CRON_RESUME_FENCE_CONTRACT,
      resumeAfterUnixMs: 1_735_689_600_000,
      createdAt: "2025-01-01T00:00:00.000Z",
      acknowledgementPath: "C:\\MicroClaw\\cron-resume.json",
      acknowledgementToken: "token-1",
    });
    expect(parseWindowsNodeMxcCronResumeFence(fence)).toEqual(fence);
    expect(getWindowsNodeMxcCronResumeEnvironment(fence)).toEqual({
      MICROCLAW_MXC_CRON_RESUME_FENCE_UNIX_MS: "1735689600000",
      MICROCLAW_MXC_CRON_RESUME_ACK_PATH: "C:\\MicroClaw\\cron-resume.json",
      MICROCLAW_MXC_CRON_RESUME_ACK_TOKEN: "token-1",
    });
  });

  it("rejects malformed or self-inconsistent resume fences", () => {
    expect(parseWindowsNodeMxcCronResumeFence(null)).toBeNull();
    expect(
      parseWindowsNodeMxcCronResumeFence({
        contract: WINDOWS_NODE_MXC_CRON_RESUME_FENCE_CONTRACT,
        resumeAfterUnixMs: 1,
        createdAt: "wrong",
        acknowledgementPath: "C:\\MicroClaw\\cron-resume.json",
        acknowledgementToken: "token-1",
      }),
    ).toBeNull();
    expect(() =>
      getWindowsNodeMxcCronResumeEnvironment({
        contract: WINDOWS_NODE_MXC_CRON_RESUME_FENCE_CONTRACT,
        resumeAfterUnixMs: -1,
        createdAt: "",
        acknowledgementPath: "relative",
        acknowledgementToken: "",
      }),
    ).toThrow(/invalid/);
  });

  it("returns preserved jobs with truthful requested and effective states", () => {
    expect(
      annotateWindowsNodeMxcPausedCronJobs(
        {
          jobs: [
            {
              id: "daily",
              enabled: true,
              schedule: { kind: "cron", expr: "0 9 * * *" },
            },
            {
              id: "disabled",
              enabled: false,
              schedule: { kind: "cron", expr: "0 10 * * *" },
            },
          ],
        },
        "limited-dacl",
      ),
    ).toEqual({
      jobs: [
        {
          id: "daily",
          enabled: true,
          requestedEnabled: true,
          effectiveEnabled: false,
          pausedByMxc: true,
          requestedMode: "limited-dacl",
          schedule: { kind: "cron", expr: "0 9 * * *" },
        },
        {
          id: "disabled",
          enabled: false,
          requestedEnabled: false,
          effectiveEnabled: false,
          pausedByMxc: false,
          requestedMode: "limited-dacl",
          schedule: { kind: "cron", expr: "0 10 * * *" },
        },
      ],
      pausedByMxc: true,
      requestedMode: "limited-dacl",
    });
  });

  it("accepts only the acknowledgement bound to the exact durable fence", () => {
    const fence = createWindowsNodeMxcCronResumeFence(
      "C:\\MicroClaw\\cron-resume.json",
      "token-1",
      100,
    );
    expect(
      isWindowsNodeMxcCronResumeAcknowledgement(
        {
          contract: WINDOWS_NODE_MXC_CRON_RESUME_FENCE_CONTRACT,
          resumeAfterUnixMs: 100,
          acknowledgementToken: "token-1",
          completedAtUnixMs: 101,
        },
        fence,
      ),
    ).toBe(true);
    expect(
      isWindowsNodeMxcCronResumeAcknowledgement(
        {
          contract: WINDOWS_NODE_MXC_CRON_RESUME_FENCE_CONTRACT,
          resumeAfterUnixMs: 100,
          acknowledgementToken: "wrong",
          completedAtUnixMs: 101,
        },
        fence,
      ),
    ).toBe(false);
  });
});
