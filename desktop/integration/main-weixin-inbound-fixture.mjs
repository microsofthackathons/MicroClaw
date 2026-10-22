import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import ts from "typescript";

// Execute the real Electron handler without starting Electron or replacing its source-store logic.
export function createMainWeixinInboundFixture(dependencies) {
  return createMainFunctionFixture("handleWindowsNodeMxcWeixinRemoteApprovalInbound", dependencies);
}

export function createMainFunctionFixture(name, dependencies) {
  const filename = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const source = ts.createSourceFile(
    filename,
    readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) throw new Error("Actual main WeChat inbound handler missing");
  const { outputText, diagnostics } = ts.transpileModule(declaration.getText(source), {
    fileName: "main-weixin-inbound.ts",
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  if (diagnostics?.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (value) => value,
        getCurrentDirectory: () => "",
        getNewLine: () => "\n",
      }),
    );
  const names = Object.keys(dependencies);
  if (names.some((name) => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)))
    throw new Error("Invalid main fixture dependency name");
  return new Function(
    ...names,
    `${outputText}
return {
  handle: ${name},
  replace(name, value) {
    switch (name) {
      ${names.map((name) => `case ${JSON.stringify(name)}: ${name} = value; return;`).join("\n")}
      default: throw new Error("Unknown main fixture dependency");
    }
  }
};`,
  )(...names.map((name) => dependencies[name]));
}
