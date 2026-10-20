import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WINDOWS_NODE_MXC_BLOCKED_CRON_METHODS } from "./windows-node-mxc-cron";
// @ts-expect-error The compatibility preload is intentionally external ESM for the Gateway child.
import * as replayCompat from "./openclaw-approval-replay-compat.mjs";

const {
  APPROVAL_PROOF_CONTRACT,
  APPROVAL_PROOF_TTL_MS,
  classifyWindowsNodeMxcInvokeFailure,
  resolveWindowsNodeSystemRunPayload,
  PINNED_WEB_FETCH_HTTP_ONLY_SOURCE,
  PINNED_BASH_TOOLS_DISPATCH_FAILURE_SOURCE,
  PINNED_BASH_TOOLS_FAILURE_CLASSIFIER_SOURCE,
  PINNED_BASH_TOOLS_FINAL_DISPATCH_SOURCE,
  PINNED_BASH_TOOLS_FOLLOWUP_FAILURE_SOURCE,
  PINNED_BASH_TOOLS_INVOKE_RESULT_SOURCE,
  PINNED_BASH_TOOLS_HOST_SELECTION_SOURCE,
  PINNED_BASH_TOOLS_POLICY_DENIED_GUIDANCE_SOURCE,
  PINNED_BASH_TOOLS_PREPARED_SOURCE,
  PINNED_EXEC_APPROVAL_VALIDATION_SOURCE,
  PINNED_CRON_STARTUP_MISSED_JOBS_SOURCE,
  PINNED_CRON_STARTUP_ACK_SOURCE,
  PINNED_CRON_HANDLER_MAP_SOURCE,
  PINNED_CRON_MUTATION_HANDLER_SOURCES,
  PINNED_EXTERNAL_HOOK_HANDLER_SOURCE,
  PINNED_INTERNAL_HOOK_TRIGGER_SOURCE,
  PINNED_NODE_GATEWAY_APPROVAL_SOURCE,
  PINNED_NODE_GATEWAY_ASK_FALLBACK_SOURCE,
  PINNED_NODE_GATEWAY_DIRECT_DISPATCH_SOURCE,
  PINNED_NODE_GATEWAY_MINT_INSERT_SOURCE,
  PINNED_NODE_GATEWAY_PLUGIN_DISPATCH_SOURCE,
  PINNED_NODE_INVOKE_PLUGIN_DISPATCH_SOURCE,
  PINNED_NODE_INVOKE_PLUGIN_REQUEST_SOURCE,
  PINNED_NODE_REGISTRY_PRE_DISPATCH_SOURCE,
  PINNED_NODE_REGISTRY_SERIALIZATION_SOURCE,
  PINNED_SYSTEM_RUN_PLAN_SOURCE,
  attestPinnedOpenClawWebFetchHttpOnly,
  createWindowsNodeMxcApprovalProofMinter,
  computeWindowsNodeMxcApprovalPlanSha256,
  createWindowsNodeMxcHooksGate,
  isWindowsNodeMxcProtectedHooksPath,
  patchPinnedOpenClawExecApproval,
  patchPinnedOpenClawBashTools,
  patchPinnedOpenClawCronService,
  patchPinnedOpenClawCronHandlers,
  patchPinnedOpenClawExternalHooks,
  patchPinnedOpenClawInternalHooks,
  patchPinnedOpenClawNodeGateway,
  patchPinnedOpenClawNodeInvokePluginPolicy,
  patchPinnedOpenClawNodeRegistryPrivate,
  patchPinnedOpenClawSystemRun,
  shouldInitializeApprovalPreload,
  validatePinnedOpenClawApprovalPackage,
} = replayCompat;

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

  it.each(["2026.8.2", "2026.9.3", "2026.10.1", "2026.10.2-beta.1", "2026.10.3"])(
    "rejects an unpinned OpenClaw version: %s",
    (version) => {
      expect(() => validatePinnedOpenClawApprovalPackage(createPackage(version))).toThrow(
        /requires OpenClaw 2026\.10\.2/,
      );
    },
  );

  it("rejects modified 10.2 approval bundles", () => {
    const packageDir = createPackage("2026.10.2");
    writeFileSync(join(packageDir, "dist", "nodes-CUbe_1MQ.mjs"), "// changed");
    expect(() => validatePinnedOpenClawApprovalPackage(packageDir)).toThrow(/hash mismatch/);
  });

  const publishedPackage = process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR;
  describe.skipIf(!publishedPackage)("official npm package integration", () => {
    it("validates all published hashes and patch points and parses the patched bundles", () => {
      const targets = validatePinnedOpenClawApprovalPackage(publishedPackage, {
        approval: true,
        cronPause: true,
        cronResume: true,
        hooksPause: true,
        canvasPhase1: true,
      });
      expect(targets.map((target: { module: string }) => target.module)).toEqual([
        "nodes-CUbe_1MQ.mjs",
        "node-invoke-plugin-policy-DLQRKKVA.mjs",
        "node-registry-private-CyaYRwVd.mjs",
        "system-run-approval-plan-Cu-Ftdkp.mjs",
        "exec-approval-mGU7M4-K.mjs",
        "bash-tools-Bl8Bd3CR.mjs",
        "openclaw-tools-Dxfbrtff.mjs",
        "service-31u04axN.mjs",
        "cron-D3Bd3ZFt.mjs",
        "server-start-DfGddYU-.mjs",
        "internal-hooks-DfVqU7ax.mjs",
        "extensions/canvas/index.js",
        "tool-CpRzQ0s7.mjs",
        "node-eligibility-UXb9xB0F.mjs",
      ]);
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
        if (target.module === "node-invoke-plugin-policy-DLQRKKVA.mjs") {
          expect(patched).toContain("const requestParams = override.params ?? params.params");
          expect(patched).toContain(
            "params.onNodeCommandDispatchPreparing?.(requestParams)",
          );
        }
        if (target.module === "node-registry-private-CyaYRwVd.mjs") {
          expect(patched.indexOf("params.isDispatchAuthorized?.()")).toBeLessThan(
            patched.indexOf("params.onDispatchPreparing?.(params.params)"),
          );
          expect(patched.indexOf("params.onDispatchPreparing?.(params.params)")).toBeLessThan(
            patched.indexOf("invokeParams = normalizeSystemRunInvokeParams"),
          );
          expect(patched.indexOf("invokeParams = normalizeSystemRunInvokeParams")).toBeLessThan(
            patched.indexOf("payload = buildNodeInvokeRequest"),
          );
        }
        if (target.module === "extensions/canvas/index.js") {
          expect(patched).toContain('"canvas.snapshot"');
          expect(patched).not.toContain('"canvas.navigate"');
          expect(patched).toContain('defaultPlatforms: ["windows"]');
        }
        if (target.module === "tool-CpRzQ0s7.mjs") {
          expect(patched).not.toContain('case "navigate"');
          expect(patched).not.toContain("presentTarget");
          expect(patched).toContain('case "a2ui_push"');
          expect(patched).toContain('"canvas.snapshot"');
        }
        if (target.module === "node-eligibility-UXb9xB0F.mjs") {
          expect(patched).toContain("/^windows(?:\\s|$)/i");
          expect(patched).not.toContain('"navigate"');
          expect(patched).toContain('"a2ui_push"');
          expect(patched).not.toContain("target: Type.Optional");
          expect(patched).not.toContain("url: Type.Optional");
        }
      }
    });

    it("initializes the real preload only after package validation", () => {
      const hook = pathToFileURL(resolve(__dirname, "openclaw-approval-replay-compat.mjs")).href;
      const initialized = spawnSync(
        process.execPath,
        [
          "--import",
          hook,
          "--input-type=module",
          "-e",
          `import assert from "node:assert/strict";
assert.equal(process.env.MICROCLAW_MXC_APPROVAL_PROOF_SECRET, undefined);
assert.equal(process.env.MICROCLAW_MXC_APPROVAL_PRELOAD_INITIALIZED, "1");
assert.equal(typeof globalThis[Symbol.for("microclaw.windows-node-mxc.approval-proof.v1")].mint, "function");`,
        ],
        {
          env: {
            ...process.env,
            MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT: "1",
            MICROCLAW_MXC_CANVAS_PHASE1: "1",
            MICROCLAW_MXC_APPROVAL_PRELOAD_INITIALIZED: "",
            MICROCLAW_OPENCLAW_PACKAGE_DIR: publishedPackage,
            MICROCLAW_MXC_APPROVAL_PROOF_SECRET: Buffer.alloc(32, 1).toString("base64"),
            MICROCLAW_MXC_APPROVAL_PROOF_GATEWAY_GENERATION: "test-generation",
            MICROCLAW_MXC_APPROVAL_PROOF_POLICY_FINGERPRINT: "a".repeat(64),
            MICROCLAW_MXC_APPROVAL_PROOF_NODE_ID: "b".repeat(64),
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(initialized.error).toBeUndefined();
      expect(initialized.status, initialized.stderr).toBe(0);
      expect(initialized.stdout).toContain("enabled one-use node proof");
    });

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

    describe("pinned OpenClaw Hooks pause contract", () => {
      it("rejects the configured external hook path before reading or dispatching the request", () => {
        const patched = patchPinnedOpenClawExternalHooks(PINNED_EXTERNAL_HOOK_HANDLER_SOURCE);
        expect(patched).toContain("microclawMxcHooksGate?.rejectExternal(req, res)");
        expect(patched.indexOf("rejectExternal(req, res)")).toBeLessThan(
          patched.indexOf("params.hooksConfig()"),
        );
      });

      it("drops internal hook events before listener lookup or handler execution", () => {
        const patched = patchPinnedOpenClawInternalHooks(PINNED_INTERNAL_HOOK_TRIGGER_SOURCE);
        expect(patched).toContain("microclawMxcHooksGate?.dropInternal(event)");
        expect(patched.indexOf("dropInternal(event)")).toBeLessThan(
          patched.indexOf("internalHooksEnabledState.enabled"),
        );
      });

      it("returns an explicit unavailable response only at the protected external path", () => {
        const gate = createWindowsNodeMxcHooksGate({
          contract: "microclaw.windows-node-mxc.hooks-gate.v1",
          gatewayGeneration: "generation",
          policyFingerprint: "a".repeat(64),
          requestedMode: "limited-dacl",
          externalRequested: true,
          internalRequested: true,
          basePath: "/hooks",
        });
        const headers: Record<string, string> = {};
        let body = "";
        const response = {
          statusCode: 200,
          setHeader(name: string, value: string) {
            headers[name] = value;
          },
          end(value: string) {
            body = value;
          },
        };

        expect(gate.rejectExternal({ url: "/health" }, response)).toBe(false);
        expect(gate.rejectExternal({ url: "/hooks/agent?token=secret" }, response)).toBe(true);
        expect(response.statusCode).toBe(503);
        expect(headers["Cache-Control"]).toBe("no-store");
        expect(JSON.parse(body)).toMatchObject({ ok: false, code: "MXC_HOOKS_PAUSED" });
        expect(body).not.toContain("secret");
        expect(gate.dropInternal({ type: "command:new" })).toBe(true);
      });

      it("rejects encoded protected paths without reading or admitting request content", () => {
        expect(isWindowsNodeMxcProtectedHooksPath("/%68ooks/agent", "/hooks")).toBe(true);
        expect(isWindowsNodeMxcProtectedHooksPath("/%2568ooks/agent", "/hooks")).toBe(true);
        expect(isWindowsNodeMxcProtectedHooksPath("/hooks%5Cagent", "/hooks")).toBe(true);
        expect(isWindowsNodeMxcProtectedHooksPath("/hooks/%E0", "/hooks")).toBe(true);
        expect(isWindowsNodeMxcProtectedHooksPath("/health/%68ooks", "/hooks")).toBe(false);

        const gate = createWindowsNodeMxcHooksGate({
          contract: "microclaw.windows-node-mxc.hooks-gate.v1",
          gatewayGeneration: "generation",
          policyFingerprint: "a".repeat(64),
          requestedMode: "full",
          externalRequested: true,
          internalRequested: true,
          basePath: "/hooks",
        });
        const request = {
          url: "/%68ooks/agent",
          get body() {
            throw new Error("request body must not be read");
          },
        };
        const response = {
          statusCode: 200,
          setHeader() {},
          end() {},
        };

        expect(gate.rejectExternal(request, response)).toBe(true);
        expect(response.statusCode).toBe(503);
      });

      it("returns explicit unavailability at the default hook path even when none was configured", () => {
        const gate = createWindowsNodeMxcHooksGate({
          contract: "microclaw.windows-node-mxc.hooks-gate.v1",
          gatewayGeneration: "generation",
          policyFingerprint: "a".repeat(64),
          requestedMode: "full",
          externalRequested: false,
          internalRequested: false,
          basePath: "/hooks",
        });
        const response = {
          statusCode: 200,
          setHeader() {},
          end() {},
        };

        expect(gate.rejectExternal({ url: "/hooks/wake" }, response)).toBe(true);
        expect(response.statusCode).toBe(503);
      });

      it("fails closed when either pinned hook boundary drifts", () => {
        expect(() => patchPinnedOpenClawExternalHooks("unrecognized source")).toThrow(
          /did not match exactly once/,
        );
        expect(() => patchPinnedOpenClawInternalHooks("unrecognized source")).toThrow(
          /did not match exactly once/,
        );
      });

      it("rejects ambiguous gate policy paths", () => {
        for (const basePath of ["/hooks/%68idden", "/hooks?token=x", "/a/../hooks"]) {
          expect(() =>
            createWindowsNodeMxcHooksGate({
              contract: "microclaw.windows-node-mxc.hooks-gate.v1",
              gatewayGeneration: "generation",
              policyFingerprint: "a".repeat(64),
              requestedMode: "limited-dacl",
              externalRequested: true,
              internalRequested: true,
              basePath,
            }),
          ).toThrow(/policy is invalid/);
        }
      });
    });

    it("blocks every Cron mutation and run-now handler while MXC is requested", () => {
      const patched = patchPinnedOpenClawCronHandlers(
        [PINNED_CRON_HANDLER_MAP_SOURCE, ...PINNED_CRON_MUTATION_HANDLER_SOURCES].join("\n"),
      );

      for (const handler of PINNED_CRON_MUTATION_HANDLER_SOURCES) {
        const method = handler.match(/"([^"]+)"/)?.[1];
        const respondExpression = method === "cron.run" ? "options.respond" : "respond";
        expect(patched).toContain(
          `rejectMicroclawMxcPausedCronMutation("${method}", ${respondExpression})`,
        );
      }
      expect(
        PINNED_CRON_MUTATION_HANDLER_SOURCES.map(
          (handler: string) => handler.match(/"([^"]+)"/)?.[1],
        ),
      ).toEqual(WINDOWS_NODE_MXC_BLOCKED_CRON_METHODS);
      expect(patched).toContain("MICROCLAW_MXC_CRON_PAUSED");
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

  it("attaches the proof to the final plugin params before registry serialization", () => {
    const patchedPlugin = patchPinnedOpenClawNodeInvokePluginPolicy(
      [
        PINNED_NODE_INVOKE_PLUGIN_REQUEST_SOURCE,
        PINNED_NODE_INVOKE_PLUGIN_DISPATCH_SOURCE,
      ].join("\n"),
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
    expect(patchedPlugin).toContain(
      "params.onNodeCommandDispatchPreparing?.(requestParams)",
    );
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
      expect(patched).toContain(
        'nodeErrorDetails?.executionState === "rejectedBeforeExecution"',
      );
      expect(patched).toContain(
        'payload.success === false && payload.executionState === "rejectedBeforeExecution"',
      );
      expect(patched).toContain('reason: "policy-denied"');
      expect(patched).toContain("Do not retry this command automatically.");
      expect(patched).toContain("Do not switch to gateway or sandbox execution.");
      expect(patched).toContain("MicroClaw MXC execution is locked to host=node.");
    });

    it("accepts only an exact validated system.run result envelope", () => {
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
        resolveWindowsNodeSystemRunPayload({
          ok: true,
          nodeId: "node",
          command: "system.run",
          payload: completed,
          payloadJSON: null,
        }),
      ).toEqual(completed);
      expect(
        resolveWindowsNodeSystemRunPayload({
          ok: true,
          nodeId: "node",
          command: "system.run",
          payload: completed,
          payloadJSON: JSON.stringify(completed),
        }),
      ).toEqual(completed);
      expect(
        resolveWindowsNodeSystemRunPayload({
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
        success: false,
        executionState: "rejectedBeforeExecution",
      });
      expect(
        resolveWindowsNodeSystemRunPayload({
          ok: true,
          command: "system.run",
          payload: { stdout: "", exitCode: 0, timedOut: false },
        }),
      ).toBeNull();
      expect(
        resolveWindowsNodeSystemRunPayload({
          ok: false,
          command: "system.run",
          payload: completed,
        }),
      ).toBeNull();
      expect(
        resolveWindowsNodeSystemRunPayload({
          ok: true,
          command: "system.run",
          payload: { payload: completed },
        }),
      ).toBeNull();
      expect(
        resolveWindowsNodeSystemRunPayload({
          ok: true,
          command: "system.run",
          payload: { ...completed, success: true, exitCode: 7 },
        }),
      ).toBeNull();
      expect(
        resolveWindowsNodeSystemRunPayload({
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
        resolveWindowsNodeSystemRunPayload({
          ok: true,
          command: "system.run",
          payload: completed,
          payloadJSON: "{",
        }),
      ).toBeNull();
      expect(
        resolveWindowsNodeSystemRunPayload({
          ok: true,
          command: "system.run",
          payload: completed,
          payloadJSON: JSON.stringify({ ...completed, success: false }),
        }),
      ).toBeNull();
      expect(
        resolveWindowsNodeSystemRunPayload({
          ok: true,
          command: "system.run.prepare",
          payload: completed,
        }),
      ).toBeNull();

      expect(patched).toContain("resolveMicroclawNodeSystemRunPayload(raw)");
      expect(patched).toContain('response.command !== "system.run"');
    });

    it("deduplicates an exact unresolved plan before approval and records both dispatch paths", () => {
      const patched = patchPinnedOpenClawBashTools(source);

      expect(patched).not.toContain("MICROCLAW_UNRESOLVED_NODE_RUN_TTL_MS");
      expect(patched).not.toContain("expiresAt: Date.now()");
      expect(patched).toContain(
        "buildMicroclawUnresolvedNodeRunKey(target.nodeId, prepared.plan)",
      );
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
  ])("awaits one-use consumption before scheduling dispatch-time proof minting: %j", async (entry) => {
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
  });

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
      it("validates the standard plan projection while retaining the original bound plan", () => {
        const patched = patchPinnedOpenClawExecApproval(PINNED_EXEC_APPROVAL_VALIDATION_SOURCE);

        expect(patched).toContain("const validationParams = rawPlan");
        expect(patched).toContain('name !== "executablePath"');
        expect(patched).toContain('name !== "executableSha256"');
        expect(patched).toContain('name !== "cwdBinding"');
        expect(patched).toContain('name !== "declaredAccess"');
        expect(patched).toContain("const p = params");
        expect(patched).toContain(
          'assertValidParams(validationParams, validateExecApprovalRequestParams, "exec.approval.request", respond)',
        );
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
    argv: ["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", "echo café"],
    cwd: "C:\\Users\\Test\\Work",
    commandText: "echo café",
    commandPreview: "[declare-access]rw:C:\\Users\\Test\\Work[/declare-access] echo café",
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
      signature: "be550cd55e9ba5040270c80bcefc88179813a0cd8e18c393545fa6155c43f296",
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
          { access: "ro", path: "C:\\ä" },
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
      expect(shouldInitializeApprovalPreload({ MICROCLAW_MXC_CRON_PAUSED: "1" }, true)).toBe(true);
      expect(
        shouldInitializeApprovalPreload({ MICROCLAW_MXC_HOOKS_GATE_POLICY_BASE64: "e30=" }, true),
      ).toBe(true);
      expect(shouldInitializeApprovalPreload({ MICROCLAW_MXC_CANVAS_PHASE1: "1" }, true)).toBe(
        true,
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
