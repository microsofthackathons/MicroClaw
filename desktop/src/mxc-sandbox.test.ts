import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertMxcReadyForChat,
  buildMxcAgentPolicies,
  createInitialMxcStatus,
  ensureMxcSecurityConfig,
  expectedWxcHash,
  MXC_PLUGIN_ID,
  parseMxcProbe,
  pathsOverlap,
  resolveMxcPluginDir,
  sha256Base64,
  stripMxcWorkerEnvironment,
  validateMxcFolder,
} from "./mxc-sandbox";

afterEach(() => vi.restoreAllMocks());

describe("Microsoft MXC sandbox policy", () => {
  it("enforces the pinned plugin and denies every host execution bypass", () => {
    const config: Record<string, any> = {
      sandbox: { backend: "docker" },
      agents: {
        defaults: { sandbox: { mode: "all", docker: { network: "bridge" } } },
        list: [
          {
            id: "main",
            sandbox: { mode: "all" },
            tools: { allow: ["exec"] },
          },
        ],
      },
      tools: {
        profile: "full",
        allow: ["exec", "browser"],
        elevated: { enabled: true },
        codeMode: true,
      },
    };
    const policies = buildMxcAgentPolicies(
      ["main"],
      { main: { readonlyPaths: ["C:\\source"], readwritePaths: ["C:\\output"] } },
      "C:\\workspaces",
      ["C:\\Users\\me\\.openclaw"],
    );

    expect(ensureMxcSecurityConfig(config, "C:\\app\\mxc-plugin", policies)).toBe(true);
    expect(config.plugins.allow).toContain(MXC_PLUGIN_ID);
    expect(config.plugins.load.paths).toEqual(["C:\\app\\mxc-plugin"]);
    expect(config.plugins.entries[MXC_PLUGIN_ID].config.fallback.allowDaclMutation).toBe(false);
    expect(config.tools.allow).toEqual(["mxc_read", "mxc_write", "mxc_edit", "mxc_exec"]);
    expect(config.tools.profile).toBe("minimal");
    expect(config.tools.alsoAllow).toBeUndefined();
    expect(config.tools.deny).toEqual(
      expect.arrayContaining([
        "read",
        "write",
        "edit",
        "apply_patch",
        "exec",
        "process",
        "code_execution",
        "browser",
        "canvas",
        "gateway",
        "nodes",
        "session_status",
      ]),
    );
    expect(config.tools.elevated.enabled).toBe(false);
    expect(config.tools.codeMode.enabled).toBe(false);
    expect(config.tools.bash).toBeUndefined();
    expect(config.tools.exec.applyPatch.enabled).toBe(false);
    expect(config.sandbox).toBeUndefined();
    expect(config.agents.defaults.sandbox).toEqual({ mode: "off" });
    expect(config.agents.list[0].sandbox).toBeUndefined();
    expect(config.agents.list[0].tools).toBeUndefined();
  });

  it("parses Windows isolation tier and UI support without accepting unknown tiers", () => {
    expect(
      parseMxcProbe({
        tier: "base-container",
        warnings: ["preview"],
        probes: { uiCapabilities: { canBlockClipboardRead: true } },
      }),
    ).toEqual({
      tier: "base-container",
      warnings: ["preview"],
      uiCapabilities: { canBlockClipboardRead: true },
    });
    expect(parseMxcProbe({ tier: "unknown" }).tier).toBeUndefined();
  });

  it("pins both signed Windows executor payload hashes", () => {
    expect(expectedWxcHash("x64")).toBe("2wo0Ir6eGzlswbJUfHD/FrJ0EkOKMcEKRavzcMrIauI=");
    expect(expectedWxcHash("arm64")).toBe("5DDQ5PRPYW6R22hPjYJabck+BqEmK40AvKrHUioxeqs=");
  });

  it("verifies the installed selected executor payload", () => {
    const binary = path.resolve(
      __dirname,
      "..",
      "node_modules",
      "@microsoft",
      "mxc-sdk",
      "bin",
      process.arch === "arm64" ? "arm64" : "x64",
      "wxc-exec.exe",
    );
    expect(fs.existsSync(binary)).toBe(true);
    expect(sha256Base64(binary)).toBe(expectedWxcHash());
  });

  it("strips API keys, tokens, credentials, provider variables, and MXC path overrides", () => {
    const result = stripMxcWorkerEnvironment(
      {
        SystemRoot: "C:\\Windows",
        PATH: "host-path",
        OPENAI_API_KEY: "secret",
        GITHUB_TOKEN: "secret",
        AWS_ACCESS_KEY_ID: "secret",
        MXC_BIN_DIR: "C:\\attacker",
      },
      { PATH: "C:\\approved", TEMP: "C:\\workspace\\.mxc-tmp" },
    );
    expect(result).toEqual({
      SystemRoot: "C:\\Windows",
      PATH: "C:\\approved",
      TEMP: "C:\\workspace\\.mxc-tmp",
    });
  });

  it("fails chat closed until package, policy, and worker proof are all ready", () => {
    const status = createInitialMxcStatus();
    expect(() => assertMxcReadyForChat(status)).toThrow(/No host-tool fallback/);
    status.ready = true;
    expect(() => assertMxcReadyForChat(status)).not.toThrow();
  });

  it("keeps desired policies separate per agent", () => {
    const policies = buildMxcAgentPolicies(
      ["main", "research"],
      {
        main: { readonlyPaths: ["C:\\main-ro"], readwritePaths: [] },
        research: { readonlyPaths: [], readwritePaths: ["C:\\research-rw"] },
      },
      "C:\\mxc",
      ["C:\\secret"],
    );
    expect(policies.main.workspace).toBe(path.join("C:\\mxc", "main"));
    expect(policies.research.readwritePaths).toEqual(["C:\\research-rw"]);
    expect(policies.main.readwritePaths).toEqual([]);
  });

  it("uses only fixed development and packaged plugin resource locations", () => {
    expect(resolveMxcPluginDir(true, "C:\\resources", "C:\\desktop\\dist")).toBe(
      path.join("C:\\resources", "mxc-plugin"),
    );
    expect(resolveMxcPluginDir(false, "ignored", "C:\\desktop\\dist")).toBe(
      path.resolve("C:\\desktop\\dist", "..", "mxc-plugin"),
    );
  });

  it("removes renderer-controlled plugin paths and host plugin allow entries", () => {
    const config: Record<string, any> = {
      plugins: {
        allow: ["attacker-plugin"],
        load: { paths: ["C:\\stale\\microclaw-mxc", "C:\\app\\mxc-plugin"] },
      },
    };
    ensureMxcSecurityConfig(config, "C:\\app\\mxc-plugin", {});
    expect(config.plugins.load.paths).toEqual(["C:\\app\\mxc-plugin"]);
    expect(config.plugins.allow).toEqual([
      MXC_PLUGIN_ID,
      "github-copilot",
      "openclaw-weixin",
    ]);
  });

  it("packages MXC native resources and no longer ships AppContainer interception", () => {
    const builder = fs.readFileSync(path.resolve(__dirname, "..", "electron-builder.yml"), "utf8");
    const main = fs.readFileSync(path.resolve(__dirname, "main.ts"), "utf8");
    const plugin = fs.readFileSync(
      path.resolve(__dirname, "..", "mxc-plugin", "index.mjs"),
      "utf8",
    );
    const runtime = fs.readFileSync(
      path.resolve(__dirname, "..", "mxc-plugin", "runtime.mjs"),
      "utf8",
    );
    expect(builder).toContain("mxc-plugin/node_modules/@microsoft/mxc-sdk/");
    expect(builder).toContain("node_modules/@microsoft/mxc-sdk/bin/**/*");
    expect(builder).toContain("mxc-plugin/node_modules/semver/");
    expect(builder).not.toContain("AppContainerLauncher.exe");
    expect(builder).not.toContain("sandbox-preload.js");
    expect(main).not.toContain("new ToolSandbox(");
    expect(main).not.toContain("OPENCLAW_SANDBOX_HMAC_KEY");
    expect(main).not.toContain("getGatewayEnv()");
    expect(main).toContain("MICROCLAW_MXC_READY");
    expect(main).toContain('key.startsWith("mxcAgentPolicies.")');
    expect(main).toContain("await validateDesiredMxcPolicies(config)");
    expect(plugin).toContain('process.env.MICROCLAW_MXC_READY !== "1"');
    expect(runtime).toContain("config.processContainer.leastPrivilege = true");
  });
});

