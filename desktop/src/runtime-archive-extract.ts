import { extractAll, getRawHeader, type FileMetadata } from "@electron/asar";
import * as fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { measureRuntimePhase, type RuntimePreparationTiming } from "./runtime-preparation-timing";

// Electron treats .asar paths as virtual directories; read the physical archive.
const disk: typeof fs = process.versions.electron ? createRequire(__filename)("original-fs") : fs;
const FILE_CONCURRENCY = 8;
const COPY_BUFFER_BYTES = 1024 * 1024;

interface PackedFile {
  destination: string;
  offset: number;
  size: number;
  executable: boolean;
}

async function readFully(
  archive: FileHandle,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<void> {
  let received = 0;
  while (received < length) {
    const { bytesRead } = await archive.read(
      buffer,
      received,
      length - received,
      position + received,
    );
    if (bytesRead === 0) throw new Error("Bundled OpenClaw archive ended before its file contents");
    received += bytesRead;
  }
}

async function copyPackedFile(
  archive: FileHandle,
  file: PackedFile,
  buffer: Buffer,
): Promise<void> {
  if (file.size <= buffer.length) {
    await readFully(archive, buffer, file.size, file.offset);
    await disk.promises.writeFile(file.destination, buffer.subarray(0, file.size), { flag: "wx" });
  } else {
    const output = await disk.promises.open(file.destination, "wx");
    try {
      for (let copied = 0; copied < file.size; ) {
        const length = Math.min(buffer.length, file.size - copied);
        await readFully(archive, buffer, length, file.offset + copied);
        let written = 0;
        while (written < length) {
          const { bytesWritten } = await output.write(
            buffer,
            written,
            length - written,
            copied + written,
          );
          if (bytesWritten === 0) throw new Error("Could not write the bundled runtime file");
          written += bytesWritten;
        }
        copied += length;
      }
    } finally {
      await output.close();
    }
  }
  if (file.executable) await disk.promises.chmod(file.destination, 0o755);
}

/** Extract packed files with one shared read handle and at most eight writes in flight. */
export async function extractRuntimeArchiveParallel(
  archivePath: string,
  destination: string,
  timing?: RuntimePreparationTiming,
): Promise<void> {
  const { header, headerSize } = getRawHeader(archivePath);
  const root = path.resolve(destination);
  const directories: string[] = [];
  const files: PackedFile[] = [];
  let compatibilityExtraction = false;
  const walk = (entries: Record<string, FileMetadata>, parent: string, unpacked = false) => {
    for (const [name, entry] of Object.entries(entries)) {
      // Validate archive names once while planning, before creating any files.
      if (
        !name ||
        name === "." ||
        name === ".." ||
        /[/\\\0]/.test(name) ||
        (process.platform === "win32" &&
          (/[<>:"|?*]|[. ]$/.test(name) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)))
      )
        throw new Error("Bundled OpenClaw archive contains an invalid entry name");
      const target = path.join(parent, name);
      if ("files" in entry) {
        directories.push(target);
        walk(entry.files, target, unpacked || entry.unpacked === true);
      } else if ("link" in entry || unpacked || entry.unpacked) {
        // Keep upstream link/unpacked-file behavior for archives with these entries.
        compatibilityExtraction = true;
      } else {
        const offset = Number(entry.offset);
        if (
          !/^\d+$/.test(entry.offset) ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0
        )
          throw new Error("Bundled OpenClaw archive contains an invalid file range");
        files.push({
          destination: target,
          offset: 8 + headerSize + offset,
          size: entry.size,
          executable: entry.executable === true,
        });
      }
    }
  };
  walk(header.files, root);
  if (compatibilityExtraction) {
    measureRuntimePhase(timing, "archive-extract-compatibility", () =>
      extractAll(archivePath, root),
    );
    return;
  }

  const archive = await disk.promises.open(archivePath, "r");
  try {
    const { size: archiveSize } = await archive.stat();
    for (const file of files) {
      if (!Number.isSafeInteger(file.offset + file.size) || file.offset + file.size > archiveSize) {
        throw new Error("Bundled OpenClaw archive is truncated");
      }
    }
    disk.mkdirSync(root, { recursive: true });
    // Header traversal is parent-first, so each directory is created only once.
    for (const directory of directories) disk.mkdirSync(directory);

    const concurrency = Math.min(FILE_CONCURRENCY, files.length);
    const finish = timing?.start("archive-write-files");
    const details = {
      concurrency,
      fileCount: files.length,
      byteCount: files.reduce((total, file) => total + file.size, 0),
    };
    let next = 0;
    let stopped = false;
    const consume = async () => {
      try {
        // Reuse a 1 MiB buffer per consumer, including for large native binaries.
        const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
        while (!stopped) {
          const file = files[next++];
          if (!file) return;
          await copyPackedFile(archive, file, buffer);
        }
      } catch (error) {
        stopped = true;
        throw error;
      }
    };
    // Drain every in-flight write before closing the archive or deleting staging.
    const results = await Promise.allSettled(Array.from({ length: concurrency }, consume));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      finish?.("failed", details);
      throw failure.reason;
    }
    finish?.("success", details);
  } finally {
    await archive.close();
  }
}
