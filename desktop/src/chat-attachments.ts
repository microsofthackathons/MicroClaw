import { mkdir, readFile, rm, stat, writeFile } from "fs/promises";
import { createHash, randomUUID } from "crypto";
import * as path from "path";
import { CHAT_ATTACHMENT_MAX_FILE_BYTES, CHAT_ATTACHMENT_MAX_TOTAL_BYTES } from "./constants";

export interface ChatAttachment {
  type: "image" | "file";
  mimeType: string;
  fileName: string;
  size: number;
  content: string;
}

export type AttachmentRejectionReason = "file_too_large" | "total_too_large" | "read_failed";

export interface AttachmentRejection {
  fileName: string;
  reason: AttachmentRejectionReason;
  size?: number;
  limit?: number;
}

export interface PrepareChatAttachmentsResult {
  attachments: ChatAttachment[];
  rejections: AttachmentRejection[];
}

export interface ClipboardImageInput {
  mimeType: string;
  fileName: string;
  data: ArrayBuffer | Uint8Array;
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rtf": "application/rtf",
  ".svg": "image/svg+xml",
  ".text": "text/plain",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
};

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/tiff": ".tiff",
  "image/webp": ".webp",
};

const ATTACHMENT_MIME_EXTENSIONS: Record<string, string> = {
  "application/json": ".json",
  "application/pdf": ".pdf",
  "text/csv": ".csv",
  "text/markdown": ".md",
  "text/plain": ".txt",
  ...IMAGE_MIME_EXTENSIONS,
};

export function inferAttachmentMimeType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function attachmentExtensionForMimeType(mimeType: string): string | undefined {
  return IMAGE_MIME_EXTENSIONS[mimeType.toLowerCase()];
}

export function sanitizeAttachmentFileName(fileName: string, mimeType: string): string {
  const baseName = path
    .basename(fileName)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim();
  const usableBaseName =
    baseName && baseName !== "." && baseName !== ".." ? baseName : "attachment";
  const detectedExtension = path.extname(usableBaseName);
  const extension = (
    detectedExtension ||
    ATTACHMENT_MIME_EXTENSIONS[mimeType.toLowerCase()] ||
    ".bin"
  ).slice(0, 20);
  const stem = detectedExtension
    ? usableBaseName.slice(0, -detectedExtension.length)
    : usableBaseName;
  return `${stem.slice(0, Math.max(1, 180 - extension.length))}${extension}`;
}

export function validateChatAttachments(
  value: unknown,
  maxFileBytes = CHAT_ATTACHMENT_MAX_FILE_BYTES,
  maxTotalBytes = CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
): ChatAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Chat attachments must be an array");

  let totalBytes = 0;
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("Invalid chat attachment");
    }
    const attachment = candidate as Partial<ChatAttachment>;
    if (
      (attachment.type !== "image" && attachment.type !== "file") ||
      typeof attachment.mimeType !== "string" ||
      !attachment.mimeType ||
      typeof attachment.fileName !== "string" ||
      !attachment.fileName ||
      typeof attachment.content !== "string" ||
      typeof attachment.size !== "number" ||
      !Number.isSafeInteger(attachment.size) ||
      attachment.size < 0
    ) {
      throw new Error("Invalid chat attachment");
    }
    if (attachment.content.length > Math.ceil(maxFileBytes / 3) * 4) {
      throw new Error(`Attachment exceeds the per-file limit: ${attachment.fileName}`);
    }
    if (!BASE64_PATTERN.test(attachment.content)) {
      throw new Error(`Invalid attachment encoding: ${attachment.fileName}`);
    }
    const padding = attachment.content.endsWith("==")
      ? 2
      : attachment.content.endsWith("=")
        ? 1
        : 0;
    const decodedBytes = (attachment.content.length / 4) * 3 - padding;
    if (decodedBytes !== attachment.size) {
      throw new Error(`Attachment size mismatch: ${attachment.fileName}`);
    }
    if (decodedBytes > maxFileBytes) {
      throw new Error(`Attachment exceeds the per-file limit: ${attachment.fileName}`);
    }
    totalBytes += decodedBytes;
    if (totalBytes > maxTotalBytes) {
      throw new Error("Attachments exceed the aggregate limit");
    }
    return attachment as ChatAttachment;
  });
}

