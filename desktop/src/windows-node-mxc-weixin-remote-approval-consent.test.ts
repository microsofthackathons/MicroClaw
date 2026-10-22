import { describe, expect, it, vi } from "vitest";

import {
  createWeixinRemoteApprovalConsentDialog,
  planWeixinRemoteApprovalNativeTransition,
} from "./windows-node-mxc-weixin-remote-approval-consent";
import {
  planWeixinRemoteApprovalTransition,
  type WeixinRemoteApprovalActivationOptions,
} from "./windows-node-mxc-weixin-remote-approval-activation";
import type { WindowsNodeMxcRequestedMode } from "./windows-node-mxc-modes";
import {
  normalizeWeixinRemoteApprovalOwner,
  WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE,
  weixinRemoteApprovalConsentHash,
} from "./windows-node-mxc-weixin-remote-approval";

const owner = { accountId: "exact-bot@im.wechat", userId: "exact-user@im.wechat" };
const eligible = (): WeixinRemoteApprovalActivationOptions => ({
  weixinEnabled: true,
  linkedAccountCount: 1,
  authenticatedAccountCount: 1,
  invariantState: "single",
  account: { ...owner },
  enableAvailable: true,
  unavailableReason: null,
});
const disabled = { enabled: false, owner: null };

function activation(response = 0) {
  return {
    request: { requestedMode: "full" },
    currentMode: "off" as WindowsNodeMxcRequestedMode,
    requestedMode: "full" as WindowsNodeMxcRequestedMode,
    currentConfiguration: disabled,
    readOptions: vi.fn(eligible),
    showDialog: vi.fn().mockResolvedValue({ response }),
    locale: "en-US" as const,
  };
}

