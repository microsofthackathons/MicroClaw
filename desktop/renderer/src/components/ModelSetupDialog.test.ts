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
  emits: ["update:modelValue", "change"],
  template:
    '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value); $emit(\'change\', $event.target.value)"><slot /></select>',
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
  const prepareGitHubCopilot = vi.fn();
  const startGitHubCopilotLogin = vi.fn();
  const cancelGitHubCopilotLogin = vi.fn();
  const getGitHubCopilotStatus = vi.fn();
  const listGitHubCopilotModels = vi.fn();
  const removeGitHubCopilotListener = vi.fn();
  let githubCopilotLoginListener: ((event: GitHubCopilotLoginEvent) => void) | undefined;

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
    prepareGitHubCopilot.mockResolvedValue({ restartRequired: false });
    startGitHubCopilotLogin.mockResolvedValue({ sessionId: "copilot-session" });
    cancelGitHubCopilotLogin.mockResolvedValue({ cancelled: true });
    getGitHubCopilotStatus.mockResolvedValue({ authenticated: false });
    listGitHubCopilotModels.mockResolvedValue([]);
    githubCopilotLoginListener = undefined;
    window.openclaw = {
      config: { read, write },
      gateway: { restart },
      model: {
        testConnection,
        prepareGitHubCopilot,
        startGitHubCopilotLogin,
        cancelGitHubCopilotLogin,
        getGitHubCopilotStatus,
        listGitHubCopilotModels,
        onGitHubCopilotLoginEvent: (listener: (event: GitHubCopilotLoginEvent) => void) => {
          githubCopilotLoginListener = listener;
          return removeGitHubCopilotListener;
        },
      },
      shell: { openExternal },
    } as unknown as typeof window.openclaw;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function openCustomForm(wrapper: ReturnType<typeof mountDialog>) {
    const cards = wrapper.findAll(".model-family-card");
    expect(cards).toHaveLength(4);
    await cards[3].trigger("click");
    expect(wrapper.text()).toContain("Configure custom provider");
    await wrapper.find(".primary-action").trigger("click");
  }

  async function openGitHubCopilotForm(wrapper: ReturnType<typeof mountDialog>) {
    const cards = wrapper.findAll(".model-family-card");
    expect(cards).toHaveLength(4);
    await cards[2].trigger("click");
    expect(wrapper.text()).toContain("GitHub Copilot");
    await wrapper.find(".primary-action").trigger("click");
    await flushPromises();
  }

  it("shows only MicroClaw-managed providers, Copilot, and custom setup", () => {
    const wrapper = mountDialog();
    expect(wrapper.findAll(".model-family-card").map((card) => card.text())).toEqual([
      "千问",
      "MiniMax",
      "GitHub Copilot",
      "Other model",
    ]);
    expect(wrapper.text()).not.toContain("OpenClaw catalog");
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
      models: [
        {
          ...existingProvider.models[0],
          name: "qwen3.7-plus",
          input: ["text", "image"],
        },
        existingProvider.models[1],
      ],
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

  it("signs into GitHub Copilot with a device code and saves a full model reference", async () => {
    listGitHubCopilotModels.mockResolvedValueOnce([
      { id: "github-copilot/claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
      { id: "github-copilot/gpt-5.4", name: "GPT-5.4" },
    ]);
    prepareGitHubCopilot.mockResolvedValueOnce({ restartRequired: true });
    const wrapper = mountDialog();
    await openGitHubCopilotForm(wrapper);
    expect(getGitHubCopilotStatus).toHaveBeenCalledOnce();
    expect(listGitHubCopilotModels).not.toHaveBeenCalled();
    expect(wrapper.find(".primary-action").text()).toContain("Sign in with GitHub");
    await wrapper.find(".primary-action").trigger("mousedown");
    await flushPromises();
    expect(startGitHubCopilotLogin).toHaveBeenCalledOnce();

    githubCopilotLoginListener?.({
      sessionId: "copilot-session",
      status: "code",
      verificationUrl: "https://github.com/login/device",
      userCode: "ABCD-1234",
      expiresInMs: 900_000,
    });
    await flushPromises();
    expect(wrapper.text()).toContain("ABCD-1234");

    githubCopilotLoginListener?.({
      sessionId: "copilot-session",
      status: "success",
      defaultModel: "github-copilot/gpt-5.4",
    });
    await flushPromises();
    expect(listGitHubCopilotModels).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("GitHub Copilot connected");
    expect(wrapper.find("select").element.value).toBe("github-copilot/gpt-5.4");

    await wrapper.find(".primary-action").trigger("mousedown");
    await flushPromises();
    await vi.runAllTimersAsync();

    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toMatchObject({
      agents: {
        defaults: {
          model: { primary: "github-copilot/gpt-5.4" },
        },
      },
    });
    expect(write.mock.calls[0][0].models).toBeUndefined();
    expect(prepareGitHubCopilot).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledOnce();
  });

  it("cancels an in-progress GitHub device login when the dialog closes", async () => {
    const wrapper = mountDialog();
    await openGitHubCopilotForm(wrapper);
    await wrapper.find(".primary-action").trigger("mousedown");
    await flushPromises();

    await wrapper.find(".model-setup-close").trigger("click");
    await flushPromises();

    expect(cancelGitHubCopilotLogin).toHaveBeenCalledWith("copilot-session");
    expect(write).not.toHaveBeenCalled();
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
    expect(restart).toHaveBeenCalledOnce();
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
