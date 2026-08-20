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
      },
    });

    expect(wrapper.find(".loading-status").text()).toContain("Testing locked generation");
    expect(wrapper.find(".loading-status").text()).not.toContain("Ready");
  });

  it("shows fail-closed recovery without labeling MXC failure as a Gateway outage", async () => {
    const wrapper = shallowMount(GatewayLoading, {
      props: {
        status: "running",
        connected: false,
        warming: false,
        mxcDesired: true,
        mxcPhase: "locked",
        mxcDetail: "Attended PowerShell check was denied",
      },
    });

    expect(wrapper.find(".loading-status").text()).toContain("MXC readiness failed");
    expect(wrapper.find(".loading-error-detail").text()).toBe(
      "Attended PowerShell check was denied",
    );
    expect(wrapper.findAll(".loading-retry")).toHaveLength(2);

    await wrapper.find(".loading-disable-mxc").trigger("click");
    expect(wrapper.emitted("disable-mxc")).toHaveLength(1);
  });
});
