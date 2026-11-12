import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { BackgroundSearchProvider, SEARCH_SETUP_FILENAME } from "../src/background-search-provider";
import { BundledWindowsNodeHost } from "../src/bundled-windows-node-host";
import { writeGuardedConfig } from "../src/config-write-service";
import { GatewayClient } from "../src/gateway-client";
import { getGatewayProcessStdio } from "../src/gateway-lifecycle";
import { applySearchConfig } from "../src/search-config-application";
import { createPowerShellFilesystemInitialization } from "../src/windows-node-mxc-powershell-scope";
import {
  applyWindowsNodeCommandPolicy,
  getWindowsNodeMxcMissingFolders,
  normalizeWindowsNodeMxcGatewayApproval,
  planWindowsNodeMxcFolderUpsert,
  WINDOWS_NODE_MXC_NODE_COMMANDS,
} from "../src/windows-node-mxc";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: (name) => {
      const root = process.env.MICROCLAW_GATEWAY_E2E_ROOT;
      if (!root) throw new Error("Missing isolated Gateway fixture root");
      if (name === "userData") return path.join(root, "user-data");
      if (name === "home") return path.join(root, "home");
      if (name === "appData") return path.join(root, "app-data");
      if (name === "temp") return path.join(root, "temp");
      throw new Error(`Unexpected fixture path: ${name}`);
    },
  },
}));

