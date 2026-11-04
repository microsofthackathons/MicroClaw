import { describe, expect, it, vi } from "vitest";
import { prepareDroppedImages } from "./chat-image-drop";

const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const file = (bytes = png, name = "photo.png", type = "image/png") =>
  new File([new Uint8Array(bytes)], name, { type });
const textBytes = (text: string) => [...text].map((character) => character.charCodeAt(0));

describe("dropped chat images", () => {
  it.each([
    [png, "image/png"],
    [[0xff, 0xd8, 0xff], "image/jpeg"],
    [textBytes("GIF89a"), "image/gif"],
    [textBytes("BM"), "image/bmp"],
    [[0x49, 0x49, 0x2a, 0], "image/tiff"],
    [[0x4d, 0x4d, 0, 0x2a], "image/tiff"],
    [textBytes("RIFF0000WEBP"), "image/webp"],
    [[0, 0, 0, 24, ...textBytes("ftypavif0000avif")], "image/avif"],
    [[0, 0, 0, 24, ...textBytes("ftypheic0000heic")], "image/heic"],
    [[0, 0, 0, 24, ...textBytes("ftypmif10000mif1")], "image/heif"],
  ])("detects image format from bytes with no OS MIME type (%s)", async (bytes, mimeType) => {
    const result = await prepareDroppedImages([file(bytes as number[], "original", "")], 0);
    expect(result.rejections).toEqual([]);
    expect(result.images).toEqual([
      { fileName: "original", mimeType, data: expect.any(ArrayBuffer) },
    ]);
  });

  it("rejects unsupported content regardless of its declared image type or extension", async () => {
    const result = await prepareDroppedImages(
      [
        file(textBytes("<svg></svg>"), "vector.svg", "image/svg+xml"),
        file(textBytes("not an image"), "spoof.png", "image/png"),
        file(textBytes("plain text"), "notes.txt", "text/plain"),
      ],
      0,
    );
    expect(result.images).toEqual([]);
    expect(result.rejections).toEqual([
      { fileName: "vector.svg", reason: "unsupported_image" },
      { fileName: "spoof.png", reason: "unsupported_image" },
      { fileName: "notes.txt", reason: "unsupported_image" },
    ]);
  });

  it("does not mistake brands outside the ISO file-type box for an AVIF image", async () => {
    const result = await prepareDroppedImages(
      [file([0, 0, 0, 16, ...textBytes("ftypisom0000avif")], "video.mp4", "")],
      0,
    );
    expect(result.images).toEqual([]);
    expect(result.rejections).toEqual([{ fileName: "video.mp4", reason: "unsupported_image" }]);
  });

  it("rejects oversized files before reading their bytes and preserves valid images in a mixed drop", async () => {
    const oversized = file(png, "large.png");
    Object.defineProperty(oversized, "size", { value: 20 * 1024 * 1024 + 1 });
    const read = vi.spyOn(oversized, "arrayBuffer");
    const header = vi.spyOn(oversized, "slice");
    const result = await prepareDroppedImages([oversized, file()], 0);
    expect(read).not.toHaveBeenCalled();
    expect(header).not.toHaveBeenCalled();
    expect(result.images).toHaveLength(1);
    expect(result.rejections).toEqual([
      { fileName: "large.png", reason: "file_too_large", limit: 20 * 1024 * 1024 },
    ]);
  });

  it("includes existing attachments and earlier images in the total limit", async () => {
    const result = await prepareDroppedImages(
      [file(png, "first.png"), file(png, "second.png")],
      50 * 1024 * 1024 - png.length,
    );
    expect(result.images.map((image) => image.fileName)).toEqual(["first.png"]);
    expect(result.rejections).toEqual([
      { fileName: "second.png", reason: "total_too_large", limit: 50 * 1024 * 1024 },
    ]);
  });

  it("reports unreadable images while continuing with other files", async () => {
    const unreadable = file(png, "missing.png");
    vi.spyOn(unreadable, "arrayBuffer").mockRejectedValue(new Error("read failed"));
    const result = await prepareDroppedImages([unreadable, file()], 0);
    expect(result.images).toHaveLength(1);
    expect(result.rejections).toEqual([{ fileName: "missing.png", reason: "read_failed" }]);
  });
});
