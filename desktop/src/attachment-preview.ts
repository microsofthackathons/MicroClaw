import { open } from "fs/promises";
import { CHAT_ATTACHMENT_MAX_FILE_BYTES } from "./constants";
import { resolveInboundMediaFile } from "./attachment-open";

function imageMimeType(content: Buffer): string | undefined {
  if (content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (content[0] === 255 && content[1] === 216 && content[2] === 255) return "image/jpeg";
  const signature = content.toString("ascii", 0, 6);
  if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  if (content.toString("ascii", 0, 4) === "RIFF" && content.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (content.toString("ascii", 0, 2) === "BM") return "image/bmp";
  if (
    content.toString("ascii", 4, 8) === "ftyp" &&
    ["avif", "avis"].includes(content.toString("ascii", 8, 12))
  ) {
    return "image/avif";
  }
  return undefined;
}

export async function readInboundImage(mediaPath: unknown, stateDir: string): Promise<string> {
  if (typeof mediaPath !== "string") throw new Error("Invalid image reference");
  const imagePath = await resolveInboundMediaFile(stateDir, mediaPath);
  const image = await open(imagePath, "r");
  try {
    const { size } = await image.stat();
    if (size === 0 || size > CHAT_ATTACHMENT_MAX_FILE_BYTES) {
      throw new Error("Image exceeds the preview size limit or is empty");
    }
    const buffer = Buffer.alloc(size + 1);
    let totalRead = 0;
    while (totalRead < buffer.length) {
      const { bytesRead } = await image.read(buffer, totalRead, buffer.length - totalRead, null);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }
    if (totalRead !== size) throw new Error("Image changed while reading");
    const content = buffer.subarray(0, totalRead);
    const mimeType = imageMimeType(content);
    if (!mimeType) throw new Error("Unsupported image format");
    return `data:${mimeType};base64,${content.toString("base64")}`;
  } finally {
    await image.close();
  }
}
