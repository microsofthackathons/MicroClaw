import type { MessageBoxOptions } from "electron";
import { t, type SupportedLocale } from "./i18n";
import type { WindowsNodeMxcRequestedMode } from "./windows-node-mxc-modes";
import {
  WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE,
  type WeixinRemoteApprovalConfiguration,
} from "./windows-node-mxc-weixin-remote-approval";
import {
  planWeixinRemoteApprovalTransition,
  type WeixinRemoteApprovalActivationOptions,
  type WeixinRemoteApprovalActivationSelection,
  type WeixinRemoteApprovalTransitionPlan,
} from "./windows-node-mxc-weixin-remote-approval-activation";

export function assertNativeWeixinRemoteApprovalAuthority(request: unknown): void {
  const allowed = new Set(["enabled", "requestedMode", "acknowledgeLimitedFilesystem", "nodeId"]);
  if (
    request &&
    typeof request === "object" &&
    Object.keys(request).some((key) => !allowed.has(key))
  ) {
    throw new Error("Renderer-supplied WeChat remote approval choices are not accepted");
  }
}

export function createWeixinRemoteApprovalConsentDialog(
  locale: SupportedLocale,
): MessageBoxOptions {
  return {
    type: "warning",
    title: t(locale, "weixinRemoteApproval.consentTitle"),
    message: t(locale, "weixinRemoteApproval.consentMessage"),
    detail: t(locale, "weixinRemoteApproval.consentRisk"),
    buttons: [
      t(locale, "weixinRemoteApproval.disable"),
      t(locale, "weixinRemoteApproval.enable"),
      t(locale, "weixinRemoteApproval.cancelActivation"),
    ],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
}

export async function planWeixinRemoteApprovalNativeTransition(params: {
  request: unknown;
  currentMode: WindowsNodeMxcRequestedMode;
  requestedMode: WindowsNodeMxcRequestedMode;
  currentConfiguration: WeixinRemoteApprovalConfiguration;
  readOptions: () => WeixinRemoteApprovalActivationOptions;
  showDialog: (options: MessageBoxOptions) => Promise<{ response: number }>;
  locale: SupportedLocale;
}): Promise<{
  selection: WeixinRemoteApprovalActivationSelection | undefined;
  plan: WeixinRemoteApprovalTransitionPlan;
}> {
  assertNativeWeixinRemoteApprovalAuthority(params.request);
  let options = params.requestedMode !== "off" ? params.readOptions() : undefined;
  let selection: WeixinRemoteApprovalActivationSelection | undefined;
  if (params.currentMode === "off" && params.requestedMode !== "off") {
    selection = { enabled: false };
    if (
      options?.weixinEnabled &&
      options.invariantState === "single" &&
      options.enableAvailable &&
      options.account
    ) {
      const owner = { accountId: options.account.accountId, userId: options.account.userId };
      const { response } = await params.showDialog(
        createWeixinRemoteApprovalConsentDialog(params.locale),
      );
      if (response === 2) throw new Error("WeChat remote approval consent was cancelled");
      if (response !== 0 && response !== 1)
        throw new Error("Invalid native WeChat approval response");
      options = params.readOptions();
      if (
        !options.weixinEnabled ||
        options.invariantState !== "single" ||
        !options.enableAvailable ||
        options.account?.accountId !== owner.accountId ||
        options.account.userId !== owner.userId
      ) {
        throw new Error("The WeChat remote approval identity changed during native consent");
      }
      selection =
        response === 1
          ? {
              enabled: true,
              owner,
              consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE,
            }
          : { enabled: false };
    }
  }
  return {
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
