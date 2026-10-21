import { defineComponent } from "vue";
import { createPinia } from "pinia";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElMessage, ElMessageBox } from "element-plus";
import { createBrowserOpenClawMock } from "@/browser-openclaw";
import { useChatStore } from "@/stores/chat";
import { setLocale } from "@/i18n";
import LocalModelSetupDialog from "@/components/LocalModelSetupDialog.vue";
import SettingsView from "./SettingsView.vue";
import type { LocalModelOperation } from "../../../src/local-model-types";
import { LOCAL_MODEL_PRESETS } from "../../../src/local-model-catalog";
import LocalModelDownloadDialog from "@/components/LocalModelDownloadDialog.vue";
import DefaultModelPicker from "@/components/DefaultModelPicker.vue";
import SessionModelRecoveryNotice from "@/components/SessionModelRecoveryNotice.vue";
import { selectPrimaryModelConfig } from "@/utils/model-provider";

vi.mock("vue-router", () => ({ useRoute: () => ({ params: { section: "models" } }) }));

const SelectStub = defineComponent({
  props: ["modelValue", "disabled"],
  emits: ["change", "update:modelValue"],
  template:
    '<select :value="modelValue" :disabled="disabled" @change="$emit(\'change\', $event.target.value)"><slot /></select>',
});
const OptionStub = defineComponent({
  props: ["value", "label"],
  template: '<option :value="value">{{ label }}</option>',
});
const ButtonStub = defineComponent({
  props: ["disabled"],
  template: '<button :disabled="disabled"><slot /></button>',
});
const DefaultPickerStub = defineComponent({
  props: ["modelValue", "models", "disabled"],
  emits: ["change"],
  template: `<select :value="modelValue" :disabled="disabled" @change="$emit('change', $event.target.value)">
    <option v-for="model in models" :key="model.providerKey + '/' + model.id" :value="model.providerKey + '/' + model.id">{{ model.name }}</option>
  </select>`,
});
const PopoverStub = defineComponent({
  props: { visible: Boolean },
  emits: ["update:visible"],
  template: `<div><div @click="$emit('update:visible', !visible)"><slot name="reference" /></div><div v-show="visible"><slot /></div></div>`,
});

