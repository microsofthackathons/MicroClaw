import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(scriptDir, "..", "resources", "openclaw-weixin");
const manifestName = "microclaw-runtime.json";

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export default async function finalizePackagedWeixinResource(context) {
  const destinationRoot = path.join(context.appOutDir, "resources", "openclaw-weixin");
  fs.cpSync(sourceRoot, destinationRoot, { recursive: true, force: true });

  const manifest = JSON.parse(
    fs.readFileSync(path.join(destinationRoot, manifestName), "utf8"),
  );
  const expectedFiles = manifest.files.map((file) => file.path).sort();
  const actualFiles = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(destinationRoot, absolute).replaceAll("\\", "/");
      if (relative === manifestName) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) actualFiles.push(relative);
      else throw new Error(`Unsupported packaged Weixin resource entry: ${relative}`);
    }
  };
  visit(destinationRoot);
  actualFiles.sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("Packaged Weixin resource inventory does not match its manifest");
  }
  for (const file of manifest.files) {
    const absolute = path.join(destinationRoot, file.path);
    const stat = fs.statSync(absolute);
    if (stat.size !== file.size || sha256File(absolute) !== file.sha256) {
      throw new Error(`Packaged Weixin resource failed provenance validation: ${file.path}`);
    }
  }
  const treeSha256 = createHash("sha256")
    .update(
      manifest.files.map((file) => `${file.path}|${file.size}|${file.sha256}`).join("\n"),
      "utf8",
    )
    .digest("hex");
  if (treeSha256 !== manifest.treeSha256) {
    throw new Error("Packaged Weixin resource tree hash does not match its manifest");
  }
}