describe("MXC folder validation", () => {
  it("rejects overlaps before they can create conflicting RO/RW policies", () => {
    expect(pathsOverlap("C:\\data", "C:\\data\\child")).toBe(true);
    expect(pathsOverlap("C:\\data", "D:\\data")).toBe(false);
  });

  it("uses canonical real paths so junction targets cannot escape policy", async () => {
    vi.spyOn(fs.promises, "realpath").mockImplementation(async (candidate) => {
      if (String(candidate) === "C:\\safe-link") return "D:\\private-data" as never;
      if (String(candidate) === "C:\\Users\\me\\.ssh") return "D:\\private-data" as never;
      return String(candidate) as never;
    });
    vi.spyOn(fs.promises, "stat").mockResolvedValue({ isDirectory: () => true } as never);
    await expect(
      validateMxcFolder("C:\\safe-link", {
        existing: [],
        blockedRoots: ["C:\\Users\\me\\.ssh"],
      }),
    ).rejects.toThrow(/sensitive location/);
  });

  it("rejects broad roots and parent-child policy overlap", async () => {
    vi.spyOn(fs.promises, "realpath").mockResolvedValue("C:\\Users\\me" as never);
    vi.spyOn(fs.promises, "stat").mockResolvedValue({ isDirectory: () => true } as never);
    await expect(
      validateMxcFolder("C:\\Users\\me", {
        existing: [],
        blockedRoots: [],
        blockedExact: ["C:\\Users\\me"],
      }),
    ).rejects.toThrow(/broad location/);
  });

  it("rejects descendants of blocked Windows system and application-data roots", async () => {
    vi.spyOn(fs.promises, "realpath").mockResolvedValue(
      "C:\\Users\\me\\AppData\\Roaming\\Vendor\\credentials" as never,
    );
    vi.spyOn(fs.promises, "stat").mockResolvedValue({ isDirectory: () => true } as never);
    await expect(
      validateMxcFolder("C:\\safe-link", {
        existing: [],
        blockedRoots: ["C:\\Users\\me\\AppData\\Roaming"],
      }),
    ).rejects.toThrow(/sensitive location/);
  });

  it("rejects a parent folder that would expose a blocked credential subtree", async () => {
    vi.spyOn(fs.promises, "realpath").mockResolvedValue("C:\\Users" as never);
    vi.spyOn(fs.promises, "stat").mockResolvedValue({ isDirectory: () => true } as never);
    await expect(
      validateMxcFolder("C:\\Users", {
        existing: [],
        blockedRoots: ["C:\\Users\\me\\.ssh"],
      }),
    ).rejects.toThrow(/sensitive location/);
  });
});
