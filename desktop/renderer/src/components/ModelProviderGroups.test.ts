import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { ConfiguredModel } from "@/utils/configured-models";
import ModelProviderGroups from "./ModelProviderGroups.vue";

describe("ModelProviderGroups", () => {
  it("sorts families within the existing provider level without hiding or pinning models", async () => {
    const models: ConfiguredModel[] = [
      { providerKey: "qwen", id: "qwen3.8-27b", name: "Selected", source: "managed" },
      { providerKey: "llama-cpp", id: "local-model", name: "Local", source: "custom" },
      { providerKey: "qwen", id: "kimi/kimi-k3.1-pro", name: "Kimi", source: "managed" },
      { providerKey: "qwen", id: "qwen-image-2.1-pro", name: "Image", source: "managed" },
      {
        providerKey: "qwen",
        id: "qwen3.8-omni-flash-realtime",
        name: "Realtime",
        source: "managed",
      },
    ];
    const wrapper = mount(ModelProviderGroups, {
      props: { models, selectedModel: "qwen/qwen3.8-27b", query: "" },
    });
    const modelRefs = () =>
      wrapper.findAll("[data-model-ref]").map((entry) => entry.attributes("data-model-ref"));
    const expectedOrder = [
      "qwen/kimi/kimi-k3.1-pro",
      "qwen/qwen-image-2.1-pro",
      "qwen/qwen3.8-27b",
      "qwen/qwen3.8-omni-flash-realtime",
      "llama-cpp/local-model",
    ];

    expect(
      wrapper
        .findAll("[data-provider-group]")
        .map((entry) => entry.attributes("data-provider-group")),
    ).toEqual(["qwen", "llama-cpp"]);
    expect(wrapper.findAll(".model-group")).toHaveLength(2);
    expect(wrapper.findAll("h4")).toHaveLength(2);
    expect(modelRefs()).toEqual(expectedOrder);
    expect(wrapper.get('[data-model-ref="qwen/qwen3.8-27b"]').attributes("aria-pressed")).toBe(
      "true",
    );
    expect(
      wrapper.get('[data-model-ref="qwen/qwen-image-2.1-pro"]').attributes("disabled"),
    ).toBeDefined();
    expect(
      wrapper.get('[data-model-ref="qwen/qwen3.8-omni-flash-realtime"]').attributes("disabled"),
    ).toBeDefined();

    await wrapper.get('[data-model-ref="qwen/kimi/kimi-k3.1-pro"]').trigger("click");
    expect(wrapper.emitted("select")).toEqual([["qwen/kimi/kimi-k3.1-pro"]]);
    await wrapper.setProps({ selectedModel: "qwen/kimi/kimi-k3.1-pro" });
    expect(modelRefs()).toEqual(expectedOrder);

    await wrapper.setProps({ query: "qwen3.8" });
    expect(wrapper.findAll("[data-model-ref]")).toHaveLength(2);
    wrapper.unmount();
  });
});
