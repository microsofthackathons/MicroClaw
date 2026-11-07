// Match the existing attachment limits in desktop/src/constants.ts. Main-process
// import and send validation remain authoritative after this bounded preflight.
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export type DroppedImageRejection =
  | OpenFilesResult["rejections"][number]
  | {
      fileName: string;
      reason: "unsupported_image";
    };

function imageMimeType(header: Uint8Array): string | undefined {
  const startsWith = (...bytes: number[]) => bytes.every((byte, index) => header[index] === byte);
  const text = (start: number, end: number) => String.fromCharCode(...header.subarray(start, end));
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(text(0, 6))) return "image/gif";
  if (text(0, 2) === "BM") return "image/bmp";
  if (startsWith(0x49, 0x49, 0x2a, 0) || startsWith(0x4d, 0x4d, 0, 0x2a)) return "image/tiff";
  if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "image/webp";
  if (header.length >= 16 && text(4, 8) === "ftyp") {
    const boxSize = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0);
    if (boxSize < 16) return undefined;
    const brands = [text(8, 12)];
    for (let offset = 16; offset + 4 <= Math.min(boxSize, header.length); offset += 4) {
      brands.push(text(offset, offset + 4));
    }
    if (brands.some((brand) => ["avif", "avis"].includes(brand))) return "image/avif";
    if (brands.some((brand) => ["heic", "heix", "hevc", "hevx"].includes(brand)))
      return "image/heic";
    if (brands.some((brand) => ["mif1", "msf1"].includes(brand))) return "image/heif";
  }
  return undefined;
}

export async function prepareDroppedImages(
  files: File[],
  currentTotalBytes: number,
): Promise<{ images: ClipboardImageInput[]; rejections: DroppedImageRejection[] }> {
  const images: ClipboardImageInput[] = [];
  const rejections: DroppedImageRejection[] = [];
  let totalBytes = currentTotalBytes;
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      rejections.push({ fileName: file.name, reason: "file_too_large", limit: MAX_FILE_BYTES });
      continue;
    }
    if (totalBytes + file.size > MAX_TOTAL_BYTES) {
      rejections.push({ fileName: file.name, reason: "total_too_large", limit: MAX_TOTAL_BYTES });
      continue;
    }
    try {
      // OS drops may have no MIME type. Inspect a small header rather than
      // trusting the extension or the declared MIME type (including SVG).
      const mimeType = imageMimeType(new Uint8Array(await file.slice(0, 64).arrayBuffer()));
      if (!mimeType) {
        rejections.push({ fileName: file.name, reason: "unsupported_image" });
        continue;
      }
      const data = await file.arrayBuffer();
      images.push({ mimeType, fileName: file.name, data });
      totalBytes += data.byteLength;
    } catch {
      rejections.push({ fileName: file.name, reason: "read_failed" });
    }
  }
  return { images, rejections };
}
