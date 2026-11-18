import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { planDefaultWorkspaceFolderGrant } from "./agent-workspaces";
import { updateWindowsNodeInstructions } from "./windows-node-command-instructions";
import { canonicalizeApprovedCwd } from "./windows-node-mxc";

const source = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
function mainFunction(name: string) {
  const declaration = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!declaration) throw new Error(`Missing main function ${name}`);
  return declaration.getText(ast);
}
function mainVariable(name: string) {
  const statement = ast.statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
      ),
  );
  if (!statement) throw new Error(`Missing main variable ${name}`);
  return statement.getText(ast);
}
const parent = "C:\\Users\\alice\\OpenClawWorkspaces";

function grantHarness() {
  const settings: Record<string, unknown> = { windowsNodeMxcFolders: { rw: [], ro: [] } };
  const validate = vi.fn(async () => ({ ok: true, reason: undefined as string | undefined }));
  const store = {
    get: (key: string) => settings[key],
    get store() {
      return settings;
    },
    set store(value: Record<string, unknown>) {
      Object.assign(settings, value);
    },
  };
  const context = createContext({
    exports: {},
    settingsStore: store,
    getWorkspaceParent: () => parent,
    ensureWorkspaceParent: vi.fn(),
    validateWindowsNodeMxcUserDir: validate,
    getWindowsNodeMxcFolderPolicy: () => settings.windowsNodeMxcFolders,
    planDefaultWorkspaceFolderGrant,
    normalizeCompleteWindowsNodeMxcFolderPolicy: vi.fn(async (value) => value),
  });
  runInContext(
    ts.transpileModule(
      `exports.initialize = ${mainFunction("ensureDefaultWorkspaceFolderGrant")}`,
      {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      },
    ).outputText,
    context,
  );
  return { settings, validate, initialize: context.exports.initialize as () => Promise<void> };
}

