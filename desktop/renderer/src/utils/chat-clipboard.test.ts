import { describe, expect, it, vi } from "vitest";
import {
  clipboardTextToInsert,
  collectClipboardImageFiles,
  insertTextAtSelection,
  serializeClipboardImages,
} from "./chat-clipboard";

function clipboardData(items: Partial<DataTransferItem>[], text = ""): DataTransfer {
  return {
    items,
    files: [],
    getData: vi.fn().mockReturnValue(text),
  } as unknown as DataTransfer;
}

describe("chat clipboard images", () => {
  it("collects image file items without treating ordinary text as an image", () => {
    const image = new File(["png"], "image.png", { type: "image/png" });
    const data = clipboardData([
      { kind: "string", type: "text/plain" },
      { kind: "file", type: "image/png", getAsFile: () => image },
    ]);

    expect(collectClipboardImageFiles(data)).toEqual([image]);
    expect(
      collectClipboardImageFiles(clipboardData([{ kind: "string", type: "text/plain" }])),
    ).toEqual([]);
  });

  it("preserves ordinary text but suppresses image representations", () => {
    expect(clipboardTextToInsert(clipboardData([], "hello"))).toBe("hello");
    expect(clipboardTextToInsert(clipboardData([], "  "))).toBe("  ");
    expect(clipboardTextToInsert(clipboardData([], "[object File]"))).toBe("");
    expect(clipboardTextToInsert(clipboardData([], "data:image/png;base64,AQID"))).toBe("");
  });

  it("inserts accompanying clipboard text at the current selection", () => {
    expect(insertTextAtSelection("say now", 4, 7, "hello")).toEqual({
      text: "say hello",
      caret: 9,
    });
  });

  it("serializes multiple images with timestamped MIME-correct names", async () => {
    const images = await serializeClipboardImages(
      [
        new File(["png"], "ignored", { type: "image/png" }),
        new File(["jpeg"], "ignored", { type: "image/jpeg" }),
      ],
      new Date(2026, 7, 6, 14, 25, 30),
    );

    expect(images.map(({ fileName, mimeType }) => ({ fileName, mimeType }))).toEqual([
      { fileName: "Screenshot 2026-08-06 142530.png", mimeType: "image/png" },
      { fileName: "Screenshot 2026-08-06 142530 (2).jpg", mimeType: "image/jpeg" },
    ]);
    expect(Array.from(new Uint8Array(images[0].data))).toEqual([112, 110, 103]);
  });
});
