import { defineComponent } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/i18n";
import DefaultModelPicker from "./DefaultModelPicker.vue";
import type { ConfiguredModel } from "@/utils/configured-models";

const PopoverStub = defineComponent({
  props: { visible: Boolean },
  emits: ["update:visible"],
  template: `<div><div @click="$emit('update:visible', !visible)"><slot name="reference" /></div><div v-show="visible"><slot /></div></div>`,
});
const models: ConfiguredModel[] = [
  { providerKey: "github-copilot", id: "gpt-5.5", name: "GPT-5.5", source: "auth-managed" },
  { providerKey: "github-copilot", id: "claude", name: "Claude", source: "auth-managed" },
  { providerKey: "llama-cpp", id: "qwen3.5-4b-q4_k_m", name: "Qwen3.5 4B", source: "managed" },
  { providerKey: "llama-cpp", id: "qwen3.5-9b-q4_k_m", name: "Qwen3.5 9B", source: "managed" },
];
const wrappers: Array<ReturnType<typeof mount>> = [];
beforeEach(() => setLocale("en-US"));
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  document.body.replaceChildren();
});
async function open() {
  const wrapper = mount(DefaultModelPicker, {
    attachTo: document.body,
    props: {
      models,
      modelValue: "github-copilot/gpt-5.5",
      modelStatus: (model) => (model.providerKey === "llama-cpp" ? "Not downloaded" : ""),
    },
    global: { stubs: { "el-popover": PopoverStub } },
  });
  wrappers.push(wrapper);
  await wrapper.get('[data-testid="default-model-picker"]').trigger("click");
  return wrapper;
}
describe("DefaultModelPicker", () => {
  it("shows switching in the trigger without changing the selected model before confirmation", async () => {
    const wrapper = await open();
    await wrapper.setProps({ switching: true });
    const trigger = wrapper.get('[data-testid="default-model-picker"]');
    expect(trigger.text()).toContain("Switching...");
    expect(trigger.attributes("aria-busy")).toBe("true");
    expect(trigger.attributes("disabled")).toBeDefined();
    expect(trigger.attributes("aria-expanded")).toBe("false");
    await wrapper.get('[data-model-ref="llama-cpp/qwen3.5-4b-q4_k_m"]').trigger("click");
    expect(wrapper.emitted("change")).toBeUndefined();
    await wrapper.setProps({ switching: false });
    expect(trigger.text()).toContain("GPT-5.5");
  });

  it("groups the settings default list and expands only the current default's provider", async () => {
    const wrapper = await open();
    expect(wrapper.get('[data-testid="default-model-picker"]').text()).toContain(
      "GitHub Copilot · GPT-5.5",
    );
    expect(wrapper.get('[data-provider-group="github-copilot"]').attributes("aria-expanded")).toBe(
      "true",
    );
    expect(wrapper.get('[data-provider-group="llama-cpp"]').attributes("aria-expanded")).toBe(
      "false",
    );
    expect(wrapper.get('[data-model-ref="llama-cpp/qwen3.5-4b-q4_k_m"]').isVisible()).toBe(false);
    await wrapper.get('[data-provider-group="github-copilot"]').trigger("click");
    await wrapper.get('[data-provider-group="llama-cpp"]').trigger("click");
    expect(wrapper.get('[data-model-ref="github-copilot/gpt-5.5"]').isVisible()).toBe(false);
    expect(wrapper.get('[data-model-ref="llama-cpp/qwen3.5-4b-q4_k_m"]').isVisible()).toBe(true);
    expect(wrapper.emitted("change")).toBeUndefined();
  });

  it("reveals search results without losing previous folds or selecting any model", async () => {
    const wrapper = await open();
    await wrapper.get(".model-search").setValue("qwen");
    expect(wrapper.get('[data-model-ref="llama-cpp/qwen3.5-4b-q4_k_m"]').isVisible()).toBe(true);
    expect(wrapper.find('[data-provider-group="github-copilot"]').exists()).toBe(false);
    await wrapper.get(".model-search").setValue("absent");
    expect(wrapper.text()).toContain("No matching models.");
    await wrapper.get(".clear-search").trigger("click");
    expect(wrapper.get('[data-provider-group="github-copilot"]').attributes("aria-expanded")).toBe(
      "true",
    );
    expect(wrapper.get('[data-provider-group="llama-cpp"]').attributes("aria-expanded")).toBe(
      "false",
    );
    expect(wrapper.emitted("change")).toBeUndefined();
  });

  it("emits an exact local selection without changing its displayed default before the parent saves", async () => {
    const wrapper = await open();
    await wrapper.get('[data-provider-group="llama-cpp"]').trigger("click");
    const choice = wrapper.get('[data-model-ref="llama-cpp/qwen3.5-4b-q4_k_m"]');
    expect(choice.text()).toContain("Not downloaded");
    await choice.trigger("click");
    expect(wrapper.emitted("change")).toEqual([["llama-cpp/qwen3.5-4b-q4_k_m"]]);
    expect(wrapper.get('[data-testid="default-model-picker"]').attributes("aria-expanded")).toBe(
      "false",
    );
    expect(wrapper.get('[data-testid="default-model-picker"]').text()).toContain("GPT-5.5");
  });

  it("preserves collapsed groups on reopening and refreshes the current default without inventing one", async () => {
    const wrapper = await open();
    await wrapper.get('[data-provider-group="github-copilot"]').trigger("click");
    await wrapper.get('[data-testid="default-model-picker"]').trigger("click");
    await wrapper.get('[data-testid="default-model-picker"]').trigger("click");
    await wrapper.setProps({ models: [...models] });
    expect(wrapper.get('[data-provider-group="github-copilot"]').attributes("aria-expanded")).toBe(
      "false",
    );
    await wrapper.setProps({ modelValue: "" });
    expect(wrapper.get('[data-testid="default-model-picker"]').text()).toContain("Select a model");
    expect(wrapper.emitted("change")).toBeUndefined();
  });

  it("closes and blocks selection when mutations become unavailable", async () => {
    const wrapper = await open();
    await wrapper.setProps({ disabled: true });
    await flushPromises();
    expect(
      wrapper.get('[data-testid="default-model-picker"]').attributes("disabled"),
    ).toBeDefined();
    expect(wrapper.get('[data-testid="default-model-picker"]').attributes("aria-expanded")).toBe(
      "false",
    );
    await wrapper.get('[data-model-ref="github-copilot/gpt-5.5"]').trigger("click");
    expect(wrapper.emitted("change")).toBeUndefined();
  });
});
