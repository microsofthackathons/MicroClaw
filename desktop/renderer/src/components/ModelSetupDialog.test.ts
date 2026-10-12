import { defineComponent } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElMessageBox } from "element-plus";
import { createBrowserOpenClawMock } from "@/browser-openclaw";
import type { LocalModelOperation } from "../../../src/local-model-types";
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
    "<select :value=\"modelValue\" @change=\"$emit('update:modelValue', $event.target.value); $emit('change', $event.target.value)\"><slot /></select>",
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

function mountDialog(props: Partial<InstanceType<typeof ModelSetupDialog>["$props"]> = {}) {
  return mount(ModelSetupDialog, {
    props: { modelValue: true, ...props },
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
    expect(cards).toHaveLength(5);
    await cards[3].trigger("click");
    expect(wrapper.text()).toContain("Configure custom provider");
    await wrapper.find(".primary-action").trigger("click");
  }

  async function openGitHubCopilotForm(wrapper: ReturnType<typeof mountDialog>) {
    const cards = wrapper.findAll(".model-family-card");
    expect(cards).toHaveLength(5);
    await cards[2].trigger("click");
    expect(wrapper.text()).toContain("GitHub Copilot");
    await wrapper.find(".primary-action").trigger("click");
    await flushPromises();
  }

  it("shows managed providers, Copilot, custom setup, and a first-time local entry", () => {
    const wrapper = mountDialog();
    const cards = wrapper.findAll(".model-family-card");
    expect(cards.map((card) => card.text())).toEqual([
      "千问",
      "MiniMax",
      "GitHub Copilot",
      "Other model",
      "Local model",
    ]);
    expect(cards[2].findAll(".family-icon img")).toHaveLength(1);
    const copilotLogo = decodeURIComponent(
      cards[2].find(".family-icon img").attributes("src") ?? "",
    );
    expect(copilotLogo).toContain("viewBox='0 0 128 128'");
    expect(copilotLogo).toContain("fill='black'");
    expect(wrapper.text()).not.toContain("OpenClaw catalog");
  });

  it("edits a custom connection inline without inference or changing the default and preserves its ID", async () => {
    const config = {
      models: {
        providers: {
          private: {
            baseUrl: "https://old.example/v1",
            apiKey: "existing-key",
            models: [{ id: "model", name: "My model", input: ["text", "image"], reasoning: true }],
          },
          cloud: { models: [{ id: "default" }] },
        },
      },
      agents: {
        defaults: {
          model: { primary: "cloud/default", fallbacks: ["private/model"] },
          models: { "private/model": {}, "cloud/default": {} },
        },
      },
    };
    read.mockResolvedValue(config);
    const wrapper = mountDialog({
      inline: true,
      manageOnly: true,
      currentProvider: {
        familyId: "custom",
        providerKey: "private",
        modelName: "model",
        displayName: "My model",
        baseUrl: "https://new.example/v1",
        apiKey: "existing-key",
        apiFormat: "openai-chat",
        reasoningEffort: "low",
        input: ["text", "image"],
      },
    });
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(wrapper.find('[role="region"]').exists()).toBe(true);
    await wrapper.get(".primary-action").trigger("mousedown");
    await flushPromises();
    await vi.runAllTimersAsync();
    expect(testConnection).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
    const saved = write.mock.calls[0][0];
    expect(write.mock.calls[0][1]).toEqual(config);
    expect(saved.models.providers.private.baseUrl).toBe("https://new.example/v1");
    expect(saved.models.providers.custom).toBeUndefined();
    expect(saved.models.providers.private.models[0].input).toEqual(["text", "image"]);
    expect(saved.models.providers.private.models[0].reasoning).toBe(true);
    expect(saved.agents).toEqual(config.agents);
    wrapper.unmount();
  });

  it("opens the local dialog from the family grid without starting an operation", async () => {
    const wrapper = mountDialog();
    await wrapper.findAll(".model-family-card")[4].trigger("click");
    expect(wrapper.find(".primary-action").text()).toBe("Set up a local model");
    await wrapper.find(".primary-action").trigger("click");
    await flushPromises();
    expect(wrapper.find(".local-model-panel").exists()).toBe(true);
    expect(testConnection).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("adds a new model from an inline editor without renaming existing session/default references", async () => {
    const config = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://127.0.0.1:1234/v1",
            models: [{ id: "old", name: "Existing model" }],
          },
        },
      },
      agents: { defaults: { model: { primary: "custom/old", fallbacks: ["custom/old"] } } },
    };
    read.mockResolvedValue(config);
    const wrapper = mountDialog({
      inline: true,
      manageOnly: true,
      currentProvider: {
        familyId: "custom",
        providerKey: "custom",
        modelName: "old",
        displayName: "Existing model",
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "",
        apiFormat: "openai-chat",
      },
    });
    await flushPromises();
    await wrapper.findAll("input")[1].setValue("new-model");
    await wrapper.get(".primary-action").trigger("keydown", { key: "Enter" });
    await flushPromises();
    await vi.runAllTimersAsync();
    expect(testConnection).not.toHaveBeenCalled();
    const saved = write.mock.calls[0][0];
    expect(saved.agents).toEqual(config.agents);
    expect(saved.models.providers.custom.models.map((model: { id: string }) => model.id)).toEqual([
      "old",
      "new-model",
    ]);
    wrapper.unmount();
  });

  it("opens directly on the requested GitHub Copilot recovery form", async () => {
    const wrapper = mountDialog({ initialFamily: "github-copilot" });
    await flushPromises();

    expect(wrapper.find(".model-key-form").exists()).toBe(true);
    expect(wrapper.text()).toContain("GitHub Copilot");
    expect(getGitHubCopilotStatus).toHaveBeenCalledOnce();
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
    const wrapper = mountDialog({ singleProvider: true });

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

  it("keeps cloud, official local-service fields, and Copilot authentication when adding a connection", async () => {
    const retained = {
      cloud: { models: [{ id: "remote" }], unknown: true },
      "llama-cpp": { localService: { managed: true }, models: [{ id: "local" }] },
    };
    const auth = {
      profiles: { "github-copilot:github": { provider: "github-copilot", mode: "token" } },
    };
    read.mockResolvedValue({
      models: { providers: retained },
      auth,
      agents: { defaults: { models: { "github-copilot/gpt-5.4": { alias: "Copilot" } } } },
    });
    const wrapper = mountDialog({ singleProvider: true });
    await wrapper.find(".text-action").trigger("click");
    await wrapper.findAll("input")[1].setValue("new-key");
    await wrapper.find(".primary-action").trigger("mousedown");
    await flushPromises();
    await vi.runAllTimersAsync();
    const next = write.mock.calls[0][0];
    expect(write.mock.calls[0][1]).toBe(await read.mock.results.at(-1)!.value);
    expect(next.models.providers).toMatchObject(retained);
    expect(next.auth).toEqual(auth);
    expect(next.agents.defaults.models["github-copilot/gpt-5.4"]).toEqual({ alias: "Copilot" });
  });

  it("does not use generic configuration for the official llama-cpp provider", async () => {
    const wrapper = mountDialog();
    await openCustomForm(wrapper);
    await wrapper.findAll("input")[0].setValue("llama-cpp");
    await wrapper.find(".key-actions .primary-action").trigger("mousedown");
    await flushPromises();
    expect(wrapper.find(".local-model-panel").exists()).toBe(true);
    expect(testConnection).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps configured providers when choosing an authenticated Copilot model in the legacy single-provider flow", async () => {
    const providers = {
      "llama-cpp": { models: [{ id: "saved" }], localService: { managed: true } },
      cloud: { models: [{ id: "remote" }] },
    };
    read.mockResolvedValue({ models: { providers } });
    getGitHubCopilotStatus.mockResolvedValue({ authenticated: true });
    listGitHubCopilotModels.mockResolvedValue([{ id: "github-copilot/gpt-5.4", name: "GPT 5.4" }]);
    const wrapper = mountDialog({ initialFamily: "github-copilot", singleProvider: true });
    await flushPromises();
    await wrapper.find("select").setValue("github-copilot/gpt-5.4");
    await wrapper.find(".key-actions .primary-action").trigger("mousedown");
    await flushPromises();
    await vi.runAllTimersAsync();
    expect(write.mock.calls[0][0].models.providers).toEqual(providers);
    expect(write.mock.calls[0][1]).toEqual({ models: { providers } });
  });

  it("uses the original missing-config snapshot for a first cloud setup", async () => {
    read.mockResolvedValue(null);
    const wrapper = mountDialog();
    await wrapper.find(".text-action").trigger("click");
    await wrapper.findAll("input")[1].setValue("new-key");
    await wrapper.find(".primary-action").trigger("mousedown");
    await flushPromises();
    await vi.runAllTimersAsync();
    expect(write.mock.calls[0][1]).toBeNull();
  });

  it("surfaces a stale config rejection without restarting or claiming configuration success", async () => {
    write.mockRejectedValueOnce(new Error("Configuration changed; reload before saving"));
    const wrapper = mountDialog();
    await wrapper.find(".text-action").trigger("click");
    await wrapper.findAll("input")[1].setValue("new-key");
    await wrapper.find(".primary-action").trigger("mousedown");
    await flushPromises();
    expect(wrapper.text()).toContain("Configuration changed; reload before saving");
    expect(restart).not.toHaveBeenCalled();
    expect(wrapper.emitted("configured")).toBeUndefined();
  });

  it("warns before setup when the default agent has a model override", async () => {
    read.mockResolvedValue({ agents: { list: [{ id: "main", model: "cloud/override" }] } });
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.get('[data-testid="default-agent-override"]').text()).toContain(
      "Changing the global default does not change this override",
    );
    expect(wrapper.text()).toContain("cloud/override");
    expect(write).not.toHaveBeenCalled();
  });

  it("blocks cloud setup while a reply is streaming", async () => {
    const wrapper = mountDialog({ streaming: true });
    await wrapper.find(".text-action").trigger("click");
    await wrapper.findAll("input")[1].setValue("new-key");
    expect(wrapper.find(".key-actions .primary-action").attributes("disabled")).toBeDefined();
    await wrapper.find(".key-actions .primary-action").trigger("mousedown");
    expect(testConnection).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps cloud configuration usable and cancels local setup only after valid connection and consent", async () => {
    const local = createBrowserOpenClawMock().model.local;
    const active: LocalModelOperation = {
      id: "pending-local",
      kind: "prepare",
      phase: "step",
      agentId: "main",
      busy: true,
      cancellationPending: false,
    };
    local.getOperation = vi.fn().mockResolvedValue({ ok: true, value: active });
    local.cancel = vi.fn(async () => {
      const done = { ...active, phase: "cancelled" as const, busy: false };
      vi.mocked(local.getOperation).mockResolvedValue({ ok: true, value: done });
      return { ok: true as const, value: done };
    });
    window.openclaw.model.local = local;
    const confirmation = vi.spyOn(ElMessageBox, "confirm").mockResolvedValue("confirm" as never);
    try {
      const wrapper = mountDialog();
      await openCustomForm(wrapper);
      await flushPromises();
      expect(wrapper.get(".model-setup-close").attributes("disabled")).toBeUndefined();
      expect(wrapper.get(".key-actions .primary-action").attributes("disabled")).toBeUndefined();
      expect(local.cancel).not.toHaveBeenCalled();
      const inputs = wrapper.findAll("input");
      await inputs[0].setValue("cloud-new");
      await inputs[1].setValue("model");
      await inputs[2].setValue("https://model.example/v1");
      await inputs[3].setValue("key");
      await wrapper.get(".key-actions .primary-action").trigger("mousedown");
      await flushPromises();
      await vi.runAllTimersAsync();
      expect(testConnection).toHaveBeenCalledBefore(vi.mocked(local.cancel));
      expect(local.cancel).toHaveBeenCalledExactlyOnceWith("pending-local");
      expect(write).toHaveBeenCalledOnce();
      expect(wrapper.emitted("configured")).toHaveLength(1);
      wrapper.unmount();
    } finally {
      confirmation.mockRestore();
    }
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

  it("cannot close after configuration is written until the Gateway restart finishes", async () => {
    const restartPending = deferred<void>();
    restart.mockReturnValueOnce(restartPending.promise);
    const wrapper = mountDialog();
    await openCustomForm(wrapper);
    const inputs = wrapper.findAll("input");

    await inputs[0].setValue("ollama");
    await inputs[1].setValue("llama3.2");
    await inputs[2].setValue("http://localhost:11434");
    await wrapper.find(".key-actions .primary-action").trigger("mousedown");
    await flushPromises();

    expect(write).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledOnce();
    expect(wrapper.find(".model-setup-close").attributes("disabled")).toBeDefined();
    await wrapper.find(".model-setup-close").trigger("click");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();

    restartPending.resolve();
    await flushPromises();
    await vi.runAllTimersAsync();
    await flushPromises();

    expect(wrapper.emitted("update:modelValue")).toEqual([[false]]);
    expect(wrapper.emitted("configured")).toHaveLength(1);
  });
});
