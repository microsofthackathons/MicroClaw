import { enableAutoUnmount, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "@/i18n";
import MxcCapabilityConsentDialog from "./MxcCapabilityConsentDialog.vue";

const dialogStub = {
  props: [
    "modelValue",
    "title",
    "beforeClose",
    "closeOnClickModal",
    "closeOnPressEscape",
    "showClose",
  ],
  emits: ["opened"],
  template:
    '<div v-if="modelValue"><h2 class="stub-title">{{ title }}</h2><slot/><slot name="footer"/></div>',
};

const buttonStub = {
  props: ["disabled", "loading"],
  emits: ["click"],
  template:
    '<button :disabled="disabled" :data-loading="String(Boolean(loading))" @click="$emit(\'click\')"><slot/></button>',
};

function mountDialog(targetMode: "full" | "limited-dacl" = "full") {
  return mount(MxcCapabilityConsentDialog, {
    attachTo: document.body,
    props: {
      modelValue: true,
      targetMode,
    },
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

describe("MxcCapabilityConsentDialog", () => {
  it("renders the versioned policy groups and Full boundary in English", () => {
    setLocale("en-US");
    const wrapper = mountDialog("full");

    expect(wrapper.find(".stub-title").text()).toBe("Enable Full containment?");
    expect(wrapper.find('[data-testid="mxc-consent-group-disabled"]').text()).toContain(
      "read, write, edit, and apply_patch",
    );
    expect(wrapper.find('[data-testid="mxc-consent-group-disabled"]').text()).toContain(
      "default Gateway memory plugin",
    );
    expect(wrapper.find('[data-testid="mxc-consent-group-paused"]').text()).toContain(
      "no catch-up",
    );
    expect(wrapper.find('[data-testid="mxc-consent-group-paused"]').text()).toContain(
      "return 503",
    );
    expect(wrapper.find('[data-testid="mxc-consent-group-available-restricted"]').text()).toContain(
      "Canvas Phase 1",
    );
    expect(wrapper.text()).toContain("backend preflight can still fail");
    expect(wrapper.text()).toContain("asks again for every explicit enable or switch");
  });

  it("renders natural Limited disclosure and retained acknowledgement in Chinese", () => {
    setLocale("zh-CN");
    const wrapper = mountDialog("limited-dacl");

    expect(wrapper.find(".stub-title").text()).toBe("启用有限隔离（DACL）？");
    expect(wrapper.text()).toContain("暂停 Cron 和计划任务");
    expect(wrapper.text()).toContain("仅限 HTTP(S) 的 web_fetch");
    expect(wrapper.text()).toContain("叠加 DACL 授权");
    expect(wrapper.text()).toContain("仍必须完成单独的有限模式确认");
    expect(wrapper.find('[data-testid="mxc-consent-accept"]').text()).toBe("启用 MXC");
  });

  it("emits accept only once across duplicate clicks", async () => {
    const wrapper = mountDialog();
    const accept = wrapper.find('[data-testid="mxc-consent-accept"]');

    await accept.trigger("click");
    await accept.trigger("click");

    expect(wrapper.emitted("accept")).toHaveLength(1);
    expect(accept.attributes("disabled")).toBeDefined();
  });

  it("focuses Enable MXC when the dialog opens", async () => {
    const wrapper = mountDialog();
    wrapper.findComponent(dialogStub).vm.$emit("opened");
    await wrapper.vm.$nextTick();

    expect(document.activeElement).toBe(
      wrapper.find('[data-testid="mxc-consent-accept"]').element,
    );
  });

  it("cancels from the button and close, Escape, or backdrop close path", async () => {
    const wrapper = mountDialog();
    await wrapper.find('[data-testid="mxc-consent-cancel"]').trigger("click");
    expect(wrapper.emitted("cancel")).toHaveLength(1);
    expect(wrapper.emitted("update:modelValue")).toEqual([[false]]);

    const closeWrapper = mountDialog();
    const beforeClose = closeWrapper.findComponent(dialogStub).props("beforeClose") as (
      done: () => void,
    ) => void;
    let closed = false;
    beforeClose(() => {
      closed = true;
    });

    expect(closed).toBe(true);
    expect(closeWrapper.emitted("cancel")).toHaveLength(1);
    expect(closeWrapper.findComponent(dialogStub).props("closeOnClickModal")).toBe(true);
    expect(closeWrapper.findComponent(dialogStub).props("closeOnPressEscape")).toBe(true);
    expect(closeWrapper.findComponent(dialogStub).props("showClose")).toBe(true);
  });
});
