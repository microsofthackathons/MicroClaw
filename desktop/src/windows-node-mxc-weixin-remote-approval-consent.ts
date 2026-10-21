import type { WindowsNodeMxcRequestedMode } from "./windows-node-mxc-modes";
import type { WeixinRemoteApprovalActivationOwner } from "./windows-node-mxc-weixin-remote-approval-activation";

export async function requireWeixinRemoteApprovalNativeConsent(params: {
  requestedMode: Exclude<WindowsNodeMxcRequestedMode, "off">;
  owner: WeixinRemoteApprovalActivationOwner;
  confirm: (details: {
    requestedMode: Exclude<WindowsNodeMxcRequestedMode, "off">;
    accountId: string;
    userId: string;
  }) => Promise<boolean>;
}): Promise<void> {
  const confirmed = await params.confirm({
    requestedMode: params.requestedMode,
    accountId: params.owner.accountId,
    userId: params.owner.userId,
  });
  if (!confirmed) {
    throw new Error("WeChat remote approval consent was cancelled");
  }
}
