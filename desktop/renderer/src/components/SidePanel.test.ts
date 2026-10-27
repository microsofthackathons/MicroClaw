import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, t } from "@/i18n";
import SidePanel from "./SidePanel.vue";
import sidePanelSource from "./SidePanel.vue?raw";

const mocks = vi.hoisted(() => ({
  getStats: vi.fn(),
  push: vi.fn(),
  gateway: {
    ready: true,
    status: "running",
    refreshWeixinStatus: vi.fn(),
  },
  chat: {
    wsConnected: true,
    messages: [],
    sessionKey: "test-session",
    currentSessionAgentId: "main",
    sessionTitleRefreshRevision: 0,
  },
  sessions: {
    sessions: [],
    setGatewayTitles: vi.fn(),
  },
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
  mocks.gateway.ready = true;
  mocks.gateway.status = "running";
  localStorage.clear();
  setLocale("en-US");
  mocks.getStats.mockResolvedValue({
    totalSpend: 42.35,
    totalTokens: 4_400_000,
    exchangeRate: 7.2,
  });
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
  const wrapper = mount(SidePanel);
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

describe("SidePanel token-only usage snapshot", () => {
  it.each([
    { locale: "en-US" as const, spendLabel: "Spend" },
    { locale: "zh-CN" as const, spendLabel: "花费" },
  ])("shows tokens without a monetary card in $locale", async ({ locale, spendLabel }) => {
    setLocale(locale);
    const wrapper = await mountPanel();
    const snapshot = wrapper.get(".sp-usage-snapshot");

    expect(snapshot.findAll(".sp-usage-card")).toHaveLength(1);
    expect(snapshot.get(".sp-usage-label").text()).toBe("Tokens");
    expect(snapshot.get(".sp-usage-value").text()).toBe("4.4M");
    expect(snapshot.text()).not.toContain(spendLabel);
    expect(snapshot.text()).not.toMatch(/[¥￥$]/);
    expect(snapshot.get(".sp-usage-foot").text()).toContain(t("sidebar.usageSnapshotPeriod"));
  });

  it("keeps the token card visible when usage is zero", async () => {
    mocks.getStats.mockResolvedValue({ totalSpend: 0, totalTokens: 0 });
    const wrapper = await mountPanel();

    expect(wrapper.findAll(".sp-usage-card")).toHaveLength(1);
    expect(wrapper.get(".sp-usage-value").text()).toBe("0");
  });

  it("shows incomplete background coverage next to the combined token total", async () => {
    mocks.getStats.mockResolvedValue({ totalTokens: 41_967, backgroundUsageAvailable: false });
    const wrapper = await mountPanel();
    expect(wrapper.get(".sp-usage-value").text()).toBe("42K");
    expect(wrapper.get('.sp-usage-snapshot [role="status"]').text()).toBe(
      t("usage.backgroundUnavailable"),
    );
  });

  it("uses a neutral placeholder without loading text before the first snapshot", async () => {
    let resolveStats!: (stats: { totalTokens: number }) => void;
    mocks.getStats.mockReturnValueOnce(
      new Promise<{ totalTokens: number }>((resolve) => {
        resolveStats = resolve;
      }),
    );
    const wrapper = await mountPanel();

    expect(wrapper.find(".sp-usage-state").exists()).toBe(false);
    expect(wrapper.get(".sp-usage-value").text()).toBe("—");
    expect(wrapper.text()).not.toContain(t("settings.usageLoading"));

    resolveStats({ totalTokens: 4_400_000 });
    await flushPromises();

    expect(wrapper.find(".sp-usage-state").exists()).toBe(false);
    expect(wrapper.get(".sp-usage-value").text()).toBe("4.4M");
  });

  it.each([
    { totalTokens: 4_400_000, label: "4.4M" },
    { totalTokens: 0, label: "0" },
  ])("keeps $label visible during background refresh", async ({ totalTokens, label }) => {
    mocks.getStats.mockResolvedValueOnce({ totalTokens });
    const wrapper = await mountPanel();
    const tokenCard = wrapper.get(".sp-usage-card").element;
    let resolveStats!: (stats: { totalTokens: number }) => void;
    mocks.getStats.mockReturnValueOnce(
      new Promise<{ totalTokens: number }>((resolve) => {
        resolveStats = resolve;
      }),
    );

    await vi.advanceTimersByTimeAsync(60_000);

    expect(mocks.getStats).toHaveBeenCalledTimes(2);
    expect(wrapper.find(".sp-usage-card").exists()).toBe(true);
    expect(wrapper.get(".sp-usage-card").element).toBe(tokenCard);
    expect(wrapper.get(".sp-usage-value").text()).toBe(label);
    expect(wrapper.find(".sp-usage-state").exists()).toBe(false);

    resolveStats({ totalTokens: 5_000_000 });
    await flushPromises();

    expect(wrapper.get(".sp-usage-card").element).toBe(tokenCard);
    expect(wrapper.get(".sp-usage-value").text()).toBe("5M");
  });

  it("refreshes tokens and stops polling when unmounted", async () => {
    const wrapper = await mountPanel();
    mocks.getStats.mockResolvedValue({ totalSpend: 99, totalTokens: 5_000_000 });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.getStats).toHaveBeenCalledTimes(2);
    expect(wrapper.get(".sp-usage-value").text()).toBe("5M");
    expect(wrapper.findAll(".sp-usage-card")).toHaveLength(1);

    wrappers.splice(wrappers.indexOf(wrapper), 1);
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.getStats).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous number and timestamp when a background refresh fails", async () => {
    const wrapper = await mountPanel();
    const footer = wrapper.get(".sp-usage-foot").text();
    mocks.getStats.mockRejectedValue(new Error("Gateway disconnected"));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(wrapper.get(".sp-usage-value").text()).toBe("4.4M");
    expect(wrapper.get(".sp-usage-foot").text()).toBe(footer);
    expect(wrapper.find(".sp-usage-state").exists()).toBe(false);
  });

  it("reads the cached number even when the Gateway is offline", async () => {
    mocks.gateway.ready = false;
    mocks.gateway.status = "stopped";
    mocks.getStats.mockResolvedValue({ totalTokens: 53_532 });
    const wrapper = await mountPanel();
    expect(mocks.getStats).toHaveBeenCalledTimes(1);
    expect(wrapper.get(".sp-usage-value").text()).toBe("53.5K");
    expect(wrapper.find(".sp-usage-state").exists()).toBe(false);
  });

  it("restores the saved total immediately without a loading flash", async () => {
    localStorage.setItem(
      "microclaw:usageSnapshot",
      JSON.stringify({ totalTokens: 53_532, updatedAt: Date.now() - 86_400_000 }),
    );
    mocks.getStats.mockRejectedValue(new Error("Gateway disconnected"));
    const wrapper = await mountPanel();
    expect(wrapper.get(".sp-usage-value").text()).toBe("53.5K");
    expect(wrapper.find(".sp-usage-state").exists()).toBe(false);
  });

  it("does not replace real data with malformed values or development mocks", async () => {
    const wrapper = await mountPanel();
    for (const totalTokens of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      mocks.getStats.mockResolvedValue({ totalTokens });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(wrapper.get(".sp-usage-value").text()).toBe("4.4M");
    }
  });

  it("allows a complete refreshed total to decrease to zero", async () => {
    const wrapper = await mountPanel();
    mocks.getStats.mockResolvedValue({ totalTokens: 0 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wrapper.get(".sp-usage-value").text()).toBe("0");
  });

  it("preserves the saved collapse preference and expands to tokens only", async () => {
    localStorage.setItem("microclaw:usageSnapshotCollapsed", "1");
    const wrapper = await mountPanel();
    const toggle = wrapper.get(".sp-usage-toggle");

    expect(wrapper.find(".sp-usage-card").exists()).toBe(false);
    expect(toggle.attributes("aria-label")).toBe(t("sidebar.usageSnapshotExpand"));

    await toggle.trigger("click");
    expect(localStorage.getItem("microclaw:usageSnapshotCollapsed")).toBe("0");
    expect(wrapper.findAll(".sp-usage-card")).toHaveLength(1);
    expect(toggle.attributes("aria-label")).toBe(t("sidebar.usageSnapshotCollapse"));

    await toggle.trigger("click");
    expect(localStorage.getItem("microclaw:usageSnapshotCollapsed")).toBe("1");
    expect(wrapper.find(".sp-usage-card").exists()).toBe(false);
  });

  it("keeps chat creation and settings navigation available", async () => {
    const wrapper = await mountPanel();

    await wrapper.get(".sp-create-btn").trigger("click");
    expect(mocks.push).toHaveBeenLastCalledWith("/chat/main");
    await wrapper.get(".sp-menu-item").trigger("click");
    expect(mocks.push).toHaveBeenLastCalledWith("/settings");
  });

  it("uses one full-width column for the remaining token card", () => {
    const gridRule = sidePanelSource.match(/\.sp-usage-grid\s*\{(?<body>[\s\S]*?)\}/)?.groups?.body;

    expect(gridRule).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });
});
