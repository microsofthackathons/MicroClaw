import { describe, expect, it } from "vitest";
import {
  WINDOWS_NODE_MXC_CRON_RESUME_FENCE_CONTRACT,
  getWindowsNodeMxcCronResumeEnvironment,
  isWindowsNodeMxcCronResumeAcknowledgement,
  parseWindowsNodeMxcCronResumeFence,
  type WindowsNodeMxcCronResumeFence,
} from "./windows-node-mxc-cron";

describe("legacy Windows Node MXC Cron resume", () => {
  it("validates a stored durable resume fence", () => {
    const fence: WindowsNodeMxcCronResumeFence = {
      contract: WINDOWS_NODE_MXC_CRON_RESUME_FENCE_CONTRACT,
      resumeAfterUnixMs: 1_735_689_600_000,
      createdAt: "2025-01-01T00:00:00.000Z",
      acknowledgementPath: "C:\\MicroClaw\\cron-resume.json",
      acknowledgementToken: "token-1",
    };
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

  it("accepts only the acknowledgement bound to the exact durable fence", () => {
    const fence: WindowsNodeMxcCronResumeFence = {
      contract: WINDOWS_NODE_MXC_CRON_RESUME_FENCE_CONTRACT,
      resumeAfterUnixMs: 100,
      createdAt: "1970-01-01T00:00:00.100Z",
      acknowledgementPath: "C:\\MicroClaw\\cron-resume.json",
      acknowledgementToken: "token-1",
    };
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
