import { defineComponent } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelSetupDialog from "./ModelSetupDialog.vue";

const InputStub = defineComponent({
  props: {
    modelValue: { type: String, default: "" },
    placeholder: { type: String, default: "" },
  },
  emits: ["update:modelValue"],
  template:
    '<input :value="modelValue" :placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value)" />',
});

const SelectStub = defineComponent({
  props: {
    modelValue: { type: String, default: "" },
  },
  emits: ["update:modelValue"],
  template:
    '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><slot /></select>',
});

const componentStubs = {
  "el-form": { template: "<form><slot /></form>" },
  "el-form-item": {
    props: ["label"],
    template: "<label>{{ label }}<slot /></label>",
  },
  "el-input": InputStub,
  "el-select": SelectStub,
  "el-option": {
    props: ["label", "value"],
    template: '<option :value="value">{{ label }}</option>',
  },
  "el-option-group": { template: "<optgroup><slot /></optgroup>" },
};

function mountDialog() {
  return mount(ModelSetupDialog, {
    props: { modelValue: true },
    global: { stubs: componentStubs },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ModelSetupDialog", () => {
  const read = vi.fn();
  const write = vi.fn();
  const restart = vi.fn();
  const testConnection = vi.fn();
  const openExternal = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    read.mockResolvedValue({ gateway: { port: 18789 } });
    write.mockResolvedValue(undefined);
    restart.mockResolvedValue(undefined);
    testConnection.mockResolvedValue({
      ok: true,
      message: "Connection successful",
      baseUrl: "http://localhost:11434/v1",
    });
    window.openclaw = {
      config: { read, write },
      gateway: { restart },
      model: { testConnection },
      shell: { openExternal },
    } as unknown as typeof window.openclaw;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function openCustomForm(wrapper: ReturnType<typeof mountDialog>) {
    const cards = wrapper.findAll(".model-family-card");
    expect(cards).toHaveLength(3);
    await cards[2].trigger("click");
    expect(wrapper.text()).toContain("Configure custom provider");
    await wrapper.find(".primary-action").trigger("click");
  }

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
    read.mockResolvedValue({
      models: {
        mode: "merge",
        providers: { qwen: existingProvider },
      },
      agents: {
        defaults: {
          model: { primary: "qwen/qwen3-32b" },
        },
      },
    });
    testConnection.mockResolvedValueOnce({
      ok: true,
      message: "Connection successful",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
    const wrapper = mountDialog();

    await wrapper.find(".text-action").trigger("click");
    await wrapper.findAll("input")[1].setValue("new-key");
    await wrapper.find(".primary-action").trigger("mousedown");
    await flushPromises();
    await vi.runAllTimersAsync();

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

  it("shows an Other model path with custom provider fields", async () => {
    const wrapper = mountDialog();
    await openCustomForm(wrapper);

    expect(wrapper.text()).toContain("Provider ID");
    expect(wrapper.text()).toContain("API Format");
    expect(wrapper.text()).toContain("API KEY (OPTIONAL)");
  });

  it("validates and saves a keyless local provider using the tested Base URL", async () => {
    const wrapper = mountDialog();
    await openCustomForm(wrapper);
    const inputs = wrapper.findAll("input");

    await inputs[0].setValue("ollama");
    await inputs[1].setValue("llama3.2");
    await inputs[2].setValue("http://localhost:11434");
    await wrapper.find(".key-actions .primary-action").trigger("mousedown");
    await flushPromises();
    await vi.runAllTimersAsync();

    expect(testConnection).toHaveBeenCalledWith({
      baseUrl: "http://localhost:11434",
      apiKey: "",
      apiFormat: "openai-chat",
      modelName: "llama3.2",
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatchObject({
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            apiKey: "",
            models: [{ id: "llama3.2", input: ["text"] }],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "ollama/llama3.2" },
        },
      },
    });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted("configured")).toHaveLength(1);
  });

  it("does not write after the dialog is closed during connection validation", async () => {
    const connection = deferred<{
      ok: boolean;
      message: string;
      baseUrl?: string;
    }>();
    testConnection.mockReturnValueOnce(connection.promise);
    const wrapper = mountDialog();
    await openCustomForm(wrapper);
    const inputs = wrapper.findAll("input");

    await inputs[0].setValue("ollama");
    await inputs[1].setValue("llama3.2");
    await inputs[2].setValue("http://localhost:11434");
    await wrapper.find(".key-actions .primary-action").trigger("mousedown");
    await wrapper.find(".model-setup-close").trigger("click");
    connection.resolve({
      ok: true,
      message: "Connection successful",
      baseUrl: "http://localhost:11434/v1",
    });
    await flushPromises();

    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });
});
