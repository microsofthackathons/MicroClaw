import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error The compatibility preload is intentionally external ESM for the Gateway child.
import * as replayCompat from "./openclaw-approval-replay-compat.mjs";

const {
  APPROVAL_PROOF_CONTRACT,
  APPROVAL_PROOF_TTL_MS,
  classifyWindowsNodeMxcInvokeFailure,
  describeWindowsNodeSystemRunResponseShape,
  normalizeWindowsNodeSystemRunResponse,
  PINNED_WEB_FETCH_HTTP_ONLY_SOURCE,
  PINNED_WEB_FETCH_HTTP_ONLY_10_5_SOURCE,
  PINNED_BASH_TOOLS_DISPATCH_FAILURE_SOURCE,
  PINNED_BASH_TOOLS_FAILURE_CLASSIFIER_SOURCE,
  PINNED_BASH_TOOLS_FINAL_DISPATCH_SOURCE,
  PINNED_BASH_TOOLS_FOLLOWUP_FAILURE_SOURCE,
  PINNED_BASH_TOOLS_INVOKE_RESULT_SOURCE,
  PINNED_BASH_TOOLS_WINDOWS_SHELL_SOURCE,
  PINNED_BASH_TOOLS_HOST_SELECTION_SOURCE,
  PINNED_BASH_TOOLS_POLICY_DENIED_GUIDANCE_SOURCE,
  PINNED_BASH_TOOLS_PREPARED_SOURCE,
  PINNED_EXEC_APPROVAL_VALIDATION_SOURCE,
  PINNED_CRON_STARTUP_MISSED_JOBS_SOURCE,
  PINNED_CRON_STARTUP_ACK_SOURCE,
  PINNED_NODE_GATEWAY_APPROVAL_SOURCE,
  PINNED_NODE_GATEWAY_ASK_FALLBACK_SOURCE,
  PINNED_NODE_GATEWAY_DIRECT_DISPATCH_SOURCE,
  PINNED_NODE_GATEWAY_MINT_INSERT_SOURCE,
  PINNED_NODE_GATEWAY_PLUGIN_DISPATCH_SOURCE,
  PINNED_NODE_INVOKE_PLUGIN_DISPATCH_SOURCE,
  PINNED_NODE_INVOKE_PLUGIN_REQUEST_SOURCE,
  PINNED_NODE_REGISTRY_PRE_DISPATCH_SOURCE,
  PINNED_NODE_REGISTRY_SERIALIZATION_SOURCE,
  PINNED_NODE_REGISTRY_SERIALIZATION_10_5_SOURCE,
  PINNED_SYSTEM_RUN_PLAN_SOURCE,
  attestPinnedOpenClawWebFetchHttpOnly,
  createWindowsNodeMxcApprovalProofMinter,
  computeWindowsNodeMxcApprovalPlanSha256,
  patchPinnedOpenClawExecApproval,
  patchPinnedOpenClawBashTools,
  patchPinnedOpenClawCronService,
  patchPinnedOpenClawNodeGateway,
  patchPinnedOpenClawNodeInvokePluginPolicy,
  patchPinnedOpenClawNodeRegistryPrivate,
  patchPinnedOpenClawSystemRun,
  shouldInitializeApprovalPreload,
  validatePinnedOpenClawApprovalPackage,
  createPinnedApprovalLoadHook,
} = replayCompat;

describe("pinned approval module load boundaries", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "microclaw-approval-load-"));
    roots.push(root);
    const directory = join(root, "pinned");
    mkdirSync(directory);
    const modulePath = join(directory, "module.mjs");
    writeFileSync(modulePath, "export const value = 'original';");
    const target = {
      module: "module.mjs",
      modulePath,
      targetPath: (process.platform === "win32" ? realpathSync.native : realpathSync)(modulePath),
      original: readFileSync(modulePath),
      patch: vi.fn((source: string) => source.replace("original", "patched")),
    };
    return { root, directory, target };
  }

  it("patches the validated source while passing unrelated modules and builtins through", () => {
    const { root, target } = fixture();
    const hook = createPinnedApprovalLoadHook([target]);
    const loaded = { format: "module", source: "untrusted loaded bytes" };
    const next = vi.fn(() => loaded);
    const result = hook(pathToFileURL(target.modulePath).href, {}, next);
    expect(result.source).toBe("export const value = 'patched';");
    const unrelated = join(root, "other.mjs");
    writeFileSync(unrelated, "export const other = true;");
    expect(hook(pathToFileURL(unrelated).href, {}, next)).toBe(loaded);
    expect(hook("node:fs", {}, next)).toBe(loaded);
    expect(target.patch).toHaveBeenCalledOnce();
  });

  it("recognizes directory aliases without bypassing the pinned transform", () => {
    const { root, directory, target } = fixture();
    const alias = join(root, "alias");
    symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
    const hook = createPinnedApprovalLoadHook([target]);
    expect(
      hook(pathToFileURL(join(alias, "module.mjs")).href, {}, () => ({ format: "module" })).source,
    ).toBe("export const value = 'patched';");
  });

  it("rejects a validated lexical path redirected to a different file", () => {
    const { root, directory, target } = fixture();
    const alias = join(root, "alias");
    symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
    const hook = createPinnedApprovalLoadHook([
      { ...target, modulePath: join(alias, "module.mjs") },
    ]);
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "module.mjs"), "throw new Error('redirected');");
    if (process.platform === "win32") rmdirSync(alias);
    else unlinkSync(alias);
    symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
    expect(() =>
      hook(pathToFileURL(join(alias, "module.mjs")).href, {}, () => ({ format: "module" })),
    ).toThrow("changed after validation");
    expect(target.patch).not.toHaveBeenCalled();
  });
});

