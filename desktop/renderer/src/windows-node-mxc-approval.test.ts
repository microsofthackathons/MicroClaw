import { describe, expect, it } from "vitest";
import { resolveWindowsNodeMxcAllowedDecisions } from "./windows-node-mxc-approval";

describe("Windows Node MXC approval decisions", () => {
  it("preserves exact conversation approval for Gateway user commands", () => {
    expect(
      resolveWindowsNodeMxcAllowedDecisions({
        approvalLayer: "gateway",
        allowedDecisions: ["deny", "allow-once", "allow-always"],
      }),
    ).toEqual(["deny", "allow-once", "allow-always"]);
  });

  it("keeps diagnostic node approvals one-use", () => {
    expect(
      resolveWindowsNodeMxcAllowedDecisions({
        approvalLayer: "node",
        allowedDecisions: ["deny", "allow-once", "allow-always"],
      }),
    ).toEqual(["deny", "allow-once"]);
  });
});
