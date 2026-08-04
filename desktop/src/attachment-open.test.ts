import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  prepareAttachmentForOpen,
  resolveInboundMediaPath,
  sanitizeAttachmentFileName,
} from "./attachment-open";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "microclaw-open-attachment-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("attachment opening", () => {
  it("sanitizes temp filenames and writes validated base64 content", async () => {
    const tempDir = await makeTempDir();
    const outputPath = await prepareAttachmentForOpen(
      {
        type: "file",
        mimeType: "text/plain",
        fileName: "..\\unsafe?.txt",
        size: 5,
        content: "aGVsbG8=",
      },
      tempDir,
      tempDir,
    );

    expect(path.dirname(outputPath)).toBe(path.join(tempDir, "MicroClaw", "attachments"));
    expect(path.basename(outputPath)).not.toContain("?");
    expect(await readFile(outputPath, "utf8")).toBe("hello");
    expect(sanitizeAttachmentFileName("", "image/png")).toBe("attachment.png");
    expect(sanitizeAttachmentFileName("a".repeat(200) + ".pdf", "application/pdf")).toMatch(
      /\.pdf$/,
    );
    expect(
      sanitizeAttachmentFileName("8f6cbb00-1234-4abc-8def-1234567890ab", "application/pdf"),
    ).toMatch(/\.pdf$/);
  });

  it("resolves only existing files inside the inbound media directory", async () => {
    const stateDir = await makeTempDir();
    const inboundDir = path.join(stateDir, "media", "inbound");
    await mkdir(inboundDir, { recursive: true });
    const mediaFile = path.join(inboundDir, "report.txt");
    await writeFile(mediaFile, "history");

    expect(resolveInboundMediaPath(stateDir, "media://inbound/report.txt")).toBe(mediaFile);
    expect(resolveInboundMediaPath(stateDir, mediaFile)).toBe(mediaFile);
    await expect(
      prepareAttachmentForOpen(
        {
          mediaPath: "media://inbound/report.txt",
        },
        stateDir,
        stateDir,
      ),
    ).resolves.toBe(mediaFile);
    await expect(
      prepareAttachmentForOpen(
        {
          mediaPath: mediaFile,
        },
        stateDir,
        stateDir,
      ),
    ).resolves.toBe(mediaFile);
    expect(() => resolveInboundMediaPath(stateDir, path.join(stateDir, "outside.txt"))).toThrow(
      "escaped its root",
    );
    expect(() => resolveInboundMediaPath(stateDir, "media://inbound/..%5Coutside.txt")).toThrow(
      "Invalid inbound media filename",
    );
  });

  it("copies extensionless inbound media to a MIME-suffixed temp file", async () => {
    const stateDir = await makeTempDir();
    const tempDir = await makeTempDir();
    const inboundDir = path.join(stateDir, "media", "inbound");
    await mkdir(inboundDir, { recursive: true });
    await writeFile(path.join(inboundDir, "8f6cbb00-1234-4abc-8def-1234567890ab"), "image");

    const outputPath = await prepareAttachmentForOpen(
      {
        type: "image",
        mimeType: "image/jpeg",
        fileName: "",
        size: 0,
        content: "",
        mediaPath: "media://inbound/8f6cbb00-1234-4abc-8def-1234567890ab",
      },
      tempDir,
      stateDir,
    );

    expect(outputPath).toMatch(/attachment\.jpg$/);
    expect(await readFile(outputPath, "utf8")).toBe("image");
  });
});
