import { createPinia } from "pinia";
import { shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserOpenClawMock } from "@/browser-openclaw";
import { setLocale } from "@/i18n";
import { useChatStore } from "@/stores/chat";
import ChatMessageList from "./ChatMessageList.vue";

vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe("chat waiting feedback", () => {
  beforeEach(() => {
    setLocale("en-US");
    window.openclaw = createBrowserOpenClawMock();
  });

  it("shows a waiting notice without directing the user to change model settings", () => {
    const pinia = createPinia();
    const store = useChatStore(pinia);
    store.lastError = { code: "response_delayed", source: "watchdog" };
    const wrapper = shallowMount(ChatMessageList, { global: { plugins: [pinia] } });
    expect(wrapper.get(".chat-error").attributes("role")).toBe("status");
    expect(wrapper.get(".chat-error").classes()).toContain("chat-error--waiting");
    expect(wrapper.find(".chat-error__btn--primary").exists()).toBe(false);
    expect(wrapper.text()).toContain("reply is taking longer");
    wrapper.unmount();
  });

  it("retains the real network-error alert and model-settings action", () => {
    const pinia = createPinia();
    const store = useChatStore(pinia);
    store.lastError = { code: "network", raw: "ECONNREFUSED" };
    const wrapper = shallowMount(ChatMessageList, { global: { plugins: [pinia] } });
    expect(wrapper.get(".chat-error").attributes("role")).toBe("alert");
    expect(wrapper.find(".chat-error__btn--primary").exists()).toBe(true);
    wrapper.unmount();
  });
});
