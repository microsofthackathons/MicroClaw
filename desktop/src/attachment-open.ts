import { copyFile, mkdir, realpath, stat, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import * as path from "path";
import { validateChatAttachments, type ChatAttachment } from "./chat-attachments";

export interface OpenAttachmentRequest extends ChatAttachment {
  mediaPath?: string;
}

const MIME_EXTENSIONS: Record<string, string> = {
  "application/json": ".json",
  "application/pdf": ".pdf",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "text/csv": ".csv",
  "text/markdown": ".md",
  "text/plain": ".txt",
};

export function sanitizeAttachmentFileName(fileName: string, mimeType: string): string {
  const baseName = path
    .basename(fileName)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim();
  const usableBaseName =
    baseName && baseName !== "." && baseName !== ".." ? baseName : "attachment";
  const detectedExtension = path.extname(usableBaseName);
  const extension = (detectedExtension || MIME_EXTENSIONS[mimeType] || ".bin").slice(0, 20);
  const stem = detectedExtension
    ? usableBaseName.slice(0, -detectedExtension.length)
    : usableBaseName;
  return `${stem.slice(0, Math.max(1, 180 - extension.length))}${extension}`;
}

export function resolveInboundMediaPath(stateDir: string, mediaPath: string): string {
  const match = /^media:\/\/inbound\/([^/?#]+)$/i.exec(mediaPath);
  if (!match) throw new Error("Invalid inbound media reference");
  const fileName = decodeURIComponent(match[1]);
  if (!fileName || path.basename(fileName) !== fileName) {
    throw new Error("Invalid inbound media filename");
  }
  const inboundDir = path.resolve(stateDir, "media", "inbound");
  const candidate = path.resolve(inboundDir, fileName);
  if (!candidate.startsWith(`${inboundDir}${path.sep}`)) {
    throw new Error("Inbound media path escaped its root");
  }
  return candidate;
}

export async function prepareAttachmentForOpen(
  request: unknown,
  tempDir: string,
  stateDir: string,
): Promise<string> {
  if (!request || typeof request !== "object") throw new Error("Invalid attachment");
  const attachment = request as Partial<OpenAttachmentRequest>;

  if (typeof attachment.content === "string" && attachment.content.length > 0) {
    const padding = attachment.content.endsWith("==")
      ? 2
      : attachment.content.endsWith("=")
        ? 1
        : 0;
    const decodedBytes = (attachment.content.length / 4) * 3 - padding;
    const normalized = {
      ...attachment,
      fileName: sanitizeAttachmentFileName(attachment.fileName ?? "", attachment.mimeType ?? ""),
      size: attachment.size || decodedBytes,
    };
    const validatedAttachments = validateChatAttachments([normalized]);
    if (!validatedAttachments) throw new Error("Invalid attachment");
    const [validated] = validatedAttachments;
    const outputDir = path.join(tempDir, "MicroClaw", "attachments");
    await mkdir(outputDir, { recursive: true });
    const outputPath = path.join(
      outputDir,
      `${randomUUID()}-${sanitizeAttachmentFileName(validated.fileName, validated.mimeType)}`,
    );
    await writeFile(outputPath, Buffer.from(validated.content, "base64"));
    return outputPath;
  }

  if (typeof attachment.mediaPath === "string") {
    const mediaFile = resolveInboundMediaPath(stateDir, attachment.mediaPath);
    const inboundDir = path.resolve(stateDir, "media", "inbound");
    const [realInboundDir, realMediaFile] = await Promise.all([
      realpath(inboundDir),
      realpath(mediaFile),
    ]);
    if (!realMediaFile.startsWith(`${realInboundDir}${path.sep}`)) {
      throw new Error("Inbound media file escaped its root");
    }
    const mediaStat = await stat(realMediaFile);
    if (!mediaStat.isFile()) throw new Error("Inbound media reference is not a file");
    if (path.extname(realMediaFile)) return realMediaFile;

    const outputDir = path.join(tempDir, "MicroClaw", "attachments");
    await mkdir(outputDir, { recursive: true });
    const outputPath = path.join(
      outputDir,
      `${randomUUID()}-${sanitizeAttachmentFileName(
        attachment.fileName ?? "",
        attachment.mimeType ?? "",
      )}`,
    );
    await copyFile(realMediaFile, outputPath);
    return outputPath;
  }

  throw new Error("Attachment has no openable content");
}
