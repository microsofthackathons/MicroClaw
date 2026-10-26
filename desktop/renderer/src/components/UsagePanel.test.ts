import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUsagePanel } from "@/composables/useUsagePanel";
import { setLocale, t } from "@/i18n";
import UsagePanel from "./UsagePanel.vue";

const mocks = vi.hoisted(() => ({ getDetailedStats: vi.fn(), push: vi.fn() }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/stores/gateway", () => ({
  useGatewayStore: () => ({ ready: true, status: "running" }),
}));
vi.mock("@/stores/chat", () => ({ useChatStore: () => ({ lastError: null }) }));

const wrappers: Array<ReturnType<typeof mount>> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useUsagePanel().close();
  setLocale("zh-CN");
  mocks.getDetailedStats.mockResolvedValue({
    totals: { totalTokens: 41_967, input: 37_050, output: 4917 },
    usageSources: [
      { source: "session", tokens: 36_109 },
      { source: "memory", tokens: 5858 },
      { source: "background", tokens: 0 },
    ],
    requestCount: 6,
    aggregates: { daily: [], messages: { total: 7 }, tools: { totalCalls: 2 } },
    sessions: [{ key: "agent:main:main" }],
    backgroundUsageAvailable: true,
  });
  vi.stubGlobal("openclaw", { usage: { getDetailedStats: mocks.getDetailedStats } });
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  useUsagePanel().close();
  setLocale("en-US");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function openPanel() {
  const wrapper = mount(UsagePanel);
  wrappers.push(wrapper);
  useUsagePanel().open();
  await flushPromises();
  await vi.advanceTimersByTimeAsync(300);
  await flushPromises();
  return wrapper;
}

describe("usage source accounting", () => {
  it("shows the combined total and distinguishes memory from session usage", async () => {
    const wrapper = await openPanel();
    const sources = wrapper.get('[data-testid="usage-sources"]');
    const rows = sources.findAll(".usage-source-row");
    expect(rows.map((row) => row.text())).toEqual([
      `${t("usage.sourceSession")}36,109`,
      `${t("usage.sourceMemory")}5,858`,
      `${t("usage.sourceBackground")}0`,
    ]);
    expect(wrapper.findAll(".stat-value")[0].text()).toBe("41,967");
    expect(wrapper.get(".chip-row").text()).toContain(`6 ${t("usage.requestsLabel")}`);
    expect(wrapper.get(".chip-row").text()).toContain(`1 ${t("usage.sessionsLabel")}`);
    expect(sources.text()).toContain(t("usage.accountingHint"));
    expect(wrapper.find(".usage-accounting-warning").exists()).toBe(false);
  });

  it("shows a coverage warning without discarding cached usage", async () => {
    const stats = await mocks.getDetailedStats();
    mocks.getDetailedStats.mockResolvedValue({ ...stats, backgroundUsageAvailable: false });
    const wrapper = await openPanel();
    expect(wrapper.get(".usage-accounting-warning").text()).toBe(t("usage.backgroundUnavailable"));
    expect(wrapper.findAll(".stat-value")[0].text()).toBe("41,967");
  });
});
