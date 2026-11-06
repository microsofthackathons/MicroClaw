const IMAGE_EXTENSIONS: Record<string, string> = {
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

export function collectClipboardImageFiles(data: DataTransfer): File[] {
  const files: File[] = [];
  const items = Array.from(data.items ?? []);
  if (items.length > 0) {
    for (const item of items) {
      if (item.kind !== "file" || !item.type.toLowerCase().startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) {
        files.push(
          file.type
            ? file
            : new File([file], file.name || "Screenshot", { type: item.type.toLowerCase() }),
        );
      }
    }
    return files;
  }
  return Array.from(data.files ?? []).filter((file) =>
    file.type.toLowerCase().startsWith("image/"),
  );
}

export function clipboardTextToInsert(data: DataTransfer): string {
  const text = data.getData("text/plain");
  const trimmed = text.trim();
  if (!text || trimmed === "[object File]" || /^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) {
    return "";
  }
  return text;
}

export function insertTextAtSelection(
  currentText: string,
  selectionStart: number,
  selectionEnd: number,
  insertedText: string,
): { text: string; caret: number } {
  const start = Math.max(0, Math.min(selectionStart, currentText.length));
  const end = Math.max(start, Math.min(selectionEnd, currentText.length));
  return {
    text: currentText.slice(0, start) + insertedText + currentText.slice(end),
    caret: start + insertedText.length,
  };
}

export async function serializeClipboardImages(
  files: File[],
  now = new Date(),
): Promise<ClipboardImageInput[]> {
  const timestamp = [
    now.getFullYear().toString().padStart(4, "0"),
    "-",
    (now.getMonth() + 1).toString().padStart(2, "0"),
    "-",
    now.getDate().toString().padStart(2, "0"),
    " ",
    now.getHours().toString().padStart(2, "0"),
    now.getMinutes().toString().padStart(2, "0"),
    now.getSeconds().toString().padStart(2, "0"),
  ].join("");

  return Promise.all(
    files.map(async (file, index) => {
      const mimeType = file.type.toLowerCase();
      const extension = IMAGE_EXTENSIONS[mimeType] ?? "";
      const suffix = index === 0 ? "" : ` (${index + 1})`;
      return {
        mimeType,
        fileName: `Screenshot ${timestamp}${suffix}${extension}`,
        data: await file.arrayBuffer(),
      };
    }),
  );
}
