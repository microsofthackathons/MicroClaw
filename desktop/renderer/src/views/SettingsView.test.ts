import { createPinia } from "pinia";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/i18n";
import SettingsView from "./SettingsView.vue";

vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { section: "skills" } }),
}));

describe("SettingsView Skills section", () => {
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
          startMinimized: false,
          themeMode: "light",
          privacyLevel: "balanced",
        }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as typeof window.openclaw;
  });

  it("opens the existing Skills panel from the deep-linked Settings section", async () => {
    const wrapper = shallowMount(SettingsView, {
      global: {
        plugins: [createPinia()],
        stubs: {
          SkillsDevPanel: { template: '<div data-testid="skills-panel" />' },
        },
      },
    });

    await flushPromises();

    expect(wrapper.find('[data-testid="skills-panel"]').exists()).toBe(true);
    expect(wrapper.find(".settings-content--skills").exists()).toBe(true);
    expect(wrapper.find(".settings-menu-item.active").text()).toBe("Skills");
  });

  it("shows Gateway connection status in General and leaves Gateway focused on logs", async () => {
    const wrapper = shallowMount(SettingsView, {
      global: {
        plugins: [createPinia()],
        stubs: {
          SkillsDevPanel: true,
        },
      },
    });

    await flushPromises();

    const menuItems = wrapper.findAll(".settings-menu-item");
    await menuItems.find((item) => item.text() === "General")!.trigger("click");
    expect(wrapper.find(".settings-content").text()).toContain("Gateway");
    expect(wrapper.find(".settings-content").text()).toContain("Connection Status");
    expect(wrapper.find(".settings-content").text()).not.toContain("Gateway Logs");

    await menuItems.find((item) => item.text() === "Gateway")!.trigger("click");
    expect(wrapper.find(".settings-content").text()).toContain("Gateway Logs");
    expect(wrapper.find(".settings-content").text()).not.toContain("Connection Status");
  });
});
