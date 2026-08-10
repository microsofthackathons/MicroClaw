import { createPinia } from "pinia";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/i18n";
import { useGatewayStore } from "@/stores/gateway";
import SettingsView from "./SettingsView.vue";

vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { section: "skills" } }),
}));

describe("SettingsView", () => {
  const exportGatewayLogs = vi.fn();
  const getDockerBindings = vi.fn();
  const addDockerBinding = vi.fn();

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
          privacyLevel: "balanced",
        }),
        set: vi.fn().mockResolvedValue(undefined),
      },
      logs: {
        exportGateway: exportGatewayLogs,
      },
      dockerSandbox: {
        check: vi.fn().mockResolvedValue({
          checkedAt: new Date().toISOString(),
          ready: true,
          reasons: [],
          windows: { status: "ready", reason: "ready" },
          wslCommand: { status: "ready", reason: "ready" },
          wsl2: { status: "ready", reason: "ready" },
          dockerCli: { status: "ready", reason: "ready" },
          dockerDaemon: { status: "ready", reason: "ready" },
          linuxContainers: { status: "ready", reason: "ready" },
          image: { status: "ready", reason: "ready" },
        }),
        getBindings: getDockerBindings,
        addBinding: addDockerBinding,
        removeBinding: vi.fn(),
        retryBindings: vi.fn(),
      },
    } as unknown as typeof window.openclaw;
    exportGatewayLogs.mockReset().mockResolvedValue({
      canceled: false,
      filePath: "C:\\Logs\\gateway.log",
    });
    getDockerBindings.mockReset().mockResolvedValue({
      agents: [
        {
          id: "main",
          name: "Main",
          bindings: [
            {
              source: "C:\\Work\\Reference",
              target: "/mnt/microclaw/reference-1234567890",
              access: "ro",
            },
          ],
        },
      ],
      statuses: { main: { effective: "applied" } },
    });
    addDockerBinding.mockReset().mockImplementation(async () => getDockerBindings());
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

  it("shows per-agent Docker bindings and uses the narrow picker API", async () => {
    const wrapper = shallowMount(SettingsView, {
      global: {
        plugins: [createPinia()],
      },
    });
    await flushPromises();
    await wrapper
      .findAll(".settings-menu-item")
      .find((item) => item.text() === "Security")!
      .trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("Per-agent Windows folder access");
    expect(wrapper.text()).toContain("C:\\Work\\Reference");
    expect(wrapper.text()).toContain("/mnt/microclaw/reference-1234567890");
    await wrapper
      .findAll("el-button")
      .find((button) => button.text() === "Add folder")!
      .trigger("click");
    await flushPromises();
    expect(addDockerBinding).toHaveBeenCalledWith({ agentId: "main", access: "ro" });
  });
});
