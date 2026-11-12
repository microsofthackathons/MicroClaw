import { defineComponent, h } from "vue";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserOpenClawMock } from "@/browser-openclaw";
import SetupWizard from "./SetupWizard.vue";

vi.mock("vue-router", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

const Input = defineComponent({
  props: { modelValue: String, placeholder: String },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    return () =>
      h("input", {
        value: props.modelValue,
        placeholder: props.placeholder,
        onInput: (event: Event) =>
          emit("update:modelValue", (event.target as HTMLInputElement).value),
      });
  },
});
const Button = defineComponent({
  setup(_, { slots, attrs }) {
    return () => h("button", attrs, slots.default?.());
  },
});

describe("initial model setup", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports an unavailable setup status instead of silently continuing", async () => {
    const api = createBrowserOpenClawMock();
    api.config.initialSetupRequired = vi.fn().mockRejectedValue(new Error("IPC unavailable"));
    api.config.needsSetup = vi.fn().mockResolvedValue(true);
    api.config.readEnv = vi.fn().mockResolvedValue({});
    window.openclaw = api;
    const wrapper = shallowMount(SetupWizard);
    await flushPromises();

    expect(wrapper.text()).toContain("IPC unavailable");
    expect(api.config.needsSetup).not.toHaveBeenCalled();
    expect(api.config.readEnv).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it.each([false, true])(
    "submits a separate configuration snapshot for a new Gateway=%s",
    async (fresh) => {
      const before = fresh
        ? null
        : { gateway: { port: 18789, mode: "local" }, agents: { entries: { main: {} } } };
      const original = structuredClone(before);
      const write = vi.fn(
        (
          _config: unknown,
          _expected?: unknown,
          _intent?: { kind: "initial-setup"; providerKey: string },
        ) => new Promise<void>(() => {}),
      );
      const api = createBrowserOpenClawMock();
      api.config.initialSetupRequired = vi.fn().mockResolvedValue(fresh);
      api.config.needsSetup = vi.fn().mockResolvedValue(true);
      api.config.readEnv = vi.fn().mockResolvedValue({});
      api.config.read = vi.fn().mockResolvedValue(before);
      api.config.write = write;
      window.openclaw = api;
      const wrapper = shallowMount(SetupWizard, {
        global: { stubs: { "el-input": Input, "el-button": Button } },
      });
      await flushPromises();
      if (fresh) expect(api.config.needsSetup).not.toHaveBeenCalled();
      await wrapper.get('input[placeholder="sk-..."]').setValue("fixture-key");
      await wrapper.get('input[placeholder="gpt-4o"]').setValue("fixture-model");
      await wrapper.get("button").trigger("click");
      await flushPromises();
      expect(write).toHaveBeenCalledOnce();
      const [next, expected, intent] = write.mock.calls[0];
      expect(expected).toEqual(original);
      expect(before).toEqual(original);
      expect(intent).toEqual({ kind: "initial-setup", providerKey: "custom" });
      expect(next).toMatchObject({
        models: {
          providers: { custom: { apiKey: "fixture-key", models: [{ id: "fixture-model" }] } },
        },
        agents: { defaults: { model: { primary: "custom/fixture-model" } } },
      });
      const nextGateway = (next as { gateway: { auth: { token: string } } }).gateway;
      if (fresh) {
        expect(nextGateway).toMatchObject({
          bind: "loopback",
          mode: "local",
          auth: { mode: "token" },
        });
        expect(nextGateway.auth.token).toMatch(/^[a-f0-9]{32}$/);
      } else {
        expect(nextGateway).toEqual(original!.gateway);
      }
      wrapper.unmount();
    },
  );
});
