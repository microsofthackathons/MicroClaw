import type { MessageBoxOptions } from "electron";
import { t, type SupportedLocale } from "./i18n";
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

export function createWindowsNodeMxcToggleConsentDialog(
  locale: SupportedLocale,
  requestedMode: WindowsNodeMxcRequestedMode,
  enrollWeixin: boolean,
): MessageBoxOptions {
  const enabling = requestedMode !== "off";
  return {
    type: "warning",
    title: t(locale, "mxc.toggleTitle"),
    message: t(locale, "mxc.toggleRestart"),
    detail: [
      t(locale, `mxc.toggle.${requestedMode}`),
      ...(enabling ? [t(locale, "mxc.toggleCapabilities")] : []),
      ...(enrollWeixin ? [t(locale, "weixinRemoteApproval.activationDefault")] : []),
    ].join("\n\n"),
    buttons: [t(locale, "mxc.toggleCancel"), t(locale, `mxc.toggleConfirm.${requestedMode}`)],
    defaultId: 0,
    cancelId: 0,
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
}): Promise<
  | { cancelled: true }
  | {
      cancelled: false;
      limitedFilesystemAcknowledged: boolean;
      enrollmentDisabledReason: string | null;
      selection: WeixinRemoteApprovalActivationSelection | undefined;
      plan: WeixinRemoteApprovalTransitionPlan;
    }
> {
  assertNativeWeixinRemoteApprovalAuthority(params.request);
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
  const { response } = await params.showDialog(
    createWindowsNodeMxcToggleConsentDialog(params.locale, params.requestedMode, enrollWeixin),
  );
  if (response === 0) return { cancelled: true };
  if (response !== 1) throw new Error("Invalid native sandbox confirmation response");
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
    cancelled: false,
    limitedFilesystemAcknowledged: params.requestedMode === "limited-dacl",
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
