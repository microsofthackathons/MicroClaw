import { createPinia } from "pinia";
import { flushPromises, shallowMount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { ElMessage } from "element-plus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/i18n";
import { useGatewayStore } from "@/stores/gateway";
import SettingsView from "./SettingsView.vue";

vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { section: "skills" } }),
}));

describe("SettingsView", () => {
  const exportGatewayLogs = vi.fn();

  beforeEach(() => {
    setLocale("en-US");
    window.openclaw = {
      config: {
        read: vi.fn().mockResolvedValue(null),
      },
      settings: {
        get: vi.fn().mockResolvedValue({
          language: "en-US",
          autoStart: false,
          minimizeToTray: false,
          themeMode: "light",
          privacyLevel: "basic",
        }),
        set: vi.fn().mockResolvedValue(undefined),
      },
      logs: {
        exportGateway: exportGatewayLogs,
      },
    } as unknown as typeof window.openclaw;
    exportGatewayLogs.mockReset().mockResolvedValue({
      canceled: false,
      filePath: "C:\\Logs\\gateway.log",
    });
  });

  it("hides the development-only Skills section by default", async () => {
    const wrapper = shallowMount(SettingsView, {
      global: {
        plugins: [createPinia()],
      },
    });

    await flushPromises();

    expect(wrapper.find(".settings-content--skills").exists()).toBe(false);
    expect(wrapper.findAll(".settings-menu-item").some((item) => item.text() === "Skills")).toBe(
      false,
    );
    expect(wrapper.find(".settings-menu-item.active").text()).toBe("General");
  });

  it("shows Gateway status and log export at the end of General", async () => {
    const pinia = createPinia();
    useGatewayStore(pinia).addLog("[info] Gateway started");
    const wrapper = shallowMount(SettingsView, {
      global: {
        plugins: [pinia],
      },
    });

    await flushPromises();

    const menuItems = wrapper.findAll(".settings-menu-item");
    await menuItems.find((item) => item.text() === "General")!.trigger("click");
    expect(wrapper.find(".settings-content").text()).toContain("Gateway");
    expect(wrapper.find(".settings-content").text()).toContain("Connection status");
    expect(wrapper.find(".settings-content").text()).toContain("Logs");
    expect(wrapper.find(".settings-content").text()).toContain("Gateway logs");
    expect(menuItems.some((item) => item.text() === "Gateway")).toBe(false);

    await wrapper
      .findAll("el-button")
      .find((button) => button.text() === "Export")!
      .trigger("click");
    await flushPromises();

    expect(exportGatewayLogs).toHaveBeenCalledWith(["[info] Gateway started"]);
  });
});

