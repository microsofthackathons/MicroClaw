import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  OPENCLAW_SANDBOX_IMAGE,
  REQUIRED_DOCKER_SANDBOX,
  REQUIRED_SANDBOX_TOOLS,
  addAgentDockerBinding,
  applyRequiredDockerSandboxConfig,
  canExecuteWithDockerSandbox,
  checkDockerSandboxReadiness,
  findStateOwnedSandboxContainerIds,
  listAgentDockerBindings,
  normalizeAgentDockerBindings,
  parseDockerInfo,
  parseWslState,
  prependDockerExecutableToPath,
  resolveDockerExecutable,
  saveAndRecreateAgentDockerBindings,
  validateDockerBindingSource,
  type CommandRunner,
  type DockerSandboxReadiness,
} from "./docker-sandbox";

const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });

describe("Docker sandbox configuration", () => {
  it("enforces Docker-only fail-closed policy while retaining managed agent binds", () => {
    const result = applyRequiredDockerSandboxConfig({
      agents: {
        defaults: { model: "provider/model", sandbox: { mode: "off" } },
        list: [
          {
            id: "main",
            sandbox: {
              mode: "off",
              docker: { binds: ["C:\\Work:/mnt/microclaw/work-1234567890:ro"] },
            },
            runtime: { type: "acp" },
            tools: { sandbox: { tools: { allow: [] } } },
          },
        ],
      },
      tools: {
        elevated: { enabled: true },
        exec: { host: "gateway" },
        sandbox: { tools: { allow: ["gateway"] } },
      },
      acp: { enabled: true, dispatch: { enabled: true } },
    }).config as {
      agents: {
        defaults: { sandbox: unknown };
        list: Array<{ sandbox?: unknown; runtime?: unknown; tools?: unknown }>;
      };
      tools: {
        elevated: { enabled: boolean };
        exec: { host: string };
        sandbox: { tools: { allow: string[] } };
      };
      acp: { enabled: boolean; dispatch: { enabled: boolean } };
    };
    expect(result.agents.defaults.sandbox).toEqual(REQUIRED_DOCKER_SANDBOX);
    expect(result.agents.list[0].sandbox).toEqual({
      docker: {
        binds: ["C:\\Work:/mnt/microclaw/work-1234567890:ro"],
        dangerouslyAllowExternalBindSources: true,
      },
    });
    expect(result.agents.list[0].runtime).toBeUndefined();
    expect(result.agents.list[0].tools).toBeUndefined();
    expect(result.tools.elevated.enabled).toBe(false);
    expect(result.tools.exec.host).toBe("sandbox");
    expect(result.tools.sandbox.tools.allow).toEqual(REQUIRED_SANDBOX_TOOLS);
    expect(result.acp).toMatchObject({ enabled: false, dispatch: { enabled: false } });
  });

  it("normalizes Windows bind targets deterministically and enables only external bind sources", async () => {
    const options = {
      homeDir: "C:\\Users\\test",
      stateDir: "C:\\Users\\test\\AppData\\Roaming\\openclaw",
      environment: {
        SystemRoot: "C:\\Windows",
        ProgramFiles: "C:\\Program Files",
        APPDATA: "C:\\Users\\test\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      },
      realpath: async (value: string) => value,
      stat: async () => ({ isDirectory: () => true }) as never,
    };
    const first = await validateDockerBindingSource(
      "C:\\Users\\test\\Projects\\Alpha",
      "ro",
      options,
    );
    const again = await validateDockerBindingSource(
      "c:\\users\\test\\projects\\alpha",
      "ro",
      options,
    );
    const other = await validateDockerBindingSource("C:\\Archive\\Alpha", "rw", options);
    expect(first.target).toBe(again.target);
    expect(other.target).not.toBe(first.target);
    expect(first.target).toMatch(/^\/mnt\/microclaw\/alpha-[a-f0-9]{10}$/);

    const normalized = await normalizeAgentDockerBindings(
      {
        agents: {
          list: [
            {
              id: "main",
              sandbox: { docker: { binds: ["C:\\Users\\test\\Projects\\Alpha:/old:ro"] } },
            },
          ],
        },
      },
      options,
    );
    const main = listAgentDockerBindings(normalized.config).find((agent) => agent.id === "main");
    expect(main?.bindings).toEqual([first]);
    const normalizedAgents = normalized.config.agents as {
      list: Array<{ sandbox: { docker: Record<string, unknown> } }>;
    };
    expect(normalizedAgents.list[0].sandbox.docker.dangerouslyAllowExternalBindSources).toBe(true);
  });

  it("rejects broad, credential, canonical escape, and overlapping paths", async () => {
    const options = {
      homeDir: "C:\\Users\\test",
      stateDir: "C:\\Users\\test\\AppData\\Roaming\\openclaw",
      environment: {
        SystemRoot: "C:\\Windows",
        ProgramFiles: "C:\\Program Files",
        APPDATA: "C:\\Users\\test\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      },
      realpath: async (value: string) =>
        value.endsWith("\\Link") ? "C:\\Windows\\System32" : value,
      stat: async () => ({ isDirectory: () => true }) as never,
    };
    await expect(validateDockerBindingSource("C:\\", "ro", options)).rejects.toThrow("Drive");
    await expect(
      validateDockerBindingSource("C:\\Users\\test\\.ssh", "ro", options),
    ).rejects.toThrow("Credential");
    await expect(
      validateDockerBindingSource("C:\\Users\\test\\Projects\\Link", "ro", options),
    ).rejects.toThrow("System");

    const initial = await addAgentDockerBinding(
      { agents: { list: [{ id: "main" }] } },
      "main",
      "C:\\Users\\test\\Projects",
      "ro",
      options,
    );
    await expect(
      addAgentDockerBinding(initial, "main", "C:\\Users\\test\\Projects\\Child", "rw", options),
    ).rejects.toThrow("Overlapping");
  });

  it("saves desired config before recreation and reports recreation failures honestly", async () => {
    const events: string[] = [];
    const config = { agents: { defaults: { sandbox: REQUIRED_DOCKER_SANDBOX } } };
    const success = await saveAndRecreateAgentDockerBindings(config, "main", {
      write: async () => {
        events.push("write");
      },
      recreate: async () => {
        events.push("recreate");
      },
    });
    expect(events).toEqual(["write", "recreate"]);
    expect(success.effective).toBe("applied");

    const failure = await saveAndRecreateAgentDockerBindings(config, "main", {
      write: async () => {
        events.push("write-failure-case");
      },
      recreate: async () => {
        throw new Error("container removal failed");
      },
    });
    expect(failure).toMatchObject({
      effective: "error",
      error: "container removal failed",
      config,
    });
    expect(events).toContain("write-failure-case");
  });

  it("selects only OpenClaw containers mounted from the exact state sandbox root", () => {
    const stateDir = "C:\\State\\isolated";
    expect(
      findStateOwnedSandboxContainerIds(
        [
          {
            Id: "owned",
            Config: { Labels: { "openclaw.sandbox": "1" } },
            Mounts: [{ Source: "C:\\State\\isolated\\sandboxes\\agent-main" }],
          },
          {
            Id: "other-state",
            Config: { Labels: { "openclaw.sandbox": "1" } },
            Mounts: [{ Source: "C:\\State\\other\\sandboxes\\agent-main" }],
          },
          {
            Id: "not-openclaw",
            Config: { Labels: {} },
            Mounts: [{ Source: "C:\\State\\isolated\\sandboxes\\agent-main" }],
          },
        ],
        stateDir,
      ),
    ).toEqual(["owned"]);
  });

  it("preserves unrelated model, agent, and tool configuration", () => {
    const result = applyRequiredDockerSandboxConfig({
      agents: { defaults: { model: "provider/model" }, list: [{ id: "main", name: "Assistant" }] },
      tools: { profile: "coding" },
      gateway: { port: 18789 },
    }).config as {
      agents: { defaults: { model: string }; list: Array<{ id: string; name: string }> };
      tools: { profile: string };
      gateway: { port: number };
    };
    expect(result.agents.defaults.model).toBe("provider/model");
    expect(result.agents.list[0]).toMatchObject({ id: "main", name: "Assistant" });
    expect(result.tools.profile).toBe("coding");
    expect(result.gateway.port).toBe(18789);
  });

  it("never permits execution when readiness or mandatory configuration is missing", () => {
    const ready: DockerSandboxReadiness = {
      checkedAt: new Date().toISOString(),
      ready: true,
      reasons: [],
      windows: { status: "ready", reason: "ready" },
      wslCommand: { status: "ready", reason: "ready" },
      wsl2: { status: "ready", reason: "ready" },
      dockerCli: { status: "ready", reason: "ready" },
      dockerDaemon: { status: "ready", reason: "ready" },
      linuxContainers: { status: "ready", reason: "ready" },
      image: { status: "ready", reason: "ready" },
    };
    const enforced = applyRequiredDockerSandboxConfig({}).config;
    expect(canExecuteWithDockerSandbox(ready, enforced)).toBe(true);
    expect(canExecuteWithDockerSandbox({ ...ready, ready: false }, enforced)).toBe(false);
    expect(canExecuteWithDockerSandbox(ready, {})).toBe(false);
    expect(canExecuteWithDockerSandbox(ready, enforced, true)).toBe(false);
  });
});

describe("Docker readiness", () => {
  it("detects the per-user Docker Desktop CLI location", () => {
    const localAppData = "C:\\Users\\test\\AppData\\Local";
    const expected = `${localAppData}\\Programs\\DockerDesktop\\resources\\bin\\docker.exe`;
    expect(
      resolveDockerExecutable(
        { LOCALAPPDATA: localAppData },
        (candidate) => String(candidate) === expected,
      ),
    ).toBe(expected);
    expect(prependDockerExecutableToPath(expected, "C:\\Windows\\System32")).toBe(
      `${localAppData}\\Programs\\DockerDesktop\\resources\\bin;C:\\Windows\\System32`,
    );
    expect(prependDockerExecutableToPath("docker.exe", "C:\\Windows\\System32")).toBe(
      "C:\\Windows\\System32",
    );
  });

  describe("mandatory Docker Main integration", () => {
    const source = readFileSync(join(__dirname, "main.ts"), "utf8");
    const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
    function declaration(name: string): string {
      const node = ast.statements.find(
        (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
      );
      if (!node) throw new Error(`Missing actual Main function: ${name}`);
      return node.getText(ast);
    }
    const ready: DockerSandboxReadiness = {
      checkedAt: "2026-10-26T00:00:00Z",
      ready: true,
      reasons: [],
      windows: { status: "ready", reason: "ready" },
      wslCommand: { status: "ready", reason: "ready" },
      wsl2: { status: "ready", reason: "ready" },
      dockerCli: { status: "ready", reason: "ready" },
      dockerDaemon: { status: "ready", reason: "ready" },
      linuxContainers: { status: "ready", reason: "ready" },
      image: { status: "ready", reason: "ready" },
    };
    const guard = ts.transpileModule(declaration("assertManagedDockerGatewayReady"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const preload = readFileSync(join(__dirname, "preload.ts"), "utf8");
    const preloadAst = ts.createSourceFile("preload.ts", preload, ts.ScriptTarget.Latest, true);
    function preloadProperty(name: string): string {
      const matches: ts.PropertyAssignment[] = [];
      function visit(node: ts.Node): void {
        if (ts.isPropertyAssignment(node) && node.name.getText(preloadAst) === name)
          matches.push(node);
        ts.forEachChild(node, visit);
      }
      visit(preloadAst);
      const [result] = matches;
      if (!result) throw new Error(`Missing actual preload property: ${name}`);
      return result.initializer.getText(preloadAst);
    }

    it("keeps the real Docker build-progress subscription under the Docker bridge", () => {
      const on = vi.fn();
      const removeListener = vi.fn();
      const compiled = ts.transpileModule(
        `const bridge = ${preloadProperty("dockerSandbox")}; bridge`,
        {
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        },
      ).outputText;
      const bridge: { onBuildProgress(callback: (line: string) => void): () => void } =
        runInNewContext(compiled, { ipcRenderer: { on, removeListener } });
      expect(Object.keys(bridge).sort()).toEqual([
        "addBinding",
        "buildImage",
        "check",
        "getBindings",
        "getStatus",
        "onBuildProgress",
        "onStatus",
        "removeBinding",
        "retryBindings",
      ]);
      const callback = vi.fn();
      const unsubscribe = bridge.onBuildProgress(callback);
      const [channel, handler] = on.mock.calls[0];
      expect(channel).toBe("docker-sandbox:build-progress");
      handler(undefined, "building");
      expect(callback).toHaveBeenCalledWith("building");
      unsubscribe();
      expect(removeListener).toHaveBeenCalledWith(channel, handler);
    });

    it("rejects the real native off API before IPC transport or side effects", async () => {
      const helper = preloadAst.statements.find(
        (node) =>
          ts.isFunctionDeclaration(node) && node.name?.text === "rejectExcludedNativeBackend",
      );
      if (!helper) throw new Error("Missing actual native rejection helper");
      const compiled = ts.transpileModule(
        `${helper.getText(preloadAst)}\nconst bridge = ${preloadProperty("windowsNodeMxc")}; bridge`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
      ).outputText;
      const invoke = vi.fn();
      const bridge: { setEnabled(params: { requestedMode: "off" }): Promise<never> } =
        runInNewContext(compiled, { ipcRenderer: { invoke } });
      await expect(bridge.setEnabled({ requestedMode: "off" })).rejects.toThrow("mandatory Docker");
      expect(invoke).not.toHaveBeenCalled();
    });

    it.each([
      { child: null, expected: false },
      { child: { exitCode: 0, signalCode: null, killed: false }, expected: false },
      { child: { exitCode: null, signalCode: "SIGTERM", killed: false }, expected: false },
      { child: { exitCode: null, signalCode: null, killed: true }, expected: false },
      { child: { exitCode: null, signalCode: null, killed: false }, expected: true },
    ])("uses actual child liveness rather than a retained process reference %j", (state) => {
      const compiled = ts.transpileModule(declaration("isManagedGatewayProcessAlive"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const invoke: () => boolean = runInNewContext(`${compiled}; isManagedGatewayProcessAlive`, {
        gatewayProcess: state.child,
      });
      expect(invoke()).toBe(state.expected);
    });

    it.each([
      { owned: false, live: true, ready: true, changed: false, pending: false, valid: true },
      { owned: true, live: false, ready: true, changed: false, pending: false, valid: true },
      { owned: true, live: true, ready: false, changed: false, pending: false, valid: true },
      { owned: true, live: true, ready: true, changed: true, pending: false, valid: true },
      { owned: true, live: true, ready: true, changed: false, pending: true, valid: true },
      { owned: true, live: true, ready: true, changed: false, pending: false, valid: false },
    ])("refuses unsafe Main send state %j", async (state) => {
      const invoke: () => Promise<void> = runInNewContext(
        `${guard}; assertManagedDockerGatewayReady`,
        {
          gatewaySpawnedByUs: state.owned,
          isManagedGatewayProcessAlive: () => state.live,
          refreshDockerSandboxReadiness: async () => ({ ...ready, ready: state.ready }),
          readConfig: () => (state.valid ? applyRequiredDockerSandboxConfig({}).config : {}),
          prepareRequiredDockerSandboxConfig: async () => ({ changed: state.changed }),
          readPendingDockerBindings: () => (state.pending ? { main: {} } : {}),
          canExecuteWithDockerSandbox,
          dockerSandboxBlockedMessage: () => "Docker sandbox is not ready",
        },
      );
      await expect(invoke()).rejects.toThrow();
    });

    it("allows the actual send guard only for a live owned ready Docker Gateway", async () => {
      const refresh = vi.fn(async () => ready);
      const invoke: () => Promise<void> = runInNewContext(
        `${guard}; assertManagedDockerGatewayReady`,
        {
          gatewaySpawnedByUs: true,
          isManagedGatewayProcessAlive: () => true,
          refreshDockerSandboxReadiness: refresh,
          readConfig: () => applyRequiredDockerSandboxConfig({}).config,
          prepareRequiredDockerSandboxConfig: async () => ({ changed: false }),
          readPendingDockerBindings: () => ({}),
          canExecuteWithDockerSandbox,
          dockerSandboxBlockedMessage: () => "Docker sandbox is not ready",
        },
      );
      await expect(invoke()).resolves.toBeUndefined();
      expect(refresh).toHaveBeenCalledOnce();
    });

    it.each([
      { owned: false, live: true, ready: true, pending: false, expected: false },
      { owned: true, live: false, ready: true, pending: false, expected: false },
      { owned: true, live: true, ready: false, pending: false, expected: false },
      { owned: true, live: true, ready: true, pending: true, expected: false },
      { owned: true, live: true, ready: true, pending: false, expected: true },
    ])("binds actual application ingress to Docker ownership/readiness %j", (state) => {
      const compiled = ts.transpileModule(declaration("isApplicationIngressReady"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const invoke: () => boolean = runInNewContext(`${compiled}; isApplicationIngressReady`, {
        gatewaySpawnedByUs: state.owned,
        isManagedGatewayProcessAlive: () => state.live,
        dockerSandboxReadiness: { ...ready, ready: state.ready },
        readPendingDockerBindings: () => (state.pending ? { main: {} } : {}),
      });
      expect(invoke()).toBe(state.expected);
    });

    it("explicitly refuses every native MXC and remote approval compatibility IPC", () => {
      const registration = ast.statements.find(
        (node): node is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(node) && node.name?.text === "registerIpcHandlers",
      );
      const loop = registration?.body?.statements.find(
        (node) =>
          ts.isForOfStatement(node) &&
          node.expression.getText(ast).includes('"windows-node-mxc:get-status"'),
      );
      if (!loop) throw new Error("Missing actual native compatibility refusal loop");
      const handlers = new Map<string, () => never>();
      const compiled = ts.transpileModule(loop.getText(ast), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText;
      runInNewContext(compiled, {
        ipcMain: {
          handle: (channel: string, handler: () => never) => handlers.set(channel, handler),
        },
      });
      expect(handlers.size).toBe(13);
      for (const handler of handlers.values()) expect(handler).toThrow("mandatory Docker backend");
    });

    it("refuses external ownership before configuration, workspace, migration or skill mutation", () => {
      const startup = declaration("startGatewayInner");
      const refusal = startup.indexOf("failForExternalGateway(configuredPort)");
      expect(refusal).toBeGreaterThan(startup.indexOf("await checkExistingGateway"));
      for (const mutation of [
        "persistRequiredDockerSandboxConfig(",
        "recreateDockerSandboxes(",
        "seedWorkspaceFiles(",
        "ensurePluginsAllow(",
        "reconcileConfiguredAgentOwnedSkills(",
      ]) {
        expect(startup.indexOf(mutation), mutation).toBeGreaterThan(refusal);
      }
    });

    it("retains Docker CLI discovery and upstream generic preloads without native fallback", () => {
      const startup = declaration("startGatewayInner");
      expect(startup).toContain("resolveDockerExecutable()");
      expect(startup).toContain("PATH: prependDockerExecutableToPath(");
      for (const preload of ["stateOwnerCompatPath", "fsSafeCompatPath", "localModelCompatPath"]) {
        expect(startup).toContain(`pathToFileURL(${preload}).href`);
      }
      expect(startup).not.toMatch(
        /new (?:ToolSandbox|BundledWindowsNodeHost)|prepareWindowsNodeMxcContainment|approvalCompatPath/,
      );
      expect(source).toContain("const legacyAppContainerRuntimeEnabled = false");
      expect(source).toMatch(
        /supportsExecApprovals: false,\s*beforeChatSend: assertManagedDockerGatewayReady/,
      );
      expect(source).not.toMatch(/new BundledWindowsNodeHost|runAutomaticWindowsNodeMxcReadiness/);
    });
  });

  it("requires an installed WSL2 distribution", () => {
    expect(parseWslState(ok("Default Version: 2"), ok("NAME STATE VERSION"))).toMatchObject({
      reason: "wsl-no-distribution",
    });
    expect(parseWslState(ok(), ok("Ubuntu Stopped 1"))).toMatchObject({
      reason: "wsl2-distribution-missing",
    });
    expect(parseWslState(ok(), ok("* Ubuntu Running 2"))).toMatchObject({ status: "ready" });
  });

  it("distinguishes Docker Desktop from remote and Windows engines", () => {
    expect(
      parseDockerInfo(ok('{"OSType":"linux","OperatingSystem":"Ubuntu 24.04"}')).daemon,
    ).toMatchObject({ reason: "docker-desktop-required" });
    expect(
      parseDockerInfo(ok('{"OSType":"windows","OperatingSystem":"Docker Desktop"}'))
        .linuxContainers,
    ).toMatchObject({ reason: "docker-linux-containers-required" });
  });

  it("requires the pinned sandbox image", async () => {
    const runner = vi.fn<CommandRunner>(async (executable, args) => {
      if (executable === "wsl.exe" && args[0] === "--status") return ok("Default Version: 2");
      if (executable === "wsl.exe") return ok("* Ubuntu Running 2");
      if (args[0] === "--version") return ok("Docker version 27.0.0");
      if (args[0] === "info") {
        return ok('{"OSType":"linux","OperatingSystem":"Docker Desktop"}');
      }
      if (args[0] === "image") return { exitCode: 1, stdout: "", stderr: "No such image" };
      throw new Error(`Unexpected command: ${executable} ${args.join(" ")}`);
    });
    const result = await checkDockerSandboxReadiness(runner, {
      platform: "win32",
      osRelease: "10.0.22631",
      dockerExecutable: "docker.exe",
    });
    expect(result.image).toMatchObject({ status: "missing", reason: "sandbox-image-missing" });
    expect(result.ready).toBe(false);
    expect(runner).toHaveBeenCalledWith(
      "docker.exe",
      ["image", "inspect", OPENCLAW_SANDBOX_IMAGE],
      5_000,
    );
  });

  it("reports WSL and Docker timeouts without fallback", async () => {
    const runner: CommandRunner = async (executable, args) => {
      if (executable === "wsl.exe" && args[0] === "--status") return ok("Default Version: 2");
      if (executable === "wsl.exe") {
        throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    const result = await checkDockerSandboxReadiness(runner, {
      platform: "win32",
      osRelease: "10.0.22631",
      dockerExecutable: "docker.exe",
    });
    expect(result.wslCommand.status).toBe("ready");
    expect(result.wsl2.reason).toBe("wsl-check-timeout");
    expect(result.dockerCli.reason).toBe("docker-cli-missing");
    expect(result.ready).toBe(false);
  });
});
