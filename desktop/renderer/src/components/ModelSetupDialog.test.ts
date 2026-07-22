import { mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ModelSetupDialog from "./ModelSetupDialog.vue";

const PassthroughStub = defineComponent({
  template: "<div><slot /></div>",
});

const InputStub = defineComponent({
  props: {
    modelValue: {
      type: String,
      default: "",
    },
  },
  emits: ["update:modelValue"],
  template:
    '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
});

function mountDialog() {
  return mount(ModelSetupDialog, {
    props: { modelValue: true },
    global: {
      stubs: {
        ElForm: PassthroughStub,
        ElFormItem: PassthroughStub,
        ElInput: InputStub,
        ElSelect: PassthroughStub,
        ElOption: true,
        ElOptionGroup: PassthroughStub,
      },
    },
  });
}

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
    const wrapper = mountDialog();

    await wrapper.findAll(".model-family-card")[1].trigger("click");
    await wrapper.find(".primary-action").trigger("click");

    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal.mock.calls[0][0]).toContain("minimaxi.com");
    expect(wrapper.find(".model-key-form").exists()).toBe(true);
  });

  it("returns to a clean provider selection when reopened", async () => {
    const wrapper = mountDialog();

    await wrapper.findAll(".model-family-card")[1].trigger("click");
    await wrapper.find(".text-action").trigger("click");
    expect(wrapper.find(".model-key-form").exists()).toBe(true);

    await wrapper.setProps({ modelValue: false });
    await wrapper.setProps({ modelValue: true });

    expect(wrapper.find(".model-key-form").exists()).toBe(false);
    expect(wrapper.findAll(".model-family-card")[0].classes()).toContain("active");
  });

  it("preserves an existing provider configuration when saving", async () => {
    const existingProvider = {
      baseUrl: "https://old.example/v1",
      apiKey: "old-key",
      api: "openai-completions",
      headers: { "X-Custom": "value" },
      models: [
        { id: "qwen3.7-plus", name: "Qwen Plus", input: ["text"] },
        { id: "qwen3-32b", name: "Qwen 32B", input: ["text", "image"] },
      ],
    };
    const config = {
      models: {
        mode: "merge",
        providers: { qwen: existingProvider },
      },
      agents: {
        defaults: {
          model: { primary: "qwen/qwen3-32b" },
        },
      },
    };
    const write = vi.fn().mockResolvedValue(undefined);
    const restart = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "openclaw", {
      configurable: true,
      value: {
        config: {
          read: vi.fn().mockResolvedValue(config),
          write,
        },
        gateway: { restart },
        shell: { openExternal },
      },
    });
    const wrapper = mountDialog();

    await wrapper.find(".text-action").trigger("click");
    await wrapper.findAll("input")[1].setValue("new-key");
    await wrapper.find(".primary-action").trigger("mousedown");

    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0].models.providers.qwen).toEqual({
      ...existingProvider,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "new-key",
      models: existingProvider.models,
    });
    expect(write.mock.calls[0][0].agents.defaults.model.primary).toBe("qwen/qwen3.7-plus");
    expect(restart).toHaveBeenCalledOnce();
  });
});
