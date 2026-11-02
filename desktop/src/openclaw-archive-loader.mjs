import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { isAbsolute, relative, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function archiveRelativePath(root, filename) {
  const candidate = relative(root, filename);
  if (!candidate || candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate))
    return;
  return candidate;
}

export function openRuntimeModuleArchive(archivePath, runtimeRoot) {
  if (!isAbsolute(archivePath) || !isAbsolute(runtimeRoot))
    throw new Error("Runtime module archive paths must be absolute");
  const root = realpathSync(runtimeRoot);
  const descriptor = openSync(archivePath, "r");
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeSync(descriptor);
  };
  try {
    const archiveSize = fstatSync(descriptor).size;
    const read = (offset, size) => {
      if (
        closed ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(size) ||
        offset < 0 ||
        size < 0 ||
        offset + size > archiveSize
      )
        throw new Error("Invalid runtime module archive range");
      const buffer = Buffer.alloc(size);
      let consumed = 0;
      while (consumed < size) {
        const count = readSync(descriptor, buffer, consumed, size - consumed, offset + consumed);
        if (count === 0) throw new Error("Truncated runtime module archive");
        consumed += count;
      }
      return buffer;
    };
    const sizeHeader = read(0, 8);
    const headerSize = sizeHeader.readUInt32LE(4);
    if (sizeHeader.readUInt32LE(0) !== 4 || headerSize < 8 || headerSize > 64 * 1024 * 1024)
      throw new Error("Invalid runtime module archive header");
    const header = read(8, headerSize);
    const jsonSize = header.readUInt32LE(4);
    if (header.readUInt32LE(0) !== headerSize - 4 || jsonSize > headerSize - 8)
      throw new Error("Invalid runtime module archive header");
    const tree = JSON.parse(header.subarray(8, 8 + jsonSize).toString("utf8"));
    if (!tree.files || typeof tree.files !== "object")
      throw new Error("Invalid runtime module archive tree");
    return {
      close,
      source(url) {
        if (!url.startsWith("file:")) return;
        const filename = archiveRelativePath(root, fileURLToPath(url));
        if (!filename) return;
        let entry = tree;
        for (const component of filename.split(sep)) {
          if (!entry.files || !Object.hasOwn(entry.files, component)) return;
          entry = entry.files[component];
          if (entry.link || entry.unpacked) return;
        }
        if (entry.files || typeof entry.offset !== "string") return;
        const offset = Number(entry.offset);
        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new Error("Invalid runtime module archive offset");
        const source = read(8 + headerSize + offset, entry.size);
        if (entry.integrity) {
          if (
            entry.integrity.algorithm !== "SHA256" ||
            createHash("sha256").update(source).digest("hex") !== entry.integrity.hash
          )
            throw new Error(`Runtime module archive integrity mismatch: ${filename}`);
        }
        return source;
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}

export function initializeRuntimeModuleArchive(archivePath, runtimeRoot, register = registerHooks) {
  const archive = openRuntimeModuleArchive(archivePath, runtimeRoot);
  let hooks;
  try {
    hooks = register({
      load(url, context, nextLoad) {
        if (context.format !== "module" || context.source != null) return nextLoad(url, context);
        const source = archive.source(url);
        return nextLoad(url, source === undefined ? context : { ...context, source });
      },
    });
  } catch (error) {
    archive.close();
    throw error;
  }
  return {
    close() {
      hooks.deregister();
      archive.close();
    },
  };
}

if (
  process.env.MICROCLAW_OPENCLAW_ARCHIVE &&
  process.env.MICROCLAW_OPENCLAW_RUNTIME_ROOT &&
  process.argv[1] &&
  isAbsolute(process.argv[1]) &&
  archiveRelativePath(process.env.MICROCLAW_OPENCLAW_RUNTIME_ROOT, process.argv[1])
) {
  const archive = initializeRuntimeModuleArchive(
    process.env.MICROCLAW_OPENCLAW_ARCHIVE,
    process.env.MICROCLAW_OPENCLAW_RUNTIME_ROOT,
  );
  process.once("exit", () => archive.close());
}
