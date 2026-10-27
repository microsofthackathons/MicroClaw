import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/i18n";
import LocalModelCatalog from "./LocalModelCatalog.vue";
import { LOCAL_MODEL_PRESETS, type LocalModelCatalogEntry } from "../../../src/local-model-catalog";
import type { LocalModelHardware } from "../../../src/local-model-types";

const GIB = 1024 ** 3;
const catalog: LocalModelCatalogEntry[] = LOCAL_MODEL_PRESETS.map((preset) => ({
  ...preset,
  configured: false,
  fileStatus: "not-downloaded",
}));
const hardware: LocalModelHardware = {
  cpu: "Example CPU",
  totalMemoryBytes: 32 * GIB,
  availableMemoryBytes: 24 * GIB,
  accelerator: "cuda",
  gpus: [{ name: "Example GPU", totalMemoryBytes: 16 * GIB, availableMemoryBytes: 12 * GIB }],
};
describe("LocalModelCatalog", () => {
  beforeEach(() => setLocale("en-US"));

  it("shows measured hardware and one recommendation instead of four equal technical names", () => {
    const wrapper = mount(LocalModelCatalog, { props: { catalog, hardware } });
    expect(wrapper.text()).toContain("32 GB memory");
    expect(wrapper.text()).toContain("Example GPU");
    expect(wrapper.get(".machine-summary").attributes("title")).toContain(
      "32 GB memory · 24.0 GB available now",
    );
    expect(wrapper.get(".machine-summary").attributes("title")).toContain(
      "Example GPU · 16 GB VRAM",
    );
    const featured = wrapper.get('[data-testid="recommended-local-model"]');
    expect(featured.text()).toContain("Recommended for you");
    expect(featured.text()).toContain("Qwen3.5 9B");
    expect(featured.text()).toContain("At least 16 GB memory");
    expect(wrapper.text()).not.toMatch(/Q4_K_M|Prepare/);
    expect(wrapper.findAll(".model-row")).toHaveLength(3);
    expect(wrapper.emitted("select")).toBeUndefined();
  });

  it("emits only the chosen model reference and does not start a download", async () => {
    const wrapper = mount(LocalModelCatalog, { props: { catalog, hardware } });
    await wrapper.get(`[data-model-ref="${catalog[1].modelRef}"]`).trigger("click");
    expect(wrapper.emitted("select")).toEqual([[catalog[1].modelRef]]);
    await wrapper.get(`[data-model-ref="${catalog[0].modelRef}"]`).trigger("click");
    expect(wrapper.emitted("select")?.[1]).toEqual([catalog[0].modelRef]);
  });

  it("does not label the lightweight fallback as a hardware recommendation", () => {
    const wrapper = mount(LocalModelCatalog, { props: { catalog, hardware: null } });
    expect(wrapper.text()).toContain("A lightweight start");
    expect(wrapper.text()).toContain("Full specs are unavailable");
    expect(wrapper.text()).not.toContain("Recommended for you");
  });

  it("preserves an unknown cached-file status on the featured model", () => {
    const wrapper = mount(LocalModelCatalog, {
      props: {
        catalog: catalog.map(
          (model): LocalModelCatalogEntry => ({ ...model, fileStatus: "unknown" }),
        ),
        hardware,
      },
    });
    expect(wrapper.get('[data-testid="recommended-local-model"]').text()).toContain(
      "File status unknown",
    );
  });

  it("shows a local loading state without hiding choices or making a recommendation", () => {
    const wrapper = mount(LocalModelCatalog, { props: { catalog, hardware: null, loading: true } });
    expect(wrapper.text()).toContain("Reading your computer's specs");
    expect(wrapper.findAll("button[data-model-ref]")).toHaveLength(4);
    expect(wrapper.text()).not.toContain("Recommended for you");
  });

  it("does not push a download when current resources do not fit any model", () => {
    const wrapper = mount(LocalModelCatalog, {
      props: { catalog, hardware: { ...hardware, availableMemoryBytes: 2 * GIB } },
    });
    expect(wrapper.find('[data-testid="recommended-local-model"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="local-resources-limited"]').exists()).toBe(true);
    expect(wrapper.findAll(".model-row")).toHaveLength(4);
    expect(wrapper.text()).not.toContain("Recommended for you");
  });

  it("preserves read-only, streaming, and switching guards", async () => {
    const wrapper = mount(LocalModelCatalog, { props: { catalog, hardware, disabled: true } });
    expect(
      wrapper.findAll("button").every((button) => button.attributes("disabled") !== undefined),
    ).toBe(true);
    await wrapper.setProps({ disabled: false, busyModelRef: catalog[0].modelRef });
    expect(
      wrapper.get(`[data-model-ref="${catalog[0].modelRef}"]`).attributes("disabled"),
    ).toBeUndefined();
    expect(
      wrapper.get(`[data-model-ref="${catalog[1].modelRef}"]`).attributes("disabled"),
    ).toBeDefined();
    expect(wrapper.get(`[data-model-ref="${catalog[0].modelRef}"]`).text()).toBe("View progress");
  });

  it("keeps downloaded status and the current default distinct from a recommendation", () => {
    const wrapper = mount(LocalModelCatalog, {
      props: {
        catalog: catalog.map((model, index) =>
          index === 0 ? { ...model, fileStatus: "present" as const } : model,
        ),
        hardware,
        currentModelRef: catalog[0].modelRef,
      },
    });
    const current = wrapper.findAll(".model-row")[0];
    expect(current.text()).toContain("Current default");
    expect(current.text()).toContain("Downloaded");
    expect(current.get("button").text()).toBe("Start using");
    expect(wrapper.get('[data-testid="recommended-local-model"]').text()).not.toContain(
      "Current default",
    );
  });

  it("localizes the CPU recommendation and avoids claiming that no GPU exists", () => {
    setLocale("zh-CN");
    const wrapper = mount(LocalModelCatalog, {
      props: { catalog, hardware: { ...hardware, accelerator: "cpu", gpus: [] } },
    });
    expect(wrapper.text()).toContain("CPU 运行");
    expect(wrapper.get(".machine-summary").attributes("title")).toContain(
      "未检测到可用 NVIDIA 加速，按 CPU 估算",
    );
    expect(wrapper.get('[data-testid="recommended-local-model"]').text()).toContain("Qwen3.5 4B");
    expect(wrapper.text()).toContain("下载前需你确认");
    expect(wrapper.text()).toContain("需要 GPU 加速");
  });
});
