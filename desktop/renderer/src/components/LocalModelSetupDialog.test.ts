import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/i18n";
import LocalModelSetupDialog from "./LocalModelSetupDialog.vue";
import { LOCAL_MODEL_PRESETS } from "../../../src/local-model-catalog";
import type {
  LocalModelAPI,
  LocalModelCapabilities,
  LocalModelDetection,
  LocalModelOperation,
  LocalModelResult,
  LocalModelSnapshot,
} from "../../../src/local-model-types";

const ok = <T>(value: T): LocalModelResult<T> => ({ ok: true, value });
const operation = (patch: Partial<LocalModelOperation> = {}): LocalModelOperation => ({
  id: "prepare-1",
  kind: "prepare",
  phase: "starting",
  authChoice: "llama-cpp",
  agentId: "main",
  busy: true,
  cancellationPending: false,
  ...patch,
});
const capabilities: LocalModelCapabilities = {
  gatewayVersion: "2026.9.3",
  supported: true,
  mutable: true,
  blockers: [],
  plugin: { installed: true, enabled: true, canInstall: false },
};
const detection: LocalModelDetection = {
  choices: [
    { id: "llama-cpp", label: "Official managed" },
    { id: "llama-cpp-existing-server", label: "Official existing" },
  ],
  candidates: [
    {
      kind: "prepared-model",
      modelRef: "llama-cpp/exact",
      label: "Exact",
      detail: "Official candidate details",
      recommended: true,
    },
  ],
  agentId: "main",
};
const snapshot: LocalModelSnapshot = {
  models: [{ modelRef: "llama-cpp/exact", name: "Exact" }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("LocalModelSetupDialog", () => {
  let api: LocalModelAPI;
  let listener: (value: LocalModelOperation) => void;
  const unsubscribe = vi.fn();
  const wrappers: Array<ReturnType<typeof mount>> = [];
  async function open(props = {}) {
    const wrapper = mount(LocalModelSetupDialog, { props });
    wrappers.push(wrapper);
    await flushPromises();
    return wrapper;
  }
  beforeEach(() => {
    setLocale("en-US");
    api = {
      getSnapshot: vi.fn().mockResolvedValue(ok(snapshot)),
      getCapabilities: vi.fn().mockResolvedValue(ok(capabilities)),
      detect: vi.fn().mockResolvedValue(ok(detection)),
      inspectProvider: vi.fn().mockResolvedValue(
        ok({
          pluginId: "llama-cpp",
          source: "official catalog",
          version: "2026.9.3",
          capabilities: { permissions: ["Download model files", "Start local runtime"] },
          reviewToken: "review-1",
        }),
      ),
      installProvider: vi.fn().mockResolvedValue(ok(capabilities)),
      prepare: vi.fn().mockResolvedValue(ok(operation())),
      activate: vi.fn().mockResolvedValue(ok(operation({ kind: "activate", phase: "activating" }))),
      answer: vi.fn().mockResolvedValue(ok(operation())),
      cancel: vi.fn().mockResolvedValue(ok(operation({ cancellationPending: true }))),
      getOperation: vi.fn().mockResolvedValue(ok(null)),
      resume: vi.fn().mockResolvedValue(ok(operation())),
      onEvent: vi.fn((callback) => {
        listener = callback;
        return unsubscribe;
      }),
    };
    window.openclaw = { model: { local: api } } as unknown as typeof window.openclaw;
  });
  afterEach(() => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
    vi.clearAllMocks();
  });

  it("switches a prepared preset from the provider panel without opening another modal or duplicating success", async () => {
    const preset = LOCAL_MODEL_PRESETS[0];
    vi.mocked(api.getSnapshot).mockResolvedValue(
      ok({
        models: [{ modelRef: preset.modelRef, name: preset.name, fileStatus: "present" }],
        catalog: [{ ...preset, configured: true, fileStatus: "present" }],
      }),
    );
    const callbacks = new Set<(value: LocalModelOperation) => void>();
    vi.mocked(api.onEvent).mockImplementation((callback) => {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    });
    const activation = operation({
      id: "fixed-activate",
      kind: "activate",
      phase: "activating",
      modelRef: preset.modelRef,
    });
    vi.mocked(api.activate).mockResolvedValue(ok(activation));
    const wrapper = await open({ inline: true });
    const button = wrapper.get(`[data-model-ref="${preset.modelRef}"]`);
    await button.trigger("click");
    await flushPromises();
    for (const callback of callbacks) callback(activation);
    await flushPromises();
    expect(button.text()).toContain("Switching...");
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.attributes("aria-busy")).toBe("true");
    expect(document.body.querySelector(".download-overlay")).toBeNull();
    for (const callback of callbacks) callback({ ...activation, phase: "ready", busy: false });
    await flushPromises();
    expect(wrapper.emitted("configured")).toHaveLength(1);
    expect(wrapper.emitted("close")).toHaveLength(1);
    expect(api.activate).toHaveBeenCalledExactlyOnceWith({
      kind: "existing-model",
      modelRef: preset.modelRef,
    });
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it("keeps recovery and cancellation available when new configuration changes are locked", async () => {
    vi.mocked(api.getCapabilities).mockResolvedValue(ok({ ...capabilities, mutable: false }));
    vi.mocked(api.getOperation).mockResolvedValue(ok(operation({ phase: "interrupted" })));
    const wrapper = await open();
    expect(wrapper.get('[data-testid="local-resume"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.get('[data-testid="local-cancel"]').attributes("disabled")).toBeUndefined();
    await wrapper.get('[data-testid="local-resume"]').trigger("click");
    expect(api.resume).toHaveBeenCalledOnce();
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.answer).not.toHaveBeenCalled();
  });

  it("updates the exact target when another saved model is chosen while the inline editor stays open", async () => {
    vi.mocked(api.getSnapshot).mockResolvedValue(
      ok({
        models: [
          { modelRef: "llama-cpp/first", name: "First", fileStatus: "present" },
          { modelRef: "llama-cpp/second", name: "Second", fileStatus: "present" },
        ],
      }),
    );
    const wrapper = await open({ inline: true, targetModelRef: "llama-cpp/first" });
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    await wrapper.setProps({ targetModelRef: "llama-cpp/second" });
    await wrapper.get('[data-testid="local-activate"]').trigger("click");
    expect(api.activate).toHaveBeenCalledWith({
      kind: "existing-model",
      modelRef: "llama-cpp/second",
    });
    expect(api.detect).not.toHaveBeenCalled();
  });

  it("shows saved models before a slow status refresh without running full discovery", async () => {
    const status = deferred<LocalModelResult<LocalModelCapabilities>>();
    vi.mocked(api.getSnapshot).mockResolvedValue(
      ok({ ...snapshot, configuredModel: "llama-cpp/exact" }),
    );
    vi.mocked(api.getCapabilities).mockReturnValue(status.promise);
    const wrapper = await open();
    expect(wrapper.get('[data-testid="configured-local-models"]').text()).toContain("Exact");
    expect(wrapper.get('[data-testid="configured-local-models"]').text()).toContain(
      "Current default",
    );
    expect(wrapper.find('[data-testid="local-activate"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="local-current-done"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("Refreshing status in the background");
    expect(wrapper.get('[data-testid="local-close"]').attributes("disabled")).toBeUndefined();
    expect(api.detect).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="local-close"]').trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
    status.resolve(ok(capabilities));
    await flushPromises();
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.activate).not.toHaveBeenCalled();
  });

  it("reopens and refreshes known state without any full model discovery", async () => {
    const first = await open();
    first.unmount();
    const wrapper = await open();
    await wrapper.get('[data-testid="local-refresh"]').trigger("click");
    await flushPromises();
    expect(api.getSnapshot).toHaveBeenCalledTimes(3);
    expect(api.detect).not.toHaveBeenCalled();
    expect(api.installProvider).not.toHaveBeenCalled();
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it("shows a download recovery action instead of preparing a deleted configured model for use", async () => {
    vi.mocked(api.getSnapshot).mockResolvedValue(
      ok({
        models: [{ modelRef: "llama-cpp/exact", name: "Qwen 9B", fileStatus: "missing" }],
        configuredModel: "llama-cpp/exact",
      }),
    );
    const wrapper = await open({ targetModelRef: "llama-cpp/exact" });
    expect(wrapper.get('[data-testid="configured-local-models"]').text()).toContain(
      "Download needed",
    );
    expect(wrapper.get('[data-testid="configured-local-models"]').text()).not.toContain(
      "Current default",
    );
    expect(wrapper.get('[data-testid="local-files-missing"]').text()).toContain(
      "files are missing",
    );
    expect(wrapper.find('[data-testid="local-activate"]').exists()).toBe(false);
    expect(wrapper.find("#local-candidate").exists()).toBe(false);
    expect(wrapper.find('[data-testid="local-current-done"]').exists()).toBe(false);
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.activate).not.toHaveBeenCalled();
    expect(api.detect).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="local-download-again"]').trigger("click");
    expect(api.prepare).toHaveBeenCalledExactlyOnceWith({ authChoice: "llama-cpp" });
    expect(api.answer).not.toHaveBeenCalled();
  });

  it("does not offer a missing model returned by full discovery and does not show a stale ready receipt", async () => {
    vi.mocked(api.getSnapshot).mockResolvedValue(
      ok({
        models: [{ modelRef: "llama-cpp/exact", name: "Qwen 9B", fileStatus: "missing" }],
      }),
    );
    vi.mocked(api.getOperation).mockResolvedValue(
      ok(
        operation({
          kind: "activate",
          phase: "ready",
          busy: false,
          modelRef: "llama-cpp/exact",
        }),
      ),
    );
    const wrapper = await open();
    await wrapper.get('[data-testid="local-discover"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="local-activate"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="local-operation"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="local-download-again"]').exists()).toBe(true);
    expect(wrapper.emitted("configured")).toBeUndefined();
  });

  it("reports unknown file state without claiming that externally managed files were deleted", async () => {
    vi.mocked(api.getSnapshot).mockResolvedValue(
      ok({
        models: [
          { modelRef: "llama-cpp/exact", name: "Managed", fileStatus: "unknown" },
          { modelRef: "llama-cpp/external", name: "External", fileStatus: "external" },
        ],
      }),
    );
    const wrapper = await open();
    expect(wrapper.get('[data-testid="configured-local-models"]').text()).toContain(
      "File status unknown",
    );
    expect(wrapper.find('[data-testid="local-download-again"]').exists()).toBe(false);
  });

  it("clears the missing-file notice after preparation restores the file", async () => {
    vi.mocked(api.getSnapshot)
      .mockResolvedValueOnce(
        ok({
          models: [{ modelRef: "llama-cpp/exact", name: "Qwen 9B", fileStatus: "missing" }],
        }),
      )
      .mockResolvedValue(
        ok({
          models: [{ modelRef: "llama-cpp/exact", name: "Qwen 9B", fileStatus: "present" }],
        }),
      );
    const wrapper = await open();
    listener(operation({ phase: "prepared", busy: false, preparedModelRef: "llama-cpp/exact" }));
    await flushPromises();
    expect(wrapper.find('[data-testid="local-files-missing"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="local-activate"]').attributes("disabled")).toBeUndefined();
    expect(api.detect).not.toHaveBeenCalled();
  });

  it("still shows saved models if a background plugin status lookup fails", async () => {
    vi.mocked(api.getCapabilities).mockResolvedValue({
      ok: false,
      error: "Plugin status unavailable",
    });
    const wrapper = await open();
    expect(wrapper.get('[data-testid="configured-local-models"]').text()).toContain("Exact");
    expect(wrapper.text()).toContain("Plugin status unavailable");
    expect(wrapper.get('[data-testid="local-close"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.get('[data-testid="local-activate"]').attributes("disabled")).toBeDefined();
    expect(api.detect).not.toHaveBeenCalled();
  });

  it("does not hide configuration read errors behind an apparently empty model list", async () => {
    vi.mocked(api.getSnapshot).mockResolvedValue({ ok: false, error: "Saved config unavailable" });
    const wrapper = await open();
    expect(wrapper.text()).toContain("Saved config unavailable");
    expect(api.detect).not.toHaveBeenCalled();
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it("reads saved state on mount without full discovery and separates prepared from ready", async () => {
    const wrapper = await open();
    expect(wrapper.text()).toContain("MicroClaw does not add automatic cloud fallback");
    expect(wrapper.text()).toContain(
      "Existing OpenClaw fallback settings may still route requests",
    );
    expect(api.getCapabilities).toHaveBeenCalledOnce();
    expect(api.getSnapshot).toHaveBeenCalledOnce();
    expect(api.detect).not.toHaveBeenCalled();
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.installProvider).not.toHaveBeenCalled();
    expect(api.activate).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="prepare-llama-cpp"]').trigger("click");
    expect(api.onEvent).toHaveBeenCalledBefore(vi.mocked(api.prepare));
    listener(operation({ phase: "prepared", busy: false, preparedModelRef: "llama-cpp/exact" }));
    await flushPromises();
    expect(wrapper.text()).toContain("Prepared — not enabled");
    expect(wrapper.emitted("configured")).toBeUndefined();
    expect(api.activate).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="local-activate"]').trigger("click");
    expect(api.activate).toHaveBeenCalledWith({
      kind: "existing-model",
      modelRef: "llama-cpp/exact",
    });
    listener(operation({ id: "activation", kind: "activate", phase: "applying" }));
    await flushPromises();
    expect(wrapper.emitted("configured")).toBeUndefined();
    listener(operation({ id: "activation", kind: "activate", phase: "ready", busy: false }));
    await flushPromises();
    expect(wrapper.emitted("configured")).toHaveLength(1);
    expect(wrapper.text()).toContain("without an AI test");
    expect(wrapper.text()).not.toContain("Verified and applied");
  });

  it("requires an explicit boolean confirmation and does not auto-confirm initialValue", async () => {
    const wrapper = await open();
    listener(
      operation({
        phase: "step",
        step: {
          id: "download-consent",
          type: "confirm",
          initialValue: true,
          message: "Download both inference and embedding files?",
        },
      }),
    );
    await flushPromises();
    expect(api.answer).not.toHaveBeenCalled();
    const decline = wrapper.findAll("button").find((button) => button.text() === "Decline")!;
    await decline.trigger("click");
    expect(api.answer).toHaveBeenCalledWith({
      operationId: "prepare-1",
      stepId: "download-consent",
      value: false,
    });
    expect(wrapper.emitted("configured")).toBeUndefined();
  });

  it("renders upstream text literally and clears sensitive answers after sending", async () => {
    const wrapper = await open();
    listener(
      operation({
        phase: "step",
        step: {
          id: "credential",
          type: "text",
          sensitive: true,
          initialValue: "do-not-prefill",
          message: "<b>Never execute this</b> https://example.com",
        },
      }),
    );
    await flushPromises();
    expect(wrapper.find(".wizard-step b").exists()).toBe(false);
    expect(wrapper.find(".wizard-step a").exists()).toBe(false);
    const input = wrapper.get('input[type="password"]');
    expect((input.element as HTMLInputElement).value).toBe("");
    await input.setValue("secret-answer");
    await wrapper.get(".wizard-step form").trigger("submit");
    expect(api.answer).toHaveBeenCalledWith({
      operationId: "prepare-1",
      stepId: "credential",
      value: "secret-answer",
    });
    expect((input.element as HTMLInputElement).value).toBe("");
  });

  it("does not submit gateway-owned progress or client-ineligible actions", async () => {
    const wrapper = await open();
    for (const type of ["progress", "action"] as const) {
      listener(
        operation({
          phase: "step",
          step: {
            id: type,
            type,
            executor: "gateway",
            message: "Preparing files, no percent supplied",
          },
        }),
      );
      await flushPromises();
      expect(wrapper.find(".wizard-step progress").exists()).toBe(true);
      expect(wrapper.find(".wizard-step form").exists()).toBe(false);
    }
    expect(api.answer).not.toHaveBeenCalled();
  });

  it("does not overwrite a newer event with a late prepare response", async () => {
    const late = deferred<LocalModelResult<LocalModelOperation>>();
    vi.mocked(api.prepare).mockReturnValue(late.promise);
    const wrapper = await open();
    await wrapper.get('[data-testid="prepare-llama-cpp"]').trigger("click");
    listener(operation({ phase: "prepared", busy: false, preparedModelRef: "llama-cpp/exact" }));
    await flushPromises();
    late.resolve(ok(operation()));
    await flushPromises();
    expect(wrapper.get('[data-testid="local-operation"]').text()).toContain(
      "Prepared — not enabled",
    );
    expect(wrapper.get('[data-testid="local-activate"]').attributes("disabled")).toBeUndefined();
  });

  it("ignores a stale state load after an operation event", async () => {
    const late = deferred<LocalModelResult<LocalModelOperation | null>>();
    vi.mocked(api.getOperation).mockReturnValue(late.promise);
    const wrapper = await open();
    listener(operation({ phase: "interrupted", busy: false }));
    late.resolve(ok(null));
    await flushPromises();
    expect(wrapper.find('[data-testid="local-resume"]').exists()).toBe(true);
  });

  it("shows errors without pretending the default was rolled back or configured", async () => {
    const wrapper = await open();
    vi.mocked(api.prepare).mockResolvedValue({ ok: false, error: "Disk capacity is insufficient" });
    await wrapper.get('[data-testid="prepare-llama-cpp"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Disk capacity is insufficient");
    expect(wrapper.emitted("configured")).toBeUndefined();
    listener(operation({ phase: "error", busy: false, error: "Gateway disconnected after apply" }));
    await flushPromises();
    expect(wrapper.text()).toContain("Configuration may already have been applied");
    expect(wrapper.text()).not.toContain("default model was not switched");
    listener(
      operation({
        phase: "error",
        busy: false,
        rejectedBeforePromotion: true,
        error: "Validation rejected",
      }),
    );
    await flushPromises();
    expect(wrapper.text()).toContain("default model was not switched");
  });

  it("waits for Gateway cancellation confirmation and cannot close a protected operation", async () => {
    const wrapper = await open();
    listener(operation());
    await flushPromises();
    expect(wrapper.get('[data-testid="local-close"]').attributes("disabled")).toBeUndefined();
    await wrapper.get('[data-testid="local-close"]').trigger("click");
    await flushPromises();
    expect(api.cancel).toHaveBeenCalledWith("prepare-1");
    expect(wrapper.get('[data-testid="local-close"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="local-cancel-pending"]').text()).toContain(
      "has not confirmed cancellation",
    );
    expect(wrapper.text()).not.toContain("Cancellation confirmed");
    expect(wrapper.emitted("close")).toBeUndefined();
    listener(operation({ phase: "cancelled", busy: false, cancellationPending: false }));
    await flushPromises();
    expect(wrapper.text()).toContain("Cancellation confirmed");
    await wrapper.get('[data-testid="local-close"]').trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("closes active setup only after cancellation is confirmed", async () => {
    const wrapper = await open();
    listener(operation());
    vi.mocked(api.cancel).mockResolvedValue(
      ok(operation({ phase: "cancelled", busy: false, cancellationPending: false })),
    );
    await flushPromises();
    await wrapper.get('[data-testid="local-close"]').trigger("click");
    await flushPromises();
    expect(api.cancel).toHaveBeenCalledOnce();
    expect(wrapper.emitted("close")).toHaveLength(1);
    expect(api.answer).not.toHaveBeenCalled();
  });

  it("shows a concise Chinese download card and keeps full consent in collapsed details", async () => {
    const wrapper = await open();
    setLocale("zh-CN");
    const message = [
      "Runs on Gateway host desktop-host (win32/x64), using the CPU.",
      "64 GiB RAM; 1721.3 GiB free disk.",
      "Qwen3.5 9B (Q4_K_M) fits the 39.2 GiB CPU memory budget with a 64K context. Runtime verification checks the actual model before activation.",
      "OpenClaw will check a real tool call before making this your default model.",
      "",
      "Download Qwen3.5 9B (Q4_K_M) (5.7 GB), the local embedding model (about 0.3 GB), and the verified CPU runtime, then use this model?",
    ].join("\n");
    listener(
      operation({
        phase: "step",
        step: { id: "download", type: "confirm", executor: "client", message, initialValue: false },
      }),
    );
    await flushPromises();
    expect(wrapper.get('[data-testid="download-summary"]').text()).toContain("Qwen3.5 9B");
    const details = wrapper.get('[data-testid="download-details"]');
    expect(details.attributes("open")).toBeUndefined();
    expect(details.text()).toContain(message);
    expect(details.text()).toContain("Gateway 版本");
    expect(wrapper.find('[data-testid="local-cancel"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="local-refresh"]').exists()).toBe(false);
    const visible = wrapper.element.cloneNode(true) as HTMLElement;
    for (const detail of visible.querySelectorAll("details:not([open])")) {
      detail.replaceChildren(detail.querySelector("summary")!.cloneNode(true));
    }
    const copy = visible.textContent!.replace(/\s+/g, " ").trim();
    expect(copy.length).toBeLessThan(200);
    expect(copy).toContain("约 6 GB");
    expect(copy).toContain("开始下载");
    expect(copy).not.toMatch(/Gateway|embedding|Q4_K_M|回退|desktop-host/);
    expect(api.answer).not.toHaveBeenCalled();
    const confirm = wrapper.findAll("button").find((button) => button.text() === "开始下载")!;
    await confirm.trigger("click");
    expect(api.answer).toHaveBeenCalledWith({
      operationId: "prepare-1",
      stepId: "download",
      value: true,
    });
  });

  it("leaves unknown or additional confirmation terms visible", async () => {
    const wrapper = await open();
    const message = "Download a model? Additional license or permission terms require review.";
    listener(operation({ phase: "step", step: { id: "unknown", type: "confirm", message } }));
    await flushPromises();
    expect(wrapper.find('[data-testid="download-summary"]').exists()).toBe(false);
    expect(wrapper.get(".wizard-step > .upstream-text").text()).toBe(message);
    expect(wrapper.get('[data-testid="local-details"]').attributes("open")).toBeUndefined();
    expect(api.answer).not.toHaveBeenCalled();
  });

  it("resumes interrupted work explicitly without replaying any answer", async () => {
    vi.mocked(api.getOperation).mockResolvedValue(
      ok(operation({ phase: "interrupted", busy: false })),
    );
    const wrapper = await open();
    expect(wrapper.get('[data-testid="prepare-llama-cpp"]').attributes("disabled")).toBeDefined();
    expect(api.resume).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="local-resume"]').trigger("click");
    expect(api.resume).toHaveBeenCalledOnce();
    expect(api.answer).not.toHaveBeenCalled();
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it("does not select an arbitrary candidate when preparedModelRef is absent", async () => {
    vi.mocked(api.getSnapshot).mockResolvedValue(
      ok({
        models: [...snapshot.models, { modelRef: "llama-cpp/other", name: "Other" }],
      }),
    );
    const wrapper = await open();
    listener(operation({ phase: "prepared", busy: false }));
    await flushPromises();
    expect(api.getSnapshot).toHaveBeenCalledTimes(2);
    expect(api.detect).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="local-activate"]').attributes("disabled")).toBeDefined();
    await wrapper
      .get("#local-candidate")
      .setValue(JSON.stringify(["existing-model", "llama-cpp/other"]));
    await wrapper.get('[data-testid="local-activate"]').trigger("click");
    expect(api.activate).toHaveBeenCalledWith({
      kind: "existing-model",
      modelRef: "llama-cpp/other",
    });
  });

  it("uses an exact configured model rather than the first saved model", async () => {
    vi.mocked(api.getSnapshot).mockResolvedValue(
      ok({
        models: [...snapshot.models, { modelRef: "llama-cpp/saved", name: "Saved" }],
        configuredModel: "llama-cpp/saved",
      }),
    );
    const wrapper = await open({ targetModelRef: "llama-cpp/saved" });
    await wrapper.get('[data-testid="local-activate"]').trigger("click");
    expect(api.activate).toHaveBeenCalledWith({
      kind: "existing-model",
      modelRef: "llama-cpp/saved",
    });
  });

  it("does not replay a historical ready receipt as a new configuration event", async () => {
    vi.mocked(api.getOperation).mockResolvedValue(
      ok(
        operation({
          id: "previous-activation",
          kind: "activate",
          phase: "ready",
          busy: false,
        }),
      ),
    );
    const wrapper = await open();
    expect(wrapper.emitted("configured")).toBeUndefined();
    expect(wrapper.get('[data-testid="prepare-llama-cpp"]').attributes("disabled")).toBeUndefined();
  });

  it("does not choose a cloud candidate as a fallback when local detection is empty", async () => {
    vi.mocked(api.getSnapshot).mockResolvedValue(
      ok({
        models: [],
        configuredModel: "cloud/remote",
      }),
    );
    const wrapper = await open();
    listener(operation({ phase: "prepared", busy: false }));
    await flushPromises();
    expect(wrapper.get('[data-testid="local-activate"]').attributes("disabled")).toBeDefined();
    expect(api.activate).not.toHaveBeenCalled();
  });

  it("does not mistake the old configured model for an unidentified prepared result", async () => {
    vi.mocked(api.getSnapshot).mockResolvedValue(
      ok({
        models: [{ modelRef: "llama-cpp/old", name: "Old" }],
        configuredModel: "llama-cpp/old",
      }),
    );
    const wrapper = await open();
    listener(operation({ phase: "prepared", busy: false }));
    await flushPromises();
    expect(wrapper.get('[data-testid="local-activate"]').attributes("disabled")).toBeDefined();
    expect(api.activate).not.toHaveBeenCalled();
  });

  it("reloads saved configuration after preparation without waiting for an old snapshot", async () => {
    const late = deferred<LocalModelResult<LocalModelSnapshot>>();
    vi.mocked(api.getSnapshot).mockReturnValueOnce(late.promise).mockResolvedValue(ok(snapshot));
    const wrapper = await open();
    listener(operation({ phase: "prepared", busy: false, preparedModelRef: "llama-cpp/exact" }));
    await flushPromises();
    late.resolve(ok({ models: [] }));
    await flushPromises();
    expect(api.getSnapshot).toHaveBeenCalledTimes(2);
    expect(api.detect).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="local-activate"]').attributes("disabled")).toBeUndefined();
  });

  it("disables unsupported and policy-locked capabilities with reasons", async () => {
    vi.mocked(api.getCapabilities).mockResolvedValue(
      ok({ ...capabilities, supported: false, mutable: false, blockers: ["MXC config lock"] }),
    );
    const wrapper = await open();
    expect(wrapper.text()).toContain("MXC config lock");
    expect(wrapper.text()).toContain("Configuration changes are locked");
    expect(wrapper.get('[data-testid="prepare-llama-cpp"]').attributes("disabled")).toBeDefined();
    expect(api.detect).not.toHaveBeenCalled();
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it("honors explicitly discovered choices and streaming without scanning on mount", async () => {
    vi.mocked(api.detect).mockResolvedValue(
      ok({ ...detection, choices: [{ id: "llama-cpp-existing-server", label: "Existing" }] }),
    );
    const wrapper = await open({ streaming: true });
    expect(
      wrapper.get('[data-testid="prepare-llama-cpp-existing-server"]').attributes("disabled"),
    ).toBeDefined();
    await wrapper.setProps({ streaming: false });
    expect(api.detect).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="local-discover"]').trigger("click");
    await flushPromises();
    expect(api.detect).toHaveBeenCalledExactlyOnceWith({ refresh: true });
    expect(wrapper.get('[data-testid="prepare-llama-cpp"]').attributes("disabled")).toBeDefined();
    await wrapper.get('[data-testid="prepare-llama-cpp-existing-server"]').trigger("click");
    expect(api.prepare).toHaveBeenCalledWith({ authChoice: "llama-cpp-existing-server" });
  });

  it("shows review details and requires explicit consent before installation", async () => {
    vi.mocked(api.getCapabilities).mockResolvedValue(
      ok({
        ...capabilities,
        plugin: { installed: false, enabled: false, canInstall: true },
      }),
    );
    const wrapper = await open();
    expect(api.inspectProvider).not.toHaveBeenCalled();
    expect(api.installProvider).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="provider-review"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("official catalog");
    expect(wrapper.text()).toContain("Start local runtime");
    expect(wrapper.get('[data-testid="provider-install"]').attributes("disabled")).toBeDefined();
    await wrapper.get('[data-testid="provider-confirm"]').setValue(true);
    await wrapper.get('[data-testid="provider-install"]').trigger("click");
    expect(api.installProvider).toHaveBeenCalledWith({ confirmed: true, reviewToken: "review-1" });
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it("requires fresh review and consent after installation requests staged capability review", async () => {
    vi.mocked(api.getCapabilities)
      .mockResolvedValueOnce(
        ok({
          ...capabilities,
          plugin: { installed: false, enabled: false, canInstall: true },
        }),
      )
      .mockResolvedValue(ok(capabilities));
    vi.mocked(api.inspectProvider)
      .mockResolvedValueOnce(
        ok({
          pluginId: "llama-cpp",
          source: "ClawHub @openclaw/llama-cpp-provider",
          version: "2026.9.3",
          capabilities: {},
          reviewToken: "source-review",
        }),
      )
      .mockResolvedValueOnce(
        ok({
          pluginId: "llama-cpp",
          source: "ClawHub @openclaw/llama-cpp-provider",
          version: "2026.9.3",
          capabilities: { permissions: ["Start local runtime", "Download model files"] },
          reviewToken: "staged-manifest-review",
        }),
      );
    vi.mocked(api.installProvider)
      .mockResolvedValueOnce({ ok: false, error: "Staged manifest capability review required" })
      .mockResolvedValueOnce(ok(capabilities));

    const wrapper = await open();
    await wrapper.get('[data-testid="provider-review"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="provider-capabilities-unknown"]').text()).toContain(
      "not a full permissions review",
    );
    expect(wrapper.text()).toContain("ClawHub @openclaw/llama-cpp-provider");
    expect(wrapper.text()).toContain("source and version and authorize attempting");
    expect(wrapper.text()).not.toContain("source, version, and capabilities and authorize");
    await wrapper.get('[data-testid="provider-confirm"]').setValue(true);
    await wrapper.get('[data-testid="provider-install"]').trigger("click");
    await flushPromises();
    expect(api.installProvider).toHaveBeenNthCalledWith(1, {
      confirmed: true,
      reviewToken: "source-review",
    });
    expect(wrapper.text()).toContain("Staged manifest capability review required");
    expect(wrapper.find('[data-testid="provider-confirm"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="provider-review"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.get('[data-testid="provider-review"]').text()).toBe("Review provider again");
    expect(api.inspectProvider).toHaveBeenCalledOnce();
    expect(api.installProvider).toHaveBeenCalledOnce();

    await wrapper.get('[data-testid="provider-review"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="provider-capabilities-unknown"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("Start local runtime");
    expect(wrapper.get('[data-testid="provider-install"]').attributes("disabled")).toBeDefined();
    expect(api.installProvider).toHaveBeenCalledOnce();
    await wrapper.get('[data-testid="provider-confirm"]').setValue(true);
    await wrapper.get('[data-testid="provider-install"]').trigger("click");
    await flushPromises();
    expect(api.installProvider).toHaveBeenNthCalledWith(2, {
      confirmed: true,
      reviewToken: "staged-manifest-review",
    });
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it("unsubscribes from main operation events on close", async () => {
    const wrapper = await open();
    wrapper.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("shows the default-agent override caveat without changing that agent", async () => {
    const wrapper = await open({
      defaultAgentOverride: { agentId: "main", modelRef: "cloud/pinned" },
    });
    expect(wrapper.get('[data-testid="default-agent-override"]').text()).toContain(
      "Changing the global default does not change this override",
    );
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.activate).not.toHaveBeenCalled();
  });
});
