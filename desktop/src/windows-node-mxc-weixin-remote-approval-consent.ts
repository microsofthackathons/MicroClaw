import type { WindowsNodeMxcRequestedMode } from "./windows-node-mxc-modes";
import type { WeixinRemoteApprovalConfiguration } from "./windows-node-mxc-weixin-remote-approval";
import {
  planWeixinRemoteApprovalTransition,
  revalidateAutomaticWeixinRemoteApprovalSelection,
  type WeixinRemoteApprovalActivationOptions,
  type WeixinRemoteApprovalActivationSelection,
  type WeixinRemoteApprovalTransitionPlan,
} from "./windows-node-mxc-weixin-remote-approval-activation";

export function assertNativeWeixinRemoteApprovalAuthority(request: unknown): void {
  const allowed = new Set(["enabled"]);
  if (
    request &&
    typeof request === "object" &&
    Object.keys(request).some((key) => !allowed.has(key))
  ) {
    throw new Error("Renderer-supplied WeChat remote approval choices are not accepted");
  }
}

export async function planWeixinRemoteApprovalNativeTransition(params: {
  request: unknown;
  currentMode: WindowsNodeMxcRequestedMode;
  requestedMode: WindowsNodeMxcRequestedMode;
  currentConfiguration: WeixinRemoteApprovalConfiguration;
  readOptions: () => WeixinRemoteApprovalActivationOptions;
}): Promise<{
  enrollmentDisabledReason: string | null;
  selection: WeixinRemoteApprovalActivationSelection | undefined;
  plan: WeixinRemoteApprovalTransitionPlan;
}> {
  assertNativeWeixinRemoteApprovalAuthority(params.request);
  if (params.currentMode === "limited-dacl" || params.requestedMode === "limited-dacl") {
    throw new Error("The retired DACL selection must be migrated to Full before use");
  }
  let options = params.requestedMode !== "off" ? params.readOptions() : undefined;
  const enrollWeixin =
    params.currentMode === "off" &&
    params.requestedMode !== "off" &&
    options?.weixinEnabled === true &&
    options.invariantState === "single" &&
    options.enableAvailable &&
    !!options.account;
  const owner =
    enrollWeixin && options?.account
      ? { accountId: options.account.accountId, userId: options.account.userId }
      : null;
  let selection: WeixinRemoteApprovalActivationSelection | undefined;
  let enrollmentDisabledReason: string | null = null;
  if (params.currentMode === "off" && params.requestedMode !== "off") {
    selection = { enabled: false };
    if (owner) {
      options = params.readOptions();
      const revalidated = revalidateAutomaticWeixinRemoteApprovalSelection(
        { enabled: true, owner },
        options,
      );
      selection = revalidated.selection;
      enrollmentDisabledReason = revalidated.enrollmentDisabledReason;
    }
  }
  return {
    enrollmentDisabledReason,
    selection,
    plan: planWeixinRemoteApprovalTransition({
      currentMode: params.currentMode,
      requestedMode: params.requestedMode,
      currentConfiguration: params.currentConfiguration,
      options,
      selection,
    }),
  };
}
