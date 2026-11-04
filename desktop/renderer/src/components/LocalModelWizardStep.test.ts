import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/i18n";
import LocalModelWizardStep from "./LocalModelWizardStep.vue";
import type { LocalModelStep } from "../../../src/local-model-types";

describe("LocalModelWizardStep", () => {
  beforeEach(() => setLocale("en-US"));
  const open = (step: LocalModelStep) =>
    mount(LocalModelWizardStep, { props: { step, disabled: false } });

  it("preserves typed select values rather than sending option indexes or labels", async () => {
    const wrapper = open({
      id: "select",
      type: "select",
      options: [{ label: "CPU", value: { backend: "cpu" } }],
    });
    expect(wrapper.get("button").attributes("disabled")).toBeDefined();
    await wrapper.get("select").setValue(0);
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("answer")).toEqual([[{ backend: "cpu" }]]);
  });

  it("sends a typed multiselect list", async () => {
    const wrapper = open({
      id: "multi",
      type: "multiselect",
      options: [
        { label: "First", value: 5 },
        { label: "Second", value: { id: "embedding" } },
      ],
    });
    await wrapper.findAll("input")[0].setValue(true);
    await wrapper.findAll("input")[1].setValue(true);
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("answer")).toEqual([[[5, { id: "embedding" }]]]);
  });

  it.each(["note", "action"] as const)(
    "allows an explicit Continue for a client %s",
    async (type) => {
      const wrapper = open({
        id: type,
        type,
        executor: "client",
        message: "Review this instruction",
      });
      await wrapper.get("form").trigger("submit");
      expect(wrapper.emitted("answer")).toEqual([[undefined]]);
    },
  );

  it("requires a click for true confirmation and prevents Enter from consenting", async () => {
    const wrapper = open({ id: "confirm", type: "confirm", initialValue: true });
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("answer")).toBeUndefined();
    await wrapper.findAll("button")[1].trigger("click");
    expect(wrapper.emitted("answer")).toEqual([[true]]);
  });

  it("does not let the concise card auto-consent or change the answer type", async () => {
    const wrapper = mount(LocalModelWizardStep, {
      props: {
        step: { id: "summary", type: "confirm", initialValue: true, message: "Original consent" },
        disabled: false,
        downloadSummary: { modelName: "Qwen3.5 9B", downloadGB: 6, backend: "cpu" },
      },
    });
    expect(wrapper.get("details").attributes("open")).toBeUndefined();
    expect(wrapper.text()).toContain("Runtime components are an additional download");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("answer")).toBeUndefined();
    const decline = wrapper.findAll("button").find((button) => button.text() === "Not now")!;
    await decline.trigger("click");
    expect(wrapper.emitted("answer")).toEqual([[false]]);
  });
});