export async function prepareChatAttachments(
  filePaths: string[],
  maxFileBytes = CHAT_ATTACHMENT_MAX_FILE_BYTES,
  maxTotalBytes = CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
  initialTotalBytes = 0,
): Promise<PrepareChatAttachmentsResult> {
  const attachments: ChatAttachment[] = [];
  const rejections: AttachmentRejection[] = [];
  let totalBytes = initialTotalBytes;

  for (const filePath of filePaths) {
    const fileName = path.basename(filePath);
    let size: number;

    try {
      size = (await stat(filePath)).size;
    } catch {
      rejections.push({ fileName, reason: "read_failed" });
      continue;
    }

    if (size > maxFileBytes) {
      rejections.push({ fileName, reason: "file_too_large", size, limit: maxFileBytes });
      continue;
    }
    if (totalBytes + size > maxTotalBytes) {
      rejections.push({ fileName, reason: "total_too_large", size, limit: maxTotalBytes });
      continue;
    }

    try {
      const data = await readFile(filePath);
      size = data.byteLength;
      if (size > maxFileBytes) {
        rejections.push({ fileName, reason: "file_too_large", size, limit: maxFileBytes });
        continue;
      }
      if (totalBytes + size > maxTotalBytes) {
        rejections.push({ fileName, reason: "total_too_large", size, limit: maxTotalBytes });
        continue;
      }
      const mimeType = inferAttachmentMimeType(filePath);
      attachments.push({
        type: mimeType.startsWith("image/") ? "image" : "file",
        mimeType,
        fileName,
        size,
        content: data.toString("base64"),
      });
      totalBytes += size;
    } catch {
      rejections.push({ fileName, reason: "read_failed", size });
    }
  }

  return { attachments, rejections };
}

export async function prepareClipboardImageAttachments(
  value: unknown,
  tempDir: string,
  initialTotalBytes = 0,
  maxFileBytes = CHAT_ATTACHMENT_MAX_FILE_BYTES,
  maxTotalBytes = CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
): Promise<PrepareChatAttachmentsResult> {
  if (!Array.isArray(value)) throw new Error("Clipboard images must be an array");

  const batchDir = path.join(tempDir, "MicroClaw", "attachments", "clipboard", randomUUID());
  const filePaths: string[] = [];
  const rejections: AttachmentRejection[] = [];
  const contentHashes = new Set<string>();
  const usedFileNames = new Set<string>();

  try {
    for (const candidate of value) {
      if (!candidate || typeof candidate !== "object") {
        rejections.push({ fileName: "Screenshot", reason: "read_failed" });
        continue;
      }
      const input = candidate as Partial<ClipboardImageInput>;
      const mimeType = typeof input.mimeType === "string" ? input.mimeType.toLowerCase() : "";
      const extension = attachmentExtensionForMimeType(mimeType);
      const fallbackName = `Screenshot${extension ?? ""}`;
      const sourceName =
        typeof input.fileName === "string" && input.fileName ? input.fileName : fallbackName;
      if (!extension || !(input.data instanceof ArrayBuffer || ArrayBuffer.isView(input.data))) {
        rejections.push({ fileName: path.basename(sourceName), reason: "read_failed" });
        continue;
      }

      const bytes =
        input.data instanceof ArrayBuffer
          ? Buffer.from(input.data)
          : Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength);
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (contentHashes.has(hash)) continue;
      contentHashes.add(hash);

      const rawStem = path.basename(sourceName, path.extname(sourceName));
      const sanitizedName = sanitizeAttachmentFileName(`${rawStem}${extension}`, mimeType);
      const sanitizedStem = path.basename(sanitizedName, path.extname(sanitizedName));
      let fileName = sanitizedName;
      let nameIndex = 2;
      while (usedFileNames.has(fileName.toLowerCase())) {
        fileName = `${sanitizedStem} (${nameIndex})${extension}`;
        nameIndex += 1;
      }
      usedFileNames.add(fileName.toLowerCase());
      if (bytes.byteLength > maxFileBytes) {
        rejections.push({
          fileName,
          reason: "file_too_large",
          size: bytes.byteLength,
          limit: maxFileBytes,
        });
        continue;
      }

      await mkdir(batchDir, { recursive: true });
      const filePath = path.join(batchDir, fileName);
      await writeFile(filePath, bytes);
      filePaths.push(filePath);
    }

    const prepared = await prepareChatAttachments(
      filePaths,
      maxFileBytes,
      maxTotalBytes,
      initialTotalBytes,
    );
    return {
      attachments: prepared.attachments,
      rejections: [...rejections, ...prepared.rejections],
    };
  } finally {
    await rm(batchDir, { recursive: true, force: true });
  }
}
