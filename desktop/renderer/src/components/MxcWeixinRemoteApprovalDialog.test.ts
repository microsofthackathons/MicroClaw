import { enableAutoUnmount, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "@/i18n";
import MxcWeixinRemoteApprovalDialog from "./MxcWeixinRemoteApprovalDialog.vue";

type ActivationOptions = Awaited<
  ReturnType<typeof window.openclaw.windowsNodeMxc.getWeixinRemoteApprovalActivationOptions>
>;

const dialogStub = {
  props: [
    "modelValue",
    "title",
    "beforeClose",
    "closeOnClickModal",
    "closeOnPressEscape",
    "showClose",
  ],
  template:
    '<div v-if="modelValue"><h2>{{ title }}</h2><slot/><slot name="footer"/></div>',
};

const buttonStub = {
  props: ["disabled", "loading"],
  emits: ["click"],
  template:
    '<button :disabled="disabled" @click="$emit(\'click\')"><slot/></button>',
};

const eligibleOptions: ActivationOptions = {
  weixinEnabled: true,
  linkedAccountCount: 2,
  authenticatedAccountCount: 2,
  eligibleOwners: [
    { accountId: "first@im.wechat", userId: "owner-one@im.wechat" },
    { accountId: "second@im.wechat", userId: "owner-two@im.wechat" },
  ],
  ineligibleAccounts: [],
};

function mountDialog(options: ActivationOptions = eligibleOptions) {
  return mount(MxcWeixinRemoteApprovalDialog, {
    props: { modelValue: true, options },
    global: {
      stubs: {
        "el-dialog": dialogStub,
        "el-button": buttonStub,
      },
    },
  });
}

enableAutoUnmount(afterEach);
afterEach(() => setLocale("en-US"));

describe("MxcWeixinRemoteApprovalDialog", () => {
  it("defaults to Disabled and emits an explicit disabled decision", async () => {
    const wrapper = mountDialog();

    expect(
      (wrapper.find('[data-testid="mxc-weixin-approval-disabled"]').element as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(wrapper.find('[data-testid="mxc-weixin-approval-owner"]').exists()).toBe(false);

    await wrapper.find('[data-testid="mxc-weixin-approval-confirm"]').trigger("click");

    expect(wrapper.emitted("confirm")).toEqual([[{ enabled: false }]]);
  });

  it("requires and emits the exact selected account ID and user ID", async () => {
    const wrapper = mountDialog();
    await wrapper.find('[data-testid="mxc-weixin-approval-enabled"]').setValue(true);
    const select = wrapper.find('[data-testid="mxc-weixin-approval-owner"]');
    expect(select.exists()).toBe(true);
    expect(wrapper.find('[data-testid="mxc-weixin-approval-confirm"]').attributes("disabled")).toBe(
      "",
    );

    await select.setValue('["second@im.wechat","owner-two@im.wechat"]');
    await wrapper.find('[data-testid="mxc-weixin-approval-confirm"]').trigger("click");

    expect(wrapper.emitted("confirm")).toEqual([
      [
        {
          enabled: true,
          owner: {
            accountId: "second@im.wechat",
            userId: "owner-two@im.wechat",
          },
        },
      ],
    ]);
  });

  it("shows ineligible accounts without offering a useless owner selector", () => {
    const wrapper = mountDialog({
      weixinEnabled: true,
      linkedAccountCount: 2,
      authenticatedAccountCount: 1,
      eligibleOwners: [],
      ineligibleAccounts: [
        {
          accountId: "missing@im.wechat",
          userId: "owner@im.wechat",
          reason: "not-allowlisted" as const,
        },
        {
          accountId: "logged-out@im.wechat",
          userId: null,
          reason: "not-authenticated" as const,
        },
      ],
    });

    expect(wrapper.find('[data-testid="mxc-weixin-approval-enabled"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="mxc-weixin-approval-owner"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="mxc-weixin-approval-no-eligible"]').text()).toContain(
      "continue with remote approval disabled",
    );
    expect(wrapper.text()).toContain("explicit sender allowlist");
    expect(wrapper.text()).toContain("not authenticated");
  });

  it("cancels without emitting a selection", async () => {
    const wrapper = mountDialog();

    await wrapper.find('[data-testid="mxc-weixin-approval-cancel"]').trigger("click");

    expect(wrapper.emitted("cancel")).toHaveLength(1);
    expect(wrapper.emitted("confirm")).toBeUndefined();
    expect(wrapper.emitted("update:modelValue")).toEqual([[false]]);
  });
});
