import { readFile, stat } from "fs/promises";
import * as path from "path";
import {
  CHAT_ATTACHMENT_MAX_FILE_BYTES,
  CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
} from "./constants";

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

export function inferAttachmentMimeType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
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