describe("SettingsView model integration", () => {
  let config: Record<string, any>;
  let listener: (operation: LocalModelOperation) => void;
  let write: ReturnType<typeof vi.fn<(config: any, expectedConfig?: any) => Promise<void>>>;
  const wrappers: Array<ReturnType<typeof shallowMount>> = [];
  beforeEach(() => {
    vi.useFakeTimers();
    setLocale("en-US");
    config = {
      models: {
        mode: "merge",
        providers: {
          cloud: { models: [{ id: "remote", name: "Cloud" }], apiKey: "key" },
          "llama-cpp": {
            models: [{ id: "saved", name: "Saved local" }],
            localService: { ownership: "official" },
            unknown: { keep: true },
          },
        },
      },
      auth: { profiles: { copilot: { provider: "github-copilot", mode: "token" } } },
      agents: {
        defaults: {
          model: { primary: "llama-cpp/saved" },
          models: { "github-copilot/gpt-5.4": { alias: "Copilot" } },
        },
        list: [{ id: "separate", model: "cloud/remote" }],
      },
      memory: { provider: "existing" },
    };
    const api = createBrowserOpenClawMock();
    Object.assign(api.features, { githubCopilot: true });
    api.config.read = vi.fn(async () => structuredClone(config));
    write = vi.fn(async (next) => {
      config = structuredClone(next);
    });
    api.config.write = write;
    api.gateway.restart = vi.fn().mockResolvedValue(undefined);
    api.model.selectDefault = vi.fn(async ({ modelRef }) => {
      config = selectPrimaryModelConfig(config, modelRef);
      return { modelRef };
    });
    api.model.session.select = vi.fn();
    api.model.local.getOperation = vi.fn().mockResolvedValue({ ok: true, value: null });
    api.model.local.onEvent = vi.fn((callback) => {
      listener = callback;
      return () => {};
    });
    window.openclaw = api;
  });
  afterEach(() => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  async function open(realPicker = false, realLocalFlow = false) {
    const pinia = createPinia();
    const wrapper = shallowMount(SettingsView, {
      attachTo: document.body,
      global: {
        plugins: [pinia],
        stubs: {
          "el-select": SelectStub,
          "el-option": OptionStub,
          "el-button": ButtonStub,
          DefaultModelPicker: realPicker ? false : DefaultPickerStub,
          LocalModelDownloadDialog: !realLocalFlow,
          ModelProviderGroups: false,
          "el-popover": PopoverStub,
        },
      },
    });
    wrappers.push(wrapper);
    await flushPromises();
    return { wrapper, chat: useChatStore(pinia) };
  }

  it("hides disabled Copilot cards and saved models without reading authentication or deleting configuration", async () => {
    Object.assign(window.openclaw.features, { githubCopilot: false });
    window.openclaw.model.getGitHubCopilotStatus = vi.fn();
    window.openclaw.model.listGitHubCopilotModels = vi.fn();
    const original = structuredClone(config);
    const { wrapper } = await open(true);
    expect(wrapper.find('[data-provider="github-copilot"]').exists()).toBe(false);
    expect(wrapper.find('[data-provider-group="github-copilot"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("GitHub Copilot");
    expect(window.openclaw.model.getGitHubCopilotStatus).not.toHaveBeenCalled();
    expect(window.openclaw.model.listGitHubCopilotModels).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(config).toEqual(original);
  });

  it("exposes the shared recovery entry and blocks default changes until saved state is confirmed", async () => {
    const { wrapper } = await open();
    const recovery = wrapper.getComponent(SessionModelRecoveryNotice);
    recovery.vm.$emit("state", {
      id: "unknown",
      requiresRestart: true,
      recovering: false,
      canRecover: true,
    });
    await flushPromises();
    expect(wrapper.get("select.model-picker-select").attributes("disabled")).toBeDefined();
    wrapper.getComponent(DefaultPickerStub).vm.$emit("change", "cloud/remote");
    await flushPromises();
    expect(window.openclaw.model.selectDefault).not.toHaveBeenCalled();
    recovery.vm.$emit("state", null);
    recovery.vm.$emit("recovered");
    await flushPromises();
    expect(wrapper.get("select.model-picker-select").attributes("disabled")).toBeUndefined();
  });

  it("switches a prepared local default inline and confirms the selection instead of provider setup", async () => {
    const preset = LOCAL_MODEL_PRESETS[0];
    config.models.providers["llama-cpp"].models.push({
      id: preset.modelRef.slice("llama-cpp/".length),
      name: preset.name,
    });
    const original = structuredClone(config);
    window.openclaw.model.local.getCapabilities = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        supported: true,
        mutable: true,
        blockers: [],
        gatewayVersion: "2026.9.3",
        plugin: { installed: true, enabled: true, canInstall: false },
      },
    });
    window.openclaw.model.local.getSnapshot = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        models: [{ modelRef: preset.modelRef, name: preset.name, fileStatus: "present" }],
        catalog: [{ ...preset, configured: true, fileStatus: "present" }],
      },
    });
    let finishSelection!: (value: LocalModelOperation) => void;
    const selectionPending = new Promise<LocalModelOperation>((resolve) => {
      finishSelection = resolve;
    });
    window.openclaw.model.local.activate = vi.fn(async () => ({
      ok: true as const,
      value: await selectionPending,
    }));
    const success = vi.spyOn(ElMessage, "success");
    const { wrapper } = await open(true, true);
    const picker = wrapper.getComponent(DefaultModelPicker);
    await picker.get('[data-testid="default-model-picker"]').trigger("click");
    await picker.get(`[data-model-ref="${preset.modelRef}"]`).trigger("click");
    await flushPromises();
    expect(picker.get('[data-testid="default-model-picker"]').text()).toContain("Switching...");
    expect(picker.get('[data-testid="default-model-picker"]').attributes("disabled")).toBeDefined();
    expect(document.body.querySelector(".download-overlay")).toBeNull();
    expect(window.openclaw.model.local.activate).toHaveBeenCalledExactlyOnceWith({
      kind: "existing-model",
      modelRef: preset.modelRef,
    });
    expect(config).toEqual(original);
    config.agents.defaults.model.primary = preset.modelRef;
    finishSelection({
      id: "select-default",
      kind: "activate",
      phase: "ready",
      agentId: "main",
      modelRef: preset.modelRef,
      busy: false,
      cancellationPending: false,
    });
    await flushPromises();
    expect(picker.get('[data-testid="default-model-picker"]').text()).toContain(preset.name);
    expect(success).toHaveBeenCalledExactlyOnceWith(`Model switched to ${preset.modelRef}`);
    expect(document.body.querySelector(".download-overlay")).toBeNull();
    expect(config.agents.list).toEqual(original.agents.list);
    expect(config.models).toEqual(original.models);
    expect(write).not.toHaveBeenCalled();
    expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
  });

  it("shows a local setup entry even without configured providers and never starts setup on mount", async () => {
    config = {};
    window.openclaw.model.local.getCapabilities = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        supported: true,
        mutable: true,
        blockers: [],
        gatewayVersion: "2026.10.3",
        plugin: { installed: false, enabled: false, canInstall: true },
      },
    });
    const inspectProvider = vi.spyOn(window.openclaw.model.local, "inspectProvider");
    const installProvider = vi.spyOn(window.openclaw.model.local, "installProvider");
    const prepare = vi.spyOn(window.openclaw.model.local, "prepare");
    const { wrapper } = await open();
    expect(wrapper.findComponent(LocalModelSetupDialog).exists()).toBe(false);
    expect(wrapper.find("select.model-picker-select").exists()).toBe(false);
    expect(wrapper.text()).toContain("No model provider configured");
    expect(
      wrapper.get('[data-testid="manage-provider-qwen"]').attributes("disabled"),
    ).toBeUndefined();
    await wrapper.get('[data-testid="add-local-model"]').trigger("click");
    expect(wrapper.findComponent(LocalModelSetupDialog).exists()).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(wrapper.getComponent(LocalModelSetupDialog).props("inline")).toBe(true);
    expect(inspectProvider).not.toHaveBeenCalled();
    expect(installProvider).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("uses section headings and removes unused compatible API entry points from the overview", async () => {
    config = {};
    const { wrapper } = await open();
    expect(wrapper.findAll("h2.model-section-title").map((heading) => heading.text())).toEqual([
      "Model providers",
      "Web search",
    ]);
    expect(wrapper.find('[data-testid="configure-cloud-model"]').exists()).toBe(false);
    expect(wrapper.find('[data-provider="custom"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Add compatible API");
    expect(wrapper.text()).not.toContain("OpenAI-compatible API");
    expect(
      wrapper.findAll(".provider-card").map((card) => card.attributes("data-provider")),
    ).toEqual(["github-copilot", "qwen", "minimax", "llama-cpp"]);
    expect(write).not.toHaveBeenCalled();
  });

  it("renders the real default selector with foldable groups and keeps default/session scope separate", async () => {
    const original = structuredClone(config);
    const { wrapper } = await open(true);
    const picker = wrapper.getComponent(DefaultModelPicker);
    await picker.get('[data-testid="default-model-picker"]').trigger("click");
    expect(picker.get('[data-testid="default-model-picker"]').text()).toContain("Saved local");
    expect(picker.get('[data-provider-group="llama-cpp"]').attributes("aria-expanded")).toBe(
      "true",
    );
    expect(picker.get('[data-provider-group="github-copilot"]').attributes("aria-expanded")).toBe(
      "false",
    );
    await picker.get('[data-provider-group="llama-cpp"]').trigger("click");
    expect(picker.get('[data-model-ref="llama-cpp/saved"]').isVisible()).toBe(false);
    await picker.get(".model-search").setValue("cloud");
    expect(picker.get('[data-provider-group="cloud"]').attributes("aria-expanded")).toBe("true");
    await picker.get(".model-search").setValue("");
    expect(picker.get('[data-model-ref="llama-cpp/saved"]').isVisible()).toBe(false);
    expect(write).not.toHaveBeenCalled();
    await picker.get('[data-provider-group="cloud"]').trigger("click");
    await picker.get('[data-model-ref="cloud/remote"]').trigger("click");
    await flushPromises();
    await vi.runAllTimersAsync();
    expect(config.agents.defaults.model.primary).toBe("cloud/remote");
    expect(config.agents.list).toEqual(original.agents.list);
    expect(config.models).toEqual(original.models);
    expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
  });

  it("shows a connected local provider without weights and offers all four managed presets", async () => {
    config = {};
    window.openclaw.model.local.getCapabilities = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        supported: true,
        mutable: true,
        blockers: [],
        gatewayVersion: "2026.9.3",
        plugin: { installed: true, enabled: true, canInstall: false },
      },
    });
    window.openclaw.model.local.getSnapshot = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        models: [],
        catalog: LOCAL_MODEL_PRESETS.map((model) => ({
          ...model,
          configured: false,
          fileStatus: "not-downloaded",
        })),
      },
    });
    const { wrapper } = await open();
    expect(wrapper.get('[data-provider="llama-cpp"]').text()).toContain("Connected");
    expect(
      wrapper
        .findAll("select.model-picker-select option")
        .map((option) => option.attributes("value")),
    ).toEqual(LOCAL_MODEL_PRESETS.map((model) => model.modelRef));
    expect(LOCAL_MODEL_PRESETS).toHaveLength(4);
    await wrapper.get("select.model-picker-select").setValue(LOCAL_MODEL_PRESETS[2].modelRef);
    expect(wrapper.getComponent(LocalModelDownloadDialog).props("modelRef")).toBe(
      LOCAL_MODEL_PRESETS[2].modelRef,
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("labels the local provider for users and keeps the runtime name secondary", async () => {
    const { wrapper } = await open();
    const card = wrapper.get('[data-provider="llama-cpp"]');
    expect(card.get(".provider-card-title strong").text()).toBe("Local model");
    expect(card.get(".provider-runtime").text()).toBe("llama.cpp");
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps no-key search compact and still exposes credentials when a provider needs them", async () => {
    const { wrapper } = await open();
    const search = wrapper.get('[data-testid="web-search-settings"]');
    expect(search.findAll(".card-row")).toHaveLength(1);
    expect(search.get(".model-search-hint").text()).toBe("No API key required");
    expect(search.find(".api-key-row").exists()).toBe(false);
    search.getComponent(SelectStub).vm.$emit("update:modelValue", "brave");
    await flushPromises();
    expect(search.findAll(".card-row")).toHaveLength(2);
    expect(search.find(".api-key-row").exists()).toBe(true);
    expect(search.find(".model-search-hint").exists()).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps existing custom provider connections accessible without offering an empty placeholder", async () => {
    config.models.providers.custom = {
      baseUrl: "http://127.0.0.1:1234/v1",
      models: [{ id: "existing", name: "Existing connection" }],
    };
    const original = structuredClone(config);
    const { wrapper } = await open();
    expect(wrapper.get('[data-provider="custom"]').text()).toContain("Configured connection");
    await wrapper.get('[data-testid="manage-provider-custom"]').trigger("click");
    expect(
      wrapper.getComponent({ name: "ModelSetupDialog" }).props("currentProvider"),
    ).toMatchObject({
      providerKey: "custom",
      modelName: "existing",
    });
    expect(config).toEqual(original);
    expect(write).not.toHaveBeenCalled();
  });

  it("switches cloud defaults without deleting local fields, other providers, auth profiles, or overrides", async () => {
    const original = structuredClone(config);
    const { wrapper } = await open();
    await wrapper.get("select.model-picker-select").setValue("cloud/remote");
    await flushPromises();
    await vi.runAllTimersAsync();
    expect(window.openclaw.model.selectDefault).toHaveBeenCalledExactlyOnceWith({
      modelRef: "cloud/remote",
      expectedConfig: original,
    });
    expect(write).not.toHaveBeenCalled();
    expect(window.openclaw.gateway.restart).not.toHaveBeenCalled();
    expect(config.models).toEqual(original.models);
    expect(config.auth).toEqual(original.auth);
    expect(config.agents.list).toEqual(original.agents.list);
    expect(config.agents.defaults.models).toEqual(original.agents.defaults.models);
    expect(config.memory).toEqual(original.memory);
    expect(config.agents.defaults.model.primary).toBe("cloud/remote");
  });

  it("routes a local selection through the official dialog without writing generic config", async () => {
    const { wrapper } = await open();
    await wrapper.get("select.model-picker-select").setValue("llama-cpp/saved");
    await flushPromises();
    expect(wrapper.getComponent(LocalModelSetupDialog).props("targetModelRef")).toBe(
      "llama-cpp/saved",
    );
    expect(write).not.toHaveBeenCalled();
    expect(config.agents.defaults.model.primary).toBe("llama-cpp/saved");
  });

  it("retains saved Copilot rows and profiles when switching from a local default", async () => {
    const original = structuredClone(config);
    const { wrapper } = await open();
    expect(wrapper.findAll("option").map((option) => option.attributes("value"))).toContain(
      "github-copilot/gpt-5.4",
    );
    await wrapper.get("select.model-picker-select").setValue("github-copilot/gpt-5.4");
    await flushPromises();
    await vi.runAllTimersAsync();
    expect(config.models).toEqual(original.models);
    expect(config.auth).toEqual(original.auth);
    expect(config.agents.defaults.models).toEqual(original.agents.defaults.models);
    expect(config.agents.defaults.model.primary).toBe("github-copilot/gpt-5.4");
  });

  it("blocks changes during streaming but does not disable cloud entry for local setup state", async () => {
    const { wrapper, chat } = await open();
    chat.streaming = true;
    await flushPromises();
    expect(wrapper.get("select.model-picker-select").attributes("disabled")).toBeDefined();
    wrapper.getComponent(DefaultPickerStub).vm.$emit("change", "cloud/remote");
    await flushPromises();
    expect(write).not.toHaveBeenCalled();
    chat.streaming = false;
    listener({
      id: "recover",
      kind: "prepare",
      phase: "interrupted",
      agentId: "main",
      busy: false,
      cancellationPending: false,
    });
    await flushPromises();
    expect(wrapper.get("select.model-picker-select").attributes("disabled")).toBeUndefined();
    expect(
      wrapper.get('[data-testid="manage-provider-qwen"]').attributes("disabled"),
    ).toBeUndefined();
    expect(wrapper.get('[data-testid="add-local-model"]').attributes("disabled")).toBeUndefined();
  });

  it("shows only configured models without catalog diagnostics or duplicated cards", async () => {
    const { wrapper } = await open();
    expect(wrapper.text()).toContain("Saved local");
    expect(wrapper.text()).not.toContain("Catalog availability");
    expect(wrapper.text()).not.toContain("Refresh model catalog");
    expect(wrapper.text()).not.toContain("Changes the default model only");
    expect(wrapper.findAll("option").map((option) => option.attributes("value"))).not.toContain(
      "llama-cpp/detected",
    );
  });

  it("prevents active local deletion and removes only the connection after another default is selected", async () => {
    const { wrapper } = await open();
    await wrapper.get('[data-testid="add-local-model"]').trigger("click");
    expect(wrapper.getComponent(LocalModelSetupDialog).props("removableConnections")).toEqual([]);
    await wrapper.get("select.model-picker-select").setValue("cloud/remote");
    await flushPromises();
    await vi.runAllTimersAsync();
    await flushPromises();
    const beforeRemoval = structuredClone(config);
    wrapper.getComponent(LocalModelSetupDialog).vm.$emit("remove-connection", "llama-cpp/saved");
    await flushPromises();
    await vi.runAllTimersAsync();
    expect(config.models.providers["llama-cpp"]).toBeUndefined();
    expect(config.models.providers.cloud).toBeDefined();
    expect(config.agents.defaults.model.primary).toBe("cloud/remote");
    expect(write.mock.calls.at(-1)![1]).toEqual(beforeRemoval);
  });

  it("keeps a stale-write rejection from restarting or changing the selected default", async () => {
    const original = structuredClone(config);
    vi.mocked(window.openclaw.model.selectDefault).mockRejectedValueOnce(
      new Error("Configuration changed; reload before saving"),
    );
    const error = vi.spyOn(ElMessage, "error");
    const { wrapper } = await open();
    await wrapper.get("select.model-picker-select").setValue("cloud/remote");
    await flushPromises();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Configuration changed"));
    expect(window.openclaw.gateway.restart).not.toHaveBeenCalled();
    expect(config).toEqual(original);
  });

  it("keeps the cloud switch busy until acknowledgement and surfaces an uncertain result without restarting", async () => {
    let reject!: (cause: Error) => void;
    vi.mocked(window.openclaw.model.selectDefault).mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const success = vi.spyOn(ElMessage, "success");
    const error = vi.spyOn(ElMessage, "error");
    const { wrapper } = await open(true);
    const picker = wrapper.getComponent(DefaultModelPicker);
    await picker.get('[data-testid="default-model-picker"]').trigger("click");
    await picker.get('[data-provider-group="cloud"]').trigger("click");
    await picker.get('[data-model-ref="cloud/remote"]').trigger("click");
    await flushPromises();
    expect(picker.get('[data-testid="default-model-picker"]').text()).toContain("Switching...");
    expect(picker.get('[data-testid="default-model-picker"]').attributes("disabled")).toBeDefined();
    expect(config.agents.defaults.model.primary).toBe("llama-cpp/saved");
    config = selectPrimaryModelConfig(config, "cloud/remote");
    reject(new Error("The default model is saved, but its application could not be confirmed"));
    await flushPromises();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("application could not be confirmed"),
    );
    expect(success).not.toHaveBeenCalled();
    expect(window.openclaw.gateway.restart).not.toHaveBeenCalled();
    expect(window.openclaw.model.selectDefault).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
  });

  it("passes the original snapshot when disconnecting Copilot", async () => {
    config.agents.defaults.model.primary = "github-copilot/gpt-5.4";
    const original = structuredClone(config);
    vi.spyOn(ElMessageBox, "confirm").mockResolvedValue("confirm" as never);
    const { wrapper } = await open();
    await wrapper.get('[data-testid="manage-provider-github-copilot"]').trigger("click");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Disconnect")!
      .trigger("click");
    await flushPromises();
    await vi.runAllTimersAsync();
    expect(write.mock.calls[0][1]).toEqual(original);
    expect(config.agents.list).toEqual(original.agents.list);
  });

  it("shows the default agent override caveat and forwards it to local setup", async () => {
    config.agents.list = [
      { id: "other", model: "cloud/other" },
      { id: "primary-agent", default: true, model: { primary: "cloud/pinned" } },
    ];
    const { wrapper } = await open();
    expect(wrapper.find('[data-testid="default-agent-override"]').exists()).toBe(false);
    await wrapper.get('[data-testid="add-local-model"]').trigger("click");
    expect(wrapper.getComponent(LocalModelSetupDialog).props("defaultAgentOverride")).toEqual({
      agentId: "primary-agent",
      modelRef: "cloud/pinned",
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("does not invent a default from the first configured model", async () => {
    config.agents.defaults.model = undefined;
    const { wrapper } = await open();
    expect(wrapper.getComponent(DefaultPickerStub).props("modelValue")).toBe("");
    expect(write).not.toHaveBeenCalled();
  });

  it("opens cloud setup while local work is pending without cancelling or changing anything", async () => {
    const current: LocalModelOperation = {
      id: "pending-local",
      kind: "prepare",
      phase: "step",
      agentId: "main",
      busy: true,
      cancellationPending: false,
    };
    vi.mocked(window.openclaw.model.local.getOperation).mockResolvedValue({
      ok: true,
      value: current,
    });
    window.openclaw.model.local.cancel = vi.fn(async () => {
      const terminal = { ...current, phase: "cancelled" as const, busy: false };
      vi.mocked(window.openclaw.model.local.getOperation).mockResolvedValue({
        ok: true,
        value: terminal,
      });
      listener(terminal);
      return { ok: true as const, value: terminal };
    });
    const confirm = vi.spyOn(ElMessageBox, "confirm").mockResolvedValue("confirm" as never);
    const { wrapper } = await open();
    expect(
      wrapper.get('[data-testid="manage-provider-qwen"]').attributes("disabled"),
    ).toBeUndefined();
    await wrapper.get('[data-testid="manage-provider-qwen"]').trigger("click");
    await flushPromises();
    expect(window.openclaw.model.local.cancel).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(wrapper.findComponent({ name: "ModelSetupDialog" }).props("modelValue")).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it("uses inline cards with correct provider prefill and shows missing local files without claiming connectivity", async () => {
    config.models.providers.cloud.baseUrl = "https://cloud.example/v1";
    window.openclaw.model.local.getSnapshot = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        models: [{ modelRef: "llama-cpp/saved", name: "Saved local", fileStatus: "missing" }],
      },
    });
    const { wrapper } = await open();
    expect(wrapper.get('[data-provider="llama-cpp"]').text()).toContain("Download needed");
    expect(wrapper.get('[data-provider="cloud"]').text()).not.toContain("Connected");
    await wrapper.get('[data-testid="manage-provider-cloud"]').trigger("click");
    const editor = wrapper.getComponent({ name: "ModelSetupDialog" });
    expect(editor.props("inline")).toBe(true);
    expect(editor.props("manageOnly")).toBe(true);
    expect(editor.props("currentProvider")).toMatchObject({
      providerKey: "cloud",
      modelName: "remote",
      baseUrl: "https://cloud.example/v1",
    });
    const customRow = wrapper.get('[data-provider="cloud"] .provider-model-row');
    expect(customRow.text()).toContain("Edit");
    expect(customRow.text()).toContain("Remove connection");
    expect(write).not.toHaveBeenCalled();
  });

  it.each(["qwen", "minimax"])(
    "uses only the %s model dropdown instead of a duplicate saved-model list",
    async (provider) => {
      config.models.providers[provider] = {
        baseUrl: "https://provider.example/v1",
        apiKey: "saved-key",
        models: [
          { id: "saved-one", name: "Saved model one" },
          { id: "saved-two", name: "Saved model two" },
        ],
      };
      const original = structuredClone(config);
      const { wrapper } = await open();
      await wrapper.get(`[data-testid="manage-provider-${provider}"]`).trigger("click");
      await flushPromises();
      const card = wrapper.get(`[data-provider="${provider}"]`);
      expect(card.text()).toContain("Configured connection");
      expect(card.find(".provider-model-row").exists()).toBe(false);
      expect(card.text()).not.toContain("Saved model one");
      expect(card.text()).not.toContain("Saved model two");
      expect(card.text()).not.toContain("Remove connection");
      expect(card.findAll("button").some((button) => button.text() === "Edit")).toBe(false);
      expect(
        wrapper.getComponent({ name: "ModelSetupDialog" }).props("currentProvider"),
      ).toMatchObject({
        providerKey: provider,
        modelName: "saved-one",
        apiKey: "saved-key",
      });
      expect(config).toEqual(original);
      expect(write).not.toHaveBeenCalled();
      expect(window.openclaw.gateway.restart).not.toHaveBeenCalled();
    },
  );

  it("uses accessible arrows to expand and collapse provider editors without duplicate key links", async () => {
    const { wrapper } = await open();
    expect(wrapper.findComponent({ name: "ModelSetupDialog" }).exists()).toBe(false);
    for (const id of ["qwen", "minimax", "github-copilot"]) {
      const button = wrapper.get(`[data-testid="manage-provider-${id}"]`);
      expect(button.text()).toBe("");
      expect(button.attributes("aria-expanded")).toBe("false");
      await button.trigger("click");
      await flushPromises();
      expect(button.attributes("aria-expanded")).toBe("true");
      expect(button.get("svg").classes()).toContain("provider-chevron-up");
      expect(wrapper.findComponent({ name: "ModelSetupDialog" }).exists()).toBe(true);
      await button.trigger("click");
      await flushPromises();
      expect(button.attributes("aria-expanded")).toBe("false");
      expect(wrapper.findComponent({ name: "ModelSetupDialog" }).exists()).toBe(false);
    }
    expect(wrapper.find('[data-testid^="provider-signup-"]').exists()).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(window.openclaw.gateway.restart).not.toHaveBeenCalled();
  });

  it.each(["qwen", "minimax"])(
    "reopens %s on its last saved form selection, not the first model",
    async (provider) => {
      config.models.providers[provider] = {
        baseUrl: "https://provider.example/v1",
        apiKey: "fixture",
        models: [
          { id: "first", name: "First" },
          { id: "last-saved", name: "Last saved" },
        ],
      };
      const saved = await window.openclaw.settings.get();
      window.openclaw.settings.get = vi.fn().mockResolvedValue({
        ...saved,
        modelFormSelections: { [provider]: `${provider}/last-saved` },
      });
      const { wrapper } = await open();
      await wrapper.get(`[data-testid="manage-provider-${provider}"]`).trigger("click");
      expect(
        wrapper.getComponent({ name: "ModelSetupDialog" }).props("currentProvider"),
      ).toMatchObject({
        providerKey: provider,
        modelName: "last-saved",
      });
      expect(write).not.toHaveBeenCalled();
      expect(window.openclaw.gateway.restart).not.toHaveBeenCalled();
    },
  );

  it("shows the full live cloud catalog in the default selector and hot-selects an unsaved ID", async () => {
    config.models.providers.qwen = {
      baseUrl: "https://provider.example/v1",
      apiKey: "fixture",
      models: [{ id: "saved", name: "Saved" }],
    };
    window.openclaw.model.discoverModels = vi.fn().mockResolvedValue({
      ok: true,
      models: ["saved", "live-one", "live-two"],
    });
    const { wrapper } = await open();
    const picker = wrapper.getComponent(DefaultPickerStub);
    expect(
      picker
        .props("models")
        .filter((model: { providerKey: string }) => model.providerKey === "qwen")
        .map((model: { id: string }) => model.id),
    ).toEqual(["saved", "live-one", "live-two"]);
    picker.vm.$emit("change", "qwen/live-two");
    await flushPromises();
    expect(window.openclaw.model.selectDefault).toHaveBeenCalledWith(
      expect.objectContaining({ modelRef: "qwen/live-two" }),
    );
    expect(window.openclaw.gateway.restart).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("toggles the local provider panel with the same arrow behavior", async () => {
    const { wrapper } = await open();
    const button = wrapper.get('[data-testid="add-local-model"]');
    await button.trigger("click");
    await flushPromises();
    expect(button.attributes("aria-expanded")).toBe("true");
    expect(wrapper.findComponent(LocalModelSetupDialog).exists()).toBe(true);
    await button.trigger("click");
    await flushPromises();
    expect(button.attributes("aria-expanded")).toBe("false");
    expect(wrapper.findComponent(LocalModelSetupDialog).exists()).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("leaves local work untouched when the user declines cloud switching", async () => {
    vi.mocked(window.openclaw.model.local.getOperation).mockResolvedValue({
      ok: true,
      value: {
        id: "keep",
        kind: "prepare",
        phase: "step",
        agentId: "main",
        busy: true,
        cancellationPending: false,
      },
    });
    const cancel = vi.spyOn(window.openclaw.model.local, "cancel");
    vi.spyOn(ElMessageBox, "confirm").mockRejectedValue("cancel");
    const { wrapper } = await open();
    await wrapper.get("select.model-picker-select").setValue("cloud/remote");
    await flushPromises();
    expect(cancel).not.toHaveBeenCalled();
    expect(wrapper.findComponent({ name: "ModelSetupDialog" }).exists()).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("switches an existing cloud model after confirmed cancellation rather than disabling selection", async () => {
    const current: LocalModelOperation = {
      id: "download-choice",
      kind: "prepare",
      phase: "step",
      agentId: "main",
      busy: true,
      cancellationPending: false,
    };
    vi.mocked(window.openclaw.model.local.getOperation).mockResolvedValue({
      ok: true,
      value: current,
    });
    window.openclaw.model.local.cancel = vi.fn(async () => {
      const terminal = { ...current, phase: "cancelled" as const, busy: false };
      vi.mocked(window.openclaw.model.local.getOperation).mockResolvedValue({
        ok: true,
        value: terminal,
      });
      listener(terminal);
      return { ok: true as const, value: terminal };
    });
    vi.spyOn(ElMessageBox, "confirm").mockResolvedValue("confirm" as never);
    const { wrapper } = await open();
    expect(wrapper.get("select.model-picker-select").attributes("disabled")).toBeUndefined();
    await wrapper.get("select.model-picker-select").setValue("cloud/remote");
    await flushPromises();
    await vi.runAllTimersAsync();
    expect(window.openclaw.model.local.cancel).toHaveBeenCalledWith("download-choice");
    expect(config.agents.defaults.model.primary).toBe("cloud/remote");
    expect(config.models.providers["llama-cpp"]).toBeDefined();
  });
});
