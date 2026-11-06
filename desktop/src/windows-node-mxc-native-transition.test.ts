import { describe, expect, it, vi } from "vitest";
import { planWeixinRemoteApprovalNativeTransition } from "./windows-node-mxc-weixin-remote-approval-consent";
import {
  planWeixinRemoteApprovalTransition,
  revalidateAutomaticWeixinRemoteApprovalSelection,
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

function activation() {
  return {
    request: { enabled: true },
    currentMode: "off" as WindowsNodeMxcRequestedMode,
    requestedMode: "full" as WindowsNodeMxcRequestedMode,
    currentConfiguration: disabled,
    readOptions: vi.fn(eligible),
  };
}

async function accept(params: Parameters<typeof planWeixinRemoteApprovalNativeTransition>[0]) {
  const result = await planWeixinRemoteApprovalNativeTransition(params);
  return result;
}

describe("direct sandbox toggle planning", () => {
  it.each(["full", "limited-dacl"] as const)(
    "plans %s directly and binds the fresh eligible account without durable consent",
    async (requestedMode) => {
      const params = { ...activation(), requestedMode };
      const result = await accept(params);
      expect(params.readOptions).toHaveBeenCalledTimes(2);
      expect(result.limitedFilesystemAcknowledged).toBe(requestedMode === "limited-dacl");
      expect(result.selection).toEqual({ enabled: true, owner });
      expect(result.plan).toMatchObject({
        action: "persist",
        configuration: { enabled: true, owner },
      });
      if (result.plan.action !== "persist") throw new Error("Missing enrollment plan");
      expect(result.plan.configuration.consentScope).toBeUndefined();
      expect(weixinRemoteApprovalConsentHash(result.plan.configuration)).toBeNull();
    },
  );

  it.each([
    { invariantState: "none", account: null, enableAvailable: false },
    { invariantState: "multiple", account: null, enableAvailable: false },
    { invariantState: "invalid", account: null, enableAvailable: false },
    { weixinEnabled: false, enableAvailable: false },
    { enableAvailable: false, unavailableReason: "not-authenticated" },
  ] satisfies Partial<WeixinRemoteApprovalActivationOptions>[])(
    "disables remote approvals for ineligible state %j without blocking the toggle",
    async (state) => {
      const params = activation();
      params.readOptions.mockReturnValue({ ...eligible(), ...state });
      expect(await accept(params)).toMatchObject({
        selection: { enabled: false },
        plan: { action: "persist", configuration: disabled },
      });
    },
  );

  it.each([
    { invariantState: "none", account: null, enableAvailable: false },
    { account: { ...owner, accountId: "replacement-account" } },
    { account: { ...owner, userId: "replacement-user" } },
    { weixinEnabled: false },
    { enableAvailable: false },
    { invariantState: "multiple", account: null },
  ] satisfies Partial<WeixinRemoteApprovalActivationOptions>[])(
    "disables optional enrollment without blocking sandboxing on eligibility/owner changes: %j",
    async (change) => {
      const params = activation();
      params.readOptions.mockReturnValueOnce(eligible()).mockReturnValueOnce({
        ...eligible(),
        ...change,
      });
      expect(await accept(params)).toMatchObject({
        selection: { enabled: false },
        plan: { action: "persist", configuration: disabled },
        enrollmentDisabledReason: expect.any(String),
      });
    },
  );

  it("copies the owner before revalidation without weakening the strict explicit-selection planner", async () => {
    const params = activation();
    const initial = eligible();
    params.readOptions.mockReturnValueOnce(initial).mockImplementationOnce(() => {
      initial.account!.userId = "replacement-user";
      return initial;
    });
    expect(await accept(params)).toMatchObject({
      selection: { enabled: false },
      plan: { action: "persist", configuration: disabled },
    });
    const accepted = await accept(activation());
    expect(() =>
      planWeixinRemoteApprovalTransition({
        currentMode: "off",
        requestedMode: "full",
        selection: accepted.selection,
        options: { ...eligible(), account: { ...owner, accountId: "replacement-bot" } },
      }),
    ).toThrow("no longer eligible");
  });

  it("does not turn malformed owners or durable-consent authority into automatic enrollment", () => {
    expect(() =>
      revalidateAutomaticWeixinRemoteApprovalSelection(
        { enabled: true, owner: { ...owner, userId: "" } },
        eligible(),
      ),
    ).toThrow("Invalid automatic WeChat approval enrollment authority");
    expect(() =>
      revalidateAutomaticWeixinRemoteApprovalSelection(
        { enabled: true, owner, consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE },
        eligible(),
      ),
    ).toThrow("Invalid automatic WeChat approval enrollment authority");
  });

  it.each([
    "remoteApproval",
    "owner",
    "consentScope",
    "durableConsent",
    "requestedMode",
    "acknowledgeLimitedFilesystem",
  ])("rejects renderer-supplied %s before reading native state", async (key) => {
    const params = activation();
    await expect(accept({ ...params, request: { enabled: true, [key]: true } })).rejects.toThrow(
      "Renderer-supplied",
    );
    expect(params.readOptions).not.toHaveBeenCalled();
  });

  it.each([undefined, WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE] as const)(
    "preserves existing consent scope %s without upgrading active consent and Off revokes",
    async (consentScope) => {
      const currentConfiguration = {
        enabled: true,
        owner: normalizeWeixinRemoteApprovalOwner(
          owner.accountId,
          owner.userId,
          new Date(0).toISOString(),
        ),
        ...(consentScope ? { consentScope } : {}),
      };
      const active = await accept({
        ...activation(),
        currentMode: "full",
        currentConfiguration,
      });
      expect(active.selection).toBeUndefined();
      expect(active.plan).toEqual({ action: "preserve" });
      const off = await accept({
        ...activation(),
        request: { enabled: false },
        currentMode: "full",
        requestedMode: "off",
        currentConfiguration,
      });
      expect(off.plan).toEqual({ action: "persist", configuration: disabled });
    },
  );
});
