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
});
