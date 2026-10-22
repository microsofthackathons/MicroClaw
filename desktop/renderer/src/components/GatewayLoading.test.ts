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

  it("shows MXC progress instead of claiming a healthy Gateway is ready", () => {
    const wrapper = shallowMount(GatewayLoading, {
      props: {
        status: "running",
        connected: false,
        warming: false,
        mxcDesired: true,
        mxcPhase: "smoking-locked",
        mxcRequestedMode: "limited-dacl",
        mxcEffectiveStrength: "off",
      },
    });

    expect(wrapper.find(".loading-status").text()).toContain(
      "Running internal probes in locked generation",
    );
    expect(wrapper.find(".loading-status").text()).not.toContain("Ready");
    expect(wrapper.find(".loading-mxc-strength").text()).toBe(
      "Limited containment (DACL) — Starting",
    );
    expect(wrapper.find(".loading-mxc-strength").text()).not.toContain("Attested");
    expect(wrapper.text()).not.toMatch(/approve|permission|allow once/i);
  });

  it("shows validation while persisted mode is Off without jumping to connected 90%", async () => {
    vi.useFakeTimers();
    const wrapper = shallowMount(GatewayLoading, {
      props: {
        status: "running",
        connected: false,
        warming: false,
        mxcDesired: false,
        mxcPhase: "validating",
        mxcDetail: "Assessing Limited-mode ambient filesystem access",
        mxcRequestedMode: "off",
        mxcEffectiveStrength: "off",
      },
    });

    expect(wrapper.find(".loading-status").text()).toContain("Validating policy");
    expect(wrapper.find(".loading-mxc-detail").text()).toBe(
      "Assessing Limited-mode ambient filesystem access",
    );
    expect(wrapper.find(".loading-status").text()).not.toContain("Ready");
    await wrapper.setProps({ connected: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(Number.parseInt(wrapper.find(".loading-pct").text(), 10)).toBeLessThanOrEqual(35);
    expect(wrapper.find(".loading-status").text()).not.toContain("90%");
    wrapper.unmount();
    vi.useRealTimers();
  });

  it("shows in-process policy promotion as a guarded startup phase", () => {
    const wrapper = shallowMount(GatewayLoading, {
      props: {
        status: "running",
        connected: true,
        warming: false,
        mxcDesired: true,
        mxcPhase: "promoting-active",
      },
    });

    expect(wrapper.find(".loading-status").text()).toContain(
      "Promoting verified policy in the current generation",
    );
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

  it("does not expose a conflicting retry when the Gateway timer expires mid-transition", () => {
    const wrapper = shallowMount(GatewayLoading, {
      props: {
        status: "timeout",
        connected: false,
        warming: false,
        mxcDesired: true,
        mxcPhase: "starting-locked",
        mxcRequestedMode: "limited-dacl",
        mxcEffectiveStrength: "off",
      },
    });

    expect(wrapper.find(".loading-status").text()).toContain("Starting locked generation");
    expect(wrapper.find(".loading-mxc-strength").text()).toBe(
      "Limited containment (DACL) — Starting",
    );
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
