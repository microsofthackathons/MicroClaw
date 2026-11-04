import { randomUUID } from "node:crypto";
import type { MessageBoxOptions } from "electron";
import { t, type SupportedLocale } from "./i18n";
import type {
  WeixinRemoteApprovalConfiguration,
  WeixinRemoteApprovalOwnerBinding,
} from "./windows-node-mxc-weixin-remote-approval";
import type { WeixinRemoteApprovalActivationOptions } from "./windows-node-mxc-weixin-remote-approval-activation";

export const WEIXIN_FULL_DETAIL_DISCLOSURE = "microclaw.wechat-exec-full-details-consent.v2";

export interface WeixinFullDetailDisclosure {
  contract: typeof WEIXIN_FULL_DETAIL_DISCLOSURE;
  receiptId: string;
  acknowledgedAt: string;
  owner: WeixinRemoteApprovalOwnerBinding;
}

export interface WeixinDisclosureStatus {
  consented: boolean;
  available: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function validateWeixinFullDetailDisclosure(
  value: unknown,
  owner: WeixinRemoteApprovalOwnerBinding | null,
): WeixinFullDetailDisclosure | null {
  const candidate = record(value);
  const bound = record(candidate?.owner);
  if (
    !candidate ||
    !owner ||
    !bound ||
    Object.keys(candidate).some(
      (key) => !["contract", "receiptId", "acknowledgedAt", "owner"].includes(key),
    ) ||
    Object.keys(bound).some(
      (key) => !["contract", "accountId", "userId", "boundAt"].includes(key),
    ) ||
    candidate.contract !== WEIXIN_FULL_DETAIL_DISCLOSURE ||
    typeof candidate.receiptId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      candidate.receiptId,
    ) ||
    typeof candidate.acknowledgedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.acknowledgedAt)) ||
    bound.contract !== owner.contract ||
    bound.accountId !== owner.accountId ||
    bound.userId !== owner.userId ||
    bound.boundAt !== owner.boundAt
  ) {
    return null;
  }
  return {
    contract: WEIXIN_FULL_DETAIL_DISCLOSURE,
    receiptId: candidate.receiptId,
    acknowledgedAt: candidate.acknowledgedAt,
    owner: { ...owner },
  };
}

export function createWeixinDisclosureDialog(locale: SupportedLocale): MessageBoxOptions {
  return {
    type: "warning",
    title: t(locale, "weixinDisclosure.title"),
    message: t(locale, "weixinDisclosure.message"),
    detail: t(locale, "weixinDisclosure.risk"),
    buttons: [
      t(locale, "weixinDisclosure.keepDesktop"),
      t(locale, "weixinDisclosure.allow"),
      t(locale, "weixinDisclosure.cancel"),
    ],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
}

export async function planNativeWeixinDisclosure(params: {
  request: unknown;
  readConfiguration: () => WeixinRemoteApprovalConfiguration;
  readOptions: () => WeixinRemoteApprovalActivationOptions;
  showDialog: (options: MessageBoxOptions) => Promise<{ response: number }>;
  locale: SupportedLocale;
}): Promise<WeixinRemoteApprovalConfiguration | null> {
  const request = record(params.request);
  if (
    !request ||
    Object.keys(request).some((key) => key !== "intent") ||
    !["enable-full-details", "revoke"].includes(String(request.intent))
  ) {
    throw new Error("Only a native WeChat disclosure intent is accepted");
  }
  const current = params.readConfiguration();
  if (request.intent === "revoke") {
    const { fullDetailDisclosure: _disclosure, ...desktopOnly } = current;
    return desktopOnly;
  }
  const owner = current.owner ? { ...current.owner } : null;
  const eligible = (configuration: WeixinRemoteApprovalConfiguration) => {
    const options = params.readOptions();
    return (
      owner &&
      configuration.enabled &&
      configuration.owner?.contract === owner.contract &&
      configuration.owner?.accountId === owner.accountId &&
      configuration.owner.userId === owner.userId &&
      configuration.owner.boundAt === owner.boundAt &&
      options.weixinEnabled &&
      options.invariantState === "single" &&
      options.enableAvailable &&
      options.account?.accountId === owner.accountId &&
      options.account.userId === owner.userId
    );
  };
  if (!eligible(current)) throw new Error("Authenticated WeChat disclosure owner is unavailable");
  const expected = JSON.stringify(current);
  const { response } = await params.showDialog(createWeixinDisclosureDialog(params.locale));
  if (![0, 1, 2].includes(response)) throw new Error("Invalid native disclosure response");
  const latest = params.readConfiguration();
  if (JSON.stringify(latest) !== expected || !eligible(latest)) {
    throw new Error("WeChat owner or disclosure policy changed during native consent");
  }
  if (response !== 1 || !owner) return null;
  return {
    ...latest,
    fullDetailDisclosure: {
      contract: WEIXIN_FULL_DETAIL_DISCLOSURE,
      receiptId: randomUUID(),
      acknowledgedAt: new Date().toISOString(),
      owner,
    },
  };
}
