import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import ModelSetupDialog from "./ModelSetupDialog.vue";

describe("ModelSetupDialog accessible actions", () => {
  let wrapper: VueWrapper;
  let read: ReturnType<typeof vi.fn>;
  let write: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    read = vi.fn().mockResolvedValue({});
    write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("openclaw", { config: { read, write } });
    wrapper = mount(ModelSetupDialog, {
      props: { modelValue: true },
      global: {
        stubs: {
          ElForm: { template: "<div><slot /></div>" },
          ElFormItem: { template: "<div><slot /></div>" },
        },
      },
    });
  });

  afterEach(() => {
    wrapper.unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function enterKeyForm() {
    await wrapper.get("button.text-action").trigger("click");
  }

  it("exposes the model setup surface as a modal dialog", () => {
    expect(wrapper.get('[role="dialog"]').attributes("aria-modal")).toBe("true");
  });

  // Keyboard activation and assistive technology send click without mousedown.
  it("returns to provider selection on a click without a preceding mousedown", async () => {
    await enterKeyForm();
    await wrapper.get("button.text-action--back").trigger("click");
    expect(wrapper.find(".model-family-grid").exists()).toBe(true);
    expect(wrapper.find(".model-key-form").exists()).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("validates an empty key when Start is activated by click alone", async () => {
    await enterKeyForm();
    await wrapper.get("button.primary-action").trigger("click");
    expect(wrapper.get(".error-msg").text()).not.toBe("");
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("saves and signals completion when Start is activated by click alone", async () => {
    await enterKeyForm();
    await wrapper.get('input[type="password"]').setValue("review-fixture-key");
    await wrapper.get("button.primary-action").trigger("click");
    await flushPromises();
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0].models.providers.qwen.apiKey).toBe("review-fixture-key");
    await vi.advanceTimersByTimeAsync(500);
    expect(wrapper.emitted("configured")).toHaveLength(1);
    expect(wrapper.emitted("update:modelValue")).toEqual([[false]]);
  });

  it("saves once for a pointer activation and disables Start while saving", async () => {
    await enterKeyForm();
    await wrapper.get('input[type="password"]').setValue("review-fixture-key");
    const start = wrapper.get<HTMLButtonElement>("button.primary-action");
    await start.trigger("mousedown");
    start.element.click();
    await flushPromises();
    expect(start.element.disabled).toBe(true);
    start.element.click();
    await flushPromises();
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(wrapper.emitted("configured")).toHaveLength(1);
  });

  it("shows a save failure and restores a usable Start action", async () => {
    write.mockRejectedValue(new Error("fixture write failure"));
    await enterKeyForm();
    await wrapper.get('input[type="password"]').setValue("review-fixture-key");
    await wrapper.get("button.primary-action").trigger("click");
    await flushPromises();
    expect(wrapper.get(".error-msg").text()).toContain("fixture write failure");
    expect(wrapper.get<HTMLButtonElement>("button.primary-action").element.disabled).toBe(false);
    expect(wrapper.emitted("configured")).toBeUndefined();
  });
});
