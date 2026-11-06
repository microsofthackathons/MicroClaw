import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { BundledWindowsNodeHost } from "../src/bundled-windows-node-host";
import { GatewayClient } from "../src/gateway-client";
import { createPowerShellFilesystemInitialization } from "../src/windows-node-mxc-powershell-scope";
import {
  WINDOWS_NODE_COMMAND_CONSENT_COMMANDS,
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
    if (contained)
      mkdirSync(path.join(root, "user-data", "mxc-weixin-media", "inbound"), { recursive: true });
    const previousState = process.env.OPENCLAW_STATE_DIR;
    const previousRoot = process.env.MICROCLAW_GATEWAY_E2E_ROOT;
    const previousPath = process.env.PATH;
    const previousPathExtensions = process.env.PATHEXT;
    const previousProfile = process.env.USERPROFILE;
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
    const port = await unusedLoopbackPort();
    const token = randomUUID();
    const generation = randomUUID();
    const host = new BundledWindowsNodeHost();
    Object.assign(host, { hostPath: process.env.MICROCLAW_GATEWAY_E2E_NATIVE_HOST });
    const nodeId = host.ensureIdentityNodeId(contained);
    const options = {
      folders: contained ? [{ path: path.join(root, "workspace"), access: "rw" }] : [],
      openClawStateRoot: state,
      requestedStrength,
      effectiveTier,
      ambientAccess: null,
      commandConsentMode: "ask-when-needed",
    };
    const proof = host.createApprovalProofContext(
      generation,
      nodeId,
      options.folders,
      state,
      randomUUID(),
      requestedStrength,
      effectiveTier,
      null,
      options.commandConsentMode,
    );
    const livePolicy = await host.initializeLivePolicy(proof, options);
    const config = {
      gateway: {
        mode: "local",
        bind: "loopback",
        port,
        auth: { mode: "token", token },
        nodes: {
          commands: {
            allow: contained
              ? [...WINDOWS_NODE_MXC_NODE_COMMANDS]
              : [...WINDOWS_NODE_COMMAND_CONSENT_COMMANDS],
            deny: [],
          },
        },
      },
      agents: {
        defaults: { workspace: path.join(root, "workspace"), heartbeat: { every: "0m" } },
        entries: { main: {} },
      },
      plugins: { enabled: false },
      skills: { allowBundled: [] },
    };
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
      { cwd: packageDir, env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let gatewayLog = "";
    gateway.stdout.on("data", (chunk) => {
      gatewayLog += chunk.toString();
    });
    gateway.stderr.on("data", (chunk) => {
      gatewayLog += chunk.toString();
    });
    const events = [];
    const client = new GatewayClient({
      port,
      token,
      supportsExecApprovals: true,
      onEvent: (event) => events.push(event),
    });
    const requester = new GatewayClient({ port, token, supportsExecApprovals: false });
    try {
      await waitFor(
        "the isolated Gateway health endpoint",
        async () => {
          if (gateway.exitCode !== null) throw new Error(`Gateway exited: ${gatewayLog}`);
          try {
            return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
          } catch {
            return false;
          }
        },
        120_000,
      );
      client.start();
      await waitFor("the authenticated Gateway socket", () => client.connected);
      requester.start();
      await waitFor("the authenticated Gateway requester", () => requester.connected);
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
            if (!initialization) throw new Error("Expected automatic CMD provider initialization");
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

      const gatewayPid = gateway.pid;
      const hostPid = host.status().processId;
      const connection = client.connectionGeneration;
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
      rmSync(root, { recursive: true, force: true });
    }
  }, 420_000);
});
