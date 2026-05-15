#!/usr/bin/env node
/**
 * Sync and process Studio assets from the Star-Office-UI source repo.
 *
 * Usage:
 *   node scripts/sync-studio-assets.js [--src <path>] [--dst <path>]
 *
 * Source path:
 *   --src  Explicit source directory (recommended)
 *   or set STUDIO_ASSETS_SRC environment variable
 *
 * Default destination:
 *   --dst  desktop\renderer\public\studio
 *
 * What it does:
 *   1. Cleans the destination directory (removes old image files)
 *   2. Copies assets that can be used directly (with optional rename)
 *   3. Converts grid-format source images into horizontal spritesheets
 *      at the frame sizes that StudioScene.ts / StudioLayout.ts expect
 *   4. Reports missing assets
 *
 * Requirements: Node.js 18+, sharp (npm install sharp)
 * Install: npm install (from repo root, sharp is in devDependencies)
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// ── CLI args ──

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const SRC = getArg("--src", process.env.STUDIO_ASSETS_SRC || "");
const DST = getArg("--dst", path.join(__dirname, "..", "desktop", "renderer", "public", "studio"));

// ── Asset manifest ──
// Each entry describes what we need and where it comes from.

const ASSETS = [
  // Direct copies (source filename → destination filename)
  { src: "office_bg_small.webp", dst: "office_bg_small.webp", type: "copy" },
  { src: "cats-spritesheet.webp", dst: "cats-spritesheet.webp", type: "copy" },
  { src: "error-bug-spritesheet-grid.webp", dst: "error-bug-spritesheet-grid.webp", type: "copy" },
  { src: "plants-spritesheet.webp", dst: "plants-spritesheet.webp", type: "copy" },
  { src: "posters-spritesheet.webp", dst: "posters-spritesheet.webp", type: "copy" },
  { src: "serverroom-spritesheet.webp", dst: "serverroom-spritesheet.webp", type: "copy" },
  {
    src: "star-working-spritesheet-grid.webp",
    dst: "star-working-spritesheet-grid.webp",
    type: "copy",
  },

  // Renamed copies (source has version suffix)
  { src: "sofa-idle-v3.png", dst: "sofa-idle.webp", type: "convert" },
  { src: "desk-v3.webp", dst: "desk-v2.webp", type: "copy" },
  { src: "coffee-machine-v3-grid.webp", dst: "coffee-machine-spritesheet.webp", type: "copy" },
  { src: "flowers-bloom-v2.webp", dst: "flowers-spritesheet.webp", type: "copy" },
  { src: "sync-animation-v3-grid.webp", dst: "sync-animation-spritesheet-grid.webp", type: "copy" },

  // Grid source → needs repack into horizontal spritesheet
  {
    src: "star-idle-v5.png",
    dst: "star-idle-spritesheet.webp",
    type: "convert",
    // Source is 2048×1536, already a grid of 8×6 = 48 frames at 256×256
    // Just convert PNG → WebP, no repacking needed
  },
];

// ── PNG read/write utilities (no native deps) ──

function readPNG(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("Not a PNG: " + filePath);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(
      `Unsupported PNG format (${bitDepth}-bit, colorType=${colorType}) for ${filePath}; expected RGBA8`,
    );
  }

  // Collect IDAT chunks
  const idatChunks = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString("ascii");
    if (type === "IDAT") {
      idatChunks.push(buf.slice(off + 8, off + 8 + len));
    }
    off += 12 + len;
    if (type === "IEND") break;
  }

  const compressed = Buffer.concat(idatChunks);
  const raw = zlib.inflateSync(compressed);

  // Parse RGBA pixels (colorType 6, bitDepth 8)
  const bpp = 4;
  const rowBytes = width * bpp;
  const pixels = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    const filterByte = raw[y * (rowBytes + 1)];
    const rowStart = y * (rowBytes + 1) + 1;
    const rowData = raw.slice(rowStart, rowStart + rowBytes);

    // Apply filter
    for (let x = 0; x < rowBytes; x++) {
      let val = rowData[x];
      if (filterByte === 1) {
        // Sub
        val = (val + (x >= bpp ? pixels[y * width * 4 + (x - bpp)] : 0)) & 0xff;
      } else if (filterByte === 2) {
        // Up
        val = (val + (y > 0 ? pixels[(y - 1) * width * 4 + x] : 0)) & 0xff;
      } else if (filterByte === 3) {
        // Average
        const a = x >= bpp ? pixels[y * width * 4 + (x - bpp)] : 0;
        const b = y > 0 ? pixels[(y - 1) * width * 4 + x] : 0;
        val = (val + Math.floor((a + b) / 2)) & 0xff;
      } else if (filterByte === 4) {
        // Paeth
        const a = x >= bpp ? pixels[y * width * 4 + (x - bpp)] : 0;
        const b = y > 0 ? pixels[(y - 1) * width * 4 + x] : 0;
        const c = x >= bpp && y > 0 ? pixels[(y - 1) * width * 4 + (x - bpp)] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a),
          pb = Math.abs(p - b),
          pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        val = (val + pr) & 0xff;
      }
      pixels[y * width * 4 + x] = val;
    }
  }

  return { width, height, pixels };
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writePNG(filePath, width, height, pixels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function chunk(type, data) {
    const typeBuf = Buffer.from(type, "ascii");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Build raw data with filter byte per row
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    pixels.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  fs.writeFileSync(
    filePath,
    Buffer.concat([
      signature,
      chunk("IHDR", ihdr),
      chunk("IDAT", compressed),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/**
 * Nearest-neighbor downscale a frame from srcPixels at (sx, sy, sw, sh)
 * into a new buffer at (outW, outH).
 */
