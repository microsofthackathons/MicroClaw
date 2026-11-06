import { createPinia, setActivePinia } from "pinia";
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

  it("keeps persisted Thinking content historical rather than creating a live activity signal", () => {
    const pinia = createPinia();
    const store = useChatStore(pinia);
    store.messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Past reasoning" },
          { type: "text", text: "Done" },
        ],
      },
    ];
    const wrapper = shallowMount(ChatMessageList, { global: { plugins: [pinia] } });
    expect(wrapper.text()).toContain("Thinking");
    expect(wrapper.text()).toContain("Done");
    expect(wrapper.find('[data-testid="chat-activity"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders only visible bubbles while keeping reasoning and tools in their group panels", async () => {
    const pinia = createPinia();
    const store = useChatStore(pinia);
    store.messages = [
      { role: "user", content: "Compare controller prices" },
      ...Array.from({ length: 50 }, (_, index) => ({
        role: "assistant",
        content: [{ type: "thinking", thinking: `Reasoning ${index}` }],
      })),
      { role: "assistant", content: [{ type: "reasoning", reasoning: "Price analysis" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "search", name: "search", input: { query: "prices" } }],
      },
      { role: "toolResult", content: [{ type: "text", text: "Search result" }] },
      { role: "assistant", content: [] },
      { role: "assistant", content: "   " },
      { role: "assistant", content: "\u001b[0m" },
      { role: "assistant", content: "<!-- step:1:done -->" },
      { role: "assistant", content: [{ type: "tool_use", name: "search", input: {} }] },
      { role: "assistant", content: "Controller comparison" },
    ];
    const wrapper = shallowMount(ChatMessageList, { global: { plugins: [pinia] } });

    expect(wrapper.findAll(".chat-bubble")).toHaveLength(2);
    expect(wrapper.get(".chat-group.user").text()).toContain("Compare controller prices");
    expect(wrapper.get(".chat-bubble.assistant").text()).toBe("Controller comparison");
    expect(wrapper.findAll(".chat-copy-btn")).toHaveLength(2);
    expect(wrapper.get(".exec-panel__count").text()).toBe("1");
    await wrapper.get(".context-panel__header").trigger("click");
    expect(wrapper.findAll(".thinking-block")).toHaveLength(51);
    expect(wrapper.text()).toContain("Price analysis");
    wrapper.unmount();
  });

  it("preserves mixed text and reasoning and the original indexes used to edit user messages", async () => {
    const pinia = createPinia();
    const store = useChatStore(pinia);
    store.messages = [
      { role: "user", content: "First question" },
      { role: "user", content: "Follow-up question" },
      { role: "assistant", content: [{ type: "thinking", thinking: "Hidden reasoning" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Mixed reasoning" },
          { type: "text", text: "Visible answer" },
          { type: "toolCall", id: "mixed", name: "search" },
        ],
      },
    ];
    const wrapper = shallowMount(ChatMessageList, { global: { plugins: [pinia] } });

    expect(wrapper.findAll(".chat-bubble.assistant")).toHaveLength(1);
    expect(wrapper.get(".chat-bubble.assistant").text()).toContain("Visible answer");
    await wrapper.findAll(".chat-bubble.user")[1].trigger("dblclick");
    expect((wrapper.get(".chat-edit-input").element as HTMLTextAreaElement).value).toBe(
      "Follow-up question",
    );
    wrapper.unmount();
  });

  it("keeps truthful activity visible after tools complete and live text arrives", async () => {
    const pinia = createPinia();
    const store = useChatStore(pinia);
    store.setMainSessionKey("agent:main:main");
    store.wsConnected = true;
    store.handleToolEvent({
      sessionKey: "agent:main:main",
      runId: "phone-run",
      stream: "tool",
      data: { phase: "start", name: "exec", toolCallId: "command" },
    });
    const wrapper = shallowMount(ChatMessageList, { global: { plugins: [pinia] } });
    expect(wrapper.get('[data-testid="chat-activity"]').text()).toBe("Running tool");
    store.handleToolEvent({
      sessionKey: "agent:main:main",
      runId: "phone-run",
      stream: "tool",
      data: { phase: "result", name: "exec", toolCallId: "command" },
    });
    store.handleChatEvent({
      sessionKey: "agent:main:main",
      runId: "phone-run",
      state: "delta",
      deltaText: "Preparing the result",
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="chat-activity"]').text()).toBe("Working");
    expect(wrapper.get('[data-testid="chat-activity"]').text()).not.toMatch(/Thinking/);
    store.handleChatEvent({
      sessionKey: "agent:main:main",
      runId: "phone-run",
      state: "status",
      lifecyclePhase: "end",
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="chat-activity"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("automatically removes preparation feedback after history becomes available", async () => {
    setLocale("zh-CN");
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useChatStore(pinia);
    const loadHistory = vi
      .spyOn(window.openclaw.chat, "loadHistory")
      .mockRejectedValueOnce(
        new Error("Agent main has not completed startup inspection and preparation."),
      )
      .mockResolvedValue({ messages: [] });
    await store.loadHistory();
    const wrapper = shallowMount(ChatMessageList, { global: { plugins: [pinia] } });

    expect(wrapper.get(".chat-error").attributes("role")).toBe("status");
    expect(wrapper.get(".chat-error").classes()).toContain("chat-error--waiting");
    expect(wrapper.text()).toContain("正在准备会话数据");
    expect(wrapper.find(".chat-error__actions").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("对话请求失败");

    await store.loadHistory({ showLoading: false });
    expect(loadHistory).toHaveBeenCalledTimes(2);
    expect(wrapper.find(".chat-error").exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps activity until the greeting run ends and removes the extra waiting group afterward", async () => {
    const pinia = createPinia();
    const store = useChatStore(pinia);
    const key = "agent:main:main";
    store.setMainSessionKey(key);
    store.wsConnected = true;
    vi.spyOn(window.openclaw.chat, "loadHistory").mockResolvedValue({
      sessionKey: key,
      messages: [
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好！有什么需要我帮忙的吗？" },
      ],
      sessionInfo: { key, hasActiveRun: true, activeRunIds: ["greeting"] },
    });
    store.handleChatEvent({
      sessionKey: key,
      runId: "greeting",
      state: "status",
      lifecyclePhase: "start",
    });
    await store.loadHistory({ passive: true });
    const wrapper = shallowMount(ChatMessageList, { global: { plugins: [pinia] } });
    expect(wrapper.text()).toContain("你好！有什么需要我帮忙的吗？");
    expect(wrapper.find('[data-testid="chat-activity"]').exists()).toBe(true);

    store.handleChatEvent({
      sessionKey: key,
      runId: "greeting",
      state: "status",
      lifecyclePhase: "end",
    });
    await store.loadHistory({ passive: true });
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("你好！有什么需要我帮忙的吗？");
    expect(wrapper.find('[data-testid="chat-activity"]').exists()).toBe(false);
    expect(wrapper.find(".chat-waiting-gif").exists()).toBe(false);
    wrapper.unmount();
  });
});
