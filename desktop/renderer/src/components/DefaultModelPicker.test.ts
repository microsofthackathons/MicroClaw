import { defineComponent } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElPopover } from "element-plus";
import { setLocale, t } from "@/i18n";
import DefaultModelPicker from "./DefaultModelPicker.vue";
import IconChevronDown from "./icons/IconChevronDown.vue";
import type { ConfiguredModel } from "@/utils/configured-models";

const PopoverStub = defineComponent({
  props: {
    visible: Boolean,
    width: { type: Number, default: 0 },
    placement: { type: String, default: "right-start" },
  },
  emits: ["update:visible"],
  template: `<div :data-width="width" :data-placement="placement"><div @click="$emit('update:visible', !visible)"><slot name="reference" /></div><div v-show="visible"><slot /></div></div>`,
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function open(realPopover = false) {
  const wrapper = mount(DefaultModelPicker, {
    attachTo: document.body,
    props: {
      models,
      modelValue: "github-copilot/gpt-5.5",
      modelStatus: (model) => (model.providerKey === "llama-cpp" ? "Not downloaded" : ""),
    },
    global: {
      components: { ElPopover },
      stubs: { "el-popover": realPopover ? false : PopoverStub },
    },
  });
  wrappers.push(wrapper);
  await wrapper.get('[data-testid="default-model-picker"]').trigger("click");
  return wrapper;
}
describe("DefaultModelPicker", () => {
  it.each([1, 5, 6, 12])("limits the second level to five of %i models", async (count) => {
    const wrapper = await open();
    const manyModels: ConfiguredModel[] = Array.from({ length: count }, (_, index) => ({
      providerKey: "openai",
      id: `test-${index}`,
      name: `Test model ${index}`,
      source: "custom",
    }));
    await wrapper.setProps({ models: manyModels });
    const provider = wrapper.get('[data-provider-group="openai"]');
    expect(provider.get(".model-group-name").text()).toBe("OpenAI");
    expect(provider.find(".provider-chevron").exists()).toBe(true);
    expect(provider.attributes("aria-expanded")).toBe("false");
    await provider.trigger("click");
    expect(provider.classes()).toContain("submenu-open");
    const second = wrapper.get('[role="menu"][aria-label="OpenAI"]');
    expect(second.isVisible()).toBe(true);
    expect(second.findAll("p,h1,h2,h3,h4,h5,h6")).toHaveLength(0);
    expect(second.findAll("[data-model-ref]")).toHaveLength(count);
    const frequent = second.findAll("[data-model-ref]").filter((model) => model.isVisible());
    expect(frequent).toHaveLength(Math.min(5, count));
    expect(wrapper.find('[data-more-models="openai"]').exists()).toBe(count > 5);
    if (count > 5) {
      await wrapper.get('[data-more-models="openai"]').trigger("click");
      expect(provider.classes()).toContain("submenu-open");
      expect(wrapper.get('[data-more-models="openai"]').classes()).toContain("submenu-open");
      const remaining = wrapper.get('[role="menu"][aria-label="OpenAI · More models"]');
      expect(remaining.findAll("p,h1,h2,h3,h4,h5,h6")).toHaveLength(0);
      expect(remaining.findAll("[data-model-ref]")).toHaveLength(count - 5);
      expect(remaining.isVisible()).toBe(true);
      await remaining.get("[data-model-ref]").trigger("click");
    } else {
      await frequent[0].trigger("click");
    }
    expect(wrapper.emitted("change")).toHaveLength(1);
    expect(wrapper.get('[data-testid="default-model-picker"]').attributes("aria-expanded")).toBe(
      "false",
    );
    expect(wrapper.find(".provider-menu").exists()).toBe(false);
  });

  it("uses fixed curated recommendations and keeps the selected overflow model in More models", async () => {
    const wrapper = await open();
    const ids = [
      "qwen",
      "qwen3-32b",
      "qwen3.5-plus",
      "qwen3.6-flash",
      "qwen3.6-plus",
      "qwen3.7-plus",
    ];
    await wrapper.setProps({
      modelValue: "qwen/qwen",
      models: ids.map((id) => ({ providerKey: "qwen", id, name: id, source: "managed" })),
    });
    await wrapper.get('[data-provider-group="qwen"]').trigger("click");
    const visible = wrapper.findAll("[data-model-ref]").filter((model) => model.isVisible());
    expect(visible.map((model) => model.attributes("data-model-ref"))).toEqual([
      "qwen/qwen3.7-plus",
      "qwen/qwen3.6-plus",
      "qwen/qwen3.6-flash",
      "qwen/qwen3.5-plus",
      "qwen/qwen3-32b",
    ]);
    const secondPopup = wrapper
      .get('[role="menu"][aria-label="Qianwen"]')
      .element.closest("[data-width]");
    secondPopup?.classList.add("el-popper");
    secondPopup?.setAttribute("data-popper-placement", "left-start");
    const more = wrapper.get('[data-more-models="qwen"]');
    await more.trigger("keydown", { key: "ArrowRight" });
    await flushPromises();
    const overflow = wrapper.get('[data-model-ref="qwen/qwen"]');
    expect(overflow.attributes("aria-checked")).toBe("true");
    expect(overflow.find("svg.model-menu-check").exists()).toBe(true);
    expect(document.activeElement).toBe(overflow.element);
    expect(overflow.element.closest("[data-placement]")?.getAttribute("data-placement")).toBe(
      "left-start",
    );
    await overflow.trigger("keydown", { key: "Escape" });
    expect(document.activeElement).toBe(more.element);
    expect(more.attributes("aria-expanded")).toBe("false");
  });

  it("supports entering and leaving cascades with the keyboard", async () => {
    const wrapper = await open();
    const provider = wrapper.get('[data-provider-group="github-copilot"]');
    await provider.trigger("keydown", { key: "ArrowRight" });
    await flushPromises();
    const first = wrapper.get('[role="menu"][aria-label="GitHub Copilot"] [data-model-ref]');
    expect(document.activeElement).toBe(first.element);
    await first.trigger("keydown", { key: "ArrowDown" });
    const second = wrapper.findAll(
      '[role="menu"][aria-label="GitHub Copilot"] [data-model-ref]',
    )[1];
    expect(document.activeElement).toBe(second.element);
    await second.trigger("keydown", { key: "ArrowLeft" });
    expect(document.activeElement).toBe(provider.element);
    expect(provider.attributes("aria-expanded")).toBe("false");
    expect(wrapper.emitted("change")).toBeUndefined();
  });

  it("uses an outlined check matching the chevron and only marks the confirmed selected model", async () => {
    const wrapper = await open();
    await wrapper.get('[data-provider-group="github-copilot"]').trigger("click");
    const selected = wrapper.get('[data-model-ref="github-copilot/gpt-5.5"]');
    const unselected = wrapper.get('[data-model-ref="github-copilot/claude"]');
    const check = selected.get("svg.model-menu-check");
    expect(selected.classes()).not.toContain("selected");
    expect(selected.attributes("aria-checked")).toBe("true");
    const chevron = wrapper.get("svg.provider-chevron");
    for (const attribute of [
      "width",
      "height",
      "viewBox",
      "fill",
      "stroke",
      "stroke-width",
      "stroke-linecap",
      "stroke-linejoin",
    ]) {
      expect(check.attributes(attribute)).toBe(chevron.attributes(attribute));
    }
    expect(check.attributes("aria-hidden")).toBe("true");
    expect(check.get("polyline").attributes("points")).toBe("20 6 9 17 4 12");
    expect(unselected.find(".model-menu-check").exists()).toBe(false);
    await wrapper.setProps({ modelValue: "github-copilot/claude" });
    expect(selected.find(".model-menu-check").exists()).toBe(false);
    expect(unselected.find(".model-menu-check").exists()).toBe(true);
    expect(wrapper.findAll(".model-menu-check")).toHaveLength(1);
    expect(wrapper.emitted("change")).toBeUndefined();
  });

  it("matches the popup's border-box width to the trigger", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 320, 32),
    );
    const wrapper = await open(true);
    await flushPromises();
    const popover = wrapper.getComponent(ElPopover);
    expect(popover.props("width")).toBe(320);
    expect(popover.props("offset")).toBe(6);
    expect(popover.props("popperStyle")).toEqual({
      minWidth: "0",
      boxSizing: "border-box",
      padding: "4px",
    });
  });

  it("keeps the popup width synchronized after resizing and disconnects on unmount", async () => {
    let resize!: () => void;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 320, 32));
    const wrapper = await open();
    expect(observe).toHaveBeenCalledWith(
      wrapper.get('[data-testid="default-model-picker"]').element,
    );
    bounds.mockReturnValue(new DOMRect(0, 0, 248.5, 32));
    resize();
    await flushPromises();
    expect(wrapper.get(".default-model-picker > [data-width]").attributes("data-width")).toBe(
      "248.5",
    );
    wrapper.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("localizes the local provider label without changing model references", async () => {
    const wrapper = await open();
    await wrapper.setProps({ modelValue: "llama-cpp/qwen3.5-9b-q4_k_m" });
    const trigger = wrapper.get('[data-testid="default-model-picker"]');
    expect(trigger.text()).toContain("Local model · Qwen3.5 9B");
    expect(wrapper.get('[data-provider-group="llama-cpp"] .model-group-name').text()).toBe(
      "Local model",
    );

    setLocale("zh-CN");
    await flushPromises();
    expect(trigger.text()).toContain("本地模型 · Qwen3.5 9B");
    expect(trigger.attributes("title")).toBe("本地模型 · Qwen3.5 9B");
    expect(wrapper.get('[data-provider-group="llama-cpp"] .model-group-name').text()).toBe(
      "本地模型",
    );
    expect(wrapper.findAll("[data-provider-group]")).toHaveLength(2);
    await wrapper.get('[data-provider-group="llama-cpp"]').trigger("click");
    expect(wrapper.get('[data-model-ref="llama-cpp/qwen3.5-4b-q4_k_m"]').isVisible()).toBe(true);
    expect(wrapper.emitted("change")).toBeUndefined();
    await wrapper.get('[data-model-ref="llama-cpp/qwen3.5-4b-q4_k_m"]').trigger("click");
    expect(wrapper.emitted("change")).toEqual([["llama-cpp/qwen3.5-4b-q4_k_m"]]);
  });

  it("keeps expanded state and a named dialog with the real Element Plus popover", async () => {
    const wrapper = await open(true);
    const trigger = wrapper.get('[data-testid="default-model-picker"]');
    await vi.waitFor(() => expect(trigger.attributes("aria-expanded")).toBe("true"));
    expect(trigger.attributes("aria-haspopup")).toBe("dialog");
    const dialogId = trigger.attributes("aria-controls");
    expect(dialogId).toBeTruthy();
    const dialog = dialogId ? document.getElementById(dialogId) : null;
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-label")).toBe("Default model");
  });

  it("keeps specialized models visible but blocks incompatible default selection", async () => {
    const wrapper = await open();
    await wrapper.setProps({
      modelValue: "qwen/qwen3.7-plus",
      models: [
        { providerKey: "qwen", id: "qwen3.7-plus", name: "Plus", source: "managed" },
        {
          providerKey: "qwen",
          id: "qwen3.8-omni-flash-realtime",
          name: "Realtime",
          source: "managed",
        },
      ],
    });
    await wrapper.get('[data-provider-group="qwen"]').trigger("click");
    expect(wrapper.findAll("[data-model-ref]")).toHaveLength(2);
    const incompatible = wrapper.get('[data-model-ref="qwen/qwen3.8-omni-flash-realtime"]');
    expect(incompatible.attributes("disabled")).toBeDefined();
    expect(incompatible.text()).toContain("Requires realtime API");
    await incompatible.trigger("click");
    expect(wrapper.emitted("change")).toBeUndefined();
    expect(
      wrapper.get('[data-model-ref="qwen/qwen3.7-plus"]').attributes("disabled"),
    ).toBeUndefined();
  });

  it("shows switching in the trigger without changing the selected model before confirmation", async () => {
    const wrapper = await open();
    await wrapper.setProps({ switching: true });
    const trigger = wrapper.get('[data-testid="default-model-picker"]');
    expect(trigger.text()).toContain("Switching...");
    expect(trigger.attributes("aria-busy")).toBe("true");
    expect(trigger.attributes("disabled")).toBeDefined();
    expect(trigger.attributes("aria-expanded")).toBe("false");
    expect(wrapper.find("[data-model-ref]").exists()).toBe(false);
    expect(wrapper.emitted("change")).toBeUndefined();
    await wrapper.setProps({ switching: false });
    expect(trigger.text()).toContain("GPT-5.5");
  });

  it("initially shows providers only and opens one submenu at a time", async () => {
    const wrapper = await open();
    expect(wrapper.get('[data-testid="default-model-picker"]').text()).toContain(
      "GitHub Copilot · GPT-5.5",
    );
    expect(wrapper.get('[data-provider-group="github-copilot"]').attributes("aria-expanded")).toBe(
      "false",
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

  it("omits search and uses the Usage sidebar's shared chevron for all menu triggers", async () => {
    const wrapper = await open();
    expect(wrapper.find('input[type="search"], .model-search, .clear-search').exists()).toBe(false);
    const chevrons = wrapper.findAllComponents(IconChevronDown);
    expect(chevrons).toHaveLength(3);
    for (const chevron of chevrons) {
      expect(chevron.props()).toEqual({ size: 12, strokeWidth: 2 });
      expect(chevron.attributes("aria-hidden")).toBe("true");
    }
    expect(wrapper.emitted("change")).toBeUndefined();
  });

  it("shows the unconfigured empty state without a search action", async () => {
    const wrapper = await open();
    await wrapper.setProps({ models: [], modelValue: "" });
    expect(wrapper.get('[role="status"]').text()).toBe(t("settings.noProviderConfigured"));
    expect(wrapper.find(".clear-search").exists()).toBe(false);
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

  it("resets cascading submenus on reopening without inventing a default", async () => {
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
    expect(wrapper.find("[data-model-ref]").exists()).toBe(false);
    expect(wrapper.emitted("change")).toBeUndefined();
  });
});