function resizeFrame(srcPixels, srcWidth, sx, sy, sw, sh, outW, outH) {
  const out = Buffer.alloc(outW * outH * 4);
  for (let dy = 0; dy < outH; dy++) {
    const srcY = sy + Math.floor((dy * sh) / outH);
    for (let dx = 0; dx < outW; dx++) {
      const srcX = sx + Math.floor((dx * sw) / outW);
      const si = (srcY * srcWidth + srcX) * 4;
      const di = (dy * outW + dx) * 4;
      out[di] = srcPixels[si];
      out[di + 1] = srcPixels[si + 1];
      out[di + 2] = srcPixels[si + 2];
      out[di + 3] = srcPixels[si + 3];
    }
  }
  return out;
}

// ── Main ──

async function main() {
  const sharp = require("sharp");

  console.log("Studio Asset Sync");
  console.log("  Source: " + SRC);
  console.log("  Dest:   " + DST);
  console.log("");

  if (!SRC) {
    console.error(
      "ERROR: Missing source directory. Provide --src <path> or set STUDIO_ASSETS_SRC.",
    );
    process.exit(1);
  }

  const resolvedSrc = path.resolve(SRC);
  const resolvedDst = path.resolve(DST);
  if (resolvedSrc.toLowerCase() === resolvedDst.toLowerCase()) {
    console.error("ERROR: Source and destination directories must be different.");
    process.exit(1);
  }

  if (!fs.existsSync(SRC)) {
    console.error("ERROR: Source directory not found: " + SRC);
    process.exit(1);
  }

  fs.mkdirSync(DST, { recursive: true });

  // Clean old image files
  for (const f of fs.readdirSync(DST)) {
    if (/\.(png|webp)$/i.test(f)) {
      fs.unlinkSync(path.join(DST, f));
    }
  }
  console.log("Cleaned old image files from destination.\n");

  let ok = 0,
    fail = 0;

  for (const asset of ASSETS) {
    const srcPath = path.join(SRC, asset.src);
    const dstPath = path.join(DST, asset.dst);

    if (!fs.existsSync(srcPath)) {
      console.log(`  ✗ NOT FOUND ${asset.src}`);
      fail++;
      continue;
    }

    if (asset.type === "copy") {
      fs.copyFileSync(srcPath, dstPath);
      const kb = Math.round(fs.statSync(dstPath).size / 1024);
      console.log(`  ✓ COPY      ${asset.src.padEnd(45)} → ${asset.dst}  (${kb}KB)`);
      ok++;
    } else if (asset.type === "convert") {
      // PNG → WebP lossless conversion via sharp
      try {
        await sharp(srcPath).webp({ lossless: true }).toFile(dstPath);
        const kb = Math.round(fs.statSync(dstPath).size / 1024);
        console.log(`  ✓ CONVERT   ${asset.src.padEnd(45)} → ${asset.dst}  (${kb}KB)`);
        ok++;
      } catch (err) {
        console.log(`  ✗ CONVERT FAILED ${asset.src}: ${err.message}`);
        fail++;
      }
    } else if (asset.type === "repack") {
      try {
        console.log(`  … REPACK    ${asset.src} → ${asset.dst}`);
        const img = readPNG(srcPath);
        const { srcFrameW, srcFrameH, outFrameW, outFrameH } = asset;
        const cols = Math.floor(img.width / srcFrameW);
        const rows = Math.floor(img.height / srcFrameH);
        const totalFrames = cols * rows;

        console.log(
          `              Source: ${img.width}×${img.height}, grid ${cols}×${rows} = ${totalFrames} frames at ${srcFrameW}×${srcFrameH}`,
        );
        console.log(
          `              Output: ${totalFrames} frames at ${outFrameW}×${outFrameH}, strip ${outFrameW * totalFrames}×${outFrameH}`,
        );

        // Build horizontal strip
        const outW = outFrameW * totalFrames;
        const outH = outFrameH;
        const outPixels = Buffer.alloc(outW * outH * 4);

        for (let i = 0; i < totalFrames; i++) {
          const srcCol = i % cols;
          const srcRow = Math.floor(i / cols);
          const sx = srcCol * srcFrameW;
          const sy = srcRow * srcFrameH;

          const frame = resizeFrame(
            img.pixels,
            img.width,
            sx,
            sy,
            srcFrameW,
            srcFrameH,
            outFrameW,
            outFrameH,
          );

          // Copy into strip
          for (let y = 0; y < outFrameH; y++) {
            frame.copy(
              outPixels,
              (y * outW + i * outFrameW) * 4,
              y * outFrameW * 4,
              (y + 1) * outFrameW * 4,
            );
          }
        }

        // Write as PNG first, then convert to WebP if needed
        if (asset.dst.endsWith(".webp")) {
          const tmpPng = dstPath.replace(/\.webp$/, ".tmp.png");
          writePNG(tmpPng, outW, outH, outPixels);
          await sharp(tmpPng).webp({ lossless: true }).toFile(dstPath);
          fs.unlinkSync(tmpPng);
        } else {
          writePNG(dstPath, outW, outH, outPixels);
        }
        const kb = Math.round(fs.statSync(dstPath).size / 1024);
        console.log(`  ✓ REPACK    → ${asset.dst}  (${totalFrames} frames, ${kb}KB)`);
        ok++;
      } catch (err) {
        console.log(`  ✗ REPACK FAILED ${asset.src}: ${err.message}`);
        fail++;
      }
    }
  }

  console.log(`\nDone: ${ok} ok, ${fail} failed`);
  console.log("\nAsset dimensions summary:");

  // Verify all output files
  for (const f of fs
    .readdirSync(DST)
    .filter((f) => /\.(png|webp)$/.test(f))
    .sort()) {
    const fp = path.join(DST, f);
    const buf = fs.readFileSync(fp);
    let w, h;
    if (f.endsWith(".png")) {
      w = buf.readUInt32BE(16);
      h = buf.readUInt32BE(20);
    } else {
      const vp8l = buf.indexOf("VP8L");
      if (vp8l > 0) {
        const off = vp8l + 9;
        w = ((buf[off] | (buf[off + 1] << 8)) & 0x3fff) + 1;
        h = (((buf[off + 1] >> 6) | (buf[off + 2] << 2) | (buf[off + 3] << 10)) & 0x3fff) + 1;
      }
    }
    const kb = Math.round(buf.length / 1024);
    console.log(`  ${f.padEnd(48)} ${(w || "?") + "×" + (h || "?")}  ${kb}KB`);
  }
}

main();
