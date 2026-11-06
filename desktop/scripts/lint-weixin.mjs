import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import config from "../eslint.weixin.config.mjs";

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.dirname(desktopDir);
const eslint = new ESLint({
  cwd: repositoryRoot,
  overrideConfig: config,
  overrideConfigFile: true,
});
const results = await eslint.lintFiles(["plugins/openclaw-weixin/**/*.ts"]);
const formatter = await eslint.loadFormatter("stylish");
const output = await formatter.format(results);

if (output) {
  process.stdout.write(output);
}

if (results.some((result) => result.errorCount > 0)) {
  process.exitCode = 1;
}
