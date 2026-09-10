import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The compatibility preload is intentionally external ESM for the Gateway child.
import * as replayCompat from "./openclaw-approval-replay-compat.mjs";

const {
  APPROVAL_PROOF_CONTRACT,
  APPROVAL_PROOF_TTL_MS,
  PINNED_EXEC_APPROVAL_VALIDATION_SOURCE,
  PINNED_NODE_GATEWAY_ALLOW_ALWAYS_SOURCE,
  PINNED_NODE_GATEWAY_ALLOW_ONCE_SOURCE,
  PINNED_NODE_GATEWAY_ASK_FALLBACK_SOURCE,
  PINNED_NODE_GATEWAY_MINT_INSERT_SOURCE,
  PINNED_SYSTEM_RUN_PLAN_SOURCE,
  createWindowsNodeMxcApprovalProofMinter,
  computeWindowsNodeMxcApprovalPlanSha256,
  patchPinnedOpenClawExecApproval,
  patchPinnedOpenClawNodeGateway,
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

  it.each(["2026.8.2", "2026.9.2", "2026.9.3-beta.1", "2026.9.4"])(
    "rejects an unpinned OpenClaw version: %s",
    (version) => {
      expect(() => validatePinnedOpenClawApprovalPackage(createPackage(version))).toThrow(
        /requires OpenClaw 2026\.9\.3/,
      );
    },
  );

  it("rejects modified 9.3 approval bundles", () => {
    const packageDir = createPackage("2026.9.3");
    writeFileSync(join(packageDir, "dist", "nodes-C8-hkmi0.mjs"), "// changed");
    expect(() => validatePinnedOpenClawApprovalPackage(packageDir)).toThrow(/hash mismatch/);
  });

  const publishedPackage = process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR;
  describe.skipIf(!publishedPackage)("official npm package integration", () => {
    it("validates all published hashes and patch points and parses the patched bundles", () => {
      const targets = validatePinnedOpenClawApprovalPackage(publishedPackage);
      expect(targets.map((target: { module: string }) => target.module)).toEqual([
        "nodes-C8-hkmi0.mjs",
        "system-run-approval-binding-DMkQH3tb.mjs",
        "exec-approval-B0MHHes6.mjs",
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
            patched.indexOf("next.microclawApprovalProof ="),
          );
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
  });
});

describe("pinned OpenClaw node approval proof backport", () => {
  const source = [
    PINNED_NODE_GATEWAY_MINT_INSERT_SOURCE,
    PINNED_NODE_GATEWAY_ALLOW_ONCE_SOURCE,
    PINNED_NODE_GATEWAY_ALLOW_ALWAYS_SOURCE,
    PINNED_NODE_GATEWAY_ASK_FALLBACK_SOURCE,
  ].join("\n");

  it("injects a proof only into approved replay branches", () => {
    const patched = patchPinnedOpenClawNodeGateway(source);

    expect(patched.match(/microclawApprovalProof =/g)).toHaveLength(1);
    expect(patched).toContain("manager.consumeAllowOnce(runId)");
    expect(patched).toContain(
      'if (snapshot.decision === "allow-always") {\n\t\treturn systemRunApprovalRequired(runId);',
    );
    expect(patched).toContain(
      'timedOut && approvalSource === "ask-fallback" && !approved && requestedDecision === null && clientHasApprovals(opts.client)) {\n\t\treturn systemRunApprovalRequired(runId);',
    );
    expect(patched).toContain('recordedResolutionSource !== "operator"');
    expect(patched).toContain("plan: runtimeContext.plan");
    expect(patched).toContain("nodeId: targetNodeId");
    expect(patched.indexOf("consumeAllowOnce(runId)")).toBeLessThan(
      patched.indexOf("microclawApprovalProof ="),
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
    PINNED_NODE_GATEWAY_ALLOW_ONCE_SOURCE,
    PINNED_NODE_GATEWAY_ALLOW_ALWAYS_SOURCE,
    PINNED_NODE_GATEWAY_ASK_FALLBACK_SOURCE,
  ])("fails closed when a pinned source fragment drifts", (fragment) => {
    expect(() =>
      patchPinnedOpenClawNodeGateway(
        source.replace(fragment, `${fragment.slice(0, -1)}/* drift */`),
      ),
    ).toThrow(/did not match exactly once/);
  });

  it("fails closed when a pinned source fragment appears more than once", () => {
    expect(() =>
      patchPinnedOpenClawNodeGateway(`${source}\n${PINNED_NODE_GATEWAY_ALLOW_ONCE_SOURCE}`),
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
      signature: "1167c6b0eeea3c385e252110d22bb87fa8e54f881a0f954d9f684289c1e48caa",
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
});
