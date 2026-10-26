import { createPinia, setActivePinia } from "pinia";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserOpenClawMock } from "@/browser-openclaw";
import { setLocale } from "@/i18n";
import { useChatStore } from "@/stores/chat";
import ChatView from "./ChatView.vue";

vi.mock("vue-router", () => ({
  useRoute: () => ({ params: {} }),
  useRouter: () => ({ push: vi.fn() }),
}));

describe("ChatView agent preparation", () => {
  beforeEach(() => {
    setLocale("zh-CN");
    window.openclaw = createBrowserOpenClawMock();
  });

  it("shows preparation in an empty session and keeps the draft until an explicit send", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useChatStore(pinia);
    store.wsConnected = true;
    vi.spyOn(window.openclaw.chat, "loadHistory")
      .mockRejectedValueOnce(
        new Error("Agent main has not completed startup inspection and preparation."),
      )
      .mockResolvedValue({ messages: [] });
    const sendMessage = vi.spyOn(window.openclaw.chat, "sendMessage");
    await store.loadHistory();
    const wrapper = shallowMount(ChatView, { global: { plugins: [pinia] } });
    const input = wrapper.get("textarea");
    await input.setValue("Keep this draft");

    expect(wrapper.findComponent({ name: "ChatMessageList" }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: "ChatWelcome" }).exists()).toBe(false);
    expect(input.attributes("disabled")).toBeUndefined();
    expect(input.attributes("placeholder")).toBe("正在准备会话数据");
    expect(wrapper.get(".home-input-send").attributes("disabled")).toBeDefined();
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(sendMessage).not.toHaveBeenCalled();

    await store.loadHistory({ showLoading: false });
    await flushPromises();
    expect((input.element as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(wrapper.get(".home-input-send").attributes("disabled")).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect((input.element as HTMLTextAreaElement).value).toBe("");
    wrapper.unmount();
  });
});
