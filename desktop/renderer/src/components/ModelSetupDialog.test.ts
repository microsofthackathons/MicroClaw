import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ModelSetupDialog from "./ModelSetupDialog.vue";

describe("ModelSetupDialog", () => {
  const openExternal = vi.fn();

  beforeEach(() => {
    openExternal.mockReset();
    Object.defineProperty(window, "openclaw", {
      configurable: true,
      value: { shell: { openExternal } },
    });
  });

  it("opens the selected provider signup flow", async () => {
    const wrapper = mount(ModelSetupDialog, {
      props: { modelValue: true },
    });

    await wrapper.findAll(".model-family-card")[1].trigger("click");
    await wrapper.find(".primary-action").trigger("click");

    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal.mock.calls[0][0]).toContain("minimaxi.com");
    expect(wrapper.find(".model-key-form").exists()).toBe(true);
  });

  it("returns to a clean provider selection when reopened", async () => {
    const wrapper = mount(ModelSetupDialog, {
      props: { modelValue: true },
    });

    await wrapper.findAll(".model-family-card")[1].trigger("click");
    await wrapper.find(".text-action").trigger("click");
    expect(wrapper.find(".model-key-form").exists()).toBe(true);

    await wrapper.setProps({ modelValue: false });
    await wrapper.setProps({ modelValue: true });

    expect(wrapper.find(".model-key-form").exists()).toBe(false);
    expect(wrapper.findAll(".model-family-card")[0].classes()).toContain("active");
  });
});
