import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { ConfiguredModel } from "@/utils/configured-models";
import ModelProviderGroups from "./ModelProviderGroups.vue";

describe("ModelProviderGroups", () => {
  it("only shows supported Qwen models together while retaining other providers", async () => {
    const models: ConfiguredModel[] = [
      { providerKey: "qwen", id: "qwen3.8-27b", name: "Selected", source: "managed" },
      { providerKey: "qwen", id: "cmaas-qwen3.8-flash", name: "Flash", source: "managed" },
      { providerKey: "qwen", id: "qwen3.5-plus", name: "Plus", source: "managed" },
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
      "qwen/qwen3.8-27b",
      "qwen/cmaas-qwen3.8-flash",
      "qwen/qwen3.5-plus",
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
    expect(wrapper.find('[data-model-ref="qwen/kimi/kimi-k3.1-pro"]').exists()).toBe(false);
    expect(wrapper.find('[data-model-ref="qwen/qwen-image-2.1-pro"]').exists()).toBe(false);
    expect(wrapper.find('[data-model-ref="qwen/qwen3.8-omni-flash-realtime"]').exists()).toBe(
      false,
    );
    expect(wrapper.get('[data-provider-group="qwen"] .model-group-count').text()).toBe("3");

    await wrapper.get('[data-model-ref="qwen/cmaas-qwen3.8-flash"]').trigger("click");
    expect(wrapper.emitted("select")).toEqual([["qwen/cmaas-qwen3.8-flash"]]);
    await wrapper.setProps({ selectedModel: "qwen/cmaas-qwen3.8-flash" });
    expect(modelRefs()).toEqual([
      "qwen/cmaas-qwen3.8-flash",
      "qwen/qwen3.5-plus",
      "llama-cpp/local-model",
    ]);
    const more = wrapper.get('[data-more-models="qwen"]');
    expect(more.attributes("aria-expanded")).toBe("false");
    await more.trigger("click");
    expect(modelRefs()).toEqual([
      "qwen/cmaas-qwen3.8-flash",
      "qwen/qwen3.5-plus",
      "qwen/qwen3.8-27b",
      "llama-cpp/local-model",
    ]);
    expect(more.attributes("aria-expanded")).toBe("true");

    await wrapper.setProps({ query: "qwen3.8" });
    expect(wrapper.findAll("[data-model-ref]")).toHaveLength(2);
    expect(wrapper.find('[data-more-models="qwen"]').exists()).toBe(false);
    await wrapper.setProps({ query: "kimi" });
    expect(wrapper.findAll("[data-model-ref]")).toHaveLength(0);
    wrapper.unmount();
  });

  it("collapses the remaining catalog, searches it directly, and retains an unfeatured selection", async () => {
    const models: ConfiguredModel[] = [
      "qwen3.6-plus",
      "qwen3.5-plus",
      "qwen3.8-max-2026-10-01",
      "qwen3.8-flash",
      "qwen3.8-max",
      "qwen3.7-plus",
    ].map((id) => ({ providerKey: "qwen", id, name: id, source: "managed" }));
    const wrapper = mount(ModelProviderGroups, {
      props: { models, selectedModel: "qwen/qwen3.7-plus", query: "" },
    });
    const modelRefs = () =>
      wrapper.findAll("[data-model-ref]").map((entry) => entry.attributes("data-model-ref"));
    const featured = [
      "qwen/qwen3.8-max",
      "qwen/qwen3.8-flash",
      "qwen/qwen3.7-plus",
      "qwen/qwen3.5-plus",
    ];
    expect(modelRefs()).toEqual(featured);
    expect(wrapper.findAll(".model-recommended")).toHaveLength(1);
    expect(wrapper.emitted("select")).toBeUndefined();
    await wrapper.get('[data-more-models="qwen"]').trigger("click");
    expect(modelRefs()).toEqual([...featured, "qwen/qwen3.8-max-2026-10-01", "qwen/qwen3.6-plus"]);
    await wrapper.get('[data-more-models="qwen"]').trigger("click");
    await wrapper.setProps({ query: "3.6" });
    expect(modelRefs()).toEqual(["qwen/qwen3.6-plus"]);
    expect(wrapper.find('[data-more-models="qwen"]').exists()).toBe(false);
    await wrapper.get('[data-model-ref="qwen/qwen3.6-plus"]').trigger("click");
    expect(wrapper.emitted("select")).toEqual([["qwen/qwen3.6-plus"]]);
    await wrapper.setProps({ query: "", selectedModel: "qwen/qwen3.6-plus" });
    expect(modelRefs()).toEqual(["qwen/qwen3.6-plus", ...featured]);
    expect(wrapper.get('[data-more-models="qwen"]').attributes("aria-expanded")).toBe("false");
    wrapper.unmount();
  });
});