describe("WeChat remote approval native consent", () => {
  it.each(["en-US", "zh-CN"] as const)(
    "defaults to Disabled with cancel/close abort in %s",
    (locale) => {
      const dialog = createWeixinRemoteApprovalConsentDialog(locale);
      expect(dialog.buttons).toEqual(
        locale === "en-US"
          ? ["Disabled", "Enabled", "Cancel MXC activation"]
          : ["禁用", "启用", "取消 MXC 激活"],
      );
      expect(dialog.defaultId).toBe(0);
      expect(dialog.cancelId).toBe(2);
      expect(dialog.type).toBe("warning");
      expect(dialog.noLink).toBe(true);
      const copy = JSON.stringify(dialog);
      expect(copy).not.toMatch(
        /accountId|userId|Account ID|User ID|@im\.wechat|exact-bot|exact-user/,
      );
      expect(copy).not.toContain("weixinRemoteApproval.");
      expect(copy).toContain("1/2/3");
      expect(copy).toMatch(
        locale === "en-US"
          ? /delayed reply can affect a newer prompt/
          : /延迟回复可能影响更新的审批/,
      );
    },
  );

  it.each(["full", "limited-dacl"] as const)(
    "asks once for %s and binds Enabled only to the main-derived exact owner",
    async (requestedMode) => {
      const params = { ...activation(1), requestedMode };
      const result = await planWeixinRemoteApprovalNativeTransition(params);
      expect(params.showDialog).toHaveBeenCalledExactlyOnceWith(
        createWeixinRemoteApprovalConsentDialog("en-US"),
      );
      expect(params.readOptions).toHaveBeenCalledTimes(2);
      expect(result.selection).toEqual({
        enabled: true,
        owner,
        consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE,
      });
      expect(result.plan).toMatchObject({
        action: "persist",
        configuration: { enabled: true, owner, consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE },
      });
    },
  );

  it("records Disabled without binding the authenticated owner", async () => {
    const params = activation();
    expect(await planWeixinRemoteApprovalNativeTransition(params)).toEqual({
      selection: { enabled: false },
      plan: { action: "persist", configuration: disabled },
    });
    expect(params.showDialog).toHaveBeenCalledOnce();
  });

  it.each([2, -1, 99])(
    "rejects cancel/close/invalid response %s before returning a mutation plan",
    async (response) => {
      const persist = vi.fn();
      await expect(
        planWeixinRemoteApprovalNativeTransition(activation(response)).then(persist),
      ).rejects.toThrow(response === 2 ? "consent was cancelled" : "Invalid native");
      expect(persist).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      invariantState: "none",
      account: null,
      enableAvailable: false,
      unavailableReason: "no-account",
    },
    {
      invariantState: "multiple",
      account: null,
      enableAvailable: false,
      unavailableReason: "multiple-accounts",
    },
    {
      invariantState: "invalid",
      account: null,
      enableAvailable: false,
      unavailableReason: "invalid-account",
    },
    { weixinEnabled: false, enableAvailable: false, unavailableReason: "account-disabled" },
    { enableAvailable: false, unavailableReason: "not-authenticated" },
  ] satisfies Partial<WeixinRemoteApprovalActivationOptions>[])(
    "skips consent and records disabled for $unavailableReason",
    async (state) => {
      const params = activation(1);
      params.readOptions.mockReturnValue({ ...eligible(), ...state });
      expect(await planWeixinRemoteApprovalNativeTransition(params)).toMatchObject({
        selection: { enabled: false },
        plan: { action: "persist", configuration: disabled },
      });
      expect(params.showDialog).not.toHaveBeenCalled();
    },
  );

  it.each([0, 1])(
    "fails closed if identity changes while native response %s is pending",
    async (response) => {
      const params = activation(response);
      params.readOptions.mockReturnValueOnce(eligible()).mockReturnValueOnce({
        ...eligible(),
        account: { ...owner, userId: "replacement-user@im.wechat" },
      });
      await expect(planWeixinRemoteApprovalNativeTransition(params)).rejects.toThrow(
        "identity changed during native consent",
      );
    },
  );

  it("copies the identity before awaiting consent and revalidates again at the locked boundary", async () => {
    const params = activation(1);
    const initial = eligible();
    params.readOptions.mockReturnValue(initial);
    params.showDialog.mockImplementation(async () => {
      initial.account!.userId = "replacement-user@im.wechat";
      return { response: 1 };
    });
    await expect(planWeixinRemoteApprovalNativeTransition(params)).rejects.toThrow(
      "identity changed",
    );

    const accepted = await planWeixinRemoteApprovalNativeTransition(activation(1));
    expect(() =>
      planWeixinRemoteApprovalTransition({
        currentMode: "off",
        requestedMode: "full",
        currentConfiguration: disabled,
        selection: accepted.selection,
        options: { ...eligible(), account: { ...owner, accountId: "replacement-bot" } },
      }),
    ).toThrow("no longer eligible");
  });

  it.each([
    { enabled: true, owner },
    { enabled: true, owner: { accountId: "spoofed-bot", userId: "spoofed-user" } },
    { enabled: false },
  ])("rejects renderer-supplied approval authority: %j", async (remoteApproval) => {
    const params = activation();
    const request = { requestedMode: "full", remoteApproval };
    await expect(planWeixinRemoteApprovalNativeTransition({ ...params, request })).rejects.toThrow(
      "Renderer-supplied",
    );
    expect(params.readOptions).not.toHaveBeenCalled();
    expect(params.showDialog).not.toHaveBeenCalled();
  });

  it.each(["consentScope", "durableConsent", "owner"])(
    "rejects a forged renderer %s before native state or mutation",
    async (key) => {
      const params = activation(1);
      await expect(
        planWeixinRemoteApprovalNativeTransition({
          ...params,
          request: { requestedMode: "full", [key]: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE },
        }),
      ).rejects.toThrow("Renderer-supplied");
      expect(params.readOptions).not.toHaveBeenCalled();
      expect(params.showDialog).not.toHaveBeenCalled();
    },
  );

  it("does not upgrade inherited one-use consent and issues a new durable epoch only on deliberate native Enabled reconsent", async () => {
    const legacy = {
      enabled: true,
      owner: normalizeWeixinRemoteApprovalOwner(
        owner.accountId,
        owner.userId,
        new Date(0).toISOString(),
      ),
    };
    const params = activation(1);
    expect(
      await planWeixinRemoteApprovalNativeTransition({
        ...params,
        currentMode: "full",
        requestedMode: "limited-dacl",
        currentConfiguration: legacy,
      }),
    ).toEqual({ selection: undefined, plan: { action: "preserve" } });
    expect(weixinRemoteApprovalConsentHash(legacy)).toBeNull();
    expect(params.showDialog).not.toHaveBeenCalled();
    const renewed = await planWeixinRemoteApprovalNativeTransition({
      ...params,
      currentConfiguration: legacy,
    });
    expect(params.showDialog).toHaveBeenCalledOnce();
    expect(renewed.plan.action).toBe("persist");
    if (renewed.plan.action !== "persist") throw new Error("Missing native consent");
    expect(renewed.plan.configuration.consentScope).toBe(WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE);
    expect(weixinRemoteApprovalConsentHash(renewed.plan.configuration)).not.toBeNull();
    expect(renewed.plan.configuration.owner?.boundAt).not.toBe(legacy.owner.boundAt);
    const preserve = await planWeixinRemoteApprovalNativeTransition({
      ...activation(),
      currentMode: "full",
      requestedMode: "limited-dacl",
      currentConfiguration: renewed.plan.configuration,
    });
    expect(preserve).toEqual({ selection: undefined, plan: { action: "preserve" } });
  });

  it("preserves a valid owner on contained-mode switches without asking again, and Off revokes", async () => {
    const params = activation(1);
    const currentConfiguration = {
      enabled: true,
      owner: normalizeWeixinRemoteApprovalOwner(
        owner.accountId,
        owner.userId,
        new Date(0).toISOString(),
      ),
    };
    expect(
      await planWeixinRemoteApprovalNativeTransition({
        ...params,
        currentMode: "full",
        requestedMode: "limited-dacl",
        currentConfiguration,
      }),
    ).toEqual({ selection: undefined, plan: { action: "preserve" } });
    expect(
      await planWeixinRemoteApprovalNativeTransition({
        ...params,
        currentMode: "full",
        requestedMode: "off",
        currentConfiguration,
      }),
    ).toEqual({ selection: undefined, plan: { action: "persist", configuration: disabled } });
    expect(params.showDialog).not.toHaveBeenCalled();
  });
});
