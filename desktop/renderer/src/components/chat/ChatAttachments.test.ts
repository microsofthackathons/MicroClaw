import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import ChatAttachments from "./ChatAttachments.vue";

const openAttachment = vi.fn().mockResolvedValue({ ok: true });

beforeEach(() => {
  openAttachment.mockClear();
  Object.defineProperty(window, "openclaw", {
    configurable: true,
    value: { attachment: { open: openAttachment } },
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
});
