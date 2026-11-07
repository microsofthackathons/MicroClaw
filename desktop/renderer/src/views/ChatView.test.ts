import { createPinia, setActivePinia } from "pinia";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserOpenClawMock } from "@/browser-openclaw";
import { ElMessage } from "element-plus";
import { setLocale, t } from "@/i18n";
import { useChatStore } from "@/stores/chat";
import ChatView from "./ChatView.vue";

vi.mock("vue-router", () => ({
  useRoute: () => ({ params: {} }),
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
});

describe("ChatView image drops", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const image = (name = "photo.png") => new File([png], name, { type: "image/png" });
  const data = (files: File[]) => ({ files, types: ["Files"], dropEffect: "none" });

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
    return { store, send, imported, wrapper, box: wrapper.get(".home-input-box") };
  }

  beforeEach(() => {
    setLocale("en-US");
    window.openclaw = createBrowserOpenClawMock();
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
    expect(wrapper.findAll(".chat-attachment__thumbnail")).toHaveLength(2);
    await wrapper.findAll(".chat-attachment__remove")[0].trigger("click");
    expect(wrapper.findAll(".chat-attachment__thumbnail")).toHaveLength(1);
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
    expect(wrapper.findAll(".chat-attachment__thumbnail")).toHaveLength(0);
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
    expect(wrapper.findAll(".chat-attachment__thumbnail")).toHaveLength(1);
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
    expect(wrapper.findAll(".chat-attachment__thumbnail")).toHaveLength(1);
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
    expect(wrapper.findAll(".chat-attachment__thumbnail")).toHaveLength(0);
    wrapper.unmount();
  });

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
    expect(wrapper.findAll(".chat-attachment__thumbnail")).toHaveLength(2);
    wrapper.unmount();
  });
});
