import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, t } from "@/i18n";
import SidePanel from "./SidePanel.vue";

const mocks = vi.hoisted(() => ({
  getStats: vi.fn(),
  push: vi.fn(),
  gateway: { ready: true, status: "running", refreshWeixinStatus: vi.fn() },
  chat: {
    wsConnected: true,
    messages: [],
    sessionKey: "test-session",
    currentSessionAgentId: "main",
    sessionTitleRefreshRevision: 0,
  },
  sessions: { sessions: [], setGatewayTitles: vi.fn() },
  agents: {
    currentAgentId: "main",
    agents: [{ id: "main", name: "MicroClaw", avatar: "" }],
  },
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: mocks.push }),
  useRoute: () => ({ name: "chat", path: "/chat/main" }),
}));
vi.mock("@/stores/gateway", () => ({ useGatewayStore: () => mocks.gateway }));
vi.mock("@/stores/chat", () => ({ useChatStore: () => mocks.chat }));
vi.mock("@/stores/sessions", () => ({ useSessionStore: () => mocks.sessions }));
vi.mock("@/stores/agents", () => ({ useAgentStore: () => mocks.agents }));

const wrappers: Array<ReturnType<typeof mount>> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  setLocale("en-US");
  vi.stubGlobal("openclaw", { usage: { getStats: mocks.getStats } });
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  localStorage.clear();
  setLocale("en-US");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mountPanel() {
  const wrapper = mount(SidePanel, {
    global: {
      stubs: {
        WeixinConnectionShortcut: {
          name: "WeixinConnectionShortcut",
          template: "<button>WeChat</button>",
        },
      },
    },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

describe("SidePanel WeChat footer", () => {
  it.each(["en-US", "zh-CN"] as const)(
    "replaces usage with a WeChat shortcut in %s",
    async (locale) => {
      setLocale(locale);
      const wrapper = await mountPanel();
      expect(
        wrapper.get(".sp-footer").findComponent({ name: "WeixinConnectionShortcut" }).exists(),
      ).toBe(true);
      expect(wrapper.find(".sp-usage-snapshot").exists()).toBe(false);
      expect(wrapper.text()).not.toContain(t("sidebar.usageSnapshotTitle"));
      expect(wrapper.text()).not.toContain("Tokens");
    },
  );

  it("does not fetch usage or start its former background polling", async () => {
    localStorage.setItem(
      "microclaw:usageSnapshot",
      JSON.stringify({ totalTokens: 123, updatedAt: Date.now() }),
    );
    const wrapper = await mountPanel();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(mocks.getStats).not.toHaveBeenCalled();
    expect(mocks.gateway.refreshWeixinStatus).not.toHaveBeenCalled();
    expect(wrapper.find(".sp-usage-card").exists()).toBe(false);
  });

  it("keeps chat creation and settings navigation available", async () => {
    const wrapper = await mountPanel();
    await wrapper.get(".sp-create-btn").trigger("click");
    expect(mocks.push).toHaveBeenLastCalledWith("/chat/main");
    await wrapper.get(".sp-menu-item").trigger("click");
    expect(mocks.push).toHaveBeenLastCalledWith("/settings");
  });
});