describe("workspace startup wiring", () => {
  it.each(["off", "full", "limited-dacl"])(
    "seeds the same global default in %s without restoring later revocations",
    async (requestedMode) => {
      const { settings, validate, initialize } = grantHarness();
      settings.windowsNodeMxcSelection = { version: 1, requestedMode };
      await initialize();
      expect(settings.windowsNodeMxcFolders).toEqual({ rw: [parent], ro: [] });
      expect(settings.windowsNodeMxcWorkspaceGrantVersion).toBe(1);
      settings.windowsNodeMxcFolders = { rw: [], ro: [] };
      await initialize();
      expect(settings.windowsNodeMxcFolders).toEqual({ rw: [], ro: [] });
      expect(validate).toHaveBeenCalledTimes(1);
      settings.windowsNodeMxcFolders = { rw: [], ro: [parent] };
      await initialize();
      expect(settings.windowsNodeMxcFolders).toEqual({ rw: [], ro: [parent] });
    },
  );

  it("fails closed when the normal folder validator rejects the parent", async () => {
    const { settings, validate, initialize } = grantHarness();
    validate.mockResolvedValue({ ok: false, reason: "path-reparse-point" });
    await expect(initialize()).rejects.toThrow("path-reparse-point");
    expect(settings.windowsNodeMxcWorkspaceGrantVersion).toBeUndefined();
    expect(settings.windowsNodeMxcFolders).toEqual({ rw: [], ro: [] });
  });

  it("does not mutate an unresolved live-folder recovery", async () => {
    const { settings, validate, initialize } = grantHarness();
    settings.windowsNodeMxcFolderPolicyRecovery = { lastError: "recovery pending" };
    await expect(initialize()).rejects.toThrow("pending MXC folder policy recovery");
    expect(validate).not.toHaveBeenCalled();
    expect(settings.windowsNodeMxcWorkspaceGrantVersion).toBeUndefined();
  });

  it("uses the global parent for every agent CWD but rejects outside folders", () => {
    const roots = [{ path: parent, access: "rw" as const }];
    const protectedRoot = "C:\\Users\\alice\\.openclaw";
    for (const id of ["main", "coder", "master-archive"]) {
      expect(
        canonicalizeApprovedCwd(path.win32.join(parent, id), roots, (value) => value),
      ).toMatchObject({ allowed: true, access: "rw" });
    }
    expect(
      canonicalizeApprovedCwd(`${protectedRoot}\\workspace`, roots, (value) => value),
    ).toMatchObject({ allowed: false });
  });

  it("materializes migrated directories before snapshots, config publication and seeding", () => {
    const startup = mainFunction("runGatewayStartup");
    const plan = startup.indexOf("planAgentWorkspaces(");
    const copy = startup.indexOf("materializeAgentWorkspaces(workspacePlan)");
    const snapshot = startup.indexOf("captureAgentWorkspaces(");
    const persist = startup.indexOf("persistAgentPersonas(");
    const seed = startup.indexOf("seedWorkspaceFiles(");
    expect(plan).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(plan);
    expect(snapshot).toBeGreaterThan(copy);
    expect(persist).toBeGreaterThan(snapshot);
    expect(seed).toBeGreaterThan(persist);
    expect(startup).toContain(
      "if (!alreadyRunning && !isManagedGatewayProcessAlive()) await ensureDefaultWorkspaceFolderGrant()",
    );
    expect(startup.indexOf("ensureDefaultWorkspaceFolderGrant()")).toBeLessThan(
      startup.indexOf("bundledWindowsNodeHost.createApprovalProofContext("),
    );
    const seeder = mainFunction("seedWorkspaceFiles");
    expect(seeder).toContain("resolveAgentPersonaWorkspace(");
    expect(seeder).not.toContain('path.join(stateDir, "workspace")');
    expect(mainFunction("captureAgentWorkspace")).toContain('"BOOTSTRAP.md"');
    expect(startup).toContain("const mxcEnabledForInstructions = isWindowsNodeMxcDesired()");
    expect(startup).toContain("mxcEnabledForInstructions,");
  });

  it("seeds and migrates the actual main SOUL for the current sandbox mode", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-main-soul-"));
    try {
      const context = createContext({
        exports: {} as {
          seed?: (
            state: string,
            config: object,
            env: object,
            cwd: string,
            enabled: boolean,
          ) => void;
          defaultSoul?: string;
        },
        fs,
        path,
        os,
        updateWindowsNodeInstructions,
        MAIN_PLATFORM_IDENTITY_SECTION: "## Platform Identity\n\nKeep the identity.",
        resolveAgentPersonaWorkspace: () => workspace,
        getAgentPersona: () => ({ id: "main" }),
        console: { log: vi.fn(), warn: vi.fn() },
      });
      runInContext(
        ts.transpileModule(
          `${mainVariable("DEFAULT_SOUL_MD")}
          ${mainVariable("DECLARE_ACCESS_SECTION")}
          exports.seed = ${mainFunction("seedWorkspaceFiles")};
          exports.defaultSoul = DEFAULT_SOUL_MD;`,
          { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
        ).outputText,
        context,
      );
      const seed = context.exports.seed!;
      const soulPath = path.join(workspace, "SOUL.md");
      seed(workspace, {}, {}, workspace, false);
      expect(fs.readFileSync(soulPath, "utf-8")).not.toMatch(/\bMXC\b|\[declare-access\]/);

      fs.writeFileSync(soulPath, `${context.exports.defaultSoul}\n## User notes\nKeep these.\n`);
      seed(workspace, {}, {}, workspace, false);
      expect(fs.readFileSync(soulPath, "utf-8")).not.toMatch(/\bMXC\b|\[declare-access\]/);
      seed(workspace, {}, {}, workspace, true);
      expect(fs.readFileSync(soulPath, "utf-8")).toContain(
        "## MXC filesystem and executable recovery",
      );
      seed(workspace, {}, {}, workspace, false);
      const off = fs.readFileSync(soulPath, "utf-8");
      expect(off).not.toMatch(/\bMXC\b|\[declare-access\]/);
      expect(off).toContain("## User notes\nKeep these.");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("applies the same layout when adding an agent without creating per-agent grants", () => {
    const add = mainFunction("addCatalogAgent");
    expect(add.indexOf("planAgentWorkspaces(")).toBeGreaterThan(
      add.indexOf("ensureAgentPersonasConfig("),
    );
    expect(add.indexOf("materializeAgentWorkspaces(workspacePlan)")).toBeLessThan(
      add.indexOf("captureAgentWorkspace("),
    );
    expect(add).not.toContain("windowsNodeMxcFolders");
    expect(add).toContain("isWindowsNodeMxcDesired()");
  });
});
