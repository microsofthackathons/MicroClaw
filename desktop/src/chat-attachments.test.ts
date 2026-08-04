import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  inferAttachmentMimeType,
  prepareChatAttachments,
  validateChatAttachments,
} from "./chat-attachments";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "microclaw-attachments-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("inferAttachmentMimeType", () => {
  it("recognizes common file types and falls back safely", () => {
    expect(inferAttachmentMimeType("photo.JPEG")).toBe("image/jpeg");
    expect(inferAttachmentMimeType("report.pdf")).toBe("application/pdf");
    expect(inferAttachmentMimeType("notes.txt")).toBe("text/plain");
    expect(inferAttachmentMimeType("data.unknown")).toBe("application/octet-stream");
  });
});

describe("prepareChatAttachments", () => {
  it("encodes accepted files and classifies images", async () => {
    const dir = await makeTempDir();
    const imagePath = path.join(dir, "pixel.png");
    const textPath = path.join(dir, "notes.txt");
    await writeFile(imagePath, Buffer.from([1, 2, 3]));
    await writeFile(textPath, "hello");

    const result = await prepareChatAttachments([imagePath, textPath], 20, 20);

    expect(result.rejections).toEqual([]);
    expect(result.attachments).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        fileName: "pixel.png",
        size: 3,
        content: "AQID",
      },
      {
        type: "file",
        mimeType: "text/plain",
        fileName: "notes.txt",
        size: 5,
        content: "aGVsbG8=",
      },
    ]);
  });

  describe("validateChatAttachments", () => {
    it("accepts a correctly sized gateway attachment", () => {
      const attachment = {
        type: "file" as const,
        mimeType: "text/plain",
        fileName: "notes.txt",
        size: 5,
        content: "aGVsbG8=",
      };

      expect(validateChatAttachments([attachment])).toEqual([attachment]);
      expect(validateChatAttachments(undefined)).toBeUndefined();
    });

    it("rejects malformed base64 and mismatched decoded sizes", () => {
      expect(() =>
        validateChatAttachments([
          {
            type: "file",
            mimeType: "text/plain",
            fileName: "notes.txt",
            size: 5,
            content: "not base64",
          },
        ]),
      ).toThrow("Invalid attachment encoding");
      expect(() =>
        validateChatAttachments([
          {
            type: "file",
            mimeType: "text/plain",
            fileName: "notes.txt",
            size: 4,
            content: "aGVsbG8=",
          },
        ]),
      ).toThrow("Attachment size mismatch");
    });

    it("enforces per-file and aggregate limits at the send boundary", () => {
      const attachment = {
        type: "file",
        mimeType: "text/plain",
        fileName: "notes.txt",
        size: 5,
        content: "aGVsbG8=",
      };

      expect(() => validateChatAttachments([attachment], 4, 10)).toThrow("per-file limit");
      expect(() => validateChatAttachments([attachment, attachment], 5, 9)).toThrow(
        "aggregate limit",
      );
    });
  });

  it("rejects only files above the per-file limit", async () => {
    const dir = await makeTempDir();
    const largePath = path.join(dir, "large.pdf");
    const smallPath = path.join(dir, "small.txt");
    await writeFile(largePath, "123456");
    await writeFile(smallPath, "ok");

    const result = await prepareChatAttachments([largePath, smallPath], 5, 20);

    expect(result.attachments.map((item) => item.fileName)).toEqual(["small.txt"]);
    expect(result.rejections).toEqual([
      { fileName: "large.pdf", reason: "file_too_large", size: 6, limit: 5 },
    ]);
  });

  it("continues after an aggregate rejection so smaller files can still fit", async () => {
    const dir = await makeTempDir();
    const firstPath = path.join(dir, "first.txt");
    const rejectedPath = path.join(dir, "rejected.txt");
    const lastPath = path.join(dir, "last.txt");
    await writeFile(firstPath, "123456");
    await writeFile(rejectedPath, "12345");
    await writeFile(lastPath, "1234");

    const result = await prepareChatAttachments(
      [firstPath, rejectedPath, lastPath],
      10,
      10,
    );

    expect(result.attachments.map((item) => item.fileName)).toEqual(["first.txt", "last.txt"]);
    expect(result.rejections).toEqual([
      { fileName: "rejected.txt", reason: "total_too_large", size: 5, limit: 10 },
    ]);
  });

  it("includes files already pending in the aggregate limit", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "new.txt");
    await writeFile(filePath, "1234");

    const result = await prepareChatAttachments([filePath], 10, 10, 7);

    expect(result.attachments).toEqual([]);
    expect(result.rejections).toEqual([
      { fileName: "new.txt", reason: "total_too_large", size: 4, limit: 10 },
    ]);
  });

  it("reports unreadable paths without dropping readable files", async () => {
    const dir = await makeTempDir();
    const readablePath = path.join(dir, "readable.txt");
    await writeFile(readablePath, "ok");

    const result = await prepareChatAttachments(
      [path.join(dir, "missing.txt"), readablePath],
      10,
      10,
    );

    expect(result.attachments.map((item) => item.fileName)).toEqual(["readable.txt"]);
    expect(result.rejections).toEqual([{ fileName: "missing.txt", reason: "read_failed" }]);
  });
});