describe("SettingsView search autosave events", () => {
  function control(tag: "select" | "option" | "input") {
    return defineComponent({
      name: `Search${tag}Control`,
      props: {
        modelValue: { type: String, default: "" },
        label: { type: String, default: "" },
        value: { type: String, default: "" },
      },
      emits: ["update:modelValue", "change", "blur", "keyup"],
      setup(props, { emit, slots }) {
        return () =>
          h(
            tag,
            {
              value: tag === "option" ? props.value : props.modelValue,
              onChange(event: Event) {
                emit("update:modelValue", (event.target as HTMLSelectElement).value);
                emit("change");
              },
              onInput: (event: Event) =>
                emit("update:modelValue", (event.target as HTMLInputElement).value),
              onBlur: () => emit("blur"),
              onKeyup: (event: KeyboardEvent) => emit("keyup", event),
            },
            tag === "option" ? props.label : slots.default?.(),
          );
      },
    });
  }
  const Select = control("select"),
    Option = control("option"),
    Input = control("input");
  let wrappers: VueWrapper[];
  let config: Record<string, unknown>;
  let read: ReturnType<typeof vi.fn>;
  let write: ReturnType<typeof vi.fn>;
  let toast: ReturnType<typeof vi.spyOn>;
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }
  async function mountSearch() {
    const wrapper = shallowMount(SettingsView, {
      global: {
        plugins: [createPinia()],
        stubs: { "el-select": Select, "el-option": Option, "el-input": Input },
      },
    });
    wrappers.push(wrapper);
    await flushPromises();
    await wrapper
      .findAll(".settings-menu-item")
      .find((item) => item.text() === "Models")!
      .trigger("click");
    await flushPromises();
    // Count only search operations, after the component's initial/model-section reads.
    read.mockClear();
    write.mockClear();
    return wrapper;
  }
  const provider = (wrapper: VueWrapper) => wrapper.find('select[style*="130px"]');
  const key = (wrapper: VueWrapper) => wrapper.find("input.provider-key-input");
  const status = (wrapper: VueWrapper) => wrapper.find(".sub-label-row .status-indicator");

  beforeEach(() => {
    wrappers = [];
    setLocale("en-US");
    config = {
      models: {},
      unrelated: { keep: true },
      tools: {
        web: {
          search: { provider: "brave", apiKey: "BSA-initial" },
          fetch: { enabled: true },
          searchProviders: { legacy: true },
        },
      },
    };
    read = vi.fn(async () => structuredClone(config));
    write = vi.fn(async (next) => {
      config = next;
    });
    toast = vi.spyOn(ElMessage, "error").mockImplementation(() => ({ close: vi.fn() }));
    window.openclaw = {
      config: { read, write },
      model: {
        listGitHubCopilotModels: vi.fn().mockResolvedValue([]),
        getGitHubCopilotStatus: vi.fn().mockResolvedValue({ authenticated: false }),
      },
      settings: {
        get: vi
          .fn()
          .mockResolvedValue({ language: "en-US", themeMode: "light", privacyLevel: "basic" }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as typeof window.openclaw;
  });
  afterEach(() => {
    wrappers.forEach((wrapper) => wrapper.unmount());
    toast.mockRestore();
  });

  it("keeps captured Brave intent when switching to invalid Tavily during read", async () => {
    const wrapper = await mountSearch();
    const pending = deferred<unknown>();
    read.mockImplementationOnce(() => pending.promise);
    await key(wrapper).setValue("  BSA-new  ");
    await key(wrapper).trigger("keyup", { key: "Enter" });
    await provider(wrapper).setValue("tavily");
    expect(status(wrapper).classes()).toContain("status-indicator--error");
    pending.resolve(structuredClone(config));
    await flushPromises();
    expect(write).toHaveBeenCalledOnce();
    expect(config).toMatchObject({
      unrelated: { keep: true },
      tools: {
        web: { search: { provider: "brave", apiKey: "BSA-new" }, fetch: { enabled: true } },
      },
    });
    expect((config.tools as { web: object }).web).not.toHaveProperty("searchProviders");
    expect(status(wrapper).classes()).toContain("status-indicator--error");
    expect(toast).not.toHaveBeenCalled();
  });

  it("deduplicates Enter/blur, serializes writes, and saves the latest valid provider/key", async () => {
    const wrapper = await mountSearch();
    const pending = deferred<void>();
    write.mockImplementationOnce(async (next) => {
      await pending.promise;
      config = next;
    });
    await key(wrapper).setValue("BSA-new");
    await key(wrapper).trigger("keyup", { key: "Enter" });
    await key(wrapper).trigger("blur");
    await provider(wrapper).setValue("tavily");
    await key(wrapper).setValue("tvly-old");
    await key(wrapper).trigger("blur");
    await key(wrapper).setValue("tvly-latest");
    await key(wrapper).trigger("keyup", { key: "Enter" });
    expect(write).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve();
    await flushPromises();
    expect(write).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(2);
    expect(config).toMatchObject({
      tools: { web: { search: { provider: "tavily", apiKey: "tvly-latest" } } },
    });
    expect(status(wrapper).classes()).toContain("status-indicator--ok");
    await key(wrapper).setValue("tvly-unsaved");
    expect(status(wrapper).exists()).toBe(false);
  });

  it("does not mark an edited form saved when its pending write completes", async () => {
    const wrapper = await mountSearch();
    const pending = deferred<void>();
    write.mockImplementationOnce(() => pending.promise);
    await key(wrapper).setValue("BSA-writing");
    await key(wrapper).trigger("blur");
    await key(wrapper).setValue("BSA-unsaved");
    pending.resolve();
    await flushPromises();
    expect(status(wrapper).exists()).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    await key(wrapper).trigger("blur");
    await flushPromises();
    expect(write).toHaveBeenCalledTimes(2);
    expect(status(wrapper).classes()).toContain("status-indicator--ok");
  });

  it.each([
    { label: "null", value: null },
    { label: "array", value: [] },
    { label: "undefined", value: undefined },
  ])("does not write a replacement config after unavailable read: $label", async ({ value }) => {
    const wrapper = await mountSearch();
    read.mockResolvedValueOnce(value);
    await provider(wrapper).setValue("parallel-free");
    await flushPromises();
    expect(write).not.toHaveBeenCalled();
    expect(status(wrapper).classes()).toContain("status-indicator--error");
    expect(toast).toHaveBeenCalledOnce();
  });

  it("shows read/write errors without retry and preserves a newer validation error", async () => {
    const wrapper = await mountSearch();
    read.mockRejectedValueOnce(new Error("read failed"));
    await key(wrapper).trigger("blur");
    await flushPromises();
    expect(write).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
    write.mockRejectedValueOnce(new Error("write failed"));
    await key(wrapper).trigger("blur");
    await flushPromises();
    expect(write).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(2);
    const pending = deferred<void>();
    write.mockImplementationOnce(() => pending.promise);
    await key(wrapper).setValue("BSA-old");
    await key(wrapper).trigger("blur");
    await provider(wrapper).setValue("tavily");
    const invalid = status(wrapper).text();
    pending.reject(new Error("stale failure"));
    await flushPromises();
    expect(status(wrapper).text()).toBe(invalid);
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it("does not start a write after unmount while config read is pending", async () => {
    const wrapper = await mountSearch();
    const pending = deferred<unknown>();
    read.mockImplementationOnce(() => pending.promise);
    await key(wrapper).trigger("blur");
    wrapper.unmount();
    wrappers = [];
    pending.resolve({});
    await flushPromises();
    expect(write).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("saves the keyless provider without retaining a previous provider key", async () => {
    const wrapper = await mountSearch();
    await provider(wrapper).setValue("parallel-free");
    await flushPromises();
    expect(config).toMatchObject({ tools: { web: { search: { provider: "parallel-free" } } } });
    expect((config.tools as { web: { search: object } }).web.search).not.toHaveProperty("apiKey");
    expect(key(wrapper).exists()).toBe(false);
    expect(status(wrapper).classes()).toContain("status-indicator--ok");
  });

  it.each([
    ["brave", ""],
    ["brave", "wrong"],
    ["tavily", "tvlywrong"],
  ])("retains the existing validation for %s / %s", async (selected, value) => {
    const wrapper = await mountSearch();
    if (selected !== "brave") await provider(wrapper).setValue(selected);
    await key(wrapper).setValue(value);
    await key(wrapper).trigger("blur");
    await flushPromises();
    expect(write).not.toHaveBeenCalled();
    expect(status(wrapper).classes()).toContain("status-indicator--error");
  });

  it("drops queued events and UI errors after unmount during write", async () => {
    const wrapper = await mountSearch();
    const pending = deferred<void>();
    write.mockImplementationOnce(() => pending.promise);
    await key(wrapper).trigger("blur");
    await provider(wrapper).setValue("parallel-free");
    wrapper.unmount();
    wrappers = [];
    pending.reject(new Error("disposed"));
    await flushPromises();
    expect(write).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });
});
