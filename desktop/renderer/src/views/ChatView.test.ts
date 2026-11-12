import { createPinia, setActivePinia } from "pinia";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactive, ref } from "vue";
import { createBrowserOpenClawMock } from "@/browser-openclaw";
import { ElMessage } from "element-plus";
import { setLocale, t } from "@/i18n";
import { useChatStore } from "@/stores/chat";
import ModelSetupDialog from "@/components/ModelSetupDialog.vue";
import {
  windowsNodeMxcLifecycleStateKey,
  type WindowsNodeMxcLifecycleState,
} from "@/windows-node-mxc-lifecycle";
import ChatView from "./ChatView.vue";

const route = vi.hoisted(() => ({ params: { agentId: "main" } }));

vi.mock("vue-router", () => ({
  useRoute: () => reactive(route),
  useRouter: () => ({ push: vi.fn() }),
}));

describe("ChatView agent preparation", () => {
  beforeEach(() => {
    setLocale("zh-CN");
    window.openclaw = createBrowserOpenClawMock();
  });

  it.each([false, true])(
    "keeps the composer free of model selection while streaming is %s",
    (streaming) => {
      const pinia = createPinia();
      setActivePinia(pinia);
      const store = useChatStore(pinia);
      store.wsConnected = true;
      store.streaming = streaming;
      const wrapper = shallowMount(ChatView, { global: { plugins: [pinia] } });

      expect(wrapper.findComponent({ name: "ChatModelPicker" }).exists()).toBe(false);
      expect(wrapper.get(".home-input-right").element.children).toHaveLength(1);
      expect(wrapper.get(".home-input-right").find(".home-input-send").exists()).toBe(true);
      expect(wrapper.find(".home-input-send--stop").exists()).toBe(streaming);
      expect(wrapper.find(".home-input-plus").exists()).toBe(true);
      wrapper.unmount();
    },
  );

  it("shows preparation in an empty session and keeps the draft until an explicit send", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useChatStore(pinia);
    store.wsConnected = true;
    vi.spyOn(window.openclaw.chat, "loadHistory")
      .mockRejectedValueOnce(
        new Error("Agent main has not completed startup inspection and preparation."),
      )
      .mockResolvedValue({ messages: [] });
    const sendMessage = vi.spyOn(window.openclaw.chat, "sendMessage");
    await store.loadHistory();
    const wrapper = shallowMount(ChatView, { global: { plugins: [pinia] } });
    const input = wrapper.get("textarea");
    await input.setValue("Keep this draft");

    expect(wrapper.findComponent({ name: "ChatMessageList" }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: "ChatWelcome" }).exists()).toBe(false);
    expect(input.attributes("disabled")).toBeUndefined();
    expect(input.attributes("placeholder")).toBe("正在准备会话数据");
    expect(wrapper.get(".home-input-send").attributes("disabled")).toBeDefined();
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(sendMessage).not.toHaveBeenCalled();

    await store.loadHistory({ showLoading: false });
    await flushPromises();
    expect((input.element as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(wrapper.get(".home-input-send").attributes("disabled")).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect((input.element as HTMLTextAreaElement).value).toBe("");
    wrapper.unmount();
  });

  it("preserves drafts and blocks submission during live mode changes and failures", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useChatStore(pinia);
    store.wsConnected = true;
    const state = ref<WindowsNodeMxcLifecycleState | null>({
      phase: "active",
      detail: null,
      updatedAt: new Date().toISOString(),
    });
    const sendMessage = vi.spyOn(window.openclaw.chat, "sendMessage");
    const wrapper = shallowMount(ChatView, {
      global: {
        plugins: [pinia],
        provide: { [windowsNodeMxcLifecycleStateKey as symbol]: state },
      },
    });
    const input = wrapper.get("textarea");
    await input.setValue("Keep this draft");
    for (const phase of [
      "locking",
      "updating-folders",
      "updating-consent",
      "updating-model",
      "connecting-weixin",
      "disconnecting-weixin",
    ] as const) {
      state.value = { ...state.value!, phase };
      await wrapper.vm.$nextTick();
      expect(store.wsConnected).toBe(true);
      expect(wrapper.get(".home-input-send").attributes("disabled")).toBeDefined();
      await input.trigger("keydown", { key: "Enter" });
      expect(sendMessage).not.toHaveBeenCalled();
      expect((input.element as HTMLTextAreaElement).value).toBe("Keep this draft");
    }

    state.value = { ...state.value!, phase: "failed", detail: "Policy failed" };
    await wrapper.vm.$nextTick();
    expect(input.attributes("placeholder")).toContain("执行已锁定");
    await input.trigger("keydown", { key: "Enter" });
    expect(sendMessage).not.toHaveBeenCalled();

    state.value = { ...state.value!, phase: "idle", detail: null };
    await wrapper.vm.$nextTick();
    expect(wrapper.get(".home-input-send").attributes("disabled")).toBeUndefined();
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("preserves the draft if security locks during model setup preflight", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useChatStore(pinia);
    store.wsConnected = true;
    const state = ref<WindowsNodeMxcLifecycleState | null>({
      phase: "active",
      detail: null,
      updatedAt: new Date().toISOString(),
    });
    const response = await window.openclaw.model.session.get(store.sessionKey);
    let finish!: (value: typeof response) => void;
    vi.spyOn(window.openclaw.model.session, "get").mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const send = vi.spyOn(store, "sendMessage").mockResolvedValue(true);
    const wrapper = shallowMount(ChatView, {
      global: {
        plugins: [pinia],
        provide: { [windowsNodeMxcLifecycleStateKey as symbol]: state },
      },
    });
    const input = wrapper.get("textarea");
    await input.setValue("Keep this draft");
    await input.trigger("keydown", { key: "Enter" });
    state.value = { ...state.value!, phase: "locking" };
    finish(response);
    await flushPromises();

    expect(send).not.toHaveBeenCalled();
    expect((input.element as HTMLTextAreaElement).value).toBe("Keep this draft");
    state.value = { ...state.value!, phase: "active" };
    await wrapper.vm.$nextTick();
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(send).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("does not submit a configured model's pending draft while security is locked", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useChatStore(pinia);
    store.wsConnected = true;
    const state = ref<WindowsNodeMxcLifecycleState | null>({
      phase: "active",
      detail: null,
      updatedAt: new Date().toISOString(),
    });
    vi.spyOn(window.openclaw.config, "needsSetup")
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const send = vi.spyOn(store, "sendMessage").mockResolvedValue(true);
    const wrapper = shallowMount(ChatView, {
      global: {
        plugins: [pinia],
        provide: { [windowsNodeMxcLifecycleStateKey as symbol]: state },
      },
    });
    const input = wrapper.get("textarea");
    await input.setValue("Keep this draft");
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    const dialog = wrapper.findComponent(ModelSetupDialog);
    expect(dialog.props("modelValue")).toBe(true);

    state.value = { ...state.value!, phase: "locking" };
    dialog.vm.$emit("update:modelValue", false);
    dialog.vm.$emit("configured");
    await flushPromises();
    expect(send).not.toHaveBeenCalled();
    expect((input.element as HTMLTextAreaElement).value).toBe("Keep this draft");
    state.value = { ...state.value!, phase: "active" };
    await wrapper.vm.$nextTick();
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(send).toHaveBeenCalledOnce();
    wrapper.unmount();
  });
});

describe("ChatView image drops", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const image = (name = "photo.png") => new File([png], name, { type: "image/png" });
  const data = (files: File[]) => ({ files, types: ["Files"], dropEffect: "none" });
  const imageResult = (fileName: string): OpenFilesResult => ({
    attachments: [
      {
        type: "image",
        mimeType: "image/png",
        fileName,
        size: png.byteLength,
        content: "iVBORw0KGgo=",
      },
    ],
    rejections: [],
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((finish, fail) => {
      resolve = finish;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  function setup() {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useChatStore(pinia);
    store.wsConnected = true;
    const send = vi.spyOn(store, "sendMessage").mockResolvedValue(true);
    const imported = vi
      .spyOn(window.openclaw.attachment, "importClipboardImages")
      .mockImplementation(async (images) => ({
        attachments: images.map((input) => ({
          type: "image" as const,
          mimeType: input.mimeType,
          fileName: input.fileName,
          size: input.data.byteLength,
          content: btoa(String.fromCharCode(...new Uint8Array(input.data))),
        })),
        rejections: [],
      }));
    const wrapper = shallowMount(ChatView, {
      global: { plugins: [pinia], stubs: { ChatAttachments: false } },
    });
    return { pinia, store, send, imported, wrapper, box: wrapper.get(".home-input-box") };
  }

  beforeEach(() => {
    setLocale("en-US");
    window.openclaw = createBrowserOpenClawMock();
    reactive(route).params.agentId = "main";
  });

  it("previews multiple dropped images, removes and re-adds one, then sends through the existing flow", async () => {
    const { wrapper, box, send, imported } = setup();
    await box.trigger("drop", { dataTransfer: data([image("first.png"), image("second.png")]) });
    await flushPromises();
    expect(imported).toHaveBeenCalledWith(
      [
        expect.objectContaining({ fileName: "first.png", mimeType: "image/png" }),
        expect.objectContaining({ fileName: "second.png", mimeType: "image/png" }),
      ],
      0,
    );
    expect(wrapper.findAll(".chat-attachment__image")).toHaveLength(2);
    await wrapper.findAll(".chat-attachment__remove")[0].trigger("click");
    expect(wrapper.findAll(".chat-attachment__image")).toHaveLength(1);
    await box.trigger("drop", { dataTransfer: data([image("first.png")]) });
    await flushPromises();
    expect(imported).toHaveBeenLastCalledWith(
      [expect.objectContaining({ fileName: "first.png" })],
      png.byteLength,
    );
    await wrapper.get("textarea").setValue("Look at these images");
    await wrapper.get(".home-input-send").trigger("click");
    await flushPromises();
    expect(send).toHaveBeenCalledWith("Look at these images", [
      expect.objectContaining({ fileName: "second.png" }),
      expect.objectContaining({ fileName: "first.png" }),
    ]);
    expect(wrapper.findAll(".chat-attachment__image")).toHaveLength(0);
    wrapper.unmount();
  });

  it("shows unsupported/oversized errors and imports only supported images", async () => {
    const error = vi.spyOn(ElMessage, "error").mockImplementation(() => ({ close: vi.fn() }));
    const { wrapper, box, imported } = setup();
    const oversized = image("large.png");
    Object.defineProperty(oversized, "size", { value: 20 * 1024 * 1024 + 1 });
    await box.trigger("drop", {
      dataTransfer: data([
        new File(["text"], "notes.txt", { type: "text/plain" }),
        oversized,
        image(),
      ]),
    });
    await flushPromises();
    expect(imported.mock.calls[0][0]).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(
      t("chat.attachment.unsupportedImage", { file: "notes.txt" }),
    );
    expect(error).toHaveBeenCalledWith(
      t("chat.attachment.fileTooLarge", { file: "large.png", limit: "20 MB" }),
    );
    expect(wrapper.findAll(".chat-attachment__image")).toHaveLength(1);
    wrapper.unmount();
    error.mockRestore();
  });

  it("blocks sending during import and preserves dropped attachments when sending fails", async () => {
    const { wrapper, box, send, imported } = setup();
    let finishImport!: (result: OpenFilesResult) => void;
    imported.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishImport = resolve;
        }),
    );
    await wrapper.get("textarea").setValue("Keep this draft");
    await box.trigger("drop", { dataTransfer: data([image()]) });
    await flushPromises();
    expect(wrapper.get(".home-input-send").attributes("disabled")).toBeDefined();
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    expect(send).not.toHaveBeenCalled();
    finishImport({
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          fileName: "photo.png",
          size: png.byteLength,
          content: "iVBORw0KGgo=",
        },
      ],
      rejections: [],
    });
    await flushPromises();
    send.mockResolvedValueOnce(false);
    await wrapper.get(".home-input-send").trigger("click");
    await flushPromises();
    expect(wrapper.findAll(".chat-attachment__image")).toHaveLength(1);
    expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("Keep this draft");
    wrapper.unmount();
  });

  it("keeps the drop hint across nested drag events and prevents file navigation while disconnected", async () => {
    const { wrapper, box, store, imported } = setup();
    const transfer = data([]);
    await box.trigger("dragenter", { dataTransfer: transfer });
    await wrapper.get("textarea").trigger("dragenter", { dataTransfer: transfer });
    await wrapper.get("textarea").trigger("dragleave", { dataTransfer: transfer });
    expect(wrapper.get(".home-input-drop-hint").text()).toBe(t("chat.dropImages"));
    await box.trigger("dragleave", { dataTransfer: transfer });
    expect(wrapper.find(".home-input-drop-hint").exists()).toBe(false);
    store.wsConnected = false;
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: data([image()]) });
    box.element.dispatchEvent(event);
    await flushPromises();
    expect(event.defaultPrevented).toBe(true);
    expect(imported).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("does not add an in-flight drop to a different session", async () => {
    const { wrapper, box, store, imported } = setup();
    const originalKey = store.sessionKey;
    let finishImport!: (result: OpenFilesResult) => void;
    imported.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishImport = resolve;
        }),
    );
    await box.trigger("drop", { dataTransfer: data([image()]) });
    await flushPromises();
    store.sessionKey = "another-session";
    finishImport({
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          fileName: "photo.png",
          size: png.byteLength,
          content: "iVBORw0KGgo=",
        },
      ],
      rejections: [],
    });
    await flushPromises();
    expect(wrapper.findAll(".chat-attachment__image")).toHaveLength(0);
    store.sessionKey = originalKey;
    await flushPromises();
    expect(wrapper.findAll(".chat-attachment__image")).toHaveLength(1);
    wrapper.unmount();
  });

  it.each(["file-read", "ipc"] as const)(
    "invalidates an empty draft during %s and sends only images dropped after clearing",
    async (stage) => {
      const { wrapper, box, store, send, imported } = setup();
      const gate = deferred<void>();
      const oldImage = image("old.png");
      const queuedImage = image("queued-old.png");
      const queuedRead = vi.spyOn(queuedImage, "slice");
      if (stage === "file-read") {
        vi.spyOn(oldImage, "arrayBuffer").mockImplementationOnce(async () => {
          await gate.promise;
          return png.slice().buffer;
        });
      } else {
        imported.mockImplementationOnce(async () => {
          await gate.promise;
          return imageResult("old.png");
        });
      }

      try {
        await box.trigger("drop", { dataTransfer: data([oldImage]) });
        await flushPromises();
        await box.trigger("drop", { dataTransfer: data([queuedImage]) });
        const sessionKey = store.sessionKey;
        window.dispatchEvent(new Event("microclaw:clear-compose"));
        expect(store.sessionKey).toBe(sessionKey);
        expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("");
        expect(wrapper.findAll(".chat-attachment__image")).toHaveLength(0);
        await box.trigger("drop", { dataTransfer: data([image("new.png")]) });
        gate.resolve();
        await flushPromises();

        expect(wrapper.findAll(".chat-attachment__image")).toHaveLength(1);
        expect(queuedRead).not.toHaveBeenCalled();
        expect(imported).toHaveBeenCalledTimes(stage === "file-read" ? 1 : 2);
        expect(imported).toHaveBeenLastCalledWith(
          [expect.objectContaining({ fileName: "new.png" })],
          0,
        );
        await wrapper.get("textarea").setValue("New draft");
        await wrapper.get(".home-input-send").trigger("click");
        await flushPromises();
        expect(send).toHaveBeenCalledWith("New draft", [
          expect.objectContaining({ fileName: "new.png" }),
        ]);
      } finally {
        wrapper.unmount();
      }
    },
  );

  it.each(["session", "agent"] as const)(
    "keeps an in-flight drop for its draft after a %s round trip",
    async (target) => {
      const { wrapper, box, store, imported } = setup();
      const importing = deferred<OpenFilesResult>();
      imported.mockReturnValueOnce(importing.promise);
      try {
        await box.trigger("drop", { dataTransfer: data([image("old.png")]) });
        await flushPromises();
        if (target === "session") {
          const previous = store.sessionKey;
          store.sessionKey = "another-session";
          store.sessionKey = previous;
        } else {
          await store.switchAgentSession("writer");
          await store.switchAgentSession("main");
        }
        importing.resolve(imageResult("old.png"));
        await flushPromises();
        expect(wrapper.findAll(".chat-attachment__image")).toHaveLength(1);
      } finally {
        wrapper.unmount();
      }
    },
  );

  it.each(["session", "agent"] as const)(
    "restores independent text and attachments when switching %s",
    async (target) => {
      const { wrapper, box, store, pinia } = setup();
      const firstKey = store.sessionKey;
      try {
        await wrapper.get("textarea").setValue("First draft");
        await box.trigger("drop", { dataTransfer: data([image("first.png")]) });
        await flushPromises();
        if (target === "session") store.sessionKey = "another-session";
        else await store.switchAgentSession("writer");
        const secondKey = store.sessionKey;
        await flushPromises();
        expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("");
        expect(wrapper.findAll(".chat-attachment__image")).toHaveLength(0);
        await wrapper.get("textarea").setValue("Second draft");
        await box.trigger("drop", { dataTransfer: data([image("second.png")]) });
        await flushPromises();
        if (target === "session") store.sessionKey = firstKey;
        else await store.switchAgentSession("main");
        await flushPromises();
        expect(store.sessionKey).toBe(firstKey);
        expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("First draft");
        expect(wrapper.get(".chat-attachment__image").attributes("alt")).toBe("first.png");
        await wrapper.get(".chat-attachment__remove").trigger("click");
        if (target === "session") store.sessionKey = secondKey;
        else await store.switchAgentSession("writer");
        await flushPromises();
        expect(store.sessionKey).toBe(secondKey);
        expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("Second draft");
        expect(wrapper.get(".chat-attachment__image").attributes("alt")).toBe("second.png");
      } finally {
        wrapper.unmount();
      }
      const remounted = shallowMount(ChatView, {
        global: { plugins: [pinia], stubs: { ChatAttachments: false } },
      });
      try {
        expect((remounted.get("textarea").element as HTMLTextAreaElement).value).toBe(
          "Second draft",
        );
        expect(remounted.get(".chat-attachment__image").attributes("alt")).toBe("second.png");
      } finally {
        remounted.unmount();
      }
    },
  );

  it.each(["file-read", "ipc"] as const)(
    "finishes a %s import only in its original draft without blocking another session",
    async (stage) => {
      const { wrapper, box, store, imported, send } = setup();
      const firstKey = store.sessionKey;
      const gate = deferred<void>();
      const oldImage = image("first.png");
      if (stage === "file-read") {
        vi.spyOn(oldImage, "arrayBuffer").mockImplementationOnce(async () => {
          await gate.promise;
          return png.slice().buffer;
        });
      } else {
        imported.mockImplementationOnce(async () => {
          await gate.promise;
          return imageResult("first.png");
        });
      }
      try {
        await wrapper.get("textarea").setValue("First draft");
        await box.trigger("drop", { dataTransfer: data([oldImage]) });
        await flushPromises();
        store.sessionKey = "second-session";
        await wrapper.get("textarea").setValue("Second draft");
        await box.trigger("drop", { dataTransfer: data([image("second.png")]) });
        await flushPromises();
        await wrapper.get(".home-input-send").trigger("click");
        await flushPromises();
        expect(send).toHaveBeenCalledWith("Second draft", [
          expect.objectContaining({ fileName: "second.png" }),
        ]);
        gate.resolve();
        await flushPromises();
        expect(wrapper.findAll(".chat-attachment__image")).toHaveLength(0);
        store.sessionKey = firstKey;
        await flushPromises();
        expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("First draft");
        expect(wrapper.get(".chat-attachment__image").attributes("alt")).toBe("first.png");
      } finally {
        wrapper.unmount();
      }
    },
  );

  it("does not resurrect a cleared import after leaving and returning to its session", async () => {
    const { wrapper, box, store, imported } = setup();
    const firstKey = store.sessionKey;
    const importing = deferred<OpenFilesResult>();
    imported.mockReturnValueOnce(importing.promise);
    try {
      await box.trigger("drop", { dataTransfer: data([image("old.png")]) });
      await flushPromises();
      store.sessionKey = "second-session";
      store.clearDraft(firstKey);
      store.sessionKey = firstKey;
      importing.resolve(imageResult("old.png"));
      await flushPromises();
      expect(wrapper.findAll(".chat-attachment__image")).toHaveLength(0);
      await box.trigger("drop", { dataTransfer: data([image("new.png")]) });
      await flushPromises();
      expect(wrapper.get(".chat-attachment__image").attributes("alt")).toBe("new.png");
    } finally {
      wrapper.unmount();
    }
  });

  it("restores an import completed after leaving the chat view", async () => {
    const { wrapper, box, store, pinia, imported } = setup();
    const firstKey = store.sessionKey;
    const importing = deferred<OpenFilesResult>();
    imported.mockReturnValueOnce(importing.promise);
    await box.trigger("drop", { dataTransfer: data([image("first.png")]) });
    await flushPromises();
    wrapper.unmount();
    store.sessionKey = "second-session";
    const remounted = shallowMount(ChatView, {
      global: { plugins: [pinia], stubs: { ChatAttachments: false } },
    });
    try {
      importing.resolve(imageResult("first.png"));
      await flushPromises();
      expect(remounted.findAll(".chat-attachment__image")).toHaveLength(0);
      store.sessionKey = firstKey;
      await flushPromises();
      expect(remounted.get(".chat-attachment__image").attributes("alt")).toBe("first.png");
    } finally {
      remounted.unmount();
    }
  });

  it.each(["picker", "paste"] as const)(
    "keeps delayed %s attachments in the originating draft",
    async (source) => {
      const { wrapper, store, imported } = setup();
      const firstKey = store.sessionKey;
      const importing = deferred<OpenFilesResult>();
      if (source === "picker") {
        vi.spyOn(window.openclaw.dialog, "openFiles").mockReturnValueOnce(importing.promise);
      } else {
        imported.mockReturnValueOnce(importing.promise);
      }
      try {
        if (source === "picker") {
          await wrapper.get(".home-input-plus").trigger("click");
        } else {
          await wrapper.get("textarea").trigger("paste", {
            clipboardData: {
              files: [image()],
              getData: () => "",
            },
          });
        }
        await flushPromises();
        store.sessionKey = "second-session";
        importing.resolve(imageResult("first.png"));
        await flushPromises();
        expect(wrapper.findAll(".chat-attachment__image")).toHaveLength(0);
        store.sessionKey = firstKey;
        await flushPromises();
        expect(wrapper.get(".chat-attachment__image").attributes("alt")).toBe("first.png");
      } finally {
        wrapper.unmount();
      }
    },
  );

  it.each([false, true])(
    "updates only the originating draft when a send completes after switching (sent: %s)",
    async (sent) => {
      const { wrapper, box, store, send } = setup();
      const firstKey = store.sessionKey;
      const sending = deferred<boolean>();
      send.mockReturnValueOnce(sending.promise);
      try {
        await wrapper.get("textarea").setValue("First draft");
        await box.trigger("drop", { dataTransfer: data([image("first.png")]) });
        await flushPromises();
        await wrapper.get(".home-input-send").trigger("click");
        await flushPromises();
        store.sessionKey = "second-session";
        await flushPromises();
        await wrapper.get("textarea").setValue("Second draft");
        await box.trigger("drop", { dataTransfer: data([image("second.png")]) });
        await flushPromises();
        sending.resolve(sent);
        await flushPromises();
        expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("Second draft");
        expect(wrapper.get(".chat-attachment__image").attributes("alt")).toBe("second.png");
        store.sessionKey = firstKey;
        await flushPromises();
        expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe(
          sent ? "" : "First draft",
        );
        expect(wrapper.findAll(".chat-attachment__image")).toHaveLength(sent ? 0 : 1);
      } finally {
        wrapper.unmount();
      }
    },
  );

  it("preserves the mounted draft when the main session is canonicalized", async () => {
    const { wrapper, box, store } = setup();
    try {
      await wrapper.get("textarea").setValue("Keep this draft");
      await box.trigger("drop", { dataTransfer: data([image()]) });
      await flushPromises();
      store.setMainSessionKey("agent:main:main");
      await flushPromises();
      expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe(
        "Keep this draft",
      );
      expect(wrapper.findAll(".chat-attachment__image")).toHaveLength(1);
    } finally {
      wrapper.unmount();
    }
  });

  it("does not send an old draft after switching during model setup preflight", async () => {
    const { wrapper, store, send } = setup();
    const originalKey = store.sessionKey;
    const response = await window.openclaw.model.session.get(originalKey);
    const checking = deferred<typeof response>();
    vi.spyOn(window.openclaw.model.session, "get").mockReturnValueOnce(checking.promise);
    try {
      await wrapper.get("textarea").setValue("First draft");
      await wrapper.get(".home-input-send").trigger("click");
      await flushPromises();
      store.sessionKey = "second-session";
      await flushPromises();
      await wrapper.get("textarea").setValue("Second draft");
      checking.resolve(response);
      await flushPromises();
      expect(send).not.toHaveBeenCalled();
      expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("Second draft");
      store.sessionKey = originalKey;
      await flushPromises();
      expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("First draft");
    } finally {
      wrapper.unmount();
    }
  });

  it.each([false, true])(
    "reports import failures only for the current draft (cleared: %s)",
    async (cleared) => {
      const error = vi.spyOn(ElMessage, "error").mockImplementation(() => ({ close: vi.fn() }));
      const { wrapper, box, imported } = setup();
      const importing = deferred<OpenFilesResult>();
      imported.mockReturnValueOnce(importing.promise);
      try {
        await box.trigger("drop", { dataTransfer: data([image("old.png")]) });
        await flushPromises();
        if (cleared) window.dispatchEvent(new Event("microclaw:clear-compose"));
        await box.trigger("drop", { dataTransfer: data([image("new.png")]) });
        importing.reject(new Error("import failed"));
        await flushPromises();
        if (cleared) {
          expect(error).not.toHaveBeenCalled();
        } else {
          expect(error).toHaveBeenCalledWith(
            t("chat.attachment.pickerFailed", { error: "Error: import failed" }),
          );
        }
        expect(wrapper.findAll(".chat-attachment__image")).toHaveLength(1);
        expect(wrapper.get(".home-input-send").attributes("disabled")).toBeUndefined();
      } finally {
        wrapper.unmount();
        error.mockRestore();
      }
    },
  );

  it("serializes successive drops using the updated attachment total", async () => {
    const { wrapper, box, imported } = setup();
    let finishImport!: (result: OpenFilesResult) => void;
    imported.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishImport = resolve;
        }),
    );
    await box.trigger("drop", { dataTransfer: data([image("first.png")]) });
    await flushPromises();
    await box.trigger("drop", { dataTransfer: data([image("second.png")]) });
    await flushPromises();
    expect(imported).toHaveBeenCalledTimes(1);
    finishImport({
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          fileName: "first.png",
          size: png.byteLength,
          content: "iVBORw0KGgo=",
        },
      ],
      rejections: [],
    });
    await flushPromises();
    expect(imported).toHaveBeenLastCalledWith(
      [expect.objectContaining({ fileName: "second.png" })],
      png.byteLength,
    );
    expect(wrapper.findAll(".chat-attachment__image")).toHaveLength(2);
    wrapper.unmount();
  });
});
