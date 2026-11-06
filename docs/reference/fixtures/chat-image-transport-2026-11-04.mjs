import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Invoke only the audited package's local helpers with generated, nonprivate fixtures.
// No Gateway, provider authentication, or account state is needed.
assert.ok(
  process.argv[2],
  "Usage: node chat-image-transport-2026-11-04.mjs <OpenClaw-package-directory>",
);
const runtime = path.resolve(process.argv[2]);
const version = JSON.parse(await readFile(path.join(runtime, "package.json"), "utf8")).version;
assert.equal(version, "2026.10.5", "This probe requires the audited OpenClaw 2026.10.5 package");
const expectedHashes = {
  "attempt-system-prompt-prepare-DDHkO-l9.mjs":
    "dcca3a952829f2b4a443fcd08dbe2977cd12d9e1fe3109b7ec6d72b07936dd9a",
  "chat-attachments-C7sFtQr8.mjs":
    "6973739425845e1ef373316de382a0c461aab526247a5fed7e11c074d676565a",
  "images-D_pMoVnt.mjs": "626b3b2fd01f75021e57d83e9da159ecb16b3a4b46e869c8a9285e416285b234",
  "tool-images-B_LSlC_Y.mjs": "459e3165b80985f839b47c60b74bd69795b67881b6870373e6d1aa2f1d27163e",
};
const sourceHashes = {};
for (const [name, expected] of Object.entries(expectedHashes)) {
  sourceHashes[name] = createHash("sha256")
    .update(await readFile(path.join(runtime, "dist", name)))
    .digest("hex");
  assert.equal(
    sourceHashes[name],
    expected,
    `Re-audit the runtime before changing this probe: ${name}`,
  );
}
const scratch = path.resolve(".tmp-issue168");
process.env.OPENCLAW_STATE_DIR = path.join(scratch, "state");
process.env.OPENCLAW_CONFIG_PATH = path.join(scratch, "missing-config.json");
process.env.OPENCLAW_HOME = scratch;
await mkdir(process.env.OPENCLAW_STATE_DIR, { recursive: true });
const temp = path.join(scratch, "temp");
await mkdir(temp, { recursive: true });
process.env.TEMP = temp;
process.env.TMP = temp;
process.env.TMPDIR = temp;
const load = (name) => import(pathToFileURL(path.join(runtime, "dist", name)));
const { R: prune } = await load("attempt-system-prompt-prepare-DDHkO-l9.mjs");
const { t: sanitize } = await load("tool-images-B_LSlC_Y.mjs");
const { o: parse } = await load("chat-attachments-C7sFtQr8.mjs");
const { r: policy } = await load("chat-attachment-policy-B0H4omOp.mjs");
const { i: hydrate } = await load("images-D_pMoVnt.mjs");
const { PNG } = await import(
  pathToFileURL(path.join(runtime, "node_modules/pngjs/lib/png.js"))
).then((m) => m.default);
const image = () => ({ type: "image", data: "AA==", mimeType: "image/png" });
const rows = [];
for (const [completed, expected] of [
  [0, 0],
  [1, 1],
  [3, 3],
  [4, 3],
  [5, 4],
  [11, 10],
  [12, 3],
  [13, 4],
  [20, 3],
]) {
  const messages = [];
  for (let i = 0; i < completed; i++)
    messages.push(
      { role: "user", content: [{ type: "text", text: `turn ${i}` }, image()] },
      { role: "assistant", content: [{ type: "text", text: "observed" }] },
    );
  messages.push({ role: "user", content: [image()] });
  const before = JSON.stringify(messages);
  const after = prune(messages) ?? messages;
  assert.equal(JSON.stringify(messages), before, "canonical history mutated");
  assert.equal(after.at(-1).content.at(-1).type, "image", "current image pruned");
  const retained = after
    .slice(0, -1)
    .filter((m) => m.content.some((b) => b.type === "image")).length;
  assert.equal(retained, expected);
  assert.deepEqual(prune(after) ?? after, after, "projection is not idempotent");
  rows.push({ completed, retainedPriorImages: retained, currentImages: 1 });
}
const media = {
  role: "user",
  content: [{ type: "text", text: "[media attached: media://inbound/old.png]" }],
  __openclaw: {
    media: [{ url: "media://inbound/old.png", contentType: "image/png", kind: "image" }],
    mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 0 }] },
  },
};
const history = [media, { role: "assistant", content: "observed" }];
for (let i = 0; i < 3; i++)
  history.push({ role: "user", content: "next" }, { role: "assistant", content: "done" });
