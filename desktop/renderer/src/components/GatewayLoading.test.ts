import { shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/i18n";
import GatewayLoading from "./GatewayLoading.vue";

describe("GatewayLoading MXC lifecycle", () => {
  beforeEach(() => {
    setLocale("en-US");
    window.openclaw = {
      window: {
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizeChange: vi.fn().mockReturnValue(() => undefined),
      },
    } as unknown as typeof window.openclaw;
  });

  it("shows generic startup progress instead of containment text", () => {
    const wrapper = shallowMount(GatewayLoading, {
      props: {
        status: "running",
        connected: false,
        warming: false,
        mxcDesired: true,
        mxcPhase: "smoking-locked",
      },
    });

    expect(wrapper.find(".loading-status").text()).toContain("Starting services");
    expect(wrapper.find(".loading-status").text()).not.toContain("Ready");
    expect(wrapper.find(".loading-mxc-strength").exists()).toBe(false);
    expect(wrapper.text()).not.toMatch(/approve|permission|allow once|containment|sandbox/i);
  });

  it("keeps validation details hidden without jumping to connected 90%", async () => {
    vi.useFakeTimers();
    const wrapper = shallowMount(GatewayLoading, {
      props: {
        status: "running",
        connected: false,
        warming: false,
        mxcDesired: false,
        mxcPhase: "validating",
        mxcDetail: "Checking BaseContainer availability",
      },
    });

    expect(wrapper.find(".loading-status").text()).toContain("Starting services");
    expect(wrapper.text()).not.toContain("Checking BaseContainer availability");
    expect(wrapper.find(".loading-status").text()).not.toContain("Ready");
    await wrapper.setProps({ connected: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(Number.parseInt(wrapper.find(".loading-pct").text(), 10)).toBeLessThanOrEqual(35);
    expect(wrapper.find(".loading-status").text()).not.toContain("90%");
    wrapper.unmount();
    vi.useRealTimers();
  });

  it("keeps in-process policy promotion generic", () => {
    const wrapper = shallowMount(GatewayLoading, {
      props: {
        status: "running",
        connected: true,
        warming: false,
        mxcDesired: true,
        mxcPhase: "promoting-active",
      },
    });

    expect(wrapper.find(".loading-status").text()).toContain("Starting services");
    expect(wrapper.find(".loading-status").text()).not.toContain("Ready");
  });

  it("shows an intentional managed replacement as reconnecting", () => {
    const wrapper = shallowMount(GatewayLoading, {
      props: {
        status: "restarting",
        connected: false,
        warming: false,
      },
    });

    expect(wrapper.find(".loading-status").text()).toContain("Reconnecting services");
    expect(wrapper.find(".loading-status").text()).not.toContain("Disconnected");
  });

  it("uses generic text while switching Off", async () => {
    const wrapper = shallowMount(GatewayLoading, {
      props: {
        status: "restarting",
        connected: false,
        warming: false,
        mxcDesired: true,
        mxcPhase: "disabling",
      },
    });
    expect(wrapper.find(".loading-status").text()).toContain("Starting services");
    expect(wrapper.find(".loading-mxc-strength").exists()).toBe(false);
    await wrapper.setProps({ mxcPhase: "starting-standard" });
    expect(wrapper.find(".loading-status").text()).toContain("Starting services");
    expect(wrapper.find(".loading-mxc-strength").exists()).toBe(false);
    await wrapper.setProps({ mxcDesired: false });
    expect(wrapper.find(".loading-mxc-strength").exists()).toBe(false);
    wrapper.unmount();
  });

  it("does not expose a conflicting retry when the Gateway timer expires mid-transition", () => {
    const wrapper = shallowMount(GatewayLoading, {
      props: {
        status: "timeout",
        connected: false,
        warming: false,
        mxcDesired: true,
        mxcPhase: "starting-locked",
      },
    });

    expect(wrapper.find(".loading-status").text()).toContain("Starting services");
    expect(wrapper.find(".loading-mxc-strength").exists()).toBe(false);
    expect(wrapper.find(".loading-retry").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Gateway startup timed out");
  });

  it("shows fail-closed recovery without labeling MXC failure as a Gateway outage", async () => {
    const wrapper = shallowMount(GatewayLoading, {
      props: {
        status: "running",
        connected: false,
        warming: false,
        mxcDesired: true,
        mxcPhase: "locked",
        mxcDetail: "Internal PowerShell probe failed to start",
      },
    });

    expect(wrapper.find(".loading-status").text()).toContain("MXC readiness failed");
    expect(wrapper.find(".loading-error-detail").text()).toBe(
      "Internal PowerShell probe failed to start",
    );
    expect(wrapper.findAll(".loading-retry")).toHaveLength(2);

    await wrapper.find(".loading-disable-mxc").trigger("click");
    expect(wrapper.emitted("disable-mxc")).toHaveLength(1);
  });
});
