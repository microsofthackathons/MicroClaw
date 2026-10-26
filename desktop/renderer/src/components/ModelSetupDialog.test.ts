import { defineComponent } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElMessageBox } from "element-plus";
import { createBrowserOpenClawMock } from "@/browser-openclaw";
import { setLocale } from "@/i18n";
import type { LocalModelOperation } from "../../../src/local-model-types";
import { MANAGED_MODEL_PROVIDERS } from "@/utils/managed-model-providers";
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
  const discoverModels = vi.fn();
  const registerCatalogModel = vi.fn();
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
    discoverModels.mockResolvedValue({
      ok: true,
      models: ["qwen", "qwen3.7-plus", "MiniMax-M3", "MiniMax-M1"],
    });
    registerCatalogModel.mockResolvedValue(undefined);
    prepareGitHubCopilot.mockResolvedValue({ restartRequired: false });
    startGitHubCopilotLogin.mockResolvedValue({ sessionId: "copilot-session" });
    cancelGitHubCopilotLogin.mockResolvedValue({ cancelled: true });
    getGitHubCopilotStatus.mockResolvedValue({ authenticated: false });
    listGitHubCopilotModels.mockResolvedValue([]);
    githubCopilotLoginListener = undefined;
    window.openclaw = {
      features: { githubCopilot: true },
      config: { read, write },
      gateway: { restart },
      model: {
        discoverModels,
        registerCatalogModel,
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
    setLocale("en-US");
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it.each([
    ["recovery", undefined],
    ["saved provider", undefined],
    ["recovery", false],
    ["saved provider", false],
  ] as const)("hides Copilot for %s with feature capability %s", async (entry, githubCopilot) => {
    window.openclaw = {
      ...window.openclaw,
      features: githubCopilot === undefined ? undefined : { githubCopilot },
    } as unknown as OpenClawAPI;
    const props =
      entry === "recovery"
        ? { initialFamily: "github-copilot" as const }
        : {
            currentProvider: {
              familyId: "github-copilot",
              providerKey: "github-copilot",
              modelName: "gpt-5",
              baseUrl: "",
              apiKey: "",
              apiFormat: "openai-chat" as const,
            },
          };
    const wrapper = mountDialog(props);
    await flushPromises();
    expect(wrapper.findAll(".model-family-card")).toHaveLength(3);
    expect(wrapper.text()).not.toContain("GitHub Copilot");
    expect(getGitHubCopilotStatus).not.toHaveBeenCalled();
    expect(prepareGitHubCopilot).not.toHaveBeenCalled();
    expect(startGitHubCopilotLogin).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  async function openCustomForm(wrapper: ReturnType<typeof mountDialog>) {
    const cards = wrapper.findAll(".model-family-card");
    expect(cards).toHaveLength(4);
    await wrapper.setProps({ modelValue: false });
    await wrapper.setProps({ modelValue: true, initialFamily: "custom" });
    expect(wrapper.find(".model-key-form").exists()).toBe(true);
  }

  async function enterCloudKey(wrapper: ReturnType<typeof mountDialog>) {
    await wrapper.findAll("input")[1].setValue("new-key");
    await vi.advanceTimersByTimeAsync(600);
    await flushPromises();
    await wrapper.get("select").setValue("qwen3.7-plus");
  }

  async function openGitHubCopilotForm(wrapper: ReturnType<typeof mountDialog>) {
    const cards = wrapper.findAll(".model-family-card");
    expect(cards).toHaveLength(4);
    await cards[2].trigger("click");
    expect(wrapper.text()).toContain("GitHub Copilot");
    await wrapper.find(".primary-action").trigger("click");
    await flushPromises();
  }

  it("shows managed providers, Copilot, and a first-time local entry", () => {
    const wrapper = mountDialog();
    const cards = wrapper.findAll(".model-family-card");
    expect(cards.map((card) => card.text())).toEqual([
      "千问",
      "MiniMax",
      "GitHub Copilot",
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

  it.each(["en-US", "zh-CN"] as const)(
    "only offers Qwen, MiniMax, and local setup in %s",
    (locale) => {
      setLocale(locale);
      window.openclaw = { ...window.openclaw, features: { githubCopilot: false } };
      const wrapper = mountDialog();
      const cards = wrapper.findAll(".model-family-card");
      expect(cards.map((card) => card.text())).toEqual([
        "千问",
        "MiniMax",
        locale === "zh-CN" ? "本地模型" : "Local model",
      ]);
      expect(wrapper.text()).not.toMatch(/Other model|其他模型|OpenClaw catalog/);
      wrapper.unmount();
    },
  );

  it.each([
    ["qwen", "千问"],
    ["minimax", "MiniMax"],
  ] as const)(
    "keeps the inline %s editor focused on fields without duplicate dialog chrome",
    async (family, label) => {
      const wrapper = mountDialog({ inline: true, manageOnly: true, initialFamily: family });
      await flushPromises();
      const panel = wrapper.get('[role="region"]');
      expect(panel.attributes("aria-label")).toBe(label);
      expect(panel.find("h2").exists()).toBe(false);
      expect(panel.find(".model-setup-desc").exists()).toBe(false);
      expect(panel.find(".model-setup-close").exists()).toBe(false);
      expect(panel.element.firstElementChild?.classList.contains("model-key-form")).toBe(true);
      expect(panel.find('[data-testid="provider-key-field"]').exists()).toBe(true);
      expect(panel.find('[data-testid="provider-model-field"]').exists()).toBe(true);
      wrapper.unmount();
    },
  );

  it("retains the title, instructions and close button for standalone setup", async () => {
    const wrapper = mountDialog({ initialFamily: "qwen" });
    await wrapper.get(".text-action").trigger("click");
    const panel = wrapper.get('[role="dialog"]');
    expect(panel.get("h2").text()).not.toBe("");
    expect(panel.get(".model-setup-desc").text()).not.toBe("");
    await panel.get(".model-setup-close").trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([[false]]);
    wrapper.unmount();
  });

  it("keeps realtime models in the full catalog but disables their use for chat", async () => {
    const realtime = "qwen3.8-omni-flash-realtime";
    discoverModels.mockResolvedValue({ ok: true, models: ["qwen3.7-plus", realtime] });
    const wrapper = mountDialog({
      inline: true,
      manageOnly: true,
      currentProvider: {
        familyId: "qwen",
        providerKey: "qwen",
        modelName: realtime,
        baseUrl: MANAGED_MODEL_PROVIDERS[0].baseUrl,
        apiKey: "fixture",
        apiFormat: "openai-chat",
      },
    });
    await vi.advanceTimersByTimeAsync(600);
    await flushPromises();
    expect(wrapper.findAll("option")).toHaveLength(2);
    expect(wrapper.get(`option[value="${realtime}"]`).attributes("disabled")).toBeDefined();
    expect(wrapper.get(`option[value="${realtime}"]`).text()).toContain("Requires realtime API");
    expect(wrapper.get(".primary-action").attributes("disabled")).toBeDefined();
    await wrapper.get(".primary-action").trigger("click");
    expect(write).not.toHaveBeenCalled();
    expect(registerCatalogModel).not.toHaveBeenCalled();
    await wrapper.get("select").setValue("qwen3.7-plus");
    expect(wrapper.get(".primary-action").attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it.each([false, true])(
    "does not restart or rewrite a connection when only its model changes (failure: %s)",
    async (fail) => {
      const baseUrl = MANAGED_MODEL_PROVIDERS[0].baseUrl;
      const config = {
        models: {
          providers: {
            qwen: {
              baseUrl,
              apiKey: "existing-key",
              api: "openai-completions",
              models: [{ id: "qwen", name: "Qwen" }],
            },
          },
        },
        agents: { defaults: { model: { primary: "qwen/qwen" } } },
      };
      read.mockResolvedValue(config);
      if (fail)
        registerCatalogModel.mockRejectedValueOnce(new Error("Catalog could not be applied"));
      const wrapper = mountDialog({
        inline: true,
        manageOnly: true,
        currentProvider: {
          familyId: "qwen",
          providerKey: "qwen",
          modelName: "qwen",
          baseUrl,
          apiKey: "existing-key",
          apiFormat: "openai-chat",
        },
      });
      await vi.advanceTimersByTimeAsync(600);
      await flushPromises();
      await wrapper.get("select").setValue("qwen3.7-plus");
      await wrapper.get(".primary-action").trigger("click");
      await flushPromises();
      expect(registerCatalogModel).toHaveBeenCalledWith({
        modelRef: "qwen/qwen3.7-plus",
        expectedConfig: config,
      });
      expect(write).not.toHaveBeenCalled();
      expect(restart).not.toHaveBeenCalled();
      if (fail) {
        expect(wrapper.text()).toContain("Catalog could not be applied");
        expect(wrapper.emitted("configured")).toBeUndefined();
      } else expect(wrapper.emitted("configured")).toHaveLength(1);
      wrapper.unmount();
    },
  );

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
    await wrapper.get(".primary-action").trigger("click");
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
    await wrapper.findAll(".model-family-card")[3].trigger("click");
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
    expect(openExternal.mock.calls[0][0]).toBe(
      MANAGED_MODEL_PROVIDERS.find((provider) => provider.id === "minimax")!.signupUrl,
    );
    expect(wrapper.find(".model-key-form").exists()).toBe(true);
  });

  it.each(MANAGED_MODEL_PROVIDERS)(
    "opens $id signup from its inline editor without losing input, then saves without inference",
    async (provider) => {
      const before = {
        gateway: { port: 18789 },
        agents: { defaults: { model: { primary: "cloud/keep" } } },
        models: { providers: { cloud: { models: [{ id: "keep" }] } } },
      };
      read.mockResolvedValue(before);
      const wrapper = mountDialog({
        inline: true,
        manageOnly: true,
        initialFamily: provider.id,
      });
      await flushPromises();
      const model = provider.models.find((item) => item.id !== provider.defaultModel)!;
      await wrapper.get('input[placeholder="sk-..."]').setValue("sk-test-fixture");
      await vi.advanceTimersByTimeAsync(600);
      await flushPromises();
      await wrapper.get("select").setValue(model.id);
      await wrapper.get(".provider-api-key-link").trigger("click");
      await flushPromises();
      expect(openExternal).toHaveBeenCalledWith(provider.signupUrl);
      expect((wrapper.get("select").element as HTMLSelectElement).value).toBe(model.id);
      expect((wrapper.get('input[placeholder="sk-..."]').element as HTMLInputElement).value).toBe(
        "sk-test-fixture",
      );
      expect(write).not.toHaveBeenCalled();
      await wrapper.get(".primary-action").trigger("click");
      await flushPromises();
      await vi.runAllTimersAsync();
      expect(write).toHaveBeenCalledOnce();
      const saved = write.mock.calls[0][0];
      expect(saved.models.providers[provider.id].baseUrl).toBe(provider.baseUrl);
      expect(saved.models.providers[provider.id].models[0].id).toBe(model.id);
      expect(saved.models.providers.cloud).toEqual(before.models.providers.cloud);
      expect(saved.agents.defaults.model).toEqual(before.agents.defaults.model);
      expect(testConnection).not.toHaveBeenCalled();
      expect(restart).toHaveBeenCalledOnce();
      wrapper.unmount();
    },
  );

  it("surfaces failures opening a provider website", async () => {
    openExternal.mockRejectedValueOnce(new Error("Browser unavailable"));
    const wrapper = mountDialog({ inline: true, manageOnly: true, initialFamily: "minimax" });
    await flushPromises();
    await wrapper.get(".provider-api-key-link").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Could not open the provider website: Browser unavailable");
    expect(write).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("disables model selection until a key fetch returns live IDs", async () => {
    discoverModels.mockResolvedValue({ ok: true, models: ["account-model-2026"] });
    const wrapper = mountDialog({ inline: true, manageOnly: true, initialFamily: "qwen" });
    await flushPromises();
    expect(wrapper.get("select").attributes("disabled")).toBeDefined();
    expect(wrapper.findAll("option")).toHaveLength(0);
    expect(discoverModels).not.toHaveBeenCalled();
    await wrapper.get('input[placeholder="sk-..."]').setValue("fixture-key");
    await vi.advanceTimersByTimeAsync(600);
    await flushPromises();
    expect(discoverModels).toHaveBeenCalledWith({
      baseUrl: MANAGED_MODEL_PROVIDERS[0].baseUrl,
      apiKey: "fixture-key",
    });
    expect(wrapper.get("select").attributes("disabled")).toBeUndefined();
    expect(wrapper.findAll("option").map((o) => o.attributes("value"))).toEqual([
      "account-model-2026",
    ]);
    expect(wrapper.get(".primary-action").attributes("disabled")).toBeDefined();
    await wrapper.get("select").setValue("account-model-2026");
    expect(wrapper.get(".primary-action").attributes("disabled")).toBeUndefined();
    expect(testConnection).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it.each(["qwen", "minimax"] as const)(
    "places %s credentials before models with adjacent key and refresh actions",
    async (provider) => {
      const response = deferred<{ ok: true; models: string[] }>();
      discoverModels.mockReturnValueOnce(response.promise);
      const wrapper = mountDialog({ inline: true, manageOnly: true, initialFamily: provider });
      await flushPromises();
      const fields = wrapper
        .findAll('[data-testid$="-field"]')
        .map((field) => field.attributes("data-testid"));
      expect(fields).toEqual(["provider-base-field", "provider-key-field", "provider-model-field"]);
      const keyRow = wrapper.get('[data-testid="provider-key-field"] .model-field-row');
      expect(keyRow.findAll("input")).toHaveLength(1);
      expect(keyRow.get(".provider-api-key-link").text()).toBe("Get API Key");
      const modelRow = wrapper.get('[data-testid="provider-model-field"] .model-field-row');
      expect(modelRow.find("select").exists()).toBe(true);
      const refresh = modelRow.get('[data-testid="refresh-provider-models"]');
      expect(refresh.text()).toBe("");
      expect(refresh.attributes("aria-label")).toBe("Refresh model list");
      expect(refresh.attributes("title")).toBe("Refresh model list");
      expect(refresh.attributes("disabled")).toBeDefined();
      await keyRow.get("input").setValue("fixture-key");
      await vi.advanceTimersByTimeAsync(600);
      expect(refresh.attributes("aria-busy")).toBe("true");
      expect(refresh.get("svg").classes()).toContain("refresh-spinning");
      expect(refresh.attributes("disabled")).toBeDefined();
      response.resolve({ ok: true, models: ["remote-model"] });
      await flushPromises();
      expect(refresh.attributes("aria-busy")).toBe("false");
      expect(refresh.attributes("disabled")).toBeUndefined();
      await refresh.trigger("click");
      await flushPromises();
      expect(discoverModels).toHaveBeenCalledTimes(2);
      expect(write).not.toHaveBeenCalled();
      wrapper.unmount();
    },
  );

  it("discards a stale key's response and never falls back to presets on auth failure", async () => {
    const first = deferred<{ ok: true; models: string[] }>();
    discoverModels
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ok: false, error: "authentication" });
    const wrapper = mountDialog({ inline: true, manageOnly: true, initialFamily: "qwen" });
    await flushPromises();
    await wrapper.get('input[placeholder="sk-..."]').setValue("old-key");
    await vi.advanceTimersByTimeAsync(600);
    await wrapper.get('input[placeholder="sk-..."]').setValue("new-key");
    await vi.advanceTimersByTimeAsync(600);
    first.resolve({ ok: true, models: ["stale-model"] });
    await flushPromises();
    expect(wrapper.findAll("option")).toHaveLength(0);
    expect(wrapper.get("select").attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("provider rejected the API key");
    await wrapper.get(".primary-action").trigger("keydown", { key: "Enter" });
    expect(write).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("invalidates a fetched catalog immediately when the key is cleared", async () => {
    const wrapper = mountDialog({ inline: true, manageOnly: true, initialFamily: "minimax" });
    await flushPromises();
    await wrapper.get('input[placeholder="sk-..."]').setValue("fixture");
    await vi.advanceTimersByTimeAsync(600);
    await wrapper.get("select").setValue("MiniMax-M3");
    expect(wrapper.get(".primary-action").attributes("disabled")).toBeUndefined();
    await wrapper.get('input[placeholder="sk-..."]').setValue("");
    expect(wrapper.get("select").attributes("disabled")).toBeDefined();
    expect(wrapper.findAll("option")).toHaveLength(0);
    await wrapper.get(".primary-action").trigger("keydown", { key: "Enter" });
    expect(write).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("never reuses one provider's key when switching to another provider", async () => {
    const wrapper = mountDialog();
    await wrapper.find(".text-action").trigger("click");
    await wrapper.get('input[placeholder="sk-..."]').setValue("qwen-only-key");
    await vi.advanceTimersByTimeAsync(600);
    expect(discoverModels).toHaveBeenCalledOnce();
    await wrapper.get(".text-action--back").trigger("click");
    await wrapper.findAll(".model-family-card")[1].trigger("click");
    await wrapper.find(".text-action").trigger("click");
    await vi.advanceTimersByTimeAsync(600);
    expect(discoverModels).toHaveBeenCalledOnce();
    expect((wrapper.get('input[placeholder="sk-..."]').element as HTMLInputElement).value).toBe("");
    expect(wrapper.get("select").attributes("disabled")).toBeDefined();
    wrapper.unmount();
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
    await enterCloudKey(wrapper);
    await wrapper.find(".primary-action").trigger("click");
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
    await enterCloudKey(wrapper);
    await wrapper.find(".primary-action").trigger("click");
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
    await wrapper.find(".key-actions .primary-action").trigger("click");
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
    await wrapper.find(".key-actions .primary-action").trigger("click");
    await flushPromises();
    await vi.runAllTimersAsync();
    expect(write.mock.calls[0][0].models.providers).toEqual(providers);
    expect(write.mock.calls[0][1]).toEqual({ models: { providers } });
  });

  it("uses the original missing-config snapshot for a first cloud setup", async () => {
    read.mockResolvedValue(null);
    const wrapper = mountDialog();
    await wrapper.find(".text-action").trigger("click");
    await enterCloudKey(wrapper);
    await wrapper.find(".primary-action").trigger("click");
    await flushPromises();
    await vi.runAllTimersAsync();
    expect(write.mock.calls[0][1]).toBeNull();
  });

  it("surfaces a stale config rejection without restarting or claiming configuration success", async () => {
    write.mockRejectedValueOnce(new Error("Configuration changed; reload before saving"));
    const wrapper = mountDialog();
    await wrapper.find(".text-action").trigger("click");
    await enterCloudKey(wrapper);
    await wrapper.find(".primary-action").trigger("click");
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
    await wrapper.find(".key-actions .primary-action").trigger("click");
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
      await wrapper.get(".key-actions .primary-action").trigger("click");
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

  it("retains existing custom connection fields but returns to the supported picker", async () => {
    const wrapper = mountDialog({
      currentProvider: {
        familyId: "custom",
        providerKey: "private",
        modelName: "my-model",
        baseUrl: "https://model.example/v1",
        apiKey: "",
        apiFormat: "openai-chat",
      },
    });

    expect(wrapper.text()).toContain("Provider ID");
    expect(wrapper.text()).toContain("API Format");
    expect(wrapper.text()).toContain("API KEY (OPTIONAL)");
    await wrapper.get(".text-action--back").trigger("click");
    expect(wrapper.findAll(".model-family-card").map((card) => card.text())).toEqual([
      "千问",
      "MiniMax",
      "GitHub Copilot",
      "Local model",
    ]);
    expect(wrapper.findAll(".model-family-card")[0].classes()).toContain("active");
    expect(wrapper.find(".primary-action").text()).toBe("Get API Key");
    expect(wrapper.text()).not.toContain("Configure custom provider");
    wrapper.unmount();
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
    await wrapper.find(".primary-action").trigger("click");
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

    await wrapper.find(".primary-action").trigger("click");
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
    await wrapper.find(".primary-action").trigger("click");
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
    await wrapper.find(".key-actions .primary-action").trigger("click");
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
    await wrapper.find(".key-actions .primary-action").trigger("click");
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
    await wrapper.find(".key-actions .primary-action").trigger("click");
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