history.push({ role: "user", content: "current" });
const pruned = prune(history);
assert.equal(pruned[0].__openclaw.media, undefined);
assert.equal(pruned[0].__openclaw.mediaImagePruned, true);
assert.equal(pruned[0].__openclaw.mediaImageLayout, undefined);
assert.match(pruned[0].content[0].text, /media reference removed/);
assert.ok(history[0].__openclaw.media, "canonical media mutated");
const hydrated = await hydrate(pruned, {
  workspaceDir: scratch,
  model: { input: ["text", "image"] },
});
assert.equal(
  hydrated[0].content.some((block) => block.type === "image"),
  false,
);
const pixel = new PNG({ width: 1, height: 1 });
pixel.data.fill(255);
const bytes = PNG.sync.write(pixel);
const encoded = bytes.toString("base64");
const attachment = {
  type: "image",
  fileName: "pixel.png",
  mimeType: "image/png",
  content: encoded,
};
const raw = await parse("describe", [attachment], { supportsImages: true });
assert.equal(raw.images.length, 1);
assert.equal(raw.images[0].data, encoded);
const dataUrl = await parse(
  "describe",
  [{ ...attachment, content: `data:image/png;base64,${encoded}` }],
  { supportsImages: true },
);
assert.equal(dataUrl.images[0].data, encoded);
const sanitized = await sanitize(
  [{ type: "image", data: encoded, mimeType: "image/png" }],
  "fixture",
  { verifyDecodability: true },
);
assert.equal(sanitized[0].type, "image");
assert.equal(sanitized[0].data, encoded);
const bad = await sanitize(
  [{ type: "image", data: "not base64!", mimeType: "image/png" }],
  "fixture",
);
assert.equal(bad[0].type, "text");
assert.match(bad[0].text, /invalid base64/);
const oversized = await sanitize(
  [
    {
      type: "image",
      data: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64"),
      mimeType: "image/png",
    },
  ],
  "fixture",
);
assert.match(oversized[0].text, /input size limit/);
const wide = new PNG({ width: 1600, height: 800 });
wide.data.fill(255);
const wideBytes = PNG.sync.write(wide);
const resized = await sanitize(
  [{ type: "image", data: wideBytes.toString("base64"), mimeType: "image/png" }],
  "fixture",
  { verifyDecodability: true },
);
assert.equal(resized[0].type, "image", JSON.stringify(resized));
assert.equal(resized[0].mimeType, "image/jpeg");
const { d: metadata } = await load("image-ops-Dk9KWj3k.mjs");
const dimensions = metadata(Buffer.from(resized[0].data, "base64"));
assert.equal(dimensions.width, 1200);
assert.equal(dimensions.height, 600);
console.log(
  JSON.stringify(
    {
      version,
      policy: policy({}),
      rows,
      structuredMediaPruned: true,
      canonicalHistoryUnchanged: true,
      rawBase64AndDataUrlAccepted: true,
      smallImageBytesUnchanged: true,
      invalidBase64AndOversizeOmitted: true,
      resize: {
        input: [1600, 800],
        output: [dimensions.width, dimensions.height],
        mime: resized[0].mimeType,
      },
      sourceHashes,
    },
    null,
    2,
  ),
);
