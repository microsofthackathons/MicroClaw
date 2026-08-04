import { createPinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/i18n";
import AgentMarketView from "./AgentMarketView.vue";

const { successMessage, errorMessage } = vi.hoisted(() => ({
  successMessage: vi.fn(),
  errorMessage: vi.fn(),
}));

vi.mock("element-plus", () => ({
  ElMessage: {
    success: successMessage,
    error: errorMessage,
  },
  ElMessageBox: {
    confirm: vi.fn(),
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("AgentMarketView", () => {
  const agentsAdd = vi.fn();

  beforeEach(() => {
    setLocale("en-US");
    successMessage.mockReset();
    errorMessage.mockReset();
    agentsAdd.mockReset();
    window.openclaw = {
      agents: {
        list: vi.fn(),
        add: agentsAdd,
        remove: vi.fn(),
      },
    } as unknown as typeof window.openclaw;
  });

  it("shows progress and confirms a successful agent addition", async () => {
    const addition = deferred<{
      agents: { id: string; name: string }[];
    }>();
    agentsAdd.mockReturnValueOnce(addition.promise);
    const wrapper = mount(AgentMarketView, {
      global: { plugins: [createPinia()] },
    });
    const addButton = wrapper.find(".agent-card-action");

    await addButton.trigger("click");

    expect(addButton.attributes("disabled")).toBeDefined();
    expect(addButton.attributes("aria-busy")).toBe("true");
    expect(addButton.text()).toBe("Adding...");

    addition.resolve({
      agents: [
        { id: "main", name: "Assistant" },
        { id: "master-archive", name: "Master Archive" },
      ],
    });
    await flushPromises();

    expect(agentsAdd).toHaveBeenCalledWith("master-archive");
    expect(successMessage).toHaveBeenCalledWith("Master Archive was added.");
    expect(wrapper.find(".agent-card-action").text()).toBe("Remove");
  });
});
