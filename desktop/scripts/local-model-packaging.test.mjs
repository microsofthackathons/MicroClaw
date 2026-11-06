import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const desktopDir = new URL("../", import.meta.url);

test("desktop and MSIX packaging do not prepare or bundle llama.cpp", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", desktopDir), "utf8"));
  const builder = await readFile(new URL("electron-builder.yml", desktopDir), "utf8");
  const prepare = await readFile(new URL("scripts/prepare-resources.mjs", desktopDir), "utf8");
  const signed = await readFile(
    new URL("scripts/update-signed-windows-node-manifest.mjs", desktopDir),
    "utf8",
  );
  assert.equal(packageJson.scripts["prepare-local-model-runtime"], undefined);
  assert.doesNotMatch(packageJson.scripts["prepare-packaged-resources"], /local-model-runtime/u);
  assert.doesNotMatch(builder, /resources\/llama-cpp|finalize-packaged-resources/u);
  assert.doesNotMatch(prepare, /prepareLocalModelRuntime|prepare-local-model-runtime/u);
  assert.doesNotMatch(signed, /verifyPackagedLocalModelRuntime|finalize-packaged-resources/u);
});

test("development and installed apps do not require a bundled runtime before provider setup", async () => {
  const main = await readFile(new URL("src/main.ts", desktopDir), "utf8");
  const service = await readFile(new URL("src/local-model-service.ts", desktopDir), "utf8");
  assert.doesNotMatch(main, /ensureBundledLocalModelRuntime|ensureManagedRuntime/u);
  assert.doesNotMatch(service, /ensureManagedRuntime/u);
  assert.match(service, /openclaw\.setup\.prepare\.start/u);
});