describe("pinned OpenClaw package validation", () => {
  const temporaryPackages: string[] = [];

  function createPackage(version: string): string {
    const packageDir = mkdtempSync(join(tmpdir(), "microclaw-approval-compat-"));
    temporaryPackages.push(packageDir);
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ version }));
    mkdirSync(join(packageDir, "dist"));
    return packageDir;
  }

  afterEach(() => {
    for (const packageDir of temporaryPackages.splice(0)) {
      rmSync(packageDir, { recursive: true, force: true });
    }
  });

  it.each([undefined, "", "relative-package"])("rejects a non-absolute package path: %s", (dir) => {
    expect(() => validatePinnedOpenClawApprovalPackage(dir)).toThrow(/absolute path/);
  });

  it.each([
    "2026.8.2",
    "2026.9.3",
    "2026.10.1",
    "2026.10.2",
    "2026.10.3-beta.1",
    "2026.10.4",
    "2026.10.5-beta.1",
    "2026.10.6",
    "toString",
  ])("rejects an unpinned OpenClaw version: %s", (version) => {
    expect(() => validatePinnedOpenClawApprovalPackage(createPackage(version))).toThrow(
      /requires OpenClaw 2026\.10\.10/,
    );
  });

  it.each([
    ["2026.10.3", "nodes-Cl-Air2F.mjs"],
    ["2026.10.5", "nodes-50M4rpyG.mjs"],
    ["2026.10.10", "nodes-CXMBO_AM.mjs"],
  ])("rejects modified %s approval bundles", (version, module) => {
    const packageDir = createPackage(version);
    writeFileSync(join(packageDir, "dist", module), "// changed");
    expect(() => validatePinnedOpenClawApprovalPackage(packageDir)).toThrow(/hash mismatch/);
  });

  const publishedPackage = process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR;
  describe.skipIf(!publishedPackage)("official npm package integration", () => {
    it("validates all published hashes and patch points and parses the patched bundles", () => {
      const targets = validatePinnedOpenClawApprovalPackage(publishedPackage, {
        approval: true,
        cronResume: true,
      });
      const version = JSON.parse(
        readFileSync(join(publishedPackage!, "package.json"), "utf8"),
      ).version;
      expect(targets.map((target: { module: string }) => target.module)).toEqual(
        version === "2026.10.10"
          ? [
              "nodes-CXMBO_AM.mjs",
              "node-invoke-plugin-policy-D_JIgmYG.mjs",
              "node-registry-private-Cf6NE86i.mjs",
              "system-run-approval-plan-BzxkNWfX.mjs",
              "exec-approval-DuJx32oo.mjs",
              "bash-tools-B7jTXO_k.mjs",
              "openclaw-tools-Wz412ubE.mjs",
              "service-pOwE_Xvo.mjs",
            ]
          : version === "2026.10.5"
            ? [
                "nodes-50M4rpyG.mjs",
                "node-invoke-plugin-policy-C3OHtaj0.mjs",
                "node-registry-private-Cy7k5cze.mjs",
                "system-run-approval-plan-B2O_CKga.mjs",
                "exec-approval-DbnOAIQO.mjs",
                "bash-tools-BpD5km6h.mjs",
                "openclaw-tools-BzG0r_Mx.mjs",
                "service-BlXGdNfC.mjs",
              ]
            : [
                "nodes-Cl-Air2F.mjs",
                "node-invoke-plugin-policy-GeGCY71G.mjs",
                "node-registry-private-CyaYRwVd.mjs",
                "system-run-approval-plan-Cu-Ftdkp.mjs",
                "exec-approval-BKqqOMdp.mjs",
                "bash-tools-DQS9-f8q.mjs",
                "openclaw-tools-BA3mvtXt.mjs",
                "service-B3JlUlHg.mjs",
              ],
      );
      for (const target of targets) {
        const patched = target.patch(target.original.toString("utf8"));
        const checked = spawnSync(process.execPath, ["--check", "--input-type=module"], {
          input: patched,
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(checked.error).toBeUndefined();
        expect(checked.status, checked.stderr).toBe(0);
        if (target.module.startsWith("nodes-")) {
          expect(patched.indexOf("manager.projectDecisionIfActive")).toBeLessThan(
            patched.indexOf("microclawApprovalProofRequest: {"),
          );
          expect(patched).toContain(
            "attachMicroclawNodeApprovalProof(dispatchParams, forwardedParams.microclawApprovalProofRequest)",
          );
        }
        if (target.module.startsWith("node-invoke-plugin-policy-")) {
          expect(patched).toContain("const requestParams = override.params ?? params.params");
          expect(patched).toContain("params.onNodeCommandDispatchPreparing?.(requestParams)");
        }
        if (target.module.startsWith("node-registry-private-")) {
          expect(patched.indexOf("params.isDispatchAuthorized?.()")).toBeLessThan(
            patched.indexOf("params.onDispatchPreparing?.(params.params)"),
          );
          expect(patched.indexOf("params.onDispatchPreparing?.(params.params)")).toBeLessThan(
            patched.indexOf("invokeParams = normalizeSystemRunInvokeParams"),
          );
          expect(patched.indexOf("invokeParams = normalizeSystemRunInvokeParams")).toBeLessThan(
            patched.indexOf("payload = buildNodeInvokeRequest"),
          );
          if (version === "2026.10.5") {
            expect(patched).toContain("params: invokeParams,\n\t\tturnSource");
          }
          if (version === "2026.10.10") {
            expect(patched).toContain("params: invokeParams,\n\t\t\tturnSource");
            expect(patched).toContain(
              'return { result: nodeInvokeError("INVALID_REQUEST", "worker launch exceeds the node payload limit") }',
            );
            expect(patched).toContain(
              'nodeInvokeError("PAIRING_CHANGED", "node pairing changed before dispatch")',
            );
          }
        }
        if (version === "2026.10.10" && target.module.startsWith("bash-tools-")) {
          expect(patched).toContain('reason: "permission-missing"');
          expect(patched).toContain("source: assertSourceActive,");
          expect(patched).toContain('host !== "node"');
          expect(patched).toContain("microclawUnresolvedRunKey,");
        }
        if (version === "2026.10.10" && target.module.startsWith("service-")) {
          const fence = patched.indexOf(
            "const microclawCronWorkerResumeFenceRaw",
            patched.indexOf("async function start(state)"),
          );
          expect(fence).toBeGreaterThan(patched.indexOf("return await recoverCronRuns(state)"));
          expect(fence).toBeLessThan(
            patched.indexOf("await startCronScheduler(state, skipJobIds)"),
          );
          expect(patched.indexOf("const microclawCronResumeAckPath")).toBeGreaterThan(
            patched.indexOf("await startCronScheduler(state, skipJobIds)"),
          );
        }
        if (version === "2026.10.5" && target.module.startsWith("exec-approval-")) {
          expect(patched).toContain("const rejectRequest = (message) =>");
          expect(patched).toContain(
            'rejectRequest("agent runtime approval authority is no longer active")',
          );
        }
        if (version === "2026.10.5" && target.module.startsWith("nodes-")) {
          expect(patched).toContain(
            'systemRunApprovalGuardError("APPROVAL_PLAN_REQUIRED", "operator approval requires an approved execution plan", runId)',
          );
        }
      }
    });

    it.each(["", "1"])(
      "preserves stock Canvas with approval routing and legacy Canvas flag %j",
      (canvasFlag) => {
        const hook = pathToFileURL(resolve(__dirname, "openclaw-approval-replay-compat.mjs")).href;
        const initialized = spawnSync(
          process.execPath,
          [
            "--import",
            hook,
            "--input-type=module",
            "-e",
            `import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
assert.equal(process.env.MICROCLAW_MXC_APPROVAL_PROOF_SECRET, undefined);
assert.equal(process.env.MICROCLAW_MXC_APPROVAL_PRELOAD_INITIALIZED, "1");
assert.equal(typeof globalThis[Symbol.for("microclaw.windows-node-mxc.approval-proof.v1")].mint, "function");
const dist = join(process.env.MICROCLAW_OPENCLAW_PACKAGE_DIR, "dist");
const files = readdirSync(dist);
const paths = [
  join(dist, "extensions", "canvas", "index.js"),
  join(dist, files.find(name => /^node-eligibility-.*\\.mjs$/.test(name))),
  join(dist, files.find(name => /^tool-.*\\.mjs$/.test(name) && readFileSync(join(dist, name), "utf8").includes("function createCanvasTool("))),
];
const seen = new Set();
const urls = new Set(paths.map(file => pathToFileURL(file).href));
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (urls.has(url)) {
    assert.equal(Buffer.from(result.source).toString("utf8"), readFileSync(new URL(url), "utf8"));
    seen.add(url);
  }
  return result;
}});
const modules = await Promise.all(paths.map(file => import(pathToFileURL(file).href)));
assert.equal(seen.size, 3);
const eligibility = Object.values(modules[1]).find(value => typeof value === "function" && value.name === "isEligibleCanvasNode");
assert.equal(eligibility({ platform: "windows", connected: true, commands: ["canvas.present"] }), false);
assert.equal(eligibility({ platform: "macos", connected: true, commands: ["canvas.present"] }), true);
const resolveCanvasNode = Object.values(modules[1]).find(value => typeof value === "function" && value.name === "resolveCanvasNodeFromList");
assert.throws(() => resolveCanvasNode([{ nodeId: "windows-node", platform: "windows", connected: true, commands: ["canvas.present"] }]), /no eligible Canvas panel.*macOS/i);
const tool = modules[2].createCanvasTool({});
assert.deepEqual(tool.parameters.properties.action.enum, ["present", "hide", "navigate"]);`,
          ],
          {
            env: {
              ...process.env,
              MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT: "1",
              MICROCLAW_MXC_CANVAS_PHASE1: canvasFlag,
              MICROCLAW_MXC_APPROVAL_PRELOAD_INITIALIZED: "",
              MICROCLAW_OPENCLAW_PACKAGE_DIR: publishedPackage,
              MICROCLAW_MXC_APPROVAL_PROOF_SECRET: Buffer.alloc(32, 1).toString("base64"),
              MICROCLAW_MXC_APPROVAL_PROOF_GATEWAY_GENERATION: "test-generation",
              MICROCLAW_MXC_APPROVAL_PROOF_POLICY_FINGERPRINT: "a".repeat(64),
              MICROCLAW_MXC_APPROVAL_PROOF_NODE_ID: "b".repeat(64),
            },
            encoding: "utf8",
            timeout: 60_000,
          },
        );
        expect(initialized.error).toBeUndefined();
        expect(initialized.status, initialized.stderr).toBe(0);
        expect(initialized.stdout).toContain("enabled one-use node proof");
      },
      70_000,
    );

    it("initializes the Cron-only resume fence without approval secrets", () => {
      const hook = pathToFileURL(resolve(__dirname, "openclaw-approval-replay-compat.mjs")).href;
      const initialized = spawnSync(process.execPath, ["--import", hook, "-e", ""], {
        env: {
          ...process.env,
          MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT: "",
          MICROCLAW_MXC_APPROVAL_PRELOAD_INITIALIZED: "",
          MICROCLAW_OPENCLAW_PACKAGE_DIR: publishedPackage,
          MICROCLAW_MXC_CRON_RESUME_FENCE_UNIX_MS: "1735689600000",
          MICROCLAW_MXC_CRON_RESUME_ACK_PATH: join(tmpdir(), "microclaw-cron-resume-test.json"),
          MICROCLAW_MXC_CRON_RESUME_ACK_TOKEN: "test-token",
          MICROCLAW_MXC_APPROVAL_PROOF_SECRET: "",
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(initialized.error).toBeUndefined();
      expect(initialized.status, initialized.stderr).toBe(0);
      expect(initialized.stdout).toContain("MXC Cron no-catch-up resume fence");
    });
  });
});

describe("pinned OpenClaw web fetch contract", () => {
  it("attests the HTTP(S)-only URL scheme guard", () => {
    expect(attestPinnedOpenClawWebFetchHttpOnly(PINNED_WEB_FETCH_HTTP_ONLY_SOURCE)).toBe(
      PINNED_WEB_FETCH_HTTP_ONLY_SOURCE,
    );
    expect(attestPinnedOpenClawWebFetchHttpOnly(PINNED_WEB_FETCH_HTTP_ONLY_10_5_SOURCE)).toBe(
      PINNED_WEB_FETCH_HTTP_ONLY_10_5_SOURCE,
    );
    expect(() =>
      attestPinnedOpenClawWebFetchHttpOnly(
        'if (parsedUrl.protocol === "file:") return readFile(parsedUrl);',
      ),
    ).toThrow(/no longer rejects non-HTTP URL schemes/);
  });

  describe("pinned OpenClaw Cron resume contract", () => {
    it("advances only pre-fence schedules before normal startup catch-up", () => {
      const patched = patchPinnedOpenClawCronService(
        `${PINNED_CRON_STARTUP_MISSED_JOBS_SOURCE}\n${PINNED_CRON_STARTUP_ACK_SOURCE}`,
      );

      expect(patched).toContain("MICROCLAW_MXC_CRON_RESUME_FENCE_UNIX_MS");
      expect(patched).toContain("cron: advanced schedules missed during MXC pause");
      expect(patched).toContain("nowMs: microclawCronResumeFenceUnixMs");
      expect(patched).toContain("await runMissedJobs(state");
      expect(patched).toContain("MICROCLAW_MXC_CRON_RESUME_ACK_PATH");
      expect(patched).toContain('flag: "wx"');
      expect(patched).toContain("delete process.env.MICROCLAW_MXC_CRON_RESUME_FENCE_UNIX_MS");
      expect(patched.indexOf("nowMs: microclawCronResumeFenceUnixMs")).toBeLessThan(
        patched.indexOf("await runMissedJobs(state"),
      );
    });

    it("fails closed when the pinned Cron startup boundary drifts", () => {
      expect(() => patchPinnedOpenClawCronService("unrecognized source")).toThrow(
        /did not match exactly once/,
      );
    });
  });
});

describe("pinned OpenClaw node approval proof backport", () => {
  const source = [
    PINNED_NODE_GATEWAY_MINT_INSERT_SOURCE,
    PINNED_NODE_GATEWAY_APPROVAL_SOURCE,
    PINNED_NODE_GATEWAY_ASK_FALLBACK_SOURCE,
    PINNED_NODE_GATEWAY_PLUGIN_DISPATCH_SOURCE,
    PINNED_NODE_GATEWAY_DIRECT_DISPATCH_SOURCE,
  ].join("\n");

  it("retains the 10.5 positional approval guards and one-use operator requirement", () => {
    const modern =
      "function systemRunApprovalGuardError(code, message, runId) {}\n" +
      source.replaceAll(
        /systemRunApprovalGuardError\(\{\n\t+code: ("[^"]+"),\n\t+message: ("[^"]+"),\n\t+details: \{ runId \}\n\t+\}\)/g,
        "systemRunApprovalGuardError($1, $2, runId)",
      );
    const patched = patchPinnedOpenClawNodeGateway(modern);
    expect(patched).toContain(
      'systemRunApprovalGuardError("APPROVAL_SOURCE_MISMATCH", "approval source does not match approval record", runId)',
    );
    expect(patched).toContain(
      'systemRunApprovalGuardError("APPROVAL_PLAN_REQUIRED", "operator approval requires an approved execution plan", runId)',
    );
    expect(patched).not.toContain("systemRunApprovalGuardError({");
    expect(patched).toContain(
      'approvalDecision !== "allow-once" || recordedResolutionSource !== "operator"',
    );
    expect(patched).toContain("manager.consumeAllowOnce(runId)");
  });

  it("mints a proof only at the latest trusted dispatch boundary", () => {
    const patched = patchPinnedOpenClawNodeGateway(source);

    expect(patched.match(/microclawApprovalProof =/g)).toHaveLength(1);
    expect(patched).toContain("manager.consumeAllowOnce(runId)");
    expect(patched).toContain(
      'if (approvalDecision !== "allow-once" || recordedResolutionSource !== "operator") return systemRunApprovalRequired(runId);',
    );
    expect(patched).toContain(
      'timedOut && approvalSource === "ask-fallback" && !approved && requestedDecision === null && clientHasApprovals(opts.client)) {\n\t\treturn systemRunApprovalRequired(runId);',
    );
    expect(patched).toContain('recordedResolutionSource !== "operator"');
    expect(patched).toContain("plan: runtimeContext.plan");
    expect(patched).toContain("nodeId: targetNodeId");
    expect(patched).toContain("microclawApprovalProofRequest");
    expect(patched.match(/attachMicroclawNodeApprovalProof/g)).toHaveLength(3);
    expect(patched).toContain("stage=proof-mint");
    expect(patched).toContain("stage=gateway-forward");
    expect(patched.indexOf("consumeAllowOnce(runId)")).toBeLessThan(
      patched.indexOf("microclawApprovalProofRequest"),
    );
    expect(patched.indexOf("microclawApprovalProofRequest")).toBeLessThan(
      patched.lastIndexOf("attachMicroclawNodeApprovalProof"),
    );
  });

  it("forwards the full approved command text instead of the shell preview with the native proof", () => {
    const patched = patchPinnedOpenClawNodeGateway(source);
    const attachSource = patched.slice(
      patched.indexOf("function attachMicroclawNodeApprovalProof"),
      patched.indexOf("async function sanitizeSystemRunParamsForForwarding"),
    );
    const proof = { issuedAtUnixMs: 1000 };
    const mint = vi.fn().mockReturnValue(proof);
    const attach = new Function(
      "mintMicroclawNodeApprovalProof",
      "console",
      `${attachSource}\nreturn attachMicroclawNodeApprovalProof;`,
    )(mint, { error: vi.fn() });
    const commandText =
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command "Write-Output ok"';
    const request = { plan: { commandText, commandPreview: "Write-Output ok" } };
    const params = { rawCommand: "Write-Output ok" };
    attach(params, null);
    expect(params.rawCommand).toBe("Write-Output ok");
    expect(mint).not.toHaveBeenCalled();
    attach(params, request);
    expect(mint).toHaveBeenCalledExactlyOnceWith(request);
    expect(params).toEqual({ rawCommand: commandText, microclawApprovalProof: proof });
  });

  it("attaches the proof to the final plugin params before registry serialization", () => {
    const patchedPlugin = patchPinnedOpenClawNodeInvokePluginPolicy(
      [PINNED_NODE_INVOKE_PLUGIN_REQUEST_SOURCE, PINNED_NODE_INVOKE_PLUGIN_DISPATCH_SOURCE].join(
        "\n",
      ),
    );
    const patchedRegistry = patchPinnedOpenClawNodeRegistryPrivate(
      [
        PINNED_NODE_REGISTRY_SERIALIZATION_SOURCE,
        "if (params.signal?.aborted) return { ok: false };",
        "if (params.isDispatchAuthorized?.() === false) return { ok: false };",
        PINNED_NODE_REGISTRY_PRE_DISPATCH_SOURCE,
      ].join("\n"),
    );

    expect(patchedPlugin).toContain("const requestParams = override.params ?? params.params");
    expect(patchedPlugin).toContain("onDispatchPreparing: () =>");
    expect(patchedPlugin).toContain("params.onNodeCommandDispatchPreparing?.(requestParams)");
    expect(patchedRegistry.indexOf("params.isDispatchAuthorized?.()")).toBeLessThan(
      patchedRegistry.indexOf("params.onDispatchPreparing?.(params.params)"),
    );
    expect(patchedRegistry.indexOf("params.onDispatchPreparing?.(params.params)")).toBeLessThan(
      patchedRegistry.indexOf("invokeParams = normalizeSystemRunInvokeParams"),
    );
    expect(patchedRegistry.indexOf("invokeParams = normalizeSystemRunInvokeParams")).toBeLessThan(
      patchedRegistry.indexOf("payload = buildNodeInvokeRequest"),
    );
  });

  it("retains 10.5 turn source metadata across deferred registry serialization", () => {
    const patched = patchPinnedOpenClawNodeRegistryPrivate(
      [
        PINNED_NODE_REGISTRY_SERIALIZATION_10_5_SOURCE,
        PINNED_NODE_REGISTRY_PRE_DISPATCH_SOURCE,
      ].join("\n"),
    );
    expect(patched).toContain("params: invokeParams,\n\t\tturnSource");
    expect(patched.indexOf("params.onDispatchPreparing?.(params.params)")).toBeLessThan(
      patched.indexOf("systemRunEvent = resolvePendingSystemRunEvent"),
    );
  });

  describe("pinned OpenClaw node failure provenance and deduplication", () => {
    const source = [
      `//#region src/agents/bash-tools.exec-host-node-failure.ts\n${PINNED_BASH_TOOLS_FAILURE_CLASSIFIER_SOURCE}`,
      PINNED_BASH_TOOLS_PREPARED_SOURCE,
      PINNED_BASH_TOOLS_DISPATCH_FAILURE_SOURCE,
      PINNED_BASH_TOOLS_FOLLOWUP_FAILURE_SOURCE,
      PINNED_BASH_TOOLS_INVOKE_RESULT_SOURCE,
      PINNED_BASH_TOOLS_FINAL_DISPATCH_SOURCE,
      PINNED_BASH_TOOLS_POLICY_DENIED_GUIDANCE_SOURCE,
      PINNED_BASH_TOOLS_HOST_SELECTION_SOURCE,
    ].join("\n");

    it("classifies trusted pre-execution rejection without claiming an unknown outcome", () => {
      const patched = patchPinnedOpenClawBashTools(source);

      expect(
        classifyWindowsNodeMxcInvokeFailure({
          details: {
            nodeCommandDispatched: true,
            nodeError: {
              code: "approval-proof-stale",
              message: "launch authorization expired",
              details: { executionState: "rejectedBeforeExecution" },
            },
          },
        }),
      ).toMatchObject({ reason: "policy-denied", code: "approval-proof-stale" });
      expect(
        classifyWindowsNodeMxcInvokeFailure({
          details: {
            nodeCommandDispatched: true,
            nodeError: { code: "transport-failed", message: "connection dropped" },
          },
        }),
      ).toMatchObject({ reason: "outcome-unknown", code: "transport-failed" });
      expect(patched).toContain('nodeErrorDetails?.executionState === "rejectedBeforeExecution"');
      expect(patched).toContain(
        'payload.success === false && payload.executionState === "rejectedBeforeExecution"',
      );
      expect(patched).toContain('reason: "policy-denied"');
      expect(patched).toContain("Do not retry this command automatically.");
      expect(patched).toContain("Do not switch to gateway or sandbox execution.");
      expect(patched).toContain("MicroClaw MXC execution is locked to host=node.");
    });

    it("accepts wire rejections with omitted null exitCode without accepting executed commands", () => {
      const payload = {
        success: false,
        timedOut: false,
        error: "cwd-outside-approved-roots: denied",
        errorCode: "cwd-outside-approved-roots",
        executionState: "rejectedBeforeExecution",
      };
      const response = {
        ok: true,
        nodeId: "node",
        command: "system.run",
        payload,
        payloadJSON: JSON.stringify(payload),
      };

      expect(normalizeWindowsNodeSystemRunResponse(response)).toMatchObject({ payload });
      for (const exitCode of [0, 1, "0", false]) {
        const invalidPayload = { ...payload, exitCode };
        expect(
          normalizeWindowsNodeSystemRunResponse({
            ...response,
            payload: invalidPayload,
            payloadJSON: JSON.stringify(invalidPayload),
          }),
        ).toBeNull();
      }
    });

    it("accepts only exact validated direct or RPC-wrapped system.run results", () => {
      const patched = patchPinnedOpenClawBashTools(source);
      const completed = {
        success: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 12,
      };

      expect(
        normalizeWindowsNodeSystemRunResponse({
          ok: true,
          nodeId: "node",
          command: "system.run",
          payload: completed,
          payloadJSON: null,
        }),
      ).toEqual({
        raw: expect.objectContaining({ command: "system.run", payload: completed }),
        payload: completed,
      });
      expect(
        normalizeWindowsNodeSystemRunResponse({
          ok: true,
          nodeId: "node",
          command: "system.run",
          payload: completed,
          payloadJSON: JSON.stringify(completed),
        }),
      ).toEqual({
        raw: expect.objectContaining({ command: "system.run", payload: completed }),
        payload: completed,
      });
      expect(
        normalizeWindowsNodeSystemRunResponse({
          type: "res",
          id: "gateway-response",
          ok: true,
          payload: {
            ok: true,
            nodeId: "node",
            command: "system.run",
            payload: completed,
            payloadJSON: null,
          },
        }),
      ).toEqual({
        raw: expect.objectContaining({ command: "system.run", payload: completed }),
        payload: completed,
      });
      expect(
        normalizeWindowsNodeSystemRunResponse({
          ok: true,
          nodeId: "node",
          command: "system.run",
          payload: {
            success: false,
            exitCode: null,
            timedOut: false,
            error: "approval expired",
            errorCode: "approval-proof-stale",
            executionState: "rejectedBeforeExecution",
          },
          payloadJSON: null,
        }),
      ).toMatchObject({
        payload: {
          success: false,
          executionState: "rejectedBeforeExecution",
        },
      });
      expect(
        normalizeWindowsNodeSystemRunResponse({
          ok: true,
          command: "system.run",
          payload: { stdout: "", exitCode: 0, timedOut: false },
        }),
      ).toBeNull();
      expect(
        normalizeWindowsNodeSystemRunResponse({
          ok: false,
          command: "system.run",
          payload: completed,
        }),
      ).toBeNull();
      expect(
        normalizeWindowsNodeSystemRunResponse({
          ok: true,
          command: "system.run",
          payload: { payload: completed },
        }),
      ).toBeNull();
      expect(
        normalizeWindowsNodeSystemRunResponse({
          ok: true,
          command: "system.run",
          payload: { ...completed, success: true, exitCode: 7 },
        }),
      ).toBeNull();
      expect(
        normalizeWindowsNodeSystemRunResponse({
          ok: true,
          command: "system.run",
          payload: {
            ...completed,
            payload: {
              success: false,
              executionState: "rejectedBeforeExecution",
            },
          },
        }),
      ).toBeNull();
      expect(
        normalizeWindowsNodeSystemRunResponse({
          ok: true,
          command: "system.run",
          payload: completed,
          payloadJSON: "{",
        }),
      ).toBeNull();
      expect(
        normalizeWindowsNodeSystemRunResponse({
          ok: true,
          command: "system.run",
          payload: completed,
          payloadJSON: JSON.stringify({ ...completed, success: false }),
        }),
      ).toBeNull();
      expect(
        normalizeWindowsNodeSystemRunResponse({
          ok: true,
          command: "system.run.prepare",
          payload: completed,
        }),
      ).toBeNull();

      expect(patched).toContain("normalizeMicroclawNodeSystemRunResponse(raw)");
      expect(patched).toContain('response.command !== "system.run"');
      expect(
        describeWindowsNodeSystemRunResponseShape({
          ok: true,
          command: "system.run",
          proof: "must-not-appear",
          payload: {
            success: true,
            command: "must-not-appear",
          },
        }),
      ).toBe(
        "outer=command,ok,payload,proof outerPayload=command,success nestedPayload=null payloadJSON=undefined",
      );
      expect(patched).toContain("describeMicroclawNodeSystemRunResponseShape(raw)");
    });

    it("preserves OpenClaw's own Windows node shell transport", () => {
      const patched = patchPinnedOpenClawBashTools(
        source + "\n" + PINNED_BASH_TOOLS_WINDOWS_SHELL_SOURCE,
      );
      expect(patched).toContain(PINNED_BASH_TOOLS_WINDOWS_SHELL_SOURCE);
      expect(patched).not.toContain("buildMicroclawWindowsNodeShellCommand");
    });

    it("deduplicates an exact unresolved plan before approval and records both dispatch paths", () => {
      const patched = patchPinnedOpenClawBashTools(source);

      expect(patched).not.toContain("MICROCLAW_UNRESOLVED_NODE_RUN_TTL_MS");
      expect(patched).not.toContain("expiresAt: Date.now()");
      expect(patched).toContain("buildMicroclawUnresolvedNodeRunKey(target.nodeId, prepared.plan)");
      expect(patched.indexOf("findMicroclawUnresolvedNodeRun")).toBeLessThan(
        patched.indexOf("analyzeNodeApprovalRequirement"),
      );
      expect(patched.match(/recordMicroclawUnresolvedNodeRun/g)).toHaveLength(3);
      expect(patched).toContain("MicroClaw blocked a duplicate approval and execution request");
      expect(patched).toContain("microclawUnresolvedRunKey,");
    });

    it.each([
      PINNED_BASH_TOOLS_FAILURE_CLASSIFIER_SOURCE,
      PINNED_BASH_TOOLS_PREPARED_SOURCE,
      PINNED_BASH_TOOLS_DISPATCH_FAILURE_SOURCE,
      PINNED_BASH_TOOLS_FOLLOWUP_FAILURE_SOURCE,
      PINNED_BASH_TOOLS_INVOKE_RESULT_SOURCE,
      PINNED_BASH_TOOLS_FINAL_DISPATCH_SOURCE,
      PINNED_BASH_TOOLS_POLICY_DENIED_GUIDANCE_SOURCE,
      PINNED_BASH_TOOLS_HOST_SELECTION_SOURCE,
    ])("fails closed when a pinned bash-tools fragment drifts", (fragment) => {
      expect(() =>
        patchPinnedOpenClawBashTools(
          source.replace(fragment, `${fragment.slice(0, -1)}/* drift */`),
        ),
      ).toThrow(/did not match exactly once/);
    });
  });

  it.each([
    { decision: "allow-once", resolutionSource: "operator", consumed: true, allowed: true },
    { decision: "allow-once", resolutionSource: "operator", consumed: false, allowed: false },
    { decision: "allow-once", resolutionSource: "auto-review", consumed: true, allowed: false },
    { decision: "allow-always", resolutionSource: "operator", consumed: true, allowed: false },
  ])(
    "awaits one-use consumption before scheduling dispatch-time proof minting: %j",
    async (entry) => {
      const patched = patchPinnedOpenClawNodeGateway(source);
      const branch = patched.slice(
        patched.indexOf("\tconst approvalDecision ="),
        patched.indexOf("\tif (timedOut"),
      );
      const run = new Function(
        "snapshot",
        "recordedResolutionSource",
        "manager",
        `return (async () => {
        const approvalSource = null, next = {}, runId = "approval", targetNodeId = "node", nowMs = 2000;
        const runtimeContext = {plan: {}};
        const systemRunApprovalRequired = () => ({ok: false});
        const systemRunApprovalGuardError = () => ({ok: false});
        ${branch}
        return {ok: false};
      })();`,
      );
      const consumeAllowOnce = vi.fn().mockResolvedValue(entry.consumed);
      const result = await run(
        { decision: entry.decision, resolvedAtMs: 1000 },
        entry.resolutionSource,
        { consumeAllowOnce },
      );
      expect(result.ok).toBe(entry.allowed);
      expect(result.microclawApprovalProofRequest).toEqual(
        entry.allowed
          ? {
              approvalId: "approval",
              nodeId: "node",
              plan: {},
              decisionAtUnixMs: 1000,
            }
          : undefined,
      );
      expect(consumeAllowOnce).toHaveBeenCalledTimes(
        entry.decision === "allow-once" && entry.resolutionSource === "operator" ? 1 : 0,
      );
    },
  );

  describe("pinned OpenClaw prepared-plan identity backport", () => {
    it("preserves the exact MicroClaw executable, CWD, and declared-access identity", () => {
      const patched = patchPinnedOpenClawSystemRun(PINNED_SYSTEM_RUN_PLAN_SOURCE);

      expect(patched).toContain("normalizeMicroclawSystemRunDeclaredAccess");
      expect(patched).toContain("executablePath");
      expect(patched).toContain("executableSha256: executableSha256.toLowerCase()");
      expect(patched).toContain("cwdBinding");
      expect(patched).toContain("declaredAccess");
      expect(patched).toContain("policySnapshot");
      expect(patched).toContain("/^[a-f0-9]{64}$/i");
      expect(patched).not.toBe(PINNED_SYSTEM_RUN_PLAN_SOURCE);
    });

    describe("pinned OpenClaw approval schema projection", () => {
      it.each([
        "",
        "\n\t\t\tconst rejectRequest = (message) => respond(false, undefined, message);",
      ])(
        "validates the plan projection and retains upstream rejection helpers: %s",
        (rejectHelper) => {
          const patched = patchPinnedOpenClawExecApproval(
            `${PINNED_EXEC_APPROVAL_VALIDATION_SOURCE}${rejectHelper}\n\t\t\tconst p = params;\n\t\t\tif (requestRunId && context.chatRunState.hasAbortMarker(requestRunId)) {`,
          );

          expect(patched).toContain("const validationParams = rawPlan");
          expect(patched).toContain('name !== "executablePath"');
          expect(patched).toContain('name !== "executableSha256"');
          expect(patched).toContain('name !== "cwdBinding"');
          expect(patched).toContain('name !== "declaredAccess"');
          expect(patched).toContain('name !== "policyFingerprint"');
          expect(patched).toContain("const p = params");
          expect(patched).toContain(`${rejectHelper}\n\t\t\tconst p = params;`);
          expect(patched).toContain(
            'assertValidParams(validationParams, validateExecApprovalRequestParams, "exec.approval.request", respond)',
          );
        },
      );

      it("projects live policy identity out of the upstream schema without dropping the original binding", () => {
        const patched = patchPinnedOpenClawExecApproval(
          `${PINNED_EXEC_APPROVAL_VALIDATION_SOURCE}\n\t\t\tif (requestRunId && context.chatRunState.hasAbortMarker(requestRunId)) {`,
        );
        const project = new Function(
          "params",
          `${patched.slice(
            patched.indexOf("\t\t\tconst rawPlan"),
            patched.indexOf("\t\t\tif (!assertValidParams"),
          )}
          return validationParams;`,
        );
        const upstreamPlan = {
          argv: ["C:\\Windows\\System32\\hostname.exe"],
          cwd: null,
          commandText: "hostname",
          agentId: "main",
          sessionKey: "agent:main:main",
        };
        const params = {
          id: "live-policy-approval",
          systemRunPlan: {
            ...upstreamPlan,
            executablePath: upstreamPlan.argv[0],
            executableSha256: "a".repeat(64),
            cwdBinding: "isolated-scratch:v1",
            declaredAccess: [],
            policyFingerprint: "b".repeat(64),
          },
        };
        expect(project(params)).toEqual({ id: params.id, systemRunPlan: upstreamPlan });
        expect(params.systemRunPlan.policyFingerprint).toBe("b".repeat(64));
      });

      it("fails closed when the pinned approval handler drifts or appears twice", () => {
        expect(() => patchPinnedOpenClawExecApproval("unrecognized source")).toThrow(
          /did not match exactly once/,
        );
        expect(() =>
          patchPinnedOpenClawExecApproval(
            `${PINNED_EXEC_APPROVAL_VALIDATION_SOURCE}\n${PINNED_EXEC_APPROVAL_VALIDATION_SOURCE}`,
          ),
        ).toThrow(/did not match exactly once/);
      });
    });

    it("fails closed when the pinned plan normalizer drifts or appears twice", () => {
      expect(() => patchPinnedOpenClawSystemRun("unrecognized source")).toThrow(
        /did not match exactly once/,
      );
      expect(() =>
        patchPinnedOpenClawSystemRun(
          `${PINNED_SYSTEM_RUN_PLAN_SOURCE}\n${PINNED_SYSTEM_RUN_PLAN_SOURCE}`,
        ),
      ).toThrow(/did not match exactly once/);
    });
  });

  it.each([
    PINNED_NODE_GATEWAY_MINT_INSERT_SOURCE,
    PINNED_NODE_GATEWAY_APPROVAL_SOURCE,
    PINNED_NODE_GATEWAY_ASK_FALLBACK_SOURCE,
    PINNED_NODE_GATEWAY_PLUGIN_DISPATCH_SOURCE,
    PINNED_NODE_GATEWAY_DIRECT_DISPATCH_SOURCE,
  ])("fails closed when a pinned source fragment drifts", (fragment) => {
    expect(() =>
      patchPinnedOpenClawNodeGateway(
        source.replace(fragment, `${fragment.slice(0, -1)}/* drift */`),
      ),
    ).toThrow(/did not match exactly once/);
  });

  it("fails closed when a pinned source fragment appears more than once", () => {
    expect(() =>
      patchPinnedOpenClawNodeGateway(`${source}\n${PINNED_NODE_GATEWAY_APPROVAL_SOURCE}`),
    ).toThrow(/did not match exactly once/);
  });
});

describe("Windows Node MXC approval proof minter", () => {
  const secret = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("base64");
  const plan = {
    argv: ["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", "echo caf\u00e9"],
    cwd: "C:\\Users\\Test\\Work",
    commandText: "echo caf\u00e9",
    commandPreview: "[declare-access]rw:C:\\Users\\Test\\Work[/declare-access] echo caf\u00e9",
    agentId: "main",
    sessionKey: "agent:main:main",
    executablePath: "C:\\Windows\\System32\\cmd.exe",
    executableSha256: "c".repeat(64),
    cwdBinding: "C:\\Users\\Test\\Work",
    declaredAccess: [{ access: "rw", path: "C:\\Users\\Test\\Work" }],
  };

  it("matches the fixed cross-language proof vector", () => {
    const minter = createWindowsNodeMxcApprovalProofMinter(
      {
        secretBase64: secret,
        gatewayGeneration: "generation-test-001",
        policyFingerprint: "a".repeat(64),
        nodeId: "b".repeat(64),
      },
      {
        now: () => 1_735_689_600_000,
        randomUUID: () => "12345678-1234-4234-8234-123456789abc",
      },
    );

    expect(
      minter.mint({
        approvalId: "approval-001",
        nodeId: "B".repeat(64),
        plan,
      }),
    ).toEqual({
      contract: APPROVAL_PROOF_CONTRACT,
      approvalId: "approval-001",
      nonce: "12345678-1234-4234-8234-123456789abc",
      gatewayGeneration: "generation-test-001",
      policyFingerprint: "a".repeat(64),
      nodeId: "b".repeat(64),
      planSha256: "121d69569e93b8e70445e4d8815cf9d72fd68d5065fa11106c4f204f4c78b661",
      issuedAtUnixMs: 1_735_689_600_000,
      expiresAtUnixMs: 1_735_689_600_000 + APPROVAL_PROOF_TTL_MS,
      consentDecision: "allow-once",
      signature: "bd59c7a12592b8153fc2a991f24b078c5f5e832857bf1c231b9060bb236b236f",
    });
  });

  it("uses culture-invariant ordinal declaration ordering", () => {
    expect(
      computeWindowsNodeMxcApprovalPlanSha256({
        argv: ["cmd.exe"],
        cwd: "C:\\Work",
        commandText: "cmd.exe",
        commandPreview: null,
        agentId: "main",
        sessionKey: "agent:main:test",
        executablePath: "C:\\Windows\\System32\\cmd.exe",
        executableSha256: "c".repeat(64),
        cwdBinding: "C:\\Work",
        declaredAccess: [
          { access: "ro", path: "C:\\\u00e4" },
          { access: "rw", path: "C:\\z" },
        ],
      }),
    ).toBe("c2d61960908c9c4c8cd9792bb5e1096e0f1e3136ab0fc1994f853361b197eb93");
  });

  describe("approval preload process scope", () => {
    it("initializes only once in the Gateway main process", () => {
      const enabled = { MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT: "1" };
      expect(shouldInitializeApprovalPreload(enabled, true)).toBe(true);
      expect(
        shouldInitializeApprovalPreload(
          {
            ...enabled,
            MICROCLAW_MXC_APPROVAL_PRELOAD_INITIALIZED: "1",
          },
          false,
        ),
      ).toBe(false);
      expect(() => shouldInitializeApprovalPreload(enabled, false)).toThrow(/main thread/);
      expect(
        shouldInitializeApprovalPreload(
          { MICROCLAW_MXC_CRON_RESUME_FENCE_UNIX_MS: "1735689600000" },
          true,
        ),
      ).toBe(true);
      expect(shouldInitializeApprovalPreload({ MICROCLAW_MXC_CRON_PAUSED: "1" }, true)).toBe(false);
      expect(
        shouldInitializeApprovalPreload({ MICROCLAW_MXC_HOOKS_GATE_POLICY_BASE64: "e30=" }, true),
      ).toBe(false);
      expect(shouldInitializeApprovalPreload({ MICROCLAW_MXC_CANVAS_PHASE1: "1" }, true)).toBe(
        false,
      );
      expect(shouldInitializeApprovalPreload({}, true)).toBe(false);
    });
  });

  it("rejects malformed contexts, wrong nodes, and incomplete plans", () => {
    expect(() =>
      createWindowsNodeMxcApprovalProofMinter({
        secretBase64: Buffer.alloc(31).toString("base64"),
        gatewayGeneration: "generation",
        policyFingerprint: "a".repeat(64),
        nodeId: "b".repeat(64),
      }),
    ).toThrow(/256 bits/);

    const minter = createWindowsNodeMxcApprovalProofMinter({
      secretBase64: secret,
      gatewayGeneration: "generation",
      policyFingerprint: "a".repeat(64),
      nodeId: "b".repeat(64),
    });
    expect(() => minter.mint({ approvalId: "approval", nodeId: "c".repeat(64), plan })).toThrow(
      /node binding/,
    );
    expect(() =>
      minter.mint({
        approvalId: "approval",
        nodeId: "b".repeat(64),
        plan: { ...plan, sessionKey: null },
      }),
    ).toThrow(/sessionKey/);
  });

  it("mints a fresh nonce for each approved execution", () => {
    let nonce = 0;
    const minter = createWindowsNodeMxcApprovalProofMinter(
      {
        secretBase64: secret,
        gatewayGeneration: "generation",
        policyFingerprint: "a".repeat(64),
        nodeId: "b".repeat(64),
      },
      { randomUUID: () => `nonce-${++nonce}` },
    );

    const first = minter.mint({
      approvalId: "approval-1",
      nodeId: "b".repeat(64),
      plan,
    });
    const second = minter.mint({
      approvalId: "approval-2",
      nodeId: "b".repeat(64),
      plan,
    });

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.signature).not.toBe(second.signature);
  });

  it("starts the bounded proof lifetime at dispatch after a realistic decision delay", () => {
    const decisionAtUnixMs = 1_735_689_600_000;
    let nowUnixMs = decisionAtUnixMs + 50_000;
    const minter = createWindowsNodeMxcApprovalProofMinter(
      {
        secretBase64: secret,
        gatewayGeneration: "generation",
        policyFingerprint: "a".repeat(64),
        nodeId: "b".repeat(64),
      },
      {
        now: () => nowUnixMs,
        randomUUID: () => "12345678-1234-4234-8234-123456789abc",
      },
    );

    const proof = minter.mint({
      approvalId: "approval-delayed",
      nodeId: "b".repeat(64),
      plan,
      decisionAtUnixMs,
    });

    expect(proof.issuedAtUnixMs).toBe(nowUnixMs);
    expect(proof.expiresAtUnixMs).toBe(nowUnixMs + APPROVAL_PROOF_TTL_MS);
    nowUnixMs += APPROVAL_PROOF_TTL_MS - 1;
    expect(nowUnixMs).toBeLessThan(proof.expiresAtUnixMs);
  });
});
