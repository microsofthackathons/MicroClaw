import { describe, expect, it } from "vitest";
// @ts-expect-error The compatibility preload is intentionally external ESM for the Gateway child.
import * as replayCompat from "./openclaw-approval-replay-compat.mjs";

const { PINNED_CALL_SOURCE, PINNED_FUNCTION_SOURCE, patchPinnedOpenClawGateway } = replayCompat;

describe("OpenClaw node approval replay compatibility", () => {
  it("backports the upstream replay identity binding", () => {
    const patched = patchPinnedOpenClawGateway(
      `${PINNED_FUNCTION_SOURCE}\nfixture\n${PINNED_CALL_SOURCE}`,
    );

    expect(patched).toContain("isApprovalReplayNodeSystemRun");
    expect(patched).toContain("callParams: params");
    expect(patched).toContain("loadDeviceIdentityIfPresent()");
    expect(patched).not.toContain(PINNED_FUNCTION_SOURCE);
  });

  it("fails closed when the pinned source shape drifts", () => {
    expect(() => patchPinnedOpenClawGateway("unrecognized source")).toThrow(
      "did not match exactly once",
    );
    expect(() =>
      patchPinnedOpenClawGateway(
        `${PINNED_FUNCTION_SOURCE}\n${PINNED_FUNCTION_SOURCE}\n${PINNED_CALL_SOURCE}`,
      ),
    ).toThrow("did not match exactly once");
  });
});
