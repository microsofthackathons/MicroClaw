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
      mxc: {
        getStatus: vi.fn().mockResolvedValue({
          ready: false,
          packageReady: true,
          hashReady: true,
          osSupported: true,
          policyReady: true,
          workerReady: false,
          sdkVersion: "0.7.0",
          policyVersion: "0.7.0-alpha",
          upstreamCommit: "34d7fe2b4b3226bd4d11dc4a32419b7ec198a88b",
          architecture: "x64",
          binaryHash: "pinned-hash",
          isolationTier: "appcontainer-dacl",
          isolationWarnings: [],
          requiresHostPreparation: true,
          lastError: "DACL fallback refused",
          agents: [
            {
              id: "main",
              name: "Assistant",
              desired: { readonlyPaths: [], readwritePaths: [] },
              effective: { readonlyPaths: [], readwritePaths: [], workspace: null },
            },
          ],
        }),
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

  it("shows honest fail-closed Microsoft MXC readiness", async () => {
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();
    await wrapper
      .findAll(".settings-menu-item")
      .find((item) => item.text() === "Security")!
      .trigger("click");
    await flushPromises();

    const text = wrapper.find(".settings-content").text();
    expect(wrapper.find("el-alert").attributes("title")).toBe(
      "Microsoft MXC public preview experiment",
    );
    expect(text).toContain("Blocked (fail closed)");
    expect(text).toContain("DACL fallback refused");
    expect(text).not.toContain("Tool sandbox (AppContainer)");
  });
});
