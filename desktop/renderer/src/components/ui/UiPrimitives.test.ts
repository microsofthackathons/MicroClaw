import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import UiButton from "./UiButton.vue";
import UiDialog from "./UiDialog.vue";
import UiInput from "./UiInput.vue";

describe("UI primitive interaction contracts", () => {
  it("forwards one native button activation without submitting a form", () => {
    const click = vi.fn();
    const wrapper = mount(UiButton, { attrs: { onClick: click }, slots: { default: "Save" } });
    expect(wrapper.element.tagName).toBe("BUTTON");
    expect(wrapper.attributes("type")).toBe("button");
    (wrapper.element as HTMLButtonElement).click();
    expect(click).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it.each([
    { disabled: true, loading: false },
    { disabled: false, loading: true },
  ])("blocks native activation while unavailable (%j)", (props) => {
    const click = vi.fn();
    const wrapper = mount(UiButton, { props, attrs: { onClick: click } });
    (wrapper.element as HTMLButtonElement).click();
    expect(click).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("emits the edited input value and forwards Enter to its consumer", async () => {
    const wrapper = mount(UiInput, { props: { modelValue: "before" } });
    await wrapper.get("input").setValue("after");
    await wrapper.get("input").trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("update:modelValue")).toEqual([["after"]]);
    expect((wrapper.emitted("keydown")?.[0][0] as KeyboardEvent).key).toBe("Enter");
    wrapper.unmount();
  });

  it("reveals and hides a password without editing its value", async () => {
    const wrapper = mount(UiInput, { props: { modelValue: "fixture", showPassword: true } });
    expect(wrapper.get("input").attributes("type")).toBe("password");
    await wrapper.get("button").trigger("click");
    expect(wrapper.get("input").attributes("type")).toBe("text");
    await wrapper.get("button").trigger("click");
    expect(wrapper.get("input").attributes("type")).toBe("password");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    wrapper.unmount();
  });

  it("closes on an allowed overlay press while ignoring content presses", async () => {
    const wrapper = mount(UiDialog, { props: { modelValue: true, title: "Fixture" } });
    await wrapper.get("section").trigger("mousedown");
    expect(wrapper.emitted("close")).toBeUndefined();
    await wrapper.get(".ui-dialog-overlay").trigger("mousedown");
    expect(wrapper.emitted("update:modelValue")).toEqual([[false]]);
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("honors a blocked overlay while retaining the explicit close action", async () => {
    const wrapper = mount(UiDialog, { props: { modelValue: true, closeOnOverlay: false } });
    await wrapper.get(".ui-dialog-overlay").trigger("mousedown");
    expect(wrapper.emitted("close")).toBeUndefined();
    await wrapper.get("button").trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([[false]]);
    expect(wrapper.emitted("close")).toHaveLength(1);
    await wrapper.setProps({ modelValue: false });
    expect(wrapper.find(".ui-dialog-overlay").exists()).toBe(false);
    wrapper.unmount();
  });
});
