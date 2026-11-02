import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, t } from "@/i18n";
import SidePanel from "./SidePanel.vue";
import type { Session } from "@/stores/sessions";
import { isMainSessionKey } from "../../../src/main-session-key";

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
    mainSessionKey: "agent:main:main",
    isMainSession: vi.fn(),
    resetSession: vi.fn(),
    deleteSession: vi.fn(),
    switchSession: vi.fn(),
  },
  sessions: {
    sessions: [] as Session[],
    setGatewayTitles: vi.fn(),
    getDisplayTitle: vi.fn((session: Session) => session.title),
  },
  listSessionTitles: vi.fn(),
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
const storage = new Map<string, string>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  });
  mocks.sessions.sessions = [];
  mocks.chat.mainSessionKey = "agent:main:main";
  mocks.chat.isMainSession.mockImplementation((key: string) =>
    isMainSessionKey(key, mocks.chat.mainSessionKey),
  );
  mocks.chat.resetSession.mockResolvedValue(undefined);
  mocks.chat.deleteSession.mockResolvedValue(undefined);
  mocks.listSessionTitles.mockResolvedValue({ titles: {} });
  mocks.agents.currentAgentId = "main";
  mocks.agents.agents = [{ id: "main", name: "MicroClaw", avatar: "" }];
  localStorage.clear();
  setLocale("en-US");
  vi.stubGlobal("openclaw", {
    usage: { getStats: mocks.getStats },
    chat: { listSessionTitles: mocks.listSessionTitles },
  });
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

describe("SidePanel session actions", () => {
  function addSession(key: string, agentId = "main") {
    mocks.sessions.sessions.push({
      key,
      agentId,
      title: "Existing conversation",
      preview: "hello",
      createdAt: 1,
      updatedAt: 1,
    });
    mocks.agents.currentAgentId = agentId;
    mocks.agents.agents = [{ id: agentId, name: agentId, avatar: "" }];
  }

  it.each(["main", "writer"])("offers Reset for the %s agent's main session", async (agentId) => {
    addSession(`agent:${agentId}:main`, agentId);
    const wrapper = await mountPanel();
    const action = wrapper.get(".sp-chat-item-reset");

    expect(action.attributes("title")).toBe("Reset");
    expect(action.attributes("aria-label")).toBe("Reset");
    expect(action.findComponent({ name: "IconReset" }).exists()).toBe(true);
    expect(wrapper.find(".sp-chat-item-delete").exists()).toBe(false);
    await action.trigger("click");

    expect(mocks.chat.resetSession).toHaveBeenCalledExactlyOnceWith(`agent:${agentId}:main`);
    expect(mocks.chat.deleteSession).not.toHaveBeenCalled();
    expect(mocks.chat.switchSession).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("keeps Delete for ordinary sessions", async () => {
    addSession("agent:main:session-123");
    const wrapper = await mountPanel();
    const action = wrapper.get(".sp-chat-item-delete");

    expect(action.attributes("title")).toBe("Delete");
    expect(action.findComponent({ name: "IconClose" }).exists()).toBe(true);
    expect(wrapper.find(".sp-chat-item-reset").exists()).toBe(false);
    await action.trigger("click");

    expect(mocks.chat.deleteSession).toHaveBeenCalledExactlyOnceWith("agent:main:session-123");
    expect(mocks.chat.resetSession).not.toHaveBeenCalled();
    expect(mocks.chat.switchSession).not.toHaveBeenCalled();
  });

  it("also shows the requested Reset tooltip in Chinese", async () => {
    setLocale("zh-CN");
    addSession("agent:main:main");
    const wrapper = await mountPanel();
    expect(wrapper.get(".sp-chat-item-reset").attributes("title")).toBe("Reset");
  });
});
