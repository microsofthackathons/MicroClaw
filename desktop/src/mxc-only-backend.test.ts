import { readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

describe("MXC-only renderer bridge", () => {
  function loadBridge() {
    const invoke = vi.fn().mockResolvedValue({ rw: [], ro: [] });
    const on = vi.fn();
    const removeListener = vi.fn();
    const context = createContext({
      exports: {},
      process: { argv: [] },
      require: (name: string) => {
        if (name !== "electron") throw new Error(`Unexpected preload dependency: ${name}`);
        return {
          contextBridge: {
            exposeInMainWorld: (name: string, api: unknown) => {
              context[name] = api;
            },
          },
          ipcRenderer: { invoke, on, removeListener },
        };
      },
    });
    const compiled = ts.transpileModule(readFileSync(path.join(__dirname, "preload.ts"), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    runInContext(compiled.outputText, context);
    return { context, invoke, on, removeListener };
  }

  it("exposes no retired sandbox or command-notification entry point", () => {
    const { context } = loadBridge();
    expect(runInContext("'sandbox' in openclaw", context)).toBe(false);
    expect(runInContext("'onExecCommand' in openclaw.chat", context)).toBe(false);
  });

  it("routes folder reads, drafts and stopped-mode writes only to native MXC handlers", async () => {
    const { context, invoke } = loadBridge();
    await runInContext("openclaw.windowsNodeMxc.getFolders()", context);
    await runInContext(
      "openclaw.windowsNodeMxc.stageFolder({access:'ro',draft:{rw:[],ro:['C:\\\\Docs']}})",
      context,
    );
    await runInContext(
      "openclaw.windowsNodeMxc.setFolderPolicy({rw:['C:\\\\Work'],ro:[]})",
      context,
    );
    expect(invoke.mock.calls).toEqual([
      ["windows-node-mxc:get-folders"],
      ["windows-node-mxc:stage-folder", { access: "ro", draft: { rw: [], ro: ["C:\\Docs"] } }],
      ["windows-node-mxc:set-folder-policy", { rw: ["C:\\Work"], ro: [] }],
    ]);
  });

  it("retains native approval subscription and exact cleanup", () => {
    const { context, on, removeListener } = loadBridge();
    runInContext(
      "globalThis.dispose = openclaw.windowsNodeMxc.onApprovalRequest(() => {})",
      context,
    );
    expect(on).toHaveBeenCalledWith("windows-node-mxc:approval-request", expect.any(Function));
    runInContext("dispose()", context);
    expect(removeListener.mock.calls).toEqual(on.mock.calls);
  });

  it("registers no legacy sandbox IPC handler in the main process", () => {
    const source = ts.createSourceFile(
      "main.ts",
      readFileSync(path.join(__dirname, "main.ts"), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const channels: string[] = [];
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(source) === "ipcMain" &&
        ["handle", "on"].includes(node.expression.name.text) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        channels.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(channels).toContain("windows-node-mxc:set-folder-policy");
    expect(channels).toContain("windows-node-mxc:stage-folder");
    expect(channels.filter((channel) => channel.startsWith("sandbox:"))).toEqual([]);
  });
});

describe("native folder policy IPC", () => {
  function loadPolicyWriter(desiredEnabled = false) {
    const source = ts.createSourceFile(
      "main.ts",
      readFileSync(path.join(__dirname, "main.ts"), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    let handlerSource: string | undefined;
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(source) === "ipcMain" &&
        node.expression.name.text === "handle" &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === "windows-node-mxc:set-folder-policy"
      ) {
        handlerSource = node.arguments[1].getText(source);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (!handlerSource) throw new Error("Native folder policy handler is missing");
    const previous = { rw: ["C:\\Previous"], ro: [] };
    const persist = vi.fn();
    const begin = vi.fn();
    const end = vi.fn();
    const validate = vi.fn((draft: unknown) => {
      if (!draft || typeof draft !== "object" || !("rw" in draft) || !("ro" in draft)) {
        throw new Error("Invalid folder policy");
      }
      return structuredClone(draft);
    });
    const context = createContext({
      exports: {},
      assertTrustedRendererIpc: (event: unknown) => {
        if (event !== "trusted") throw new Error("Untrusted renderer");
      },
      beginWindowsNodeMxcFolderDraftMutation: begin,
      endWindowsNodeMxcFolderDraftMutation: end,
      isWindowsNodeMxcDesired: () => desiredEnabled,
      normalizeCompleteWindowsNodeMxcFolderPolicy: validate,
      persistWindowsNodeMxcFolderPolicy: persist,
      getWindowsNodeMxcFolderPolicy: () => previous,
    });
    const compiled = ts.transpileModule(`exports.handler = ${handlerSource}`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    runInContext(compiled.outputText, context);
    return { context, persist, begin, end, validate, previous };
  }

  it("refuses an untrusted renderer before acquiring or mutating policy", () => {
    const { context, persist, begin, end } = loadPolicyWriter();
    expect(() => runInContext("exports.handler('untrusted', {rw:[],ro:[]})", context)).toThrow(
      "Untrusted renderer",
    );
    expect(begin).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("refuses direct writes during native activation and releases its mutation guard", () => {
    const { context, persist, validate, begin, end } = loadPolicyWriter(true);
    expect(() => runInContext("exports.handler('trusted', {rw:[],ro:[]})", context)).toThrow(
      "Apply and reactivate",
    );
    expect(begin).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
    expect(validate).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("validates and persists the complete Off-mode policy without provisioning ACLs", () => {
    const { context, persist, end, previous } = loadPolicyWriter();
    expect(
      runInContext("exports.handler('trusted', {rw:['C:\\\\Work'],ro:['C:\\\\Docs']})", context),
    ).toEqual({ rw: ["C:\\Work"], ro: ["C:\\Docs"] });
    expect(persist).toHaveBeenCalledExactlyOnceWith(
      { rw: ["C:\\Work"], ro: ["C:\\Docs"] },
      previous,
      null,
    );
    expect(end).toHaveBeenCalledOnce();
  });

  it("does not persist invalid inputs and always releases its mutation guard", () => {
    const { context, persist, end } = loadPolicyWriter();
    expect(() => runInContext("exports.handler('trusted', null)", context)).toThrow(
      "Invalid folder policy",
    );
    expect(persist).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledOnce();
  });

  it("surfaces storage failures rather than reporting a successful draft", () => {
    const { context, persist, end } = loadPolicyWriter();
    persist.mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    expect(() => runInContext("exports.handler('trusted', {rw:[],ro:[]})", context)).toThrow(
      "Storage unavailable",
    );
    expect(end).toHaveBeenCalledOnce();
  });
});
