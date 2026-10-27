import { DOMWrapper, mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserOpenClawMock } from "@/browser-openclaw";
import { setLocale } from "@/i18n";
import type { LocalModelOperation } from "../../../src/local-model-types";
import { LOCAL_MODEL_PRESETS } from "../../../src/local-model-catalog";
import LocalModelDownloadDialog from "./LocalModelDownloadDialog.vue";

const modelRef = LOCAL_MODEL_PRESETS[0].modelRef;
let listener: (operation: LocalModelOperation) => void;
let active: LocalModelOperation;
const wrappers: Array<ReturnType<typeof mount>> = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  setLocale("en-US");
  active = {
    id: "download-4b",
    kind: "prepare",
    phase: "step",
    agentId: "main",
    modelRef,
    busy: true,
    cancellationPending: false,
    step: { id: "consent", type: "confirm", initialValue: false },
    download: {
      modelRef,
      modelName: "Qwen3.5 4B",
      modelBytes: 2740937888,
      embeddingBytes: 328577056,
      runtimeDiskBytes: 2 * 1024 ** 3,
      backend: "cpu",
      runtimeNote: "",
    },
  };
  const api = createBrowserOpenClawMock();
  api.model.local.getCapabilities = vi.fn().mockResolvedValue({
    ok: true,
    value: {
      supported: true,
      mutable: true,
      blockers: [],
      gatewayVersion: "2026.9.3",
      plugin: { installed: true, enabled: true, version: "2026.9.3", canInstall: false },
    },
  });
  api.model.local.getSnapshot = vi.fn().mockResolvedValue({
    ok: true,
    value: {
      models: [],
      catalog: LOCAL_MODEL_PRESETS.map((model) => ({
        ...model,
        configured: false,
        fileStatus: "not-downloaded",
      })),
    },
  });
  api.model.local.getOperation = vi.fn().mockResolvedValue({ ok: true, value: null });
  api.model.local.onEvent = vi.fn((callback) => {
    listener = callback;
    return () => {};
  });
  api.model.local.prepare = vi.fn().mockResolvedValue({ ok: true, value: active });
  api.model.local.answer = vi
    .fn()
    .mockResolvedValue({ ok: true, value: { ...active, phase: "starting", step: undefined } });
  api.model.local.cancel = vi
    .fn()
    .mockResolvedValue({ ok: true, value: { ...active, phase: "cancelled", busy: false } });
  api.model.local.activate = vi.fn();
  api.model.session.select = vi.fn(async ({ sessionKey, modelRef }) => ({
    sessionKey,
    modelRef,
    overridden: true,
  }));
  api.model.testConnection = vi.fn();
  api.config.write = vi.fn();
  window.openclaw = api;
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
async function open(sessionKey: string | null = "agent:main:one", selectedModelRef = modelRef) {
  const wrapper = mount(LocalModelDownloadDialog, {
    props: { modelRef: selectedModelRef, sessionKey: sessionKey ?? undefined, streaming: false },
    global: { stubs: { teleport: true } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}
describe("fixed local model first-use dialog", () => {
  it.each(LOCAL_MODEL_PRESETS.slice(2))(
    "shows exact $name and ModelScope consent before starting downloads",
    async (model) => {
      active.modelRef = model.modelRef;
      active.download = {
        ...active.download!,
        modelRef: model.modelRef,
        modelName: model.name,
        modelBytes: model.downloadBytes,
      };
      const wrapper = await open("agent:main:one", model.modelRef);
      expect(wrapper.get("h2").text()).toBe(model.name.replace(/\s+(?:UD-)?Q4_K_M$/u, ""));
      expect(wrapper.get("h2").attributes("title")).toBe(model.name);
      expect(wrapper.text()).toContain("ModelScope");
      expect(window.openclaw.model.local.answer).not.toHaveBeenCalled();
      expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
    },
  );
  it.each(["session", "default"])(
    "never mounts a modal during slow metadata or prepared %s selection",
    async (scope) => {
      const capabilities = await window.openclaw.model.local.getCapabilities();
      const metadata = deferred<typeof capabilities>();
      vi.mocked(window.openclaw.model.local.getCapabilities).mockReturnValue(metadata.promise);
      vi.mocked(window.openclaw.model.local.getSnapshot).mockResolvedValue({
        ok: true,
        value: { models: [{ modelRef, name: "Qwen", fileStatus: "present" }] },
      });
      const sessionSelection =
        deferred<Awaited<ReturnType<typeof window.openclaw.model.session.select>>>();
      const defaultSelection =
        deferred<Awaited<ReturnType<typeof window.openclaw.model.local.activate>>>();
      vi.mocked(window.openclaw.model.session.select).mockReturnValue(sessionSelection.promise);
      vi.mocked(window.openclaw.model.local.activate).mockReturnValue(defaultSelection.promise);
      const inserted: Element[] = [];
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (
              node instanceof Element &&
              (node.matches(".download-overlay") || node.querySelector(".download-overlay"))
            )
              inserted.push(node);
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      try {
        const wrapper = mount(LocalModelDownloadDialog, {
          attachTo: document.body,
          props: { modelRef, sessionKey: scope === "session" ? "agent:main:fresh" : undefined },
        });
        wrappers.push(wrapper);
        await flushPromises();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(wrapper.emitted("busy")?.at(-1)).toEqual([true]);
        expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
        metadata.resolve(capabilities);
        await flushPromises();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(wrapper.emitted("busy")?.at(-1)).toEqual([true]);
        if (scope === "session") {
          expect(window.openclaw.model.session.select).toHaveBeenCalledExactlyOnceWith({
            sessionKey: "agent:main:fresh",
            modelRef,
          });
          sessionSelection.resolve({ sessionKey: "agent:main:fresh", modelRef, overridden: true });
        } else {
          expect(window.openclaw.model.local.activate).toHaveBeenCalledExactlyOnceWith({
            kind: "existing-model",
            modelRef,
          });
          defaultSelection.resolve({
            ok: true,
            value: { ...active, id: "apply", kind: "activate", phase: "ready", busy: false },
          });
        }
        await flushPromises();
        expect(wrapper.emitted("selected")).toHaveLength(1);
        expect(wrapper.emitted("close")).toHaveLength(1);
        expect(wrapper.emitted("busy")?.at(-1)).toEqual([false]);
        expect(inserted).toEqual([]);
        expect(window.openclaw.model.local.prepare).not.toHaveBeenCalled();
        expect(window.openclaw.model.testConnection).not.toHaveBeenCalled();
        expect(window.openclaw.config.write).not.toHaveBeenCalled();
      } finally {
        observer.disconnect();
      }
    },
  );

  it("still requests preparation when cached weights are not yet configured", async () => {
    vi.mocked(window.openclaw.model.local.getSnapshot).mockResolvedValue({
      ok: true,
      value: {
        models: [],
        catalog: [{ ...LOCAL_MODEL_PRESETS[0], configured: false, fileStatus: "present" }],
      },
    });
    const wrapper = await open();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="confirm-local-download"]').exists()).toBe(true);
    expect(window.openclaw.model.local.prepare).toHaveBeenCalledOnce();
    expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
  });

  it("shows recovery instead of leaving an interrupted default selection invisible", async () => {
    vi.mocked(window.openclaw.model.local.getSnapshot).mockResolvedValue({
      ok: true,
      value: { models: [{ modelRef, name: "Qwen", fileStatus: "present" }] },
    });
    const activation: LocalModelOperation = {
      ...active,
      id: "apply",
      kind: "activate",
      phase: "activating",
      step: undefined,
    };
    vi.mocked(window.openclaw.model.local.activate).mockResolvedValue({
      ok: true,
      value: activation,
    });
    const wrapper = await open(null);
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    listener({ ...activation, phase: "interrupted", busy: false });
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("Resume");
    expect(wrapper.emitted("busy")?.at(-1)).toEqual([false]);
    expect(wrapper.emitted("selected")).toBeUndefined();
  });

  it("renders errors and controls at the document root outside the composer stacking context", async () => {
    vi.mocked(window.openclaw.model.local.getSnapshot).mockResolvedValue({
      ok: true,
      value: { models: [{ modelRef, name: "Qwen", fileStatus: "present" }] },
    });
    vi.mocked(window.openclaw.model.session.select).mockRejectedValue(
      new Error("The session model could not be selected"),
    );
    const composer = document.createElement("div");
    composer.style.cssText = "position: relative; z-index: 1; overflow: hidden";
    document.body.appendChild(composer);
    const wrapper = mount(LocalModelDownloadDialog, {
      attachTo: composer,
      props: { modelRef, sessionKey: "agent:main:session-fresh" },
    });
    wrappers.push(wrapper);
    await flushPromises();
    expect(composer.querySelector('[role="dialog"]')).toBeNull();
    const overlay = document.body.querySelector(".download-overlay");
    expect(overlay?.parentElement).toBe(document.body);
    const dialog = new DOMWrapper(document.body).get('[role="dialog"]');
    expect(dialog.attributes("aria-modal")).toBe("true");
    expect(dialog.get('[role="alert"]').text()).toBe("The session model could not be selected");
    await dialog.get('[aria-label="Close"]').trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
    expect(document.body.querySelector(".download-overlay")).toBeNull();
  });

  it("replaces consent with gateway progress after confirmation instead of offering download again", async () => {
    const wrapper = await open();
    window.openclaw.model.local.answer = vi.fn(async () => {
      const progress = {
        ...active,
        step: {
          id: "progress-1",
          type: "progress" as const,
          executor: "gateway" as const,
          message: "Downloading Qwen3.5 4B... 25% (0.7/2.7 GB, 20 MB/s)",
        },
      };
      listener(progress);
      return { ok: true as const, value: progress };
    });
    await wrapper.get('[data-testid="confirm-local-download"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="confirm-local-download"]').exists()).toBe(false);
    expect(wrapper.find("dl").exists()).toBe(false);
    expect(wrapper.get('[data-testid="local-download-progress"]').text()).toContain("25%");
    expect(wrapper.find("progress").exists()).toBe(true);
    expect(wrapper.text()).toContain("Cancel");
    expect(window.openclaw.model.local.answer).toHaveBeenCalledOnce();
    expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
    listener({
      ...active,
      step: {
        id: "progress-2",
        type: "progress",
        executor: "gateway",
        message: "Downloading llama.cpp runtime... 80%",
      },
    });
    await flushPromises();
    expect(wrapper.get('[data-testid="local-download-progress"]').text()).toContain("80%");
    expect(wrapper.find('[data-testid="confirm-local-download"]').exists()).toBe(false);
  });

  it("shows immediate feedback and prevents duplicate confirmation while IPC is pending", async () => {
    let resolve!: (result: Awaited<ReturnType<typeof window.openclaw.model.local.answer>>) => void;
    window.openclaw.model.local.answer = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof window.openclaw.model.local.answer>>>((done) => {
          resolve = done;
        }),
    );
    const wrapper = await open();
    const button = wrapper.get('[data-testid="confirm-local-download"]');
    await button.trigger("click");
    expect(wrapper.find('[data-testid="confirm-local-download"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("Starting the confirmed download");
    await button.trigger("click");
    expect(window.openclaw.model.local.answer).toHaveBeenCalledOnce();
    resolve({ ok: true, value: { ...active, phase: "starting", step: undefined } });
    await flushPromises();
    expect(wrapper.find("progress").exists()).toBe(true);
  });

  it("shows runtime installation failure after progress and does not leave old consent visible", async () => {
    const wrapper = await open();
    listener({
      ...active,
      step: {
        id: "runtime",
        type: "progress",
        executor: "gateway",
        message: "Installing llama.cpp runtime",
      },
    });
    await flushPromises();
    listener({
      ...active,
      phase: "error",
      busy: false,
      step: undefined,
      error: "Runtime installation failed: EPERM",
    });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("EPERM");
    expect(wrapper.find('[data-testid="confirm-local-download"]').exists()).toBe(false);
    expect(wrapper.find("progress").exists()).toBe(false);
    expect(window.openclaw.model.local.answer).not.toHaveBeenCalled();
    expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
  });

  it("reopens an ongoing download as progress without repeating confirmation or preparation", async () => {
    const progress = {
      ...active,
      step: {
        id: "runtime",
        type: "progress" as const,
        executor: "gateway" as const,
        message: "Preparing runtime",
      },
    };
    vi.mocked(window.openclaw.model.local.getOperation).mockResolvedValue({
      ok: true,
      value: progress,
    });
    const wrapper = await open();
    expect(wrapper.get('[data-testid="local-download-progress"]').text()).toBe("Preparing runtime");
    expect(wrapper.find('[data-testid="confirm-local-download"]').exists()).toBe(false);
    expect(window.openclaw.model.local.answer).not.toHaveBeenCalled();
    expect(window.openclaw.model.local.prepare).not.toHaveBeenCalled();
  });

  it("selects a default only after exact preparation, not when consent opens", async () => {
    window.openclaw.model.local.activate = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        ...active,
        id: "apply-default",
        kind: "activate",
        phase: "ready",
        busy: false,
        modelRef,
      },
    });
    const wrapper = await open(null);
    expect(window.openclaw.model.local.activate).not.toHaveBeenCalled();
    listener({ ...active, phase: "prepared", busy: false, preparedModelRef: modelRef });
    await flushPromises();
    expect(window.openclaw.model.local.activate).toHaveBeenCalledWith({
      kind: "existing-model",
      modelRef,
    });
    expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
    expect(wrapper.emitted("selected")).toHaveLength(1);
  });
  it("prepares the precise selected ID but waits for explicit download confirmation", async () => {
    const wrapper = await open();
    expect(window.openclaw.model.local.prepare).toHaveBeenCalledWith({
      authChoice: "llama-cpp",
      modelRef,
      agentId: "main",
    });
    expect(wrapper.text()).toContain("2.7 GB");
    expect(wrapper.text()).toContain("Larger models need more memory");
    expect(window.openclaw.model.local.answer).not.toHaveBeenCalled();
    expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="confirm-local-download"]').trigger("click");
    expect(window.openclaw.model.local.answer).toHaveBeenCalledWith({
      operationId: active.id,
      stepId: "consent",
      value: true,
    });
    expect(window.openclaw.model.testConnection).not.toHaveBeenCalled();
  });
  it("selects only the original conversation after exact preparation succeeds", async () => {
    const wrapper = await open();
    listener({
      ...active,
      phase: "prepared",
      busy: false,
      preparedModelRef: modelRef,
      step: undefined,
    });
    await flushPromises();
    expect(window.openclaw.model.session.select).toHaveBeenCalledWith({
      sessionKey: "agent:main:one",
      modelRef,
    });
    expect(window.openclaw.config.write).not.toHaveBeenCalled();
    expect(window.openclaw.model.local.activate).not.toHaveBeenCalled();
    expect(wrapper.emitted("selected")).toHaveLength(1);
  });
  it("retains the previous selection if preparation fails", async () => {
    const wrapper = await open();
    listener({ ...active, phase: "error", busy: false, error: "Download failed" });
    await flushPromises();
    expect(wrapper.text()).toContain("Download failed");
    expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
    expect(wrapper.emitted("selected")).toBeUndefined();
  });
  it("waits for cancellation acknowledgement before closing", async () => {
    window.openclaw.model.local.cancel = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { ...active, cancellationPending: true } });
    const wrapper = await open();
    await wrapper.get('[aria-label="Close"]').trigger("click");
    await flushPromises();
    expect(wrapper.emitted("close")).toBeUndefined();
    expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
  });
  it("selects a prepared file directly without setup or inference checks", async () => {
    vi.mocked(window.openclaw.model.local.getSnapshot).mockResolvedValue({
      ok: true,
      value: { models: [{ modelRef, name: "Qwen", fileStatus: "present" }] },
    });
    await open();
    expect(window.openclaw.model.session.select).toHaveBeenCalledOnce();
    expect(window.openclaw.model.local.prepare).not.toHaveBeenCalled();
    expect(window.openclaw.model.testConnection).not.toHaveBeenCalled();
  });
  it("does not auto-switch a conversation after its picker has been unmounted", async () => {
    const wrapper = await open();
    wrapper.unmount();
    listener({ ...active, phase: "prepared", busy: false, preparedModelRef: modelRef });
    await flushPromises();
    expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
  });
  it("does not select a different prepared model or cancel another operation", async () => {
    vi.mocked(window.openclaw.model.local.getOperation).mockResolvedValue({
      ok: true,
      value: { ...active, modelRef: LOCAL_MODEL_PRESETS[1].modelRef },
    });
    const wrapper = await open();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(window.openclaw.model.local.prepare).not.toHaveBeenCalled();
    await wrapper.get('[aria-label="Close"]').trigger("click");
    await flushPromises();
    expect(window.openclaw.model.local.cancel).not.toHaveBeenCalled();
  });
});
