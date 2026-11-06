import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { readInboundImage } from "./attachment-preview";
import { CHAT_ATTACHMENT_MAX_FILE_BYTES } from "./constants";

const tempDirs: string[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6vT8AAAAASUVORK5CYII=",
  "base64",
);

async function makeImage(content: Buffer | string = png, fileName = "photo") {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "microclaw-image-preview-"));
  tempDirs.push(stateDir);
  const inboundDir = path.join(stateDir, "media", "inbound");
  await mkdir(inboundDir, { recursive: true });
  const filePath = path.join(inboundDir, fileName);
  await writeFile(filePath, content);
  return { stateDir, inboundDir, filePath };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("inbound image previews", () => {
  it("reads extensionless Weixin images and detects their MIME type from bytes", async () => {
    const { stateDir, filePath } = await makeImage();
    const expected = `data:image/png;base64,${png.toString("base64")}`;

    await expect(readInboundImage("media://inbound/photo", stateDir)).resolves.toBe(expected);
    await expect(readInboundImage(filePath, stateDir)).resolves.toBe(expected);
  });

  it.each([
    ["image/jpeg", Buffer.from([255, 216, 255, 224])],
    ["image/gif", Buffer.from("GIF89a")],
    ["image/webp", Buffer.from("RIFF0000WEBP")],
    ["image/bmp", Buffer.from("BM0000")],
    ["image/avif", Buffer.from("0000ftypavif")],
  ])("detects %s without trusting the filename", async (mimeType, content) => {
    const { stateDir } = await makeImage(content, "photo.bin");
    await expect(readInboundImage("media://inbound/photo.bin", stateDir)).resolves.toBe(
      `data:${mimeType};base64,${content.toString("base64")}`,
    );
  });

  it.each(["<svg xmlns='http://www.w3.org/2000/svg'></svg>", "<html>not an image</html>", "text"])(
    "rejects non-raster content disguised as a PNG: %s",
    async (content) => {
      const { stateDir } = await makeImage(content, "photo.png");
      await expect(readInboundImage("media://inbound/photo.png", stateDir)).rejects.toThrow(
        "Unsupported image format",
      );
    },
  );

  it("rejects empty and oversized files before reading their content", async () => {
    const { stateDir, filePath } = await makeImage("");
    await expect(readInboundImage("media://inbound/photo", stateDir)).rejects.toThrow(
      "preview size limit",
    );
    await truncate(filePath, CHAT_ATTACHMENT_MAX_FILE_BYTES + 1);
    await expect(readInboundImage("media://inbound/photo", stateDir)).rejects.toThrow(
      "preview size limit",
    );
  });

  it.each([
    null,
    {},
    1,
    "https://example.com/image.png",
    "media://inbound/..%5Coutside.png",
    "media://inbound/..%2Foutside.png",
  ])("rejects invalid or remote references: %j", async (reference) => {
    const { stateDir } = await makeImage();
    await expect(readInboundImage(reference, stateDir)).rejects.toThrow();
  });

  it("rejects absolute paths outside inbound media", async () => {
    const { stateDir } = await makeImage();
    const outsidePath = path.join(stateDir, "outside.png");
    await writeFile(outsidePath, png);
    await expect(readInboundImage(outsidePath, stateDir)).rejects.toThrow("escaped its root");
  });

  it("rejects symlinks or junctions that escape inbound media", async () => {
    const { stateDir, inboundDir } = await makeImage();
    const outsideDir = path.join(stateDir, "outside");
    await mkdir(outsideDir);
    await symlink(outsideDir, path.join(inboundDir, "linked.png"), "junction");
    await expect(readInboundImage("media://inbound/linked.png", stateDir)).rejects.toThrow(
      "escaped its root",
    );
  });

  it("rejects directories and missing images", async () => {
    const { stateDir, inboundDir } = await makeImage();
    await mkdir(path.join(inboundDir, "directory.png"));
    await expect(readInboundImage("media://inbound/directory.png", stateDir)).rejects.toThrow(
      "not a file",
    );
    await expect(readInboundImage("media://inbound/missing.png", stateDir)).rejects.toThrow();
  });

  it("restricts the preview IPC handler to the trusted renderer", async () => {
    const source = await readFile(path.join(__dirname, "main.ts"), "utf8");
    const start = source.indexOf('ipcMain.handle("attachment:read-image"');
    expect(start).toBeGreaterThan(-1);
    const handler = source.slice(start, source.indexOf('ipcMain.handle("attachment:open"', start));
    expect(handler.indexOf("assertTrustedRendererIpc(event)")).toBeGreaterThan(-1);
    expect(handler.indexOf("assertTrustedRendererIpc(event)")).toBeLessThan(
      handler.indexOf("readInboundImage("),
    );
  });
});
