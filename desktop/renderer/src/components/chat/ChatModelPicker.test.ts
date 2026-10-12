import { defineComponent } from "vue";
import { createPinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserOpenClawMock } from "@/browser-openclaw";
import { setLocale } from "@/i18n";
import ChatModelPicker from "./ChatModelPicker.vue";
import { LOCAL_MODEL_PRESETS } from "../../../../src/local-model-catalog";
import LocalModelDownloadDialog from "@/components/LocalModelDownloadDialog.vue";
import { useChatStore } from "@/stores/chat";

const Popover = defineComponent({
  props: { visible: Boolean },
  emits: ["update:visible", "show"],
  template: `<div><div @click="$emit('update:visible', !visible); !visible && $emit('show')"><slot name="reference" /></div><div v-show="visible"><slot /></div></div>`,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ChatModelPicker", () => {
  const wrappers: Array<ReturnType<typeof mount>> = [];
  beforeEach(() => {
    setLocale("en-US");
    const api = createBrowserOpenClawMock();
    api.config.read = vi.fn().mockResolvedValue({
      models: {
        providers: {
          cloud: { models: [{ id: "remote", name: "Cloud model" }] },
          "llama-cpp": { models: [{ id: "qwen", name: "Qwen local" }] },
        },
      },
      agents: { defaults: { model: { primary: "cloud/remote" } } },
    });
    api.model.session.get = vi.fn(async (sessionKey) => ({
      sessionKey,
      modelRef: "cloud/remote",
      overridden: false,
    }));
    api.model.session.select = vi.fn(async ({ sessionKey, modelRef }) => ({
      sessionKey,
      modelRef: modelRef ?? "cloud/remote",
      overridden: modelRef !== null,
    }));
    api.model.local.getSnapshot = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        models: [{ modelRef: "llama-cpp/qwen", name: "Qwen local", fileStatus: "missing" }],
      },
    });
    api.model.local.activate = vi.fn();
    api.model.local.prepare = vi.fn();
    api.model.local.detect = vi.fn();
    api.model.testConnection = vi.fn();
    api.config.write = vi.fn();
    api.gateway.restart = vi.fn();
    window.openclaw = api;
  });
  afterEach(() => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });
  async function open() {
    const wrapper = mount(ChatModelPicker, {
      attachTo: document.body,
      props: { sessionKey: "agent:main:one", disabled: false, connected: true },
      global: { stubs: { "el-popover": Popover, LocalModelDownloadDialog: true } },
    });
    wrappers.push(wrapper);
    await flushPromises();
    await wrapper.get('[data-testid="chat-model-picker"]').trigger("click");
    await flushPromises();
    return wrapper;
  }

  function fixedCatalog() {
    const preset = LOCAL_MODEL_PRESETS[0];
    const config = {
      models: {
        providers: {
          "llama-cpp": {
            models: [
              {
                id: preset.modelRef.slice("llama-cpp/".length),
                name: preset.name,
              },
            ],
          },
        },
      },
    };
    const snapshot = {
      ok: true as const,
      value: {
        models: [{ modelRef: preset.modelRef, name: preset.name, fileStatus: "present" as const }],
        catalog: LOCAL_MODEL_PRESETS.map((model, index) => ({
          ...model,
          configured: index === 0,
          fileStatus: index === 0 ? ("present" as const) : ("not-downloaded" as const),
        })),
      },
    };
    const copilot = [{ id: "github-copilot/gpt-5.5", name: "GPT-5.5" }];
    vi.mocked(window.openclaw.config.read).mockResolvedValue(config);
    vi.mocked(window.openclaw.model.local.getSnapshot).mockResolvedValue(snapshot);
    vi.mocked(window.openclaw.model.session.get).mockImplementation(async (sessionKey) => ({
      sessionKey,
      modelRef: preset.modelRef,
      overridden: false,
    }));
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
    window.openclaw.model.getGitHubCopilotStatus = vi
      .fn()
      .mockResolvedValue({ authenticated: true });
    window.openclaw.model.listGitHubCopilotModels = vi.fn().mockResolvedValue(copilot);
    return { config, snapshot, copilot };
  }

  it("opens the first complete catalogue once instead of exposing each arriving provider", async () => {
    const fixture = fixedCatalog();
    const local = deferred<typeof fixture.snapshot>();
    const copilot = deferred<typeof fixture.copilot>();
    vi.mocked(window.openclaw.model.local.getSnapshot).mockReturnValue(local.promise);
    vi.mocked(window.openclaw.model.listGitHubCopilotModels).mockReturnValue(copilot.promise);
    const wrapper = await open();
    const trigger = wrapper.get('[data-testid="chat-model-picker"]');
    expect(trigger.text()).toContain("Loading models...");
    expect(trigger.attributes("aria-expanded")).toBe("false");
    expect(trigger.attributes("aria-busy")).toBe("true");
    expect(wrapper.findAll("[data-model-ref]")).toHaveLength(0);
    local.resolve(fixture.snapshot);
    await flushPromises();
    expect(trigger.attributes("aria-expanded")).toBe("false");
    expect(wrapper.findAll("[data-model-ref]")).toHaveLength(0);
    copilot.resolve(fixture.copilot);
    await flushPromises();
    expect(trigger.attributes("aria-expanded")).toBe("true");
    expect(trigger.attributes("aria-busy")).toBe("false");
    expect(wrapper.findAll("[data-model-ref]")).toHaveLength(3);
    expect(wrapper.get('[data-provider-group="llama-cpp"]').attributes("aria-expanded")).toBe(
      "true",
    );
    expect(wrapper.getComponent(Popover).attributes("placement")).toBe("top-end");
    expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
    expect(window.openclaw.model.local.prepare).not.toHaveBeenCalled();
  });

  it("retains a complete cached list and file statuses through every stage of reopening refresh", async () => {
    const fixture = fixedCatalog();
    const wrapper = await open();
    const refs = () =>
      wrapper.findAll("[data-model-ref]").map((model) => model.attributes("data-model-ref"));
    const before = refs();
    const localButton = wrapper.get(`[data-model-ref="${LOCAL_MODEL_PRESETS[0].modelRef}"]`);
    const beforeStatus = localButton.text();
    const trigger = wrapper.get('[data-testid="chat-model-picker"]');
    await trigger.trigger("click");
    const config = deferred<typeof fixture.config>();
    const local = deferred<typeof fixture.snapshot>();
    const copilot = deferred<typeof fixture.copilot>();
    vi.mocked(window.openclaw.config.read).mockReturnValue(config.promise);
    vi.mocked(window.openclaw.model.local.getSnapshot).mockReturnValue(local.promise);
    vi.mocked(window.openclaw.model.listGitHubCopilotModels).mockReturnValue(copilot.promise);
    await trigger.trigger("click");
    expect(trigger.attributes("aria-expanded")).toBe("true");
    expect(refs()).toEqual(before);
    expect(localButton.text()).toBe(beforeStatus);
    expect(localButton.attributes("disabled")).toBeUndefined();
    config.resolve(fixture.config);
    await flushPromises();
    expect(refs()).toEqual(before);
    local.resolve(fixture.snapshot);
    await flushPromises();
    expect(refs()).toEqual(before);
    expect(localButton.text()).toBe(beforeStatus);
    copilot.resolve(fixture.copilot);
    await flushPromises();
    expect(refs()).toEqual(before);
    expect(localButton.text()).toBe(beforeStatus);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(window.openclaw.model.local.detect).not.toHaveBeenCalled();
    expect(window.openclaw.config.write).not.toHaveBeenCalled();
  });

  it.each(["blur", "escape", "second-click", "session-change"])(
    "does not open a late first catalogue after %s cancels the request",
    async (reason) => {
      const fixture = fixedCatalog();
      const local = deferred<typeof fixture.snapshot>();
      vi.mocked(window.openclaw.model.local.getSnapshot).mockReturnValue(local.promise);
      const wrapper = await open();
      const trigger = wrapper.get('[data-testid="chat-model-picker"]');
      if (reason === "blur") await trigger.trigger("blur");
      else if (reason === "escape") await trigger.trigger("keydown", { key: "Escape" });
      else if (reason === "second-click") await trigger.trigger("click");
      else await wrapper.setProps({ sessionKey: "agent:main:two" });
      local.resolve(fixture.snapshot);
      await flushPromises();
      expect(trigger.attributes("aria-expanded")).toBe("false");
      expect(trigger.attributes("aria-busy")).toBe("false");
      expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
    },
  );

  it("coalesces a cancelled and restarted first opening rather than racing duplicate catalogues", async () => {
    const fixture = fixedCatalog();
    const local = deferred<typeof fixture.snapshot>();
    vi.mocked(window.openclaw.model.local.getSnapshot).mockReturnValue(local.promise);
    const wrapper = await open();
    const trigger = wrapper.get('[data-testid="chat-model-picker"]');
    await trigger.trigger("click");
    await trigger.trigger("click");
    expect(window.openclaw.config.read).toHaveBeenCalledOnce();
    expect(window.openclaw.model.local.getSnapshot).toHaveBeenCalledOnce();
    local.resolve(fixture.snapshot);
    await flushPromises();
    expect(trigger.attributes("aria-expanded")).toBe("true");
    expect(wrapper.findAll("[data-model-ref]")).toHaveLength(3);
  });

  it("waits for a new conversation's selection before choosing its initially expanded provider", async () => {
    fixedCatalog();
    const wrapper = await open();
    const current = deferred<Awaited<ReturnType<typeof window.openclaw.model.session.get>>>();
    vi.mocked(window.openclaw.model.session.get).mockReturnValue(current.promise);
    await wrapper.setProps({ sessionKey: "agent:main:two" });
    const trigger = wrapper.get('[data-testid="chat-model-picker"]');
    await trigger.trigger("click");
    await flushPromises();
    expect(trigger.attributes("aria-expanded")).toBe("false");
    expect(trigger.text()).toContain("Loading models...");
    current.resolve({
      sessionKey: "agent:main:two",
      modelRef: "github-copilot/gpt-5.5",
      overridden: true,
    });
    await flushPromises();
    expect(trigger.attributes("aria-expanded")).toBe("true");
    expect(wrapper.get('[data-provider-group="github-copilot"]').attributes("aria-expanded")).toBe(
      "true",
    );
    expect(wrapper.get('[data-provider-group="llama-cpp"]').attributes("aria-expanded")).toBe(
      "false",
    );
  });

  it("retains the last list on config refresh failure but blocks selection and shows the error", async () => {
    fixedCatalog();
    const wrapper = await open();
    const before = wrapper
      .findAll("[data-model-ref]")
      .map((model) => model.attributes("data-model-ref"));
    vi.mocked(window.openclaw.config.read).mockRejectedValue(
      new Error("Cannot read model configuration"),
    );
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Refresh")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("Cannot read model configuration");
    expect(
      wrapper.findAll("[data-model-ref]").map((model) => model.attributes("data-model-ref")),
    ).toEqual(before);
    expect(
      wrapper
        .findAll("[data-model-ref]")
        .every((model) => model.attributes("disabled") !== undefined),
    ).toBe(true);
    expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
  });

  it.each(["main", "writer"])(
    "selects a prepared local model in a fresh %s draft without first sending a message",
    async (agentId) => {
      const pinia = createPinia();
      const chat = useChatStore(pinia);
      chat.newSession(agentId);
      const sessionKey = chat.sessionKey;
      const modelRef = LOCAL_MODEL_PRESETS[0].modelRef;
      let currentModel = "cloud/remote";
      let finishSelection!: () => void;
      const selectionPending = new Promise<void>((resolve) => {
        finishSelection = resolve;
      });
      const requireOwner = (key: string) => {
        if (!key.startsWith(`agent:${agentId}:`))
          throw new Error("Multiple agents are configured; use an agent-prefixed session key");
      };
      window.openclaw.model.session.get = vi.fn(async (key) => {
        requireOwner(key);
        return {
          sessionKey: key,
          modelRef: currentModel,
          overridden: currentModel !== "cloud/remote",
        };
      });
      window.openclaw.model.session.select = vi.fn(async ({ sessionKey: key, modelRef: ref }) => {
        requireOwner(key);
        await selectionPending;
        currentModel = ref ?? "cloud/remote";
        return { sessionKey: key, modelRef: ref, overridden: true };
      });
      window.openclaw.model.local.getSnapshot = vi.fn().mockResolvedValue({
        ok: true,
        value: {
          models: [{ modelRef, name: "Qwen", fileStatus: "present" }],
          catalog: [{ ...LOCAL_MODEL_PRESETS[0], configured: true, fileStatus: "present" }],
        },
      });
      window.openclaw.model.local.getCapabilities = vi.fn().mockResolvedValue({
        ok: true,
        value: {
          supported: true,
          mutable: true,
          blockers: [],
          plugin: { installed: true, enabled: true, canInstall: false },
          gatewayVersion: "2026.9.3",
        },
      });
      const wrapper = mount(ChatModelPicker, {
        attachTo: document.body,
        props: { sessionKey, disabled: false, connected: true },
        global: { plugins: [pinia], stubs: { "el-popover": Popover } },
      });
      wrappers.push(wrapper);
      await flushPromises();
      await wrapper.get('[data-testid="chat-model-picker"]').trigger("click");
      await flushPromises();
      expect(window.openclaw.model.session.get).toHaveBeenCalledWith(sessionKey);
      expect(wrapper.find('[role="alert"]').exists()).toBe(false);
      await wrapper.get('[data-provider-group="llama-cpp"]').trigger("click");
      await wrapper.get(`[data-model-ref="${modelRef}"]`).trigger("click");
      await flushPromises();
      expect(window.openclaw.model.session.select).toHaveBeenCalledExactlyOnceWith({
        sessionKey,
        modelRef,
      });
      const trigger = wrapper.get('[data-testid="chat-model-picker"]');
      expect(trigger.text()).toContain("Switching...");
      expect(trigger.attributes("aria-busy")).toBe("true");
      expect(trigger.attributes("disabled")).toBeDefined();
      expect(document.body.querySelector(".download-overlay")).toBeNull();
      await wrapper.get(`[data-model-ref="${modelRef}"]`).trigger("click");
      expect(window.openclaw.model.session.select).toHaveBeenCalledOnce();
      finishSelection();
      await flushPromises();
      expect(wrapper.findComponent(LocalModelDownloadDialog).exists()).toBe(false);
      expect(trigger.text()).toContain("Qwen3.5 4B");
      expect(trigger.attributes("aria-busy")).toBe("false");
      expect(trigger.attributes("disabled")).toBeUndefined();
      expect(chat.messages).toEqual([]);
      expect(window.openclaw.model.local.prepare).not.toHaveBeenCalled();
      expect(window.openclaw.model.local.activate).not.toHaveBeenCalled();
      expect(window.openclaw.model.testConnection).not.toHaveBeenCalled();
      expect(window.openclaw.config.write).not.toHaveBeenCalled();
      expect(window.openclaw.gateway.restart).not.toHaveBeenCalled();
    },
  );

  it("groups configured models and searches names and provider IDs without any setup or inference", async () => {
    const wrapper = await open();
    expect(wrapper.findAll(".model-group-name").map((heading) => heading.text())).toEqual([
      "cloud",
      "llama.cpp",
    ]);
    await wrapper.get("input").setValue("QWEN");
    expect(wrapper.findAll("[data-model-ref]")).toHaveLength(1);
    await wrapper.get("input").setValue("no matching model");
    expect(wrapper.text()).toContain("No matching models.");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Clear search")!
      .trigger("click");
    expect(wrapper.findAll("[data-model-ref]")).toHaveLength(2);
    expect(window.openclaw.model.local.detect).not.toHaveBeenCalled();
    expect(window.openclaw.model.local.prepare).not.toHaveBeenCalled();
    expect(window.openclaw.model.local.activate).not.toHaveBeenCalled();
    expect(window.openclaw.model.testConnection).not.toHaveBeenCalled();
  });

  it("expands only the current provider by default and allows every group to be collapsed", async () => {
    const wrapper = await open();
    const cloud = wrapper.get('[data-provider-group="cloud"]');
    const local = wrapper.get('[data-provider-group="llama-cpp"]');
    expect(cloud.attributes("type")).toBe("button");
    expect(cloud.attributes("aria-expanded")).toBe("true");
    expect(local.attributes("aria-expanded")).toBe("false");
    expect(wrapper.get('[data-model-ref="cloud/remote"]').isVisible()).toBe(true);
    expect(wrapper.get('[data-model-ref="llama-cpp/qwen"]').isVisible()).toBe(false);
    const panels = wrapper.findAll(".model-group-models");
    expect(panels.map((panel) => panel.attributes("id"))).toEqual([
      cloud.attributes("aria-controls"),
      local.attributes("aria-controls"),
    ]);
    const reads = vi.mocked(window.openclaw.config.read).mock.calls.length;
    await local.trigger("click");
    expect(local.attributes("aria-expanded")).toBe("true");
    expect(wrapper.get('[data-model-ref="llama-cpp/qwen"]').isVisible()).toBe(true);
    await cloud.trigger("click");
    await local.trigger("click");
    expect(panels.every((panel) => !panel.isVisible())).toBe(true);
    expect(window.openclaw.config.read).toHaveBeenCalledTimes(reads);
    expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
    expect(window.openclaw.model.local.prepare).not.toHaveBeenCalled();
    expect(window.openclaw.config.write).not.toHaveBeenCalled();
  });

  it("automatically reveals matching groups during search and restores manual folds when cleared", async () => {
    const wrapper = await open();
    await wrapper.get('[data-provider-group="cloud"]').trigger("click");
    await wrapper.get("input").setValue("qwen");
    expect(wrapper.get('[data-provider-group="llama-cpp"]').attributes("aria-expanded")).toBe(
      "true",
    );
    expect(wrapper.get('[data-model-ref="llama-cpp/qwen"]').isVisible()).toBe(true);
    await wrapper.get('[data-provider-group="llama-cpp"]').trigger("click");
    expect(wrapper.get('[data-model-ref="llama-cpp/qwen"]').isVisible()).toBe(false);
    await wrapper.get("input").setValue("llama.cpp");
    expect(wrapper.get('[data-model-ref="llama-cpp/qwen"]').isVisible()).toBe(true);
    await wrapper.get("input").setValue("");
    expect(wrapper.findAll(".model-group-models").every((panel) => !panel.isVisible())).toBe(true);
    expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
  });

  it("keeps folds when refreshing and reopening the same conversation's picker", async () => {
    const wrapper = await open();
    await wrapper.get('[data-provider-group="cloud"]').trigger("click");
    await wrapper.get('[data-provider-group="llama-cpp"]').trigger("click");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Refresh")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-provider-group="cloud"]').attributes("aria-expanded")).toBe("false");
    expect(wrapper.get('[data-provider-group="llama-cpp"]').attributes("aria-expanded")).toBe(
      "true",
    );
    await wrapper.get('[data-testid="chat-model-picker"]').trigger("click");
    await wrapper.get('[data-testid="chat-model-picker"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-model-ref="cloud/remote"]').isVisible()).toBe(false);
    expect(wrapper.get('[data-model-ref="llama-cpp/qwen"]').isVisible()).toBe(true);
  });

  it("resets folds and search for a different conversation's current provider", async () => {
    const wrapper = await open();
    await wrapper.get('[data-provider-group="llama-cpp"]').trigger("click");
    await wrapper.get('[data-provider-group="llama-cpp"]').trigger("click");
    await wrapper.get("input").setValue("cloud");
    vi.mocked(window.openclaw.model.session.get).mockResolvedValue({
      sessionKey: "agent:main:two",
      modelRef: "llama-cpp/qwen",
      overridden: true,
    });
    await wrapper.setProps({ sessionKey: "agent:main:two" });
    await flushPromises();
    await wrapper.get('[data-testid="chat-model-picker"]').trigger("click");
    await flushPromises();
    expect((wrapper.get("input").element as HTMLInputElement).value).toBe("");
    expect(wrapper.get('[data-model-ref="cloud/remote"]').isVisible()).toBe(false);
    expect(wrapper.get('[data-model-ref="llama-cpp/qwen"]').isVisible()).toBe(true);
    expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
  });

  it("does not guess an expanded provider when there is no current model", async () => {
    vi.mocked(window.openclaw.model.session.get).mockResolvedValue({
      sessionKey: "agent:main:one",
      modelRef: null,
      overridden: false,
    });
    const wrapper = await open();
    expect(wrapper.findAll(".model-group-models").every((panel) => !panel.isVisible())).toBe(true);
  });

  it("lets users fold groups while selection is disabled or the Gateway is offline", async () => {
    const wrapper = await open();
    await wrapper.setProps({ disabled: true });
    await wrapper.get('[data-provider-group="cloud"]').trigger("click");
    expect(wrapper.get('[data-model-ref="cloud/remote"]').isVisible()).toBe(false);
    await wrapper.setProps({ connected: false });
    await wrapper.get('[data-testid="chat-model-picker"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-provider-group="llama-cpp"]').trigger("click");
    expect(wrapper.get('[data-model-ref="llama-cpp/qwen"]').isVisible()).toBe(true);
    expect(wrapper.get('[data-model-ref="llama-cpp/qwen"]').attributes("disabled")).toBeDefined();
    expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
  });

  it("shows undownloaded presets under llama.cpp and opens exact first-use confirmation", async () => {
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
    window.openclaw.model.local.getCapabilities = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        supported: true,
        mutable: true,
        blockers: [],
        plugin: { installed: true, enabled: true, canInstall: false },
        gatewayVersion: "2026.9.3",
      },
    });
    const wrapper = await open();
    await wrapper.get('[data-provider-group="llama-cpp"]').trigger("click");
    const button = wrapper.get(`[data-model-ref="${LOCAL_MODEL_PRESETS[0].modelRef}"]`);
    expect(button.text()).toContain("Not downloaded");
    expect(button.attributes("disabled")).toBeUndefined();
    await button.trigger("click");
    expect(wrapper.getComponent(LocalModelDownloadDialog).props()).toMatchObject({
      modelRef: LOCAL_MODEL_PRESETS[0].modelRef,
      sessionKey: "agent:main:one",
    });
    expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
    await wrapper.setProps({ sessionKey: "agent:main:other" });
    expect(wrapper.findComponent(LocalModelDownloadDialog).exists()).toBe(false);
  });

  it("routes missing local weights to management and cannot select them", async () => {
    const wrapper = await open();
    await wrapper.get('[data-provider-group="llama-cpp"]').trigger("click");
    const local = wrapper.get('[data-model-ref="llama-cpp/qwen"]');
    expect(local.attributes("disabled")).toBeDefined();
    expect(local.text()).toContain("Download needed");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Download model again")!
      .trigger("click");
    expect(wrapper.emitted("manage")).toEqual([["llama-cpp"]]);
    expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
  });

  it("changes only this session and never writes the default config or restarts", async () => {
    const wrapper = await open();
    await wrapper.get('[data-model-ref="cloud/remote"]').trigger("click");
    await flushPromises();
    expect(window.openclaw.model.session.select).toHaveBeenCalledWith({
      sessionKey: "agent:main:one",
      modelRef: "cloud/remote",
    });
    expect(window.openclaw.config.write).not.toHaveBeenCalled();
    expect(window.openclaw.gateway.restart).not.toHaveBeenCalled();
    expect(wrapper.emitted("busy")).toEqual([[true], [false]]);
  });

  it("selects installed local models through the same session API, not global activation", async () => {
    vi.mocked(window.openclaw.model.local.getSnapshot).mockResolvedValue({
      ok: true,
      value: {
        models: [{ modelRef: "llama-cpp/qwen", name: "Qwen local", fileStatus: "present" }],
      },
    });
    const wrapper = await open();
    await wrapper.get('[data-provider-group="llama-cpp"]').trigger("click");
    await wrapper.get('[data-model-ref="llama-cpp/qwen"]').trigger("click");
    await flushPromises();
    expect(window.openclaw.model.session.select).toHaveBeenCalledWith({
      sessionKey: "agent:main:one",
      modelRef: "llama-cpp/qwen",
    });
    expect(window.openclaw.model.local.activate).not.toHaveBeenCalled();
  });

  it("clears the session override without selecting a guessed global default", async () => {
    vi.mocked(window.openclaw.model.session.get).mockResolvedValue({
      sessionKey: "agent:main:one",
      modelRef: "cloud/remote",
      overridden: true,
    });
    const wrapper = await open();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Use agent default")!
      .trigger("click");
    await flushPromises();
    expect(window.openclaw.model.session.select).toHaveBeenCalledWith({
      sessionKey: "agent:main:one",
      modelRef: null,
    });
  });

  it("shows errors without claiming a rejected or uncertain selection succeeded", async () => {
    vi.mocked(window.openclaw.model.session.select).mockRejectedValue(
      new Error("Selection could not be confirmed. Refresh before retrying."),
    );
    const wrapper = await open();
    await wrapper.get('[data-model-ref="cloud/remote"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("Refresh before retrying");
    expect(wrapper.get('[data-testid="chat-model-picker"]').attributes("aria-expanded")).toBe(
      "true",
    );
  });

  it("leaves cloud choices usable when local file metadata fails", async () => {
    vi.mocked(window.openclaw.model.local.getSnapshot).mockResolvedValue({
      ok: false,
      error: "Cannot inspect local files",
    });

    const wrapper = await open();
    await wrapper.get('[data-provider-group="llama-cpp"]').trigger("click");
    expect(wrapper.get('[role="alert"]').text()).toContain("Cannot inspect local files");
    expect(wrapper.get('[data-model-ref="llama-cpp/qwen"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-model-ref="cloud/remote"]').attributes("disabled")).toBeUndefined();
  });

  it("disables selection during a reply and while disconnected, but keeps management accessible", async () => {
    const wrapper = await open();
    await wrapper.setProps({ disabled: true });
    expect(wrapper.get('[data-model-ref="cloud/remote"]').attributes("disabled")).toBeDefined();
    await wrapper.setProps({ disabled: false, connected: false });
    await wrapper.get('[data-testid="chat-model-picker"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Connect to the Gateway");
    expect(wrapper.get('[data-model-ref="cloud/remote"]').attributes("disabled")).toBeDefined();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Manage model providers")!
      .trigger("click");
    expect(wrapper.emitted("manage")).toHaveLength(1);
  });

  it("defers policy enforcement to the Gateway instead of treating model metadata as an allowlist", async () => {
    vi.mocked(window.openclaw.config.read).mockResolvedValue({
      models: { providers: { cloud: { models: [{ id: "remote", name: "Cloud" }] } } },
      agents: {
        defaults: { modelPolicy: { allow: [] }, models: { "github-copilot/another": {} } },
      },
    });
    const wrapper = await open();
    expect(wrapper.get('[data-model-ref="cloud/remote"]').attributes("disabled")).toBeUndefined();
    await wrapper.get('[data-model-ref="cloud/remote"]').trigger("click");
    await flushPromises();
    expect(window.openclaw.model.session.select).toHaveBeenCalledWith({
      sessionKey: "agent:main:one",
      modelRef: "cloud/remote",
    });
  });

  it("does not apply a late selection result to a different conversation", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof window.openclaw.model.session.select>>) => void;
    vi.mocked(window.openclaw.model.session.select).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const wrapper = await open();
    await wrapper.get('[data-model-ref="cloud/remote"]').trigger("click");
    await wrapper.setProps({ sessionKey: "agent:main:two" });
    await flushPromises();
    resolve({ sessionKey: "agent:main:one", modelRef: "cloud/old-session", overridden: true });
    await flushPromises();
    expect(wrapper.get('[data-testid="chat-model-picker"]').attributes("title")).toBe(
      "cloud/remote",
    );
  });
});
