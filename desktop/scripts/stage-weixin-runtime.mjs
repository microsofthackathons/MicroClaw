import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export function stageWeixinRuntime(sourceDir, stageDir) {
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8"));
  const stagedPackage = JSON.parse(fs.readFileSync(path.join(stageDir, "package.json"), "utf8"));
  if (sourcePackage.version !== stagedPackage.version) {
    throw new Error("Weixin source and vendored runtime versions do not match");
  }
  if (path.resolve(sourceDir) === path.resolve(stageDir)) {
    throw new Error("Weixin staging must not overwrite the source directory");
  }

  const files = ["index.ts"];
  function visit(relativeDir) {
    for (const entry of fs.readdirSync(path.join(sourceDir, relativeDir), {
      withFileTypes: true,
    })) {
      const relative = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) visit(relative);
      else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        files.push(relative);
      }
    }
  }
  visit("src");

  let compiledCount = 0;
  for (const relative of files) {
    const source = fs.readFileSync(path.join(sourceDir, relative), "utf8");
    const stagedSource = path.join(stageDir, relative);
    fs.mkdirSync(path.dirname(stagedSource), { recursive: true });
    fs.writeFileSync(stagedSource, source);
    if (relative.endsWith(".d.ts")) continue;

    const compiled = ts.transpileModule(source, {
      fileName: relative,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    });
    const errors = (compiled.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    if (errors.length > 0) {
      throw new Error(
        `${relative}: ${errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n")}`,
      );
    }
    const stagedRuntime = path.join(stageDir, "dist", relative.replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(stagedRuntime), { recursive: true });
    fs.writeFileSync(stagedRuntime, compiled.outputText);
    compiledCount++;
  }
  for (const name of ["package.json", "README.md", "README.zh_CN.md"]) {
    fs.copyFileSync(path.join(sourceDir, name), path.join(stageDir, name));
  }
  return compiledCount;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stageDir = process.argv[2];
  if (!stageDir) throw new Error("Usage: node stage-weixin-runtime.mjs <staging-directory>");
  const sourceDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "plugins",
    "openclaw-weixin",
  );
  const count = stageWeixinRuntime(sourceDir, path.resolve(stageDir));
  console.log(`Staged ${count} Weixin modules with the MicroClaw SDK compatibility changes.`);
}
