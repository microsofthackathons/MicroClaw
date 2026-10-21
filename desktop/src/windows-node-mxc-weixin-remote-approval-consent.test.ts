import { describe, expect, it, vi } from "vitest";

import { requireWeixinRemoteApprovalNativeConsent } from "./windows-node-mxc-weixin-remote-approval-consent";

describe("WeChat remote approval native consent", () => {
  it("binds confirmation to the exact requested mode and owner identity", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    await expect(
      requireWeixinRemoteApprovalNativeConsent({
        requestedMode: "limited-dacl",
        owner: { accountId: "bot@im.wechat", userId: "owner@im.wechat" },
        confirm,
      }),
    ).resolves.toBeUndefined();
    expect(confirm).toHaveBeenCalledWith({
      requestedMode: "limited-dacl",
      accountId: "bot@im.wechat",
      userId: "owner@im.wechat",
    });
  });

  it("cancels activation when native confirmation is declined", async () => {
    await expect(
      requireWeixinRemoteApprovalNativeConsent({
        requestedMode: "full",
        owner: { accountId: "bot@im.wechat", userId: "owner@im.wechat" },
        confirm: async () => false,
      }),
    ).rejects.toThrow("consent was cancelled");
  });
});
