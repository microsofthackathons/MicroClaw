import { enableAutoUnmount, mount } from "@vue/test-utils";
import { isProxy, ref } from "vue";
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
  it("shows only Disabled and Enabled choices, defaults to Disabled, and hides identity", async () => {
    const wrapper = mountDialog();

    expect(
      (wrapper.find('[data-testid="mxc-weixin-approval-disabled"]').element as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(wrapper.find('[data-testid="mxc-weixin-approval-enabled"]').exists()).toBe(true);
    expect(wrapper.findAll('input[type="radio"]')).toHaveLength(2);
    expect(wrapper.find("select").exists()).toBe(false);
    expect(wrapper.find('[data-testid="mxc-weixin-approval-owner"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("only@im.wechat");
    expect(wrapper.text()).not.toContain("owner@im.wechat");

    await wrapper.find('[data-testid="mxc-weixin-approval-confirm"]').trigger("click");
    expect(wrapper.emitted("confirm")).toEqual([[{ enabled: false }]]);
  });

  it("emits the hidden exact single-account binding when Enabled is selected", async () => {
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

  it("emits a plain cloneable identity DTO from reactive account options", async () => {
    const options = ref<ActivationOptions>({
      ...eligibleOptions,
      account: { accountId: "Exact_Bot@im.wechat", userId: "Exact_Owner@im.wechat" },
    });
    const wrapper = mountDialog(options.value);
    expect(isProxy(wrapper.props("options")?.account)).toBe(true);

    await wrapper.find('[data-testid="mxc-weixin-approval-enabled"]').setValue(true);
    await wrapper.find('[data-testid="mxc-weixin-approval-confirm"]').trigger("click");

    const selection = wrapper.emitted("confirm")?.[0]?.[0];
    expect(() => structuredClone(selection)).not.toThrow();
    expect(selection).toEqual({
      enabled: true,
      owner: { accountId: "Exact_Bot@im.wechat", userId: "Exact_Owner@im.wechat" },
    });
    expect(isProxy(selection)).toBe(false);
    expect(selection).toHaveProperty("owner");
    if (selection && typeof selection === "object" && "owner" in selection) {
      expect(isProxy(selection.owner)).toBe(false);
    }
  });

  it("cancels without emitting a decision", async () => {
    const wrapper = mountDialog();

    await wrapper.find('[data-testid="mxc-weixin-approval-cancel"]').trigger("click");

    expect(wrapper.emitted("cancel")).toHaveLength(1);
    expect(wrapper.emitted("confirm")).toBeUndefined();
    expect(wrapper.emitted("update:modelValue")).toEqual([[false]]);
  });
});
