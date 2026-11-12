import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { ElImageViewer } from "element-plus";
import { setLocale } from "@/i18n";
import ChatAttachments from "./ChatAttachments.vue";

const openAttachment = vi.fn().mockResolvedValue({ ok: true });
const imageDataUrl = "data:image/png;base64,AQID";
const readImage = vi.fn().mockResolvedValue({ ok: true, dataUrl: imageDataUrl });

beforeEach(() => {
  openAttachment.mockClear();
  readImage.mockReset().mockResolvedValue({ ok: true, dataUrl: imageDataUrl });
  setLocale("en-US");
  Object.defineProperty(window, "openclaw", {
    configurable: true,
    value: { attachment: { open: openAttachment, readImage } },
  });
});

describe("ChatAttachments", () => {
  const attachment: ChatAttachment = {
    type: "file",
    mimeType: "text/plain",
    fileName: "notes.txt",
    size: 5,
    content: "aGVsbG8=",
  };

  it("opens a content-bearing attachment when its card is clicked", async () => {
    const wrapper = mount(ChatAttachments, {
      props: { attachments: [attachment] },
    });

    await wrapper.get(".chat-attachment").trigger("click");

    expect(openAttachment).toHaveBeenCalledWith(attachment);
    expect(wrapper.get(".chat-attachment").attributes("role")).toBe("button");
  });

  it("removes without opening when the remove button is clicked", async () => {
    const wrapper = mount(ChatAttachments, {
      props: { attachments: [attachment], removable: true },
    });

    await wrapper.get(".chat-attachment__remove").trigger("click");

    expect(openAttachment).not.toHaveBeenCalled();
    expect(wrapper.emitted("remove")).toEqual([[0]]);
  });

  it("does not open when keyboard events originate from the remove button", async () => {
    const wrapper = mount(ChatAttachments, {
      props: { attachments: [attachment], removable: true },
    });
    const removeButton = wrapper.get(".chat-attachment__remove");

    await removeButton.trigger("keydown", { key: "Enter" });
    await removeButton.trigger("click");

    expect(openAttachment).not.toHaveBeenCalled();
    expect(wrapper.emitted("remove")).toEqual([[0]]);
  });

  it("does not show clickable affordance for an unavailable history attachment", () => {
    const wrapper = mount(ChatAttachments, {
      props: {
        attachments: [{ ...attachment, content: "", mediaPath: undefined }],
      },
    });

    expect(wrapper.get(".chat-attachment").attributes("role")).toBeUndefined();
    expect(wrapper.get(".chat-attachment").classes()).not.toContain("chat-attachment--openable");
  });

  it("opens a history attachment with an absolute inbound media path", async () => {
    const historyAttachment = {
      ...attachment,
      content: "",
      mediaPath: "C:\\Users\\sunt\\.openclaw\\media\\inbound\\notes.txt",
    };
    const wrapper = mount(ChatAttachments, {
      props: { attachments: [historyAttachment] },
    });

    await wrapper.get(".chat-attachment").trigger("click");

    expect(openAttachment).toHaveBeenCalledWith(historyAttachment);
  });

  const image: ChatAttachment = {
    type: "image",
    mimeType: "image/*",
    fileName: "",
    size: 0,
    content: "",
    mediaPath: "media://inbound/photo",
  };

  it("loads a history image inline and opens an in-app viewer on click", async () => {
    const wrapper = mount(ChatAttachments, {
      props: { attachments: [image] },
      global: { stubs: { ElImageViewer: true } },
    });
    expect(wrapper.get('[role="status"]').text()).toContain("Loading image");
    await flushPromises();

    expect(readImage).toHaveBeenCalledExactlyOnceWith(image.mediaPath);
    expect(wrapper.get(".chat-attachment__image").attributes("src")).toBe(imageDataUrl);
    expect(wrapper.find(".chat-attachment__details").exists()).toBe(false);
    await wrapper.get(".chat-attachment").trigger("click");
    expect(wrapper.getComponent(ElImageViewer).props("urlList")).toEqual([imageDataUrl]);
    expect(openAttachment).not.toHaveBeenCalled();
    wrapper.getComponent(ElImageViewer).vm.$emit("close");
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent(ElImageViewer).exists()).toBe(false);
    wrapper.unmount();
  });

  it("previews an inline image without requesting a local file", async () => {
    const wrapper = mount(ChatAttachments, {
      props: {
        attachments: [{ ...image, content: "AQID", mimeType: "image/png" }],
        removable: true,
      },
      global: { stubs: { ElImageViewer: true } },
    });
    expect(wrapper.get(".chat-attachment__image").attributes("src")).toBe(imageDataUrl);
    expect(readImage).not.toHaveBeenCalled();
    await wrapper.get(".chat-attachment").trigger("keydown", { key: "Enter" });
    expect(wrapper.findComponent(ElImageViewer).exists()).toBe(true);
    expect(openAttachment).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("keeps image removal separate from opening the viewer", async () => {
    const wrapper = mount(ChatAttachments, {
      props: { attachments: [{ ...image, content: "AQID" }], removable: true },
      global: { stubs: { ElImageViewer: true } },
    });
    await wrapper.get(".chat-attachment__remove").trigger("click");
    expect(wrapper.emitted("remove")).toEqual([[0]]);
    expect(wrapper.findComponent(ElImageViewer).exists()).toBe(false);
    expect(openAttachment).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("falls back to opening the original if the preview cannot be read", async () => {
    readImage.mockResolvedValueOnce({ ok: false, error: "Image not found" });
    const wrapper = mount(ChatAttachments, { props: { attachments: [image] } });
    await flushPromises();
    expect(wrapper.find(".chat-attachment__image").exists()).toBe(false);
    expect(wrapper.text()).toContain("Preview unavailable");
    await wrapper.get(".chat-attachment").trigger("click");
    expect(openAttachment).toHaveBeenCalledWith(image);
    wrapper.unmount();
  });

  it("handles rejected preview requests without leaving a permanent loading state", async () => {
    readImage.mockRejectedValueOnce(new Error("IPC unavailable"));
    const wrapper = mount(ChatAttachments, { props: { attachments: [image] } });
    await flushPromises();
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("Preview unavailable");
    wrapper.unmount();
  });

  it("falls back cleanly if the browser cannot decode an image", async () => {
    const wrapper = mount(ChatAttachments, { props: { attachments: [image] } });
    await flushPromises();
    await wrapper.get(".chat-attachment__image").trigger("error");
    expect(wrapper.find(".chat-attachment__image").exists()).toBe(false);
    expect(wrapper.text()).toContain("Preview unavailable");
    wrapper.unmount();
  });

  it("does not reread unchanged media when attachment objects are recreated", async () => {
    const wrapper = mount(ChatAttachments, { props: { attachments: [image] } });
    await flushPromises();
    await wrapper.setProps({ attachments: [{ ...image }] });
    await flushPromises();
    expect(readImage).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("ignores stale image loads after the attachment changes", async () => {
    let finishOldRead!: (value: { ok: boolean; dataUrl: string }) => void;
    readImage.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOldRead = resolve;
      }),
    );
    const wrapper = mount(ChatAttachments, { props: { attachments: [image] } });
    await wrapper.setProps({ attachments: [{ ...image, mediaPath: "media://inbound/new-photo" }] });
    await flushPromises();
    finishOldRead({ ok: true, dataUrl: "data:image/png;base64,OLD" });
    await flushPromises();
    expect(wrapper.get(".chat-attachment__image").attributes("src")).toBe(imageDataUrl);
    wrapper.unmount();
  });

  it("never requests remote URLs or arbitrary local files for previews", async () => {
    const wrapper = mount(ChatAttachments, {
      props: {
        attachments: [
          { ...image, mediaPath: "https://example.com/photo.png" },
          { ...image, mediaPath: "C:\\outside\\private.png" },
        ],
      },
    });
    await flushPromises();
    expect(readImage).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