async function unusedLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitFor(description, check, milliseconds = 60_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe.skipIf(
  process.platform !== "win32" ||
    !process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR ||
    !process.env.MICROCLAW_GATEWAY_E2E_NATIVE_HOST ||
    !process.env.MICROCLAW_GATEWAY_E2E_PARENT,
)("isolated real Gateway and Windows Node consent", () => {
  it("prepares and approves stock CMD through the live Gateway socket", async () => {
    const started = Date.now();
    const trace = (message) => {
      if (process.env.MICROCLAW_GATEWAY_E2E_DIAGNOSTICS === "1")
        globalThis.console.info(`[gateway-e2e +${Date.now() - started}ms] ${message}`);
    };
    const requestedStrength = process.env.MICROCLAW_GATEWAY_E2E_MODE ?? "off";
    if (requestedStrength !== "off" && requestedStrength !== "full")
      throw new Error("The isolated Gateway fixture supports only off and full modes");
    const contained = requestedStrength === "full";
    const effectiveTier = contained ? "base-container" : "host";
    const root = mkdtempSync(
      path.join(process.env.MICROCLAW_GATEWAY_E2E_PARENT, "gateway-consent-"),
    );
    for (const directory of [
      "home",
      "app-data",
      "local-app-data",
      "user-data",
      "state",
      "temp",
      "workspace",
    ]) {
      mkdirSync(path.join(root, directory));
    }
    mkdirSync(path.join(root, "user-data", "mxc-weixin-media", "inbound"), { recursive: true });
    const previousState = process.env.OPENCLAW_STATE_DIR;
    const previousRoot = process.env.MICROCLAW_GATEWAY_E2E_ROOT;
    const previousPath = process.env.PATH;
    const previousPathExtensions = process.env.PATHEXT;
    const previousProfile = process.env.USERPROFILE;
    const previousTemp = process.env.TEMP;
    const previousTmp = process.env.TMP;
    const state = path.join(root, "state");
    const tools = path.join(root, "tools");
    mkdirSync(tools);
    writeFileSync(
      path.join(tools, "microclaw-context-check.cmd"),
      "@echo off\r\necho fixture-profile=%USERPROFILE%\r\n",
    );
    process.env.OPENCLAW_STATE_DIR = state;
    process.env.MICROCLAW_GATEWAY_E2E_ROOT = root;
    process.env.PATH = `${tools}${path.delimiter}${previousPath ?? ""}`;
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    process.env.USERPROFILE = path.join(root, "home");
    process.env.TEMP = path.join(root, "temp");
    process.env.TMP = path.join(root, "temp");
    const port = await unusedLoopbackPort();
    const token = randomUUID();
    const generation = randomUUID();
    const host = new BundledWindowsNodeHost();
    const hostPath = process.env.MICROCLAW_GATEWAY_E2E_NATIVE_HOST;
    Object.assign(host, {
      hostPath,
      resourceRoot: path.dirname(path.dirname(hostPath)),
    });
    const nodeId = host.ensureIdentityNodeId(contained);
    const options = {
      folders: [{ path: path.join(root, "workspace"), access: "rw" }],
      openClawStateRoot: state,
      requestedStrength,
      effectiveTier,
      ambientAccess: null,
      commandConsentMode:
        process.env.MICROCLAW_GATEWAY_E2E_AUTO_APPROVAL === "1"
          ? "allow-always"
          : "ask-when-needed",
    };
    const proof = host.createApprovalProofContext(
      generation,
      nodeId,
      options.folders,
      randomUUID(),
      requestedStrength,
      effectiveTier,
      null,
      options.commandConsentMode,
    );
    const livePolicy = await host.initializeLivePolicy(proof, options);
    const config = applyWindowsNodeCommandPolicy(
      {
        gateway: {
          mode: "local",
          bind: "loopback",
          port,
          auth: { mode: "token", token },
          nodes: {
            commands: {
              allow: [...WINDOWS_NODE_MXC_NODE_COMMANDS],
              deny: [],
            },
          },
        },
        agents: {
          defaults: { workspace: path.join(root, "workspace"), heartbeat: { every: "0m" } },
          entries: { main: {} },
        },
        ...(process.env.MICROCLAW_GATEWAY_E2E_BROWSER_ONLY === "1"
          ? {
              browser: {
                headless: true,
                executablePath: path.join(
                  process.env["ProgramFiles(x86)"],
                  "Microsoft",
                  "Edge",
                  "Application",
                  "msedge.exe",
                ),
                ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
              },
            }
          : {}),
        plugins:
          process.env.MICROCLAW_GATEWAY_E2E_CANVAS === "1" ||
          process.env.MICROCLAW_GATEWAY_E2E_BROWSER_ONLY === "1"
            ? {
                enabled: true,
                allow: ["canvas"],
                entries: {
                  canvas: { enabled: true },
                  ...(process.env.MICROCLAW_GATEWAY_E2E_BROWSER_ONLY === "1"
                    ? { browser: { enabled: false } }
                    : {}),
                },
              }
            : process.env.MICROCLAW_GATEWAY_E2E_SEARCH_ONLY === "1"
              ? { enabled: true }
              : { enabled: false },
        skills: { allowBundled: [] },
      },
      nodeId,
    );
    const deferredProvider = process.env.MICROCLAW_GATEWAY_E2E_DEFERRED_SEARCH;
    if (deferredProvider) {
      if (!["parallel-free", "brave", "tavily"].includes(deferredProvider))
        throw new Error("Unsupported deferred search fixture");
      const search = { provider: deferredProvider, maxResults: 7 };
      const suspendedSearch = { enabled: false, maxResults: 7 };
      config.tools = { ...config.tools, web: { ...config.tools?.web, search: suspendedSearch } };
      writeFileSync(
        path.join(state, SEARCH_SETUP_FILENAME),
        JSON.stringify({
          schemaVersion: 1,
          search,
          suspendedSearch,
          pluginEntry:
            deferredProvider === "parallel-free"
              ? { enabled: true }
              : { enabled: true, config: { webSearch: { apiKey: "test-search-key" } } },
        }),
      );
    }
    writeFileSync(path.join(state, "openclaw.json"), JSON.stringify(config));
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|^MICROCLAW_|^OPENCLAW_|^NODE_OPTIONS$|^ELECTRON_/i.test(
            key,
          ),
      ),
    );
    Object.assign(environment, livePolicy, {
      HOME: path.join(root, "home"),
      USERPROFILE: path.join(root, "home"),
      APPDATA: path.join(root, "app-data"),
      LOCALAPPDATA: path.join(root, "local-app-data"),
      TEMP: path.join(root, "temp"),
      TMP: path.join(root, "temp"),
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_NO_AUTO_UPDATE: "1",
      OPENCLAW_GATEWAY_HOST_LIFELINE: "stdin",
      MICROCLAW_OPENCLAW_PACKAGE_DIR: process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR,
      MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT: "1",
      MICROCLAW_MXC_APPROVAL_PROOF_SECRET: proof.secretBase64,
      MICROCLAW_MXC_APPROVAL_PROOF_GATEWAY_GENERATION: generation,
      MICROCLAW_MXC_APPROVAL_PROOF_POLICY_FINGERPRINT: proof.policyFingerprint,
      MICROCLAW_MXC_APPROVAL_PROOF_NODE_ID: nodeId,
    });
    const packageDir = process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR;
    const gateway = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(path.resolve("src", "openclaw-approval-replay-compat.mjs")).href,
        path.join(packageDir, "openclaw.mjs"),
        "gateway",
        "run",
        "--port",
        String(port),
        "--bind",
        "loopback",
        "--allow-unconfigured",
      ],
      { cwd: packageDir, env: environment, stdio: getGatewayProcessStdio(), windowsHide: true },
    );
    let gatewayLog = "";
    gateway.stdout.on("data", (chunk) => {
      gatewayLog += chunk.toString();
    });
    gateway.stderr.on("data", (chunk) => {
      gatewayLog += chunk.toString();
    });
    const events = [];
    let routeApproval = null;
    const approvalErrors = [];
    const client = new GatewayClient({
      port,
      token,
      supportsExecApprovals: true,
      onEvent: (event) => {
        events.push(event);
        if (routeApproval && event.event === "exec.approval.requested")
          void routeApproval(event).catch((error) => approvalErrors.push(error));
      },
    });
    const requester = new GatewayClient({ port, token, supportsExecApprovals: false });
    try {
      await waitFor(
        "the isolated Gateway health endpoint",
        async () => {
          if (gateway.exitCode !== null) throw new Error(`Gateway exited: ${gatewayLog}`);
          try {
            return (await globalThis.fetch(`http://127.0.0.1:${port}/health`)).ok;
          } catch {
            return false;
          }
        },
        120_000,
      );
      trace("Gateway health endpoint ready");
      client.start();
      await waitFor("the authenticated Gateway socket", () => client.connected);
      requester.start();
      await waitFor("the authenticated Gateway requester", () => requester.connected);
      trace("Gateway sockets authenticated");
      if (
        process.env.MICROCLAW_GATEWAY_E2E_BROWSER_ONLY !== "1" ||
        process.env.MICROCLAW_GATEWAY_E2E_BROWSER_NODE === "1"
      ) {
        await host.start({
          ...options,
          gatewayUrl: `ws://127.0.0.1:${port}`,
          gatewayToken: token,
          gatewayProcessId: gateway.pid,
          gatewayGeneration: generation,
          uiLocale: "en-US",
          approvalProof: proof,
          onApproval: () => {},
        });
        await Promise.race([
          host.ensurePaired(client),
          delay(90_000, undefined, { ref: false }).then(() => {
            throw new Error("Timed out pairing the isolated Windows Node");
          }),
        ]);
        await host.setActivationLease("active", 120_000);
        trace("Windows Node paired and activation lease issued");
      }
      async function prepare(
        payload,
        sessionKey,
        expectedPayload = payload,
        initialization = null,
      ) {
        const command = ["cmd.exe", "/d", "/s", "/c", payload];
        const prepared = await client.request("node.invoke", {
          nodeId,
          command: "system.run.prepare",
          params: { command, rawCommand: payload, agentId: "main", sessionKey },
          timeoutMs: 15_000,
          idempotencyKey: randomUUID(),
        });
        const plan = prepared.payload.plan;
        expect(plan.argv[0].toLowerCase()).toBe(
          path.join(process.env.SystemRoot, "System32", "cmd.exe").toLowerCase(),
        );
        expect(plan.argv.slice(1)).toEqual([...command.slice(1, -1), expectedPayload]);
        if (initialization) {
          expect(plan.providerInitialization).toEqual({
            ...initialization,
            originalArgv: [plan.argv[0], ...initialization.originalArgv.slice(1)],
            finalArgv: [plan.argv[0], ...initialization.finalArgv.slice(1)],
          });
        }
        return plan;
      }

      async function approve(plan, sessionKey) {
        const id = randomUUID();
        const accepted = await requester.request("exec.approval.request", {
          id,
          command: plan.commandText,
          systemRunPlan: plan,
          nodeId,
          host: "node",
          security: "allowlist",
          ask: "always",
          agentId: "main",
          sessionKey,
          timeoutMs: 60_000,
          twoPhase: true,
        });
        expect(accepted).toMatchObject({
          status: "accepted",
          id,
          deliveryRoute: "approval-client",
        });
        await waitFor("the Gateway approval event", () =>
          events.some(
            (event) => event.event === "exec.approval.requested" && event.payload?.id === id,
          ),
        );
        await client.request("exec.approval.resolve", { id, decision: "allow-once" });
        const run = {
          nodeId,
          command: "system.run",
          params: {
            command: plan.argv,
            cwd: plan.cwd,
            rawCommand: plan.commandText,
            agentId: "main",
            sessionKey,
            runId: id,
            approved: true,
            approvalDecision: "allow-once",
          },
          timeoutMs: 15_000,
          idempotencyKey: randomUUID(),
        };
        return run;
      }

      async function approveAndRun(plan, sessionKey) {
        const run = await approve(plan, sessionKey);
        return { result: await client.request("node.invoke", run), run };
      }

      const sessionKey = "agent:main:main";
      function loadProductionApprovalRoute(context) {
        const source = readFileSync(path.join(process.cwd(), "src", "main.ts"), "utf8");
        const routeStart = source.indexOf('if (evt.event === "exec.approval.requested")');
        const routeEnd = source.indexOf('if (evt.event === "exec.approval.resolved")', routeStart);
        const handlerStart = source.indexOf("async function handleWindowsNodeMxcGatewayApproval(");
        const handlerEnd = source.indexOf(
          "function beginPendingWindowsNodeMxcRemoteDelivery(",
          handlerStart,
        );
        if (routeStart < 0 || routeEnd < 0 || handlerStart < 0 || handlerEnd < 0)
          throw new Error("Cannot locate the production Gateway approval route");
        const code = ts.transpileModule(
          `${source.slice(handlerStart, handlerEnd)}
           async function route(evt: any) { ${source.slice(routeStart, routeEnd)} }
           globalThis.route = route;`,
          { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
        ).outputText;
        runInNewContext(code, context);
        if (typeof context.route !== "function") throw new Error("Approval route did not load");
        return context.route;
      }

      if (process.env.MICROCLAW_GATEWAY_E2E_AUTO_APPROVAL === "1") {
        if (contained) throw new Error("The automatic approval fixture must start in Off mode");
        const context = {
          route: null,
          isWindowsNodeMxcDesired: () => false,
          getWindowsNodeMxcRequestedMode: () => "off",
          normalizeWindowsNodeMxcGatewayApproval,
          settingsStore: { get: (name) => (name === "windowsNodeMxcNodeId" ? nodeId : "en-US") },
          gatewayGenerationId: generation,
          gwClient: client,
          windowsNodeMxcApprovalProofContext: proof,
          windowsNodeMxcApprovalResolutionCompletion: null,
          getWindowsNodeMxcMissingFolders: () => {
            throw new Error("Off mode must not request MXC folder grants");
          },
          withWindowsNodeMxcApprovalResolution: async (operation) => operation(),
          requireEffectiveWindowsNodeMxc: async () => {
            if (!host.status().activationLease) throw new Error("The fixture lease is inactive");
          },
          isApplicationIngressReady: () => true,
          console: {
            info: () => {},
            error: (...args) => approvalErrors.push(new Error(args.map(String).join(" "))),
          },
        };
        routeApproval = loadProductionApprovalRoute(context);

        const downloads = path.join(root, "home", "Downloads");
        mkdirSync(downloads);
        const outputFile = path.join(downloads, "off-mode-fixture.txt");
        const command = `powershell.exe -NoProfile -Command "New-Item -Path '${outputFile}' -ItemType File -Force"`;
        const plan = await prepare(
          `# [declare-access]rw:${downloads}[/declare-access]\r\n${command}`,
          sessionKey,
          command,
        );
        expect(plan.commandConsent.required).toBe(false);
        const id = randomUUID();
        const accepted = await requester.request("exec.approval.request", {
          id,
          command: plan.commandText,
          systemRunPlan: plan,
          nodeId,
          host: "node",
          security: "allowlist",
          ask: "always",
          agentId: "main",
          sessionKey,
          timeoutMs: 60_000,
          twoPhase: true,
        });
        expect(accepted).toMatchObject({ status: "accepted", id });
        await waitFor("automatic Gateway approval", () =>
          events.some(
            (event) =>
              event.event === "exec.approval.resolved" &&
              event.payload?.id === id &&
              event.payload?.decision === "allow-once",
          ),
        );
        expect(approvalErrors).toEqual([]);
        const result = await client.request("node.invoke", {
          nodeId,
          command: "system.run",
          params: {
            command: plan.argv,
            cwd: plan.cwd,
            rawCommand: plan.commandText,
            agentId: "main",
            sessionKey,
            runId: id,
            approved: true,
            approvalDecision: "allow-once",
          },
          timeoutMs: 15_000,
          idempotencyKey: randomUUID(),
        });
        expect(result.payload).toMatchObject({
          success: true,
          exitCode: 0,
          containment: "host",
          containmentStrength: "off",
        });
        expect(existsSync(outputFile)).toBe(true);
        return;
      }

      if (process.env.MICROCLAW_GATEWAY_E2E_FOLDER_GRANT === "1") {
        if (!contained) throw new Error("The folder approval fixture must start in Full mode");
        const configPath = path.join(root, "home", ".gitconfig");
        const protectedPath = path.join(root, "user-data", "windows-node", "protected-fixture.txt");
        writeFileSync(configPath, "SYNTHETIC_GIT_CONFIG");
        writeFileSync(protectedPath, "SYNTHETIC_PROTECTED_CHILD");
        const readConfig = `type "${configPath}"`;
        const before = await approveAndRun(await prepare(readConfig, sessionKey), sessionKey);
        expect(before.result.payload.exitCode).not.toBe(0);
        expect(before.result.payload.stdout).not.toContain("SYNTHETIC_GIT_CONFIG");

        let approvedFolders = options.folders;
        const prompts = [];
        const toBundledFolders = (policy) => [
          ...policy.ro.map((folder) => ({ path: folder, access: "ro" })),
          ...policy.rw.map((folder) => ({ path: folder, access: "rw" })),
        ];
        const context = {
          route: null,
          isWindowsNodeMxcDesired: () => true,
          getWindowsNodeMxcRequestedMode: () => "full",
          normalizeWindowsNodeMxcGatewayApproval,
          getWindowsNodeMxcMissingFolders,
          getBundledWindowsNodeFolders: () => approvedFolders,
          planRequestedWindowsNodeMxcFolders: async (changes) => {
            let policy = {
              ro: approvedFolders
                .filter((folder) => folder.access === "ro")
                .map((folder) => folder.path),
              rw: approvedFolders
                .filter((folder) => folder.access === "rw")
                .map((folder) => folder.path),
            };
            for (const change of changes) {
              const next = planWindowsNodeMxcFolderUpsert(policy, change.path, change.access);
              if (!next.ok) throw new Error(`Invalid fixture folder change: ${next.reason}`);
              policy = next.dirs;
            }
            return policy;
          },
          toBundledWindowsNodeFolders: toBundledFolders,
          bundledWindowsNodeHost: host,
          settingsStore: { get: (name) => (name === "windowsNodeMxcNodeId" ? nodeId : "en-US") },
          gatewayGenerationId: generation,
          gwClient: client,
          windowsNodeMxcApprovalProofContext: proof,
          windowsNodeMxcApprovalResolutionCompletion: null,
          windowsNodeMxcWeixinContext: null,
          isApplicationIngressReady: () => true,
          findPendingWindowsNodeMxcGatewayApproval: () => null,
          mxcApprovalDeadline: (received, requested) =>
            Math.min(received + 60_000, requested ?? Infinity),
          findWeixinApprovalSource: () => null,
          windowsNodeMxcWeixinRemoteApprovalSources: [],
          currentWindowsNodeMxcWeixinRemoteApprovalSecurity: () => null,
          windowsNodeMxcWeixinRemoteApprovalServer: null,
          resolveSupportedLocale: (locale) => locale,
          WeixinRemoteDeliveryCoordinator: class {},
          WindowsNodeMxcApprovalLifecycle: class {
            start() {}
          },
          pendingWindowsNodeMxcGatewayApproval: null,
          queuedWindowsNodeMxcGatewayApprovals: [],
          projectWindowsNodeMxcApprovalForRenderer: (approval) => approval,
          sendToWindow: (_window, channel, approval) => {
            if (channel === "windows-node-mxc:approval-request") prompts.push(approval);
          },
          mainWindow: {},
          beginPendingWindowsNodeMxcRemoteDelivery: () => {},
          describeGatewayApprovalContext: () => ({}),
          console: {
            info: () => {},
            error: (...args) => approvalErrors.push(new Error(args.map(String).join(" "))),
          },
        };
        routeApproval = loadProductionApprovalRoute(context);
        const plan = await prepare(
          `# [declare-access]ro:${root}[/declare-access]\r\n${readConfig}`,
          sessionKey,
          readConfig,
        );
        const id = randomUUID();
        const accepted = await requester.request("exec.approval.request", {
          id,
          command: plan.commandText,
          systemRunPlan: plan,
          nodeId,
          host: "node",
          security: "allowlist",
          ask: "always",
          agentId: "main",
          sessionKey,
          timeoutMs: 60_000,
          twoPhase: true,
        });
        expect(accepted).toMatchObject({ status: "accepted", id });
        await waitFor("the combined folder and command prompt", () => prompts.length > 0);
        expect(approvalErrors).toEqual([]);
        const prompt = prompts[0];
        expect(prompt.folderChanges).toEqual([{ path: root, access: "ro" }]);
        expect(prompt.allowedDecisions).toEqual(["deny", "allow-once"]);
        expect(prompt.planSha256).toMatch(/^[a-f0-9]{64}$/);

        const nextFolders = [...approvedFolders, { path: root, access: "ro" }];
        const nextProof = await host.applyLiveFolderPolicy(client, nextFolders, {
          approvalId: id,
          planSha256: prompt.planSha256,
          expiresAtUnixMs: prompt.expiresAtUnixMs,
        });
        approvedFolders = nextFolders;
        context.windowsNodeMxcApprovalProofContext = nextProof;
        await host.setActivationLease("active", 120_000);
        await client.request("exec.approval.resolve", { id, decision: "allow-once" });
        routeApproval = null;
        const result = await client.request("node.invoke", {
          nodeId,
          command: "system.run",
          params: {
            command: plan.argv,
            cwd: plan.cwd,
            rawCommand: plan.commandText,
            agentId: "main",
            sessionKey,
            runId: id,
            approved: true,
            approvalDecision: "allow-once",
          },
          timeoutMs: 30_000,
          idempotencyKey: randomUUID(),
        });
        expect(result.payload).toMatchObject({ success: true, exitCode: 0, containment: "mxc" });
        expect(result.payload.stdout).toContain("SYNTHETIC_GIT_CONFIG");

        const protectedResult = await approveAndRun(
          await prepare(`type "${protectedPath}"`, sessionKey),
          sessionKey,
        );
        expect(protectedResult.result.payload.exitCode).not.toBe(0);
        expect(protectedResult.result.payload.stdout).not.toContain("SYNTHETIC_PROTECTED_CHILD");
        trace("Combined parent approval preserved the upstream protected child");
        return;
      }

      async function saveSearchSettings(mxcEnabled, provider) {
        trace(`Applying ${provider} search settings`);
        const configPath = path.join(state, "openclaw.json");
        const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"));
        const before = readConfig();
        const next = globalThis.structuredClone(before);
        next.tools ??= {};
        next.tools.web ??= {};
        next.tools.web.search = {
          provider,
          ...(provider === "brave"
            ? { apiKey: "BSA-fixture" }
            : provider === "tavily"
              ? { apiKey: "tvly-fixture" }
              : {}),
        };
        await writeGuardedConfig(
          {
            readConfig,
            configFileExists: () => existsSync(configPath),
            isMxcEnabled: () => mxcEnabled,
            assertMutable: () => {
              if (!client.connected || gateway.exitCode !== null)
                throw new Error("The fixture Gateway is not running");
            },
            requireActiveContainment: async () => {
              if (!host.status().activationLease) throw new Error("The fixture lease is inactive");
            },
            isGatewayConnected: () => client.connected,
            isGatewayRunning: () => gateway.exitCode === null,
            assertGatewayPortAvailable: async () => {
              throw new Error("Unexpected initial setup");
            },
            defaultGatewayPort: port,
            nodeId: () => nodeId,
            persist: (value) => {
              const temporary = `${configPath}.fixture.tmp`;
              writeFileSync(temporary, JSON.stringify(value));
              renameSync(temporary, configPath);
            },
            applyModel: async () => {
              throw new Error("Unexpected model change");
            },
            applySearch: (config, expectedConfig, assertCurrent) =>
              applySearchConfig(
                { gateway: () => client, readConfig, assertCurrent, nodeId: () => nodeId },
                config,
                expectedConfig,
              ),
            startServices: async () => {
              throw new Error("Unexpected Gateway startup");
            },
          },
          next,
          before,
          { kind: "search-settings" },
        );
        let lastSearchSnapshot;
        try {
          await waitFor("live search configuration", async () => {
            const snapshot = await client.request("config.get", {});
            lastSearchSnapshot = {
              valid: snapshot.valid,
              provider: snapshot.config?.tools?.web?.search?.provider,
              revisionPresent: Boolean(snapshot.configRevisionHash),
              applied: snapshot.appliedConfigHash === snapshot.configRevisionHash,
              issues: snapshot.issues,
            };
            if (snapshot.valid === false)
              throw new Error(`Gateway rejected config: ${JSON.stringify(snapshot.issues)}`);
            return (
              lastSearchSnapshot.valid === true &&
              lastSearchSnapshot.provider === provider &&
              lastSearchSnapshot.revisionPresent &&
              lastSearchSnapshot.applied
            );
          });
        } catch (error) {
          throw new Error(
            `Live search configuration was not confirmed: ${JSON.stringify(lastSearchSnapshot)}`,
            { cause: error },
          );
        }
        trace(`${provider} search settings applied`);
      }

      if (process.env.MICROCLAW_GATEWAY_E2E_BROWSER_ONLY === "1") {
        async function invokeBrowser(args) {
          const response = await globalThis.fetch(`http://127.0.0.1:${port}/tools/invoke`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ tool: "browser", args, sessionKey }),
            signal: globalThis.AbortSignal.timeout(60_000),
          });
          return { status: response.status, body: await response.json() };
        }
        const before = await invokeBrowser({ action: "status" });
        expect(before.status).toBe(404);
        const enabled = await client.request(
          "plugins.setEnabled",
          { pluginId: "browser", enabled: true },
          300_000,
        );
        expect(enabled).toMatchObject({ ok: true, restartRequired: false });
        const after = await invokeBrowser({ action: "status" });
        expect(after.status, JSON.stringify(after.body)).toBe(200);
        expect(after.body.ok).toBe(true);

        const server = http.createServer((_request, response) => {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(
            "<!doctype html><title>Fixture</title><h1>Isolated browser navigation works</h1>",
          );
        });
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        try {
          const targetUrl = `http://127.0.0.1:${server.address().port}/`;
          const opened = await invokeBrowser({ action: "open", target: "host", targetUrl });
          const browserDiagnostics = gatewayLog
            .split(/\r?\n/)
            .filter((line) => /browser|chrom|playwright|error|failed/i.test(line))
            .slice(-30)
            .join("\n")
            .replaceAll(token, "[redacted]")
            .replaceAll(root, "[fixture]");
          expect(opened.status, `${JSON.stringify(opened.body)}\n${browserDiagnostics}`).toBe(200);
          expect(opened.body.ok, JSON.stringify(opened.body)).toBe(true);
          expect(opened.body.result?.isError, JSON.stringify(opened.body)).not.toBe(true);
          const snapshot = await invokeBrowser({ action: "snapshot", target: "host" });
          expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(200);
          expect(snapshot.body.ok, JSON.stringify(snapshot.body)).toBe(true);
          expect(snapshot.body.result?.isError, JSON.stringify(snapshot.body)).not.toBe(true);
          expect(JSON.stringify(snapshot.body)).toContain("Isolated browser navigation works");
        } finally {
          try {
            const stopped = await invokeBrowser({ action: "stop", target: "host" });
            expect(stopped.body.ok, JSON.stringify(stopped.body)).toBe(true);
          } finally {
            await new Promise((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
          }
        }
        expect(gateway.exitCode).toBeNull();
        return;
      }

      if (process.env.MICROCLAW_GATEWAY_E2E_SEARCH_ONLY === "1") {
        const provider =
          deferredProvider ?? process.env.MICROCLAW_GATEWAY_E2E_SEARCH_PROVIDER ?? "brave";
        if (deferredProvider) {
          const messages = [];
          const background = new BackgroundSearchProvider({
            stateDir: () => state,
            gateway: () => client,
            ready: () => true,
            log: (message) => {
              messages.push(message);
              trace(message);
            },
          });
          trace(`Starting deferred ${provider} search setup`);
          background.start();
          try {
            await waitFor(
              "deferred search setup",
              () => {
                const failure = messages.find((message) =>
                  message.startsWith("Web search setup deferred"),
                );
                if (failure) throw new Error(failure);
                return !existsSync(path.join(state, SEARCH_SETUP_FILENAME));
              },
              360_000,
            );
            const applied = await client.request("config.get", {});
            expect(applied.config.tools.web.search).toMatchObject({ provider, maxResults: 7 });
            const persisted = JSON.parse(readFileSync(path.join(state, "openclaw.json"), "utf8"));
            expect(persisted.gateway.auth.token).toBe(token);
            if (provider !== "parallel-free") {
              expect(persisted.plugins.entries[provider].config.webSearch.apiKey).toBe(
                "test-search-key",
              );
            }
            expect(messages).toContain("Web search is ready; Gateway was not restarted");
          } finally {
            background.stop();
          }
        } else {
          await saveSearchSettings(contained, provider);
        }
        if (provider === "parallel-free") {
          const response = await globalThis.fetch(`http://127.0.0.1:${port}/tools/invoke`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({
              tool: "web_search",
              args: { query: "Microsoft Windows official website" },
              sessionKey,
            }),
            signal: globalThis.AbortSignal.timeout(60_000),
          });
          const body = await response.json();
          expect(response.ok, JSON.stringify(body)).toBe(true);
          expect(body.ok, JSON.stringify(body)).toBe(true);
          expect(body.result?.isError, JSON.stringify(body)).not.toBe(true);
          const text = body.result?.content?.find((item) => item.type === "text")?.text;
          expect(text).toBeTypeOf("string");
          const search = JSON.parse(text);
          expect(search.results, JSON.stringify(search)).toBeInstanceOf(Array);
          expect(search.results.length, JSON.stringify(search)).toBeGreaterThan(0);
        }
        return;
      }

      async function assertStockCanvasRouting() {
        const nodes = await client.request("node.list", {});
        const managed = nodes.nodes.find((node) => node.nodeId === nodeId);
        expect(managed.commands).toEqual(
          expect.arrayContaining([...WINDOWS_NODE_MXC_NODE_COMMANDS]),
        );
        expect(managed.commands.some((command) => command.startsWith("canvas."))).toBe(false);
        await expect(
          client.request("node.invoke", {
            nodeId,
            command: "canvas.present",
            params: {},
            timeoutMs: 15_000,
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toThrow(/not allowed|not supported|not advertised|not in/i);
        const response = await globalThis.fetch(`http://127.0.0.1:${port}/tools/invoke`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ tool: "canvas", args: { action: "present" }, sessionKey }),
        });
        const body = await response.json();
        expect(response.ok).toBe(false);
        expect(body).toMatchObject({ ok: false, error: { type: "tool_error" } });
      }
      if (process.env.MICROCLAW_GATEWAY_E2E_SWITCH_ONLY !== "1") {
        const plan = await prepare("echo gateway-node-consent-ok", sessionKey);
        expect(plan.commandConsent.required).toBe(true);
        const { result, run } = await approveAndRun(plan, sessionKey);
        expect(result.payload).toMatchObject({
          success: true,
          exitCode: 0,
          containment: contained ? "mxc" : "host",
          containmentStrength: requestedStrength,
          effectiveTier,
        });
        expect(result.payload.stdout.trim()).toBe("gateway-node-consent-ok");
        await expect(
          client.request("node.invoke", { ...run, idempotencyKey: randomUUID() }),
        ).rejects.toThrow();

        if (contained) {
          const workspace = path.join(root, "workspace");
          for (const quoted of [true, false]) {
            const target = path.join(workspace, `notes-${quoted}.txt`);
            const moved = path.join(workspace, `moved-${quoted}.txt`);
            const renamed = path.join(workspace, `renamed-${quoted}.txt`);
            writeFileSync(target, "isolated deletion fixture");
            for (const operation of [
              `Move-Item -LiteralPath '${target}' -Destination '${moved}' -ErrorAction Stop`,
              `Rename-Item -LiteralPath '${moved}' -NewName 'renamed-${quoted}.txt'`,
              `Remove-Item -LiteralPath '${renamed}' -Force`,
            ]) {
              const executable = `powershell -Command ${quoted ? `"${operation}"` : operation}`;
              const cmd = path.join(process.env.SystemRoot, "System32", "cmd.exe");
              const initialization = createPowerShellFilesystemInitialization(
                [cmd, "/d", "/s", "/c", executable],
                cmd,
                [{ access: "rw", path: workspace }],
              );
              if (!initialization)
                throw new Error("Expected automatic CMD provider initialization");
              const prefix = quoted ? "#" : "REM";
              const payload = `${prefix} [declare-access]rw:${workspace}[/declare-access]\n${executable}`;
              const prepared = await prepare(
                payload,
                sessionKey,
                initialization.finalArgv[4],
                initialization,
              );
              expect(prepared.commandConsent).toEqual({
                required: true,
                allowAlwaysAvailable: false,
              });
              const executed = await approveAndRun(prepared, sessionKey);
              expect(executed.result.payload).toMatchObject({ success: true, exitCode: 0 });
            }
            expect(existsSync(target)).toBe(false);
            expect(existsSync(moved)).toBe(false);
            expect(existsSync(renamed)).toBe(false);
          }
          for (const operation of [
            `Get-Item -Path '${workspace}\\missing.txt'`,
            `Copy-Item -Path '${workspace}\\missing.txt' -Destination '${workspace}\\copy.txt'`,
            `New-Item -ItemType Directory -Path '${workspace}\\new-folder'`,
          ]) {
            const script = `powershell -Command "${operation}"`;
            const prepared = await prepare(
              `# [declare-access]rw:${workspace}[/declare-access]\n${script}`,
              sessionKey,
              script,
            );
            expect(prepared.providerInitialization).toBeUndefined();
          }
        }

        if (!contained) {
          const batch = await prepare("microclaw-context-check", sessionKey);
          expect(batch.commandConsent.required).toBe(true);
          const batchResult = await approveAndRun(batch, sessionKey);
          expect(batchResult.result.payload).toMatchObject({ success: true, exitCode: 0 });
          expect(batchResult.result.payload.stdout.trim()).toBe(
            `fixture-profile=${path.join(root, "home")}`,
          );
        }

        const hostname = path.join(process.env.SystemRoot, "System32", "hostname.exe");
        const firstSession = "agent:main:first";
        const remembered = await prepare(hostname, firstSession);
        expect(remembered.commandConsent).toEqual({ required: true, allowAlwaysAvailable: true });
        expect((await approveAndRun(remembered, firstSession)).result.payload).toMatchObject({
          success: true,
          exitCode: 0,
        });
        await host.rememberCommand({
          executable: remembered.argv[0],
          arguments: remembered.argv.slice(1),
          canonicalCwd: remembered.cwdBinding,
          agent: "main",
          sessionKey: firstSession,
        });
        const secondSession = "agent:main:second";
        const matched = await prepare(hostname, secondSession);
        expect(matched.commandConsent).toEqual({ required: false, allowAlwaysAvailable: false });
        expect((await approveAndRun(matched, secondSession)).result.payload.success).toBe(true);

        const stale = await prepare("echo stale-policy", sessionKey);
        expect(stale.commandConsent.required).toBe(true);
        const staleRun = await approve(stale, sessionKey);

        const allowProof = await host.applyLiveCommandConsentPolicy(client, "allow-always");
        expect(host.status().activationLease).toBeNull();
        await host.setActivationLease("active", 120_000);
        const allowed = await prepare("echo live-allow-always", sessionKey);
        expect(allowed.policyFingerprint).toBe(allowProof.policyFingerprint);
        expect(allowed.commandConsent).toEqual({ required: false, allowAlwaysAvailable: false });
        expect((await approveAndRun(allowed, sessionKey)).result.payload.stdout.trim()).toBe(
          "live-allow-always",
        );

        const askProof = await host.applyLiveCommandConsentPolicy(client, "ask-when-needed");
        await host.setActivationLease("active", 120_000);
        expect(askProof.policyFingerprint).not.toBe(stale.policyFingerprint);
        expect(askProof.policyFingerprint).not.toBe(allowProof.policyFingerprint);
        await expect(client.request("node.invoke", staleRun)).rejects.toThrow();
        const fresh = await prepare("echo live-ask", sessionKey);
        expect(fresh.policyFingerprint).toBe(askProof.policyFingerprint);
        expect(fresh.commandConsent.required).toBe(true);
        expect((await approveAndRun(fresh, sessionKey)).result.payload.stdout.trim()).toBe(
          "live-ask",
        );
      }

      const gatewayPid = gateway.pid;
      const hostPid = host.status().processId;
      const connection = client.connectionGeneration;
      if (!contained) {
        await host.applyLiveSandboxMode(client, "full", "base-container");
        await host.setActivationLease("active", 120_000);
      }

      const staleModePlan = await prepare("echo stale-sandbox-mode", sessionKey);
      const staleModeRun = await approve(staleModePlan, sessionKey);
      const longPlan = await prepare(
        'powershell.exe -NoProfile -Command "Start-Sleep -Seconds 30"',
        sessionKey,
      );
      const longRun = await approve(longPlan, sessionKey);
      const running = client.request("node.invoke", longRun).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const runState = await Promise.race([
        running.then((result) => ({ state: "finished", result })),
        delay(2_000).then(() => ({ state: "running" })),
      ]);
      expect(runState, JSON.stringify(runState)).toMatchObject({ state: "running" });

      const offProof = await host.applyLiveSandboxMode(client, "off", "host");
      expect(host.status().activationLease).toBeNull();
      const cancelled = await Promise.race([
        running,
        delay(35_000).then(() => {
          throw new Error("The previous contained command did not drain during mode switching");
        }),
      ]);
      expect(cancelled.value?.payload?.success).not.toBe(true);
      await host.setActivationLease("active", 120_000);
      await expect(client.request("node.invoke", staleModeRun)).rejects.toThrow();
      const offPlan = await prepare("echo live-sandbox-off", sessionKey);
      expect(offPlan.policyFingerprint).toBe(offProof.policyFingerprint);
      expect((await approveAndRun(offPlan, sessionKey)).result.payload).toMatchObject({
        success: true,
        containment: "host",
        containmentStrength: "off",
        effectiveTier: "host",
      });
      if (process.env.MICROCLAW_GATEWAY_E2E_CANVAS === "1") {
        await assertStockCanvasRouting();
      }

      const staleOffPlan = await prepare("echo stale-off-mode", sessionKey);
      const staleOffRun = await approve(staleOffPlan, sessionKey);
      const fullProof = await host.applyLiveSandboxMode(client, "full", "base-container");
      expect(host.status().activationLease).toBeNull();
      await host.setActivationLease("active", 120_000);
      await expect(client.request("node.invoke", staleOffRun)).rejects.toThrow();
      const fullPlan = await prepare("echo live-sandbox-full", sessionKey);
      expect(fullPlan.policyFingerprint).toBe(fullProof.policyFingerprint);
      expect((await approveAndRun(fullPlan, sessionKey)).result.payload).toMatchObject({
        success: true,
        containment: "mxc",
        containmentStrength: "full",
        effectiveTier: "base-container",
      });
      if (process.env.MICROCLAW_GATEWAY_E2E_CANVAS === "1") {
        await assertStockCanvasRouting();
      }

      const workspacePlan = await client.request("node.invoke", {
        nodeId,
        command: "system.run.prepare",
        params: {
          command: ["cmd.exe", "/d", "/s", "/c", "echo retained-folder"],
          cwd: path.join(root, "workspace"),
          agentId: "main",
          sessionKey,
        },
        timeoutMs: 15_000,
        idempotencyKey: randomUUID(),
      });
      expect(workspacePlan.payload.plan.cwd.toLowerCase()).toBe(
        path.join(root, "workspace").toLowerCase(),
      );
      const outsidePlan = await client.request("node.invoke", {
        nodeId,
        command: "system.run.prepare",
        params: {
          command: ["cmd.exe", "/d", "/s", "/c", "echo outside-folder"],
          cwd: path.join(root, "temp"),
          agentId: "main",
          sessionKey,
        },
        timeoutMs: 15_000,
        idempotencyKey: randomUUID(),
      });
      expect(outsidePlan.payload.matchedRoot).toBeUndefined();
      const outsideRun = await approveAndRun(outsidePlan.payload.plan, sessionKey);
      expect(outsideRun.result.payload).toMatchObject({
        success: false,
        executionState: "rejectedBeforeExecution",
        errorCode: "cwd-outside-approved-roots",
      });
      expect(host.status().processId).toBe(hostPid);
      expect(gateway.pid).toBe(gatewayPid);
      expect(gateway.exitCode).toBeNull();
      expect(client.connected).toBe(true);
      expect(client.connectionGeneration).toBe(connection);
    } finally {
      requester.stop();
      client.stop();
      host.stop(true);
      gateway.stdin.end();
      await Promise.race([new Promise((resolve) => gateway.once("exit", resolve)), delay(5_000)]);
      if (gateway.exitCode === null) gateway.kill();
      if (previousState === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousState;
      if (previousRoot === undefined) delete process.env.MICROCLAW_GATEWAY_E2E_ROOT;
      else process.env.MICROCLAW_GATEWAY_E2E_ROOT = previousRoot;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousPathExtensions === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = previousPathExtensions;
      if (previousProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousProfile;
      if (previousTemp === undefined) delete process.env.TEMP;
      else process.env.TEMP = previousTemp;
      if (previousTmp === undefined) delete process.env.TMP;
      else process.env.TMP = previousTmp;
      rmSync(root, { recursive: true, force: true });
    }
  }, 600_000);
});
