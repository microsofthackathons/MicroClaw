import { readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { pruneMissingWindowsNodeMxcFolders } from "./windows-node-mxc-folder-cleanup";
import { normalizeWindowsNodeMxcFolderPolicy } from "./windows-node-mxc";
import type { WindowsNodeMxcFolderPolicy } from "./windows-node-mxc-folder-transaction";

const mainSource = readFileSync(path.join(__dirname, "main.ts"), "utf8");
const mainAst = ts.createSourceFile("main.ts", mainSource, ts.ScriptTarget.Latest, true);

function mainFunction(name: string): string {
  const declaration = mainAst.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!declaration) throw new Error(`Native function ${name} is missing`);
  return declaration.getText(mainAst);
}

function loadDraftNormalizer() {
  const normalizer = mainFunction("normalizeCompleteWindowsNodeMxcFolderPolicy");
  const validate = vi.fn((candidate: string) => ({ ok: true, canonicalPath: candidate }));
  const context = createContext({
    exports: {},
    normalizeWindowsNodeMxcFolderPolicy,
    validateWindowsNodeMxcUserDir: validate,
    pruneMissingWindowsNodeMxcFolders: (policy: WindowsNodeMxcFolderPolicy) =>
      pruneMissingWindowsNodeMxcFolders(policy, (candidate) => {
        if (candidate === "C:\\Gone") {
          throw Object.assign(new Error("Missing"), { code: "ENOENT" });
        }
        return { isDirectory: () => true, isSymbolicLink: () => false };
      }),
  });
  const compiled = ts.transpileModule(`exports.normalize = ${normalizer}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  runInContext(compiled.outputText, context);
  return {
    validate,
    normalize: context.exports.normalize as (
      policy: WindowsNodeMxcFolderPolicy,
    ) => Promise<WindowsNodeMxcFolderPolicy>,
  };
}

describe("MXC folder cleanup integration", () => {
  it("cleans persisted settings after migration and before the renderer can read them", () => {
    const migration = mainSource.indexOf("const migratedSecuritySettings =");
    const cleanup = mainSource.indexOf("\nreconcileWindowsNodeMxcFolders(settingsStore);");
    const rendererSettings = mainSource.indexOf("const RENDERER_WRITABLE_SETTING_KEYS =");
    expect(migration).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(migration);
    expect(rendererSettings).toBeGreaterThan(cleanup);
  });

  it("persists the cleaned policy before minting a new generation's approval fingerprint", () => {
    const startup = mainSource.slice(
      mainSource.indexOf("async function startGatewayInner("),
      mainSource.indexOf("function _extractText("),
    );
    const cleanup = startup.indexOf(
      "if (windowsNodeMxcDesired) reconcileWindowsNodeMxcFolders(settingsStore);",
    );
    const proof = startup.indexOf("bundledWindowsNodeHost.createApprovalProofContext(");
    const folders = startup.indexOf("getBundledWindowsNodeFolders()", proof);
    expect(cleanup).toBeGreaterThan(-1);
    expect(proof).toBeGreaterThan(cleanup);
    expect(folders).toBeGreaterThan(proof);
  });

  it("does not mutate an active generation's saved grants through a read-only getter", () => {
    const getter = mainFunction("getWindowsNodeMxcFolderPolicy");
    expect(getter).toContain('settingsStore.get("windowsNodeMxcFolders")');
    expect(getter).not.toContain("reconcileWindowsNodeMxcFolders");
    expect(getter).not.toContain("pruneMissingWindowsNodeMxcFolders");
    expect(getter).not.toContain("settingsStore.set");
  });

  it("silently drops a stale draft grant before the normal validator runs", async () => {
    const { normalize, validate } = loadDraftNormalizer();
    expect(await normalize({ ro: ["C:\\Gone"], rw: ["C:\\Work"] })).toEqual({
      ro: [],
      rw: ["C:\\Work"],
    });
    expect(validate).toHaveBeenCalledExactlyOnceWith("C:\\Work");
  });
});
