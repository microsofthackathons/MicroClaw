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
  template: '<div v-if="modelValue"><h2>{{ title }}</h2><slot/><slot name="footer"/></div>',
};

const buttonStub = {
  props: ["disabled", "loading"],
  emits: ["click"],
  template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot/></button>',
};

const eligibleOptions: ActivationOptions = {
  weixinEnabled: true,
  linkedAccountCount: 1,
  authenticatedAccountCount: 1,
  invariantState: "single",
  account: { accountId: "only@im.wechat", userId: "owner@im.wechat" },
  enableAvailable: true,
  unavailableReason: null,
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
  it("defaults to Disabled and shows the one exact identity without a selector", async () => {
    const wrapper = mountDialog();

    expect(
      (wrapper.find('[data-testid="mxc-weixin-approval-disabled"]').element as HTMLInputElement)
        .checked,
    ).toBe(true);
    const identity = wrapper.find('[data-testid="mxc-weixin-approval-owner"]');
    expect(identity.text()).toContain("only@im.wechat");
    expect(identity.text()).toContain("owner@im.wechat");
    expect(identity.find("select").exists()).toBe(false);

    await wrapper.find('[data-testid="mxc-weixin-approval-confirm"]').trigger("click");
    expect(wrapper.emitted("confirm")).toEqual([[{ enabled: false }]]);
  });

  it("enables only the exact displayed account ID and user ID", async () => {
    const wrapper = mountDialog();
    await wrapper.find('[data-testid="mxc-weixin-approval-enabled"]').setValue(true);
    await wrapper.find('[data-testid="mxc-weixin-approval-confirm"]').trigger("click");

    expect(wrapper.emitted("confirm")).toEqual([
      [
        {
          enabled: true,
          owner: {
            accountId: "only@im.wechat",
            userId: "owner@im.wechat",
          },
        },
      ],
    ]);
  });

  it("offers no enablement or identity for a legacy multiple-account state", () => {
    const wrapper = mountDialog({
      weixinEnabled: true,
      linkedAccountCount: 2,
      authenticatedAccountCount: 0,
      invariantState: "multiple",
      account: null,
      enableAvailable: false,
      unavailableReason: "multiple-accounts",
    });

    expect(wrapper.find('[data-testid="mxc-weixin-approval-enabled"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="mxc-weixin-approval-owner"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="mxc-weixin-approval-no-eligible"]').text()).toContain(
      "single-account invariant",
    );
  });

  it("cancels without emitting a decision", async () => {
    const wrapper = mountDialog();

    await wrapper.find('[data-testid="mxc-weixin-approval-cancel"]').trigger("click");

    expect(wrapper.emitted("cancel")).toHaveLength(1);
    expect(wrapper.emitted("confirm")).toBeUndefined();
    expect(wrapper.emitted("update:modelValue")).toEqual([[false]]);
  });
});
