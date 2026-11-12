import { spawnSync } from "node:child_process";
import { mkdtempSync, promises as fsPromises, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BUNDLED_WINDOWS_NODE_CWD_CONTRACT,
  BUNDLED_WINDOWS_NODE_APPROVAL_PROOF_CONTRACT,
  BUNDLED_WINDOWS_NODE_RUNTIME_CONTRACT,
  BUNDLED_WINDOWS_NODE_REVISION,
  BundledWindowsNodeHost,
  type BundledWindowsNodeApprovalProofContext,
  type BundledWindowsNodeGateway,
  assertApprovalResponseMatches,
  assertLoopbackGateway,
  approveBundledDevicePairRequest,
  createBundledWindowsNodeEnvironment,
  endBundledWindowsNodeBootstrap,
  classifyBundledHostDiagnostic,
  findBundledDevicePairRequest,
  findBundledNodePairRequest,
  inspectBundledNodeList,
  waitForBundledNodeReconnect,
  replaceFileWithRetry,
  revokeActivationLeaseFile,
  sanitizeBundledHostDiagnostic,
  terminateBundledWindowsNodeProcessTree,
  validateApprovalRequest,
  validateBundledWindowsNodeRuntimeManifest,
} from "./bundled-windows-node-host";
import { WINDOWS_NODE_MXC_NODE_COMMANDS } from "./windows-node-mxc";
import { createPowerShellFilesystemInitialization } from "./windows-node-mxc-powershell-scope";
import { WindowsNodeMxcPolicyAuthority } from "./windows-node-mxc-live-policy";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => String.raw`C:\Users\Alice\AppData\Roaming\MicroClaw`,
  },
}));

const leaseProofContext: BundledWindowsNodeApprovalProofContext = {
  contract: BUNDLED_WINDOWS_NODE_APPROVAL_PROOF_CONTRACT,
  secretBase64: Buffer.alloc(32, 9).toString("base64"),
  gatewayGeneration: "lease-test-generation",
  policyFingerprint: "b".repeat(64),
  nodeId: "a".repeat(64),
  readinessTransitionId: "12345678-1234-4234-8234-123456789abc",
};
const runtimeManifest = {
  architecture: "x64",
  runtimeIdentifier: "win-x64",
  mxcVersion: "1.0.1",
  mxcManagedSha256: "59761d9a868cde01ef05139775ad6d072f9425b5b73b911bdf465b29b4bf20a6",
  mxcNativeSha256: {
    "mxc_ffi.dll": "bd45522f06dc9cc8001dcd5d7320bc2bf303fb08a39bf10f3404bd9a8001812c",
    "plm.exe": "beffc9c9ab974ca9e7455089fd8ecb36eb8c92811ddd1705db91370a689692c3",
    "wslcsdk.dll": "8d4d55d4283fb32a5909b57e78b576d01363d7b28bb9b2595115e80faf61db5b",
    "wxc-wslc-daemon.exe": "84f61c1bc13abde8da1c3f2ff100e6d59368ecaabdbfeca939e6fdb696202d0c",
  },
  windowsNodeRevision: BUNDLED_WINDOWS_NODE_REVISION,
  hostSha256: "0".repeat(64),
  contract: BUNDLED_WINDOWS_NODE_RUNTIME_CONTRACT,
};

describe("bundled Windows node host", () => {
  it.each([true, false])(
    "updates a live policy only after the exact node acknowledgement: %s",
    async (acknowledged) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "microclaw-live-folder-"));
      try {
        const host = createLeaseHost(root);
        const process = Reflect.get(host, "process");
        const authority = new WindowsNodeMxcPolicyAuthority(leaseProofContext.gatewayGeneration);
        const policyPath = path.join(root, "live-policy.json");
        const options = {
          approvalProof: leaseProofContext,
          gatewayGeneration: leaseProofContext.gatewayGeneration,
        };
        Object.assign(host, {
          startOptions: options,
          livePolicyAuthority: authority,
          livePolicyPath: policyPath,
          livePolicyBaseJson:
            '{"approvedRoots":[],"strictNoHostFallback":true,"commandConsentMode":"ask-when-needed"}',
        });
        const stop = vi.spyOn(host, "stop");
        const request = vi.fn(async () => {
          const envelope = JSON.parse(readFileSync(policyPath, "utf8"));
          const policy = JSON.parse(envelope.payload);
          expect(JSON.parse(policy.policyJson)).toMatchObject({
            strictNoHostFallback: true,
            approvedRoots: expect.arrayContaining([{ path: "C:\\Work", access: "ReadWrite" }]),
            commandConsentMode: "ask-when-needed",
            livePolicyEpoch: expect.stringMatching(
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            ),
          });
          return {
            ok: true,
            payload: {
              revision: acknowledged ? policy.revision : 0,
              policyFingerprint: policy.policyFingerprint,
            },
          };
        });
        const operation = host.applyLiveFolderPolicy({ request } as BundledWindowsNodeGateway, [
          { path: "C:\\Work", access: "rw" },
        ]);
        if (acknowledged) {
          const proof = await operation;
          expect(proof.policyFingerprint).not.toBe(leaseProofContext.policyFingerprint);
          expect(Reflect.get(host, "startOptions").approvalProof).toBe(proof);
        } else {
          await expect(operation).rejects.toThrow(/acknowledge/);
          expect(Reflect.get(host, "startOptions")).toBe(options);
        }
        expect(request).toHaveBeenCalledTimes(1);
        expect(request.mock.calls[0]).toMatchObject([
          "node.invoke",
          { command: "system.run.cwd-policy" },
        ]);
        expect(stop).not.toHaveBeenCalled();
        expect(Reflect.get(host, "process")).toBe(process);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it("preserves live consent and folder changes with a fresh epoch", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "microclaw-live-consent-"));
    try {
      const host = createLeaseHost(root);
      const process = Reflect.get(host, "process");
      const authority = new WindowsNodeMxcPolicyAuthority(leaseProofContext.gatewayGeneration);
      const policyPath = path.join(root, "live-policy.json");
      Object.assign(host, {
        startOptions: {
          approvalProof: leaseProofContext,
          gatewayGeneration: leaseProofContext.gatewayGeneration,
        },
        livePolicyAuthority: authority,
        livePolicyPath: policyPath,
        livePolicyBaseJson:
          '{"approvedRoots":[],"strictNoHostFallback":true,"commandConsentMode":"ask-when-needed"}',
      });
      const revisions: Array<{
        policyFingerprint: string;
        approval: unknown;
        policyJson: string;
      }> = [];
      const request = vi.fn(async () => {
        const envelope = JSON.parse(readFileSync(policyPath, "utf8"));
        const policy = JSON.parse(envelope.payload);
        revisions.push(policy);
        return {
          ok: true,
          payload: { revision: policy.revision, policyFingerprint: policy.policyFingerprint },
        };
      });
      const gateway = { request } as BundledWindowsNodeGateway;
      const stop = vi.spyOn(host, "stop");
      await host.applyLiveCommandConsentPolicy(gateway, "allow-always");
      await host.applyLiveFolderPolicy(gateway, [{ path: "C:\\Work", access: "rw" }]);
      await host.applyLiveCommandConsentPolicy(gateway, "ask-when-needed");
      const policies = revisions.map((revision) => JSON.parse(revision.policyJson));
      expect(policies.map((policy) => policy.commandConsentMode)).toEqual([
        "allow-always",
        "allow-always",
        "ask-when-needed",
      ]);
      expect(policies[2].approvedRoots).toEqual(policies[1].approvedRoots);
      expect(policies[2].approvedRoots).toContainEqual({ path: "C:\\Work", access: "ReadWrite" });
      expect(policies.every((policy) => !("canvas" in policy))).toBe(true);
      expect(new Set(policies.map((policy) => policy.livePolicyEpoch)).size).toBe(3);
      expect(new Set(revisions.map((revision) => revision.policyFingerprint)).size).toBe(3);
      expect(revisions.map((revision) => revision.approval)).toEqual([null, null, null]);
      expect(Reflect.get(host, "startOptions").commandConsentMode).toBe("ask-when-needed");
      expect(Reflect.get(host, "process")).toBe(process);
      expect(stop).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("ends bootstrap stdin and binds host lifetime to the Electron owner", () => {
    const end = vi.fn();

    endBundledWindowsNodeBootstrap({ end }, { gatewayUrl: "ws://127.0.0.1:18789" }, 4242);

    expect(end).toHaveBeenCalledTimes(1);
    expect(JSON.parse(end.mock.calls[0][0])).toEqual({
      gatewayUrl: "ws://127.0.0.1:18789",
      ownerProcessId: 4242,
    });
  });

  it("uses the exact CWD policy contract", () => {
    expect(BUNDLED_WINDOWS_NODE_CWD_CONTRACT).toBe("microclaw.windows-cwd.v1");
  });

  it("attests the bundled MXC SDK and Windows node provenance", () => {
    expect(() => validateBundledWindowsNodeRuntimeManifest(runtimeManifest, "x64")).not.toThrow();
  });

  it.each([
    ["version", { mxcVersion: "1.0.0" }],
    ["Windows node revision", { windowsNodeRevision: "0".repeat(40) }],
    ["managed SDK hash", { mxcManagedSha256: "0".repeat(64) }],
    ["native SDK hashes", { mxcNativeSha256: {} }],
    ["host hash", { hostSha256: "invalid" }],
  ])("rejects an MXC runtime manifest with a mismatched %s", (_label, override) => {
    expect(() =>
      validateBundledWindowsNodeRuntimeManifest({ ...runtimeManifest, ...override }, "x64"),
    ).toThrow("runtime manifest does not match");
  });

  it("terminates the exact bundled node process tree and verifies exit", () => {
    const run = vi.fn();
    const alive = vi.fn().mockReturnValue(false);
    const listTree = vi.fn().mockReturnValue([1234, 2001, 2002]);

    terminateBundledWindowsNodeProcessTree(1234, run as never, alive, listTree);

    if (process.platform === "win32") {
      expect(run).toHaveBeenCalledWith(
        "taskkill",
        ["/pid", "1234", "/T", "/F"],
        expect.objectContaining({ windowsHide: true }),
      );
    }
    expect(alive).toHaveBeenCalledWith(2001);
    expect(alive).toHaveBeenCalledWith(2002);
  });

  it("fails closed when the bundled node process tree remains alive", () => {
    expect(() =>
      terminateBundledWindowsNodeProcessTree(
        1234,
        vi.fn() as never,
        (pid) => pid === 2001,
        () => [1234, 2001],
      ),
    ).toThrow(/live processes: 2001/);
  });

  it("terminates descendants discovered after the root kill", () => {
    const alive = new Set([1234, 2001]);
    const run = vi.fn((_file: string, args: readonly string[]) => {
      alive.delete(Number(args[1]));
      return Buffer.alloc(0);
    });
    const listTree = vi
      .fn<(rootPids: readonly number[]) => number[]>()
      .mockReturnValueOnce([1234])
      .mockReturnValue([1234, 2001]);

    terminateBundledWindowsNodeProcessTree(1234, run as never, (pid) => alive.has(pid), listTree);

    expect(run).toHaveBeenCalledWith("taskkill", ["/pid", "2001", "/T", "/F"], expect.any(Object));
    expect(alive.size).toBe(0);
  });

  it("terminates descendants even when the root host already exited", () => {
    const alive = new Set([2001]);
    const run = vi.fn((_file: string, args: readonly string[]) => {
      alive.delete(Number(args[1]));
      return Buffer.alloc(0);
    });

    terminateBundledWindowsNodeProcessTree(
      1234,
      run as never,
      (pid) => alive.has(pid),
      () => [1234, 2001],
    );

    expect(run).toHaveBeenCalledWith("taskkill", ["/pid", "2001", "/T", "/F"], expect.any(Object));
    expect(alive.size).toBe(0);
  });

  it("creates a fresh 256-bit proof context bound to policy and node identity", () => {
    const host = createPolicyHost();
    const folders = [
      { path: String.raw`C:\Users\Alice\Documents`, access: "ro" as const },
      { path: String.raw`C:\Users\Alice\Desktop`, access: "rw" as const },
    ];
    const first = host.createApprovalProofContext(
      "generation-1",
      "a".repeat(64),
      folders,
      "12345678-1234-4234-8234-123456789abc",
    );
    const second = host.createApprovalProofContext(
      "generation-1",
      "a".repeat(64),
      folders,
      "12345678-1234-4234-8234-123456789abc",
    );

    expect(Buffer.from(first.secretBase64, "base64")).toHaveLength(32);
    expect(first.gatewayGeneration).toBe("generation-1");
    expect(first.nodeId).toBe("a".repeat(64));
    expect(first.policyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.readinessTransitionId).toBe("12345678-1234-4234-8234-123456789abc");
    expect(first.secretBase64).not.toBe(second.secretBase64);
    expect(first.policyFingerprint).toBe(second.policyFingerprint);
  });

  it("preserves lease authority across signed expiry renewals without changing the native lease contract", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "microclaw-lease-authority-"));
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const host = createLeaseHost(root);
      expect(host.getActivationLeaseBindingHash(leaseProofContext)).toBeNull();
      await host.setActivationLease("active", 120_000);
      const first = host.getActivationLeaseBindingHash(leaseProofContext);
      const firstFile = JSON.parse(readFileSync(path.join(root, "lease.json"), "utf8"));
      now.mockReturnValue(1_035_000);
      await host.setActivationLease("active", 120_000);
      const secondFile = JSON.parse(readFileSync(path.join(root, "lease.json"), "utf8"));
      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(host.getActivationLeaseBindingHash(leaseProofContext)).toBe(first);
      expect(secondFile.expiresAtUnixMs - firstFile.expiresAtUnixMs).toBe(35_000);
      expect(secondFile.signature).not.toBe(firstFile.signature);
      expect(Object.keys(secondFile)).toEqual([
        "contract",
        "mode",
        "gatewayGeneration",
        "policyFingerprint",
        "expiresAtUnixMs",
        "signature",
      ]);
      for (const field of ["contract", "mode", "gatewayGeneration", "policyFingerprint"])
        expect(secondFile[field]).toBe(firstFile[field]);
      expect(JSON.stringify(secondFile)).not.toContain(first);
    } finally {
      now.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["revocation", "mode roundtrip", "host key", "policy", "generation"])(
    "changes the lease authority for %s even when a current active lease is reissued",
    async (change) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "microclaw-lease-replacement-"));
      try {
        const host = createLeaseHost(root);
        await host.setActivationLease("active", 120_000);
        const first = host.getActivationLeaseBindingHash(leaseProofContext);
        if (change === "revocation") {
          host.revokeActivationLease();
          expect(host.getActivationLeaseBindingHash(leaseProofContext)).toBeNull();
        }
        if (change === "mode roundtrip") {
          await host.setActivationLease("diagnostic", 120_000);
          expect(host.getActivationLeaseBindingHash(leaseProofContext)).toBeNull();
        }
        if (change === "host key")
          Object.assign(host, { activationLeaseSecret: Buffer.alloc(32, 8) });
        if (change === "policy") Object.assign(host, { policyFingerprint: "d".repeat(64) });
        if (change === "generation") Object.assign(host, { gatewayGeneration: "replacement" });
        await host.setActivationLease("active", 120_000);
        expect(host.getActivationLeaseBindingHash(leaseProofContext)).toMatch(/^[a-f0-9]{64}$/);
        expect(host.getActivationLeaseBindingHash(leaseProofContext)).not.toBe(first);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("does not return a binding for expired authority, a dead host or a missing lease key", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "microclaw-lease-expiry-"));
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const host = createLeaseHost(root);
      await host.setActivationLease("active", 5_000);
      expect(host.getActivationLeaseBindingHash(leaseProofContext)).not.toBeNull();
      now.mockReturnValue(1_005_000);
      expect(host.getActivationLeaseBindingHash(leaseProofContext)).toBeNull();
      now.mockReturnValue(1_000_000);
      Object.assign(host, { process: { exitCode: 0 } });
      expect(host.getActivationLeaseBindingHash(leaseProofContext)).toBeNull();
      Object.assign(host, { process: { exitCode: null }, activationLeaseSecret: null });
      expect(host.getActivationLeaseBindingHash(leaseProofContext)).toBeNull();
    } finally {
      now.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not revive a pending authority when renewal commits after the previous lease expired", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "microclaw-lease-gap-"));
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const host = createLeaseHost(root);
      await host.setActivationLease("active", 5_000);
      const first = host.getActivationLeaseBindingHash(leaseProofContext);
      now.mockReturnValue(1_005_001);
      await host.setActivationLease("active", 120_000);
      expect(host.getActivationLeaseBindingHash(leaseProofContext)).toMatch(/^[a-f0-9]{64}$/);
      expect(host.getActivationLeaseBindingHash(leaseProofContext)).not.toBe(first);
    } finally {
      now.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  function createLeaseHost(root: string): BundledWindowsNodeHost {
    return Object.assign(createPolicyHost(), {
      process: { exitCode: null },
      activationLeaseSecret: Buffer.alloc(32, 7),
      activationLeasePath: path.join(root, "lease.json"),
      activationLease: null,
      activationLeaseEpoch: 0,
      activationLeaseAuthorityRevision: 0,
      activationLeaseWriteQueue: Promise.resolve(),
      startOptions: { approvalProof: leaseProofContext },
      ensureIdentityNodeId: () => leaseProofContext.nodeId,
      gatewayGeneration: "lease-test-generation",
      policyFingerprint: "b".repeat(64),
    });
  }

  it("requires the exact Main-owned proof context without exposing binding or key in status", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "microclaw-lease-context-"));
    try {
      const host = createLeaseHost(root);
      await host.setActivationLease("active", 120_000);
      expect(host.getActivationLeaseBindingHash(leaseProofContext)).not.toBeNull();
      expect(host.getActivationLeaseBindingHash({ ...leaseProofContext })).toBeNull();
      expect(
        host.getActivationLeaseBindingHash({
          ...leaseProofContext,
          readinessTransitionId: "22345678-1234-4234-8234-123456789abc",
        }),
      ).toBeNull();
      const status = JSON.stringify(host.status());
      expect(status).not.toContain("activationLeaseAuthorityRevision");
      expect(status).not.toContain(host.getActivationLeaseBindingHash(leaseProofContext));
      expect(status).not.toContain(Buffer.alloc(32, 7).toString("base64"));
      expect(status).not.toContain(leaseProofContext.secretBase64);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes two in-flight mode writes and attests only committed authority", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "microclaw-lease-queue-"));
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const gates = [leaseWriteGate(), leaseWriteGate()];
    let writeSpy: ReturnType<typeof vi.spyOn> | undefined;
    let settled: Promise<unknown> | undefined;
    try {
      const host = createLeaseHost(root);
      await host.setActivationLease("active", 120_000);
      const original = readFileSync(path.join(root, "lease.json"), "utf8");
      const first = host.getActivationLeaseBindingHash(leaseProofContext);
      const entered: string[] = [];
      const write = fsPromises.writeFile.bind(fsPromises);
      writeSpy = vi.spyOn(fsPromises, "writeFile").mockImplementation(async (...args) => {
        const index = entered.length;
        entered.push(JSON.parse(String(args[1])).mode);
        await gates[index].promise;
        return write(...args);
      });
      const diagnostic = host.setActivationLease("diagnostic", 120_000);
      const active = host.setActivationLease("active", 120_000);
      settled = Promise.allSettled([diagnostic, active]);
      gates[1].resolve();
      await vi.waitFor(() => expect(entered).toEqual(["diagnostic"]));
      expect(host.getActivationLeaseBindingHash(leaseProofContext)).toBe(first);
      expect(readFileSync(path.join(root, "lease.json"), "utf8")).toBe(original);
      gates[0].resolve();
      await diagnostic;
      expect(host.getActivationLeaseBindingHash(leaseProofContext)).toBeNull();
      await active;
      expect(entered).toEqual(["diagnostic", "active"]);
      expect(host.getActivationLeaseBindingHash(leaseProofContext)).not.toBe(first);
      expect(readFileSync(path.join(root, "lease.json"), "utf8")).toBe(original);
    } finally {
      gates.forEach((gate) => gate.resolve());
      await settled;
      writeSpy?.mockRestore();
      now.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not attest a failed renewal as extending an expired lease", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "microclaw-lease-failed-renewal-"));
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    let writeSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const host = createLeaseHost(root);
      await host.setActivationLease("active", 5_000);
      const first = host.getActivationLeaseBindingHash(leaseProofContext);
      const original = readFileSync(path.join(root, "lease.json"), "utf8");
      now.mockReturnValue(1_004_000);
      writeSpy = vi
        .spyOn(fsPromises, "writeFile")
        .mockRejectedValueOnce(new Error("isolated write failure"));
      await expect(host.setActivationLease("active", 120_000)).rejects.toThrow(
        "isolated write failure",
      );
      expect(host.getActivationLeaseBindingHash(leaseProofContext)).toBe(first);
      expect(readFileSync(path.join(root, "lease.json"), "utf8")).toBe(original);
      now.mockReturnValue(1_005_001);
      expect(host.getActivationLeaseBindingHash(leaseProofContext)).toBeNull();
      expect(host.status().activationLease).toBeNull();
    } finally {
      writeSpy?.mockRestore();
      now.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fences both queued lease writes when authority is revoked before commit", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "microclaw-lease-queue-revoke-"));
    const gate = leaseWriteGate();
    let writeSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const host = createLeaseHost(root);
      await host.setActivationLease("active", 120_000);
      const write = fsPromises.writeFile.bind(fsPromises);
      writeSpy = vi.spyOn(fsPromises, "writeFile").mockImplementationOnce(async (...args) => {
        await gate.promise;
        return write(...args);
      });
      const results = Promise.allSettled([
        host.setActivationLease("diagnostic", 120_000),
        host.setActivationLease("active", 120_000),
      ]);
      await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
      host.revokeActivationLease();
      gate.resolve();
      expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(host.getActivationLeaseBindingHash(leaseProofContext)).toBeNull();
      await expect(fsPromises.stat(path.join(root, "lease.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      gate.resolve();
      writeSpy?.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  function leaseWriteGate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, resolve: () => release() };
  }

  it("binds mode and consent into policy identity and rejects retired DACL evidence", () => {
    const host = createPolicyHost();
    const folders = [{ path: String.raw`C:\Approved`, access: "rw" as const }];
    const args = [
      "generation-1",
      "a".repeat(64),
      folders,
      "12345678-1234-4234-8234-123456789abc",
    ] as const;
    const full = host.createApprovalProofContext(...args, "full", "base-container", null);
    const withConsent = host.createApprovalProofContext(
      ...args,
      "full",
      "base-container",
      null,
      "allow-always",
    );
    expect(full.policyFingerprint).not.toBe(withConsent.policyFingerprint);
    const targets = [
      ["desktop", String.raw`C:\Users\Alice\Desktop`],
      ["documents", String.raw`C:\Users\Alice\Documents`],
      ["downloads", String.raw`C:\Users\Alice\Downloads`],
      ["microclaw-state", String.raw`C:\Users\Alice\AppData\Roaming\MicroClaw`],
      ["openclaw-state", String.raw`C:\OpenClaw`],
      ["openclaw-roaming-state", String.raw`C:\Users\Alice\AppData\Roaming\openclaw`],
      ["ssh", String.raw`C:\Users\Alice\.ssh`],
      ["gnupg", String.raw`C:\Users\Alice\.gnupg`],
      ["aws", String.raw`C:\Users\Alice\.aws`],
      ["azure", String.raw`C:\Users\Alice\.azure`],
      ["kube", String.raw`C:\Users\Alice\.kube`],
      ["gcloud", String.raw`C:\Users\Alice\.config\gcloud`],
      ["windows-credentials", String.raw`C:\Users\Alice\AppData\Roaming\Microsoft\Credentials`],
      [
        "powershell-history",
        String.raw`C:\Users\Alice\AppData\Roaming\Microsoft\Windows\PowerShell\PSReadLine`,
      ],
      ["browser-chrome", String.raw`C:\Users\Alice\AppData\Local\Google\Chrome\User Data`],
      ["browser-edge", String.raw`C:\Users\Alice\AppData\Local\Microsoft\Edge\User Data`],
      [
        "browser-brave",
        String.raw`C:\Users\Alice\AppData\Local\BraveSoftware\Brave-Browser\User Data`,
      ],
      ["browser-firefox", String.raw`C:\Users\Alice\AppData\Roaming\Mozilla\Firefox\Profiles`],
    ] as const;
    const ambient = {
      contract: "microclaw.windows-node-mxc-ambient-access.v1" as const,
      hash: "b".repeat(64),
      checkedAt: "2026-10-09T00:00:00.000Z",
      entries: targets.map(([category]) => ({
        category,
        status: category === "downloads" ? ("read-write" as const) : ("denied" as const),
      })),
      targets: targets.map(([category, path]) => ({ category, path })),
    };
    expect(() =>
      host.createApprovalProofContext(...args, "limited-dacl", "appcontainer-dacl", ambient),
    ).toThrow("retired DACL");
    expect(() =>
      host.createApprovalProofContext(...args, "full", "base-container", ambient),
    ).toThrow("retired DACL");
  });

  it("does not add MicroClaw-specific denied roots to a profile grant", () => {
    const host = createPolicyHost();
    const policy = JSON.parse(
      host["buildPolicyJson"](
        [{ path: String.raw`C:\Users\Alice`, access: "ro" }],
        "full",
        "base-container",
        null,
      ),
    ) as { approvedRoots: Array<{ path: string; access: string }>; deniedRoots?: unknown };
    expect(policy.approvedRoots).toContainEqual({
      path: String.raw`C:\Users\Alice`,
      access: "ReadOnly",
    });
    expect(policy).not.toHaveProperty("deniedRoots");
  });

  it.each(["ws://127.0.0.1:18789", "ws://localhost:18789", "wss://[::1]:18789"])(
    "accepts loopback gateway %s",
    (url) => expect(() => assertLoopbackGateway(url)).not.toThrow(),
  );

  it.each(["ws://192.168.1.2:18789", "wss://gateway.example.com", "http://127.0.0.1"])(
    "rejects non-loopback gateway %s",
    (url) => expect(() => assertLoopbackGateway(url)).toThrow(/loopback/),
  );

  it("selects only the exact app-owned loopback device pairing request", () => {
    const nodeId = "a".repeat(64);
    const requestId = findBundledDevicePairRequest(
      {
        pending: [
          {
            requestId: "wrong-client",
            deviceId: nodeId,
            clientId: "openclaw-control-ui",
            role: "operator",
            remoteIp: "127.0.0.1",
          },
          {
            requestId: "remote-node",
            deviceId: nodeId,
            clientId: "node-host",
            role: "node",
            remoteIp: "192.168.1.20",
          },
          {
            requestId: "owned-node",
            deviceId: nodeId.toUpperCase(),
            clientId: "node-host",
            role: "node",
            remoteIp: "::1",
          },
        ],
      },
      nodeId,
    );

    expect(requestId).toBe("owned-node");
  });

  it("reconnects only after the exact app-owned device pairing approval succeeds", async () => {
    const nodeId = "e".repeat(64);
    const requestId = "owned-node";
    let approvalSucceeded = false;
    const gateway = {
      request: vi.fn(async (method: string) => {
        if (method === "device.pair.list") {
          return {
            pending: [
              {
                requestId: "other-device",
                deviceId: "f".repeat(64),
                clientId: "node-host",
                role: "node",
              },
              { requestId, deviceId: nodeId, clientId: "node-host", role: "node" },
            ],
          };
        }
        approvalSucceeded = true;
      }),
    } as unknown as BundledWindowsNodeGateway;
    const reconnect = vi.fn(() => {
      expect(approvalSucceeded).toBe(true);
    });

    await expect(approveBundledDevicePairRequest(gateway, nodeId, reconnect)).resolves.toBe(true);

    expect(gateway.request).toHaveBeenNthCalledWith(1, "device.pair.list", {});
    expect(gateway.request).toHaveBeenNthCalledWith(2, "device.pair.approve", { requestId });
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it("does not reconnect for a missing or different device pairing request", async () => {
    const nodeId = "1".repeat(64);
    const reconnect = vi.fn();
    const gateway = {
      request: vi.fn(async () => ({
        pending: [
          {
            requestId: "other-device",
            deviceId: "2".repeat(64),
            clientId: "node-host",
            role: "node",
          },
        ],
      })),
    } as unknown as BundledWindowsNodeGateway;

    await expect(approveBundledDevicePairRequest(gateway, nodeId, reconnect)).resolves.toBe(false);

    expect(gateway.request).toHaveBeenCalledOnce();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("does not reconnect when Gateway rejects the pairing approval", async () => {
    const nodeId = "3".repeat(64);
    const gateway = {
      request: vi.fn(async (method: string) => {
        if (method === "device.pair.list") {
          return {
            pending: [
              { requestId: "owned-node", deviceId: nodeId, clientId: "node-host", role: "node" },
            ],
          };
        }
        throw new Error("approval failed");
      }),
    } as unknown as BundledWindowsNodeGateway;
    const reconnect = vi.fn();

    await expect(approveBundledDevicePairRequest(gateway, nodeId, reconnect)).rejects.toThrow(
      "approval failed",
    );

    expect(reconnect).not.toHaveBeenCalled();
  });

  it("refuses ambiguous requests for the app-owned identity", () => {
    const nodeId = "b".repeat(64);
    const request = {
      deviceId: nodeId,
      clientId: "node-host",
      role: "node",
      remoteIp: "127.0.0.1",
    };

    expect(() =>
      findBundledDevicePairRequest(
        {
          pending: [
            { ...request, requestId: "first" },
            { ...request, requestId: "second" },
          ],
        },
        nodeId,
      ),
    ).toThrow(/Multiple pairing requests/);
  });

  it("accepts omitted remote metadata but rejects an explicit remote address", () => {
    const nodeId = "c".repeat(64);
    const request = {
      requestId: "owned-node",
      deviceId: nodeId,
      clientId: "node-host",
      role: "node",
    };

    expect(findBundledDevicePairRequest({ pending: [request] }, nodeId)).toBe("owned-node");
    expect(
      findBundledDevicePairRequest({ pending: [{ ...request, remoteIp: "203.0.113.10" }] }, nodeId),
    ).toBeNull();
  });

  it("approves only the exact app-owned system node surface", () => {
    const nodeId = "d".repeat(64);
    const commands = [...WINDOWS_NODE_MXC_NODE_COMMANDS];
    expect(
      findBundledNodePairRequest(
        {
          pending: [
            {
              requestId: "remote",
              nodeId,
              platform: "windows",
              remoteIp: "192.168.1.10",
              commands,
            },
            {
              requestId: "extra-command",
              nodeId,
              platform: "windows",
              remoteIp: "127.0.0.1",
              commands: [...commands, "device.info"],
            },
            {
              requestId: "owned",
              nodeId: nodeId.toUpperCase(),
              platform: "windows",
              remoteIp: "::1",
              commands,
            },
          ],
        },
        nodeId,
      ),
    ).toBe("owned");
  });

  it("keeps the node process while its client reconnects after node reapproval", async () => {
    const nodeId = "d".repeat(64);
    const commands = [...WINDOWS_NODE_MXC_NODE_COMMANDS];
    const startOptions = { requestedStrength: "off" };
    const initialProcess = { exitCode: null, signalCode: null };
    const host = new BundledWindowsNodeHost();
    Object.assign(host, { process: initialProcess, startOptions });
    vi.spyOn(host, "ensureIdentityNodeId").mockReturnValue(nodeId);
    const order: string[] = [];
    const stop = vi.spyOn(host, "stop");
    const start = vi.spyOn(host, "start").mockResolvedValue();
    let approved = false;
    let nodeListCalls = 0;
    const node = {
      nodeId,
      connected: true,
      connectedAtMs: 1000,
      commands,
      displayName: "MicroClaw Bundled Windows Node",
    };
    const gateway = {
      request: vi.fn(async (method: string) => {
        switch (method) {
          case "device.pair.list":
            return { pending: [] };
          case "node.pair.list":
            return {
              pending: approved ? [] : [{ nodeId, requestId: "owned", commands }],
            };
          case "node.pair.approve":
            approved = true;
            order.push("approve");
            return {};
          case "node.list":
            nodeListCalls += 1;
            if (nodeListCalls === 1) {
              order.push("before approval");
              return { nodes: [node] };
            }
            if (nodeListCalls === 2) {
              order.push("previous connected");
              return { nodes: [node] };
            }
            if (nodeListCalls === 3) {
              order.push("previous closed");
              return { nodes: [] };
            }
            if (nodeListCalls === 4) order.push("new connected");
            return { nodes: [{ ...node, connectedAtMs: 2000 }] };
          default:
            throw new Error(`Unexpected request: ${method}`);
        }
      }),
    } as unknown as BundledWindowsNodeGateway;

    await host.ensurePaired(gateway);

    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(Reflect.get(host, "process")).toBe(initialProcess);
    expect(order).toEqual([
      "before approval",
      "approve",
      "previous connected",
      "previous closed",
      "new connected",
    ]);
  });

  it("does not approve or restart a stopped node after a pairing snapshot returns", async () => {
    const nodeId = "d".repeat(64);
    const commands = [...WINDOWS_NODE_MXC_NODE_COMMANDS];
    const host = new BundledWindowsNodeHost();
    Object.assign(host, {
      process: { exitCode: null, signalCode: null },
      startOptions: { requestedStrength: "off" },
    });
    vi.spyOn(host, "ensureIdentityNodeId").mockReturnValue(nodeId);
    const start = vi.spyOn(host, "start").mockResolvedValue();
    let requested!: () => void;
    let release!: (value: { nodes: [] }) => void;
    const requestStarted = new Promise<void>((resolve) => (requested = resolve));
    const response = new Promise<{ nodes: [] }>((resolve) => (release = resolve));
    const gateway = {
      request: vi.fn(async (method: string) => {
        switch (method) {
          case "device.pair.list":
            return { pending: [] };
          case "node.pair.list":
            return { pending: [{ nodeId, requestId: "owned", commands }] };
          case "node.pair.approve":
            return {};
          case "node.list":
            requested();
            return response;
          default:
            throw new Error(`Unexpected request: ${method}`);
        }
      }),
    } as unknown as BundledWindowsNodeGateway;

    const pairing = host.ensurePaired(gateway);
    await requestStarted;
    host.stop(true);
    release({ nodes: [] });

    await expect(pairing).rejects.toThrow("process was replaced during pairing");
    expect(start).not.toHaveBeenCalled();
    expect(gateway.request).not.toHaveBeenCalledWith("node.pair.approve", expect.anything());
  });

  it("recognizes a newer connection when polling did not observe the brief disconnect", async () => {
    const nodeId = "d".repeat(64);
    const gateway = {
      request: vi.fn().mockResolvedValue({
        nodes: [
          {
            nodeId,
            connected: true,
            connectedAtMs: 2000,
            commands: [...WINDOWS_NODE_MXC_NODE_COMMANDS],
          },
        ],
      }),
    } as unknown as BundledWindowsNodeGateway;
    await expect(
      waitForBundledNodeReconnect({
        gateway,
        nodeId,
        previousConnection: { connected: true, connectedAtMs: 1000 },
        assertCurrent: () => undefined,
      }),
    ).resolves.toBe(true);
  });

  it("does not treat the old connection as proof of pairing reconnection", async () => {
    const nodeId = "d".repeat(64);
    let elapsed = 0;
    const gateway = {
      request: vi.fn().mockResolvedValue({
        nodes: [
          {
            nodeId,
            connected: true,
            connectedAtMs: 1000,
            commands: [...WINDOWS_NODE_MXC_NODE_COMMANDS],
          },
        ],
      }),
    } as unknown as BundledWindowsNodeGateway;
    await expect(
      waitForBundledNodeReconnect({
        gateway,
        nodeId,
        previousConnection: { connected: true, connectedAtMs: 1000 },
        assertCurrent: () => undefined,
        now: () => elapsed,
        wait: async (milliseconds) => {
          elapsed += milliseconds;
        },
      }),
    ).resolves.toBe(false);
    expect(elapsed).toBe(5000);
  });

  it("still rejects unexpected commands on a reconnected node", async () => {
    const nodeId = "d".repeat(64);
    const gateway = {
      request: vi.fn().mockResolvedValue({
        nodes: [
          {
            nodeId,
            connected: true,
            connectedAtMs: 2000,
            commands: ["device.info"],
          },
        ],
      }),
    } as unknown as BundledWindowsNodeGateway;
    await expect(
      waitForBundledNodeReconnect({
        gateway,
        nodeId,
        previousConnection: { connected: true, connectedAtMs: 1000 },
        assertCurrent: () => undefined,
      }),
    ).rejects.toThrow("unexpected command surface");
  });

  it("selects only the exact bundled identity and ignores foreign same-name records", () => {
    const nodeId = "d".repeat(64);
    const foreignId = "e".repeat(64);

    const observation = inspectBundledNodeList(
      {
        nodes: [
          {
            id: foreignId,
            displayName: "MicroClaw Bundled Windows Node",
            platform: "windows",
            connected: true,
            commands: [...WINDOWS_NODE_MXC_NODE_COMMANDS],
          },
          {
            id: nodeId.toUpperCase(),
            displayName: "Old bundled name",
            platform: "windows",
            connected: true,
            commands: [...WINDOWS_NODE_MXC_NODE_COMMANDS],
          },
        ],
      },
      nodeId,
    );

    expect(observation.foreignNodeCount).toBe(1);
    expect(observation.node).toEqual({
      connected: true,
      displayName: "Old bundled name",
      commands: [...WINDOWS_NODE_MXC_NODE_COMMANDS],
    });
  });

  it("does not let a stale foreign paired record satisfy bundled readiness", () => {
    const observation = inspectBundledNodeList(
      {
        nodes: [
          {
            id: "e".repeat(64),
            displayName: "MicroClaw Bundled Windows Node",
            connected: false,
            commands: [...WINDOWS_NODE_MXC_NODE_COMMANDS],
          },
        ],
      },
      "d".repeat(64),
    );

    expect(observation).toEqual({ node: null, foreignNodeCount: 1 });
  });

  it("rejects a connected exact identity with a broadened command surface", () => {
    expect(() =>
      inspectBundledNodeList(
        {
          nodes: [
            {
              id: "d".repeat(64),
              connected: true,
              commands: [...WINDOWS_NODE_MXC_NODE_COMMANDS, "device.info"],
            },
          ],
        },
        "d".repeat(64),
      ),
    ).toThrow(/unexpected command surface/);
  });

  it("requires the same complete system-only surface in every mode", () => {
    const nodeId = "d".repeat(64);
    const required = [...WINDOWS_NODE_MXC_NODE_COMMANDS];
    const node = (commands: string[]) => ({ nodeId, connected: true, commands });
    const pending = (commands: string[]) => ({
      pending: [{ ...node(commands), requestId: "regular-node" }],
    });

    expect(inspectBundledNodeList({ nodes: [node(required)] }, nodeId).node?.connected).toBe(true);
    expect(findBundledNodePairRequest(pending(required), nodeId)).toBe("regular-node");
    for (const commands of [
      required.slice(0, -1),
      [...required, "device.info"],
      [...required, required[0]],
    ]) {
      expect(() => inspectBundledNodeList({ nodes: [node(commands)] }, nodeId)).toThrow(
        /unexpected command surface/,
      );
      expect(findBundledNodePairRequest(pending(commands), nodeId)).toBeNull();
    }
  });

  it("rejects duplicate records for the exact bundled identity", () => {
    expect(() =>
      inspectBundledNodeList(
        {
          nodes: [
            {
              id: "d".repeat(64),
              connected: false,
              commands: [...WINDOWS_NODE_MXC_NODE_COMMANDS],
            },
            {
              nodeId: "D".repeat(64),
              connected: true,
              commands: [...WINDOWS_NODE_MXC_NODE_COMMANDS],
            },
          ],
        },
        "d".repeat(64),
      ),
    ).toThrow(/Multiple Gateway node records/);
  });

  it("redacts credential-shaped host diagnostics before persistence", () => {
    expect(
      sanitizeBundledHostDiagnostic(
        "gatewayToken=super-secret NodeDeviceToken: abcdef secretBase64=qwerty",
      ),
    ).toBe("gatewayToken=[redacted] NodeDeviceToken: [redacted] secretBase64=[redacted]");
  });

  it("persists only classified host lifecycle diagnostics", () => {
    expect(classifyBundledHostDiagnostic("node-connection-failure: DeviceTokenMismatch")).toBe(
      "node-connection-failure: DeviceTokenMismatch",
    );
    expect(
      classifyBundledHostDiagnostic(
        "node-device-token-recovery: cleared the exact bundled node token and reconnecting",
      ),
    ).toBe("node-device-token-recovery: cleared the exact bundled node token and reconnecting");
    expect(classifyBundledHostDiagnostic("node-identity-mismatch: local path details")).toBe(
      "host-policy-failure: node-identity-mismatch",
    );
    expect(classifyBundledHostDiagnostic("[canvas-host] user-provided canvas content")).toBeNull();
  });

  function createPolicyHost(): BundledWindowsNodeHost {
    const host = Object.create(BundledWindowsNodeHost.prototype) as BundledWindowsNodeHost;
    Object.assign(host, {
      wxcExecPath: process.execPath,
    });
    return host;
  }

  it("binds approval responses to the exact pending request", () => {
    expect(() => assertApprovalResponseMatches("request-1", "request-1")).not.toThrow();
    expect(() => assertApprovalResponseMatches("request-1", "request-2")).toThrow(/does not match/);
  });

  it("accepts canonical declared access in an attended approval request", () => {
    expect(
      validateApprovalRequest({
        id: "request-1",
        executable: String.raw`C:\Windows\System32\cmd.exe`,
        arguments: ["/c", "echo hello"],
        agent: "main",
        canonicalCwd: "isolated-scratch:v1",
        declaredAccess: [{ access: "rw", path: String.raw`C:\Users\test\Desktop` }],
      }).declaredAccess,
    ).toEqual([{ access: "rw", path: String.raw`C:\Users\test\Desktop` }]);
  });

  it("rejects malformed declared access before surfacing an approval", () => {
    expect(() =>
      validateApprovalRequest({
        id: "request-1",
        executable: String.raw`C:\Windows\System32\cmd.exe`,
        arguments: [],
        agent: null,
        canonicalCwd: "isolated-scratch:v1",
        declaredAccess: [{ access: "write", path: String.raw`C:\Users\test\Desktop` }],
      }),
    ).toThrow(/Malformed/);
  });

  it("preserves only exactly reconstructed native PowerShell initialization", () => {
    const executable = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
    const declaredAccess = [{ access: "rw" as const, path: String.raw`C:\workspace` }];
    const initialization = createPowerShellFilesystemInitialization(
      [
        executable,
        "-NoProfile",
        "-Command",
        String.raw`Remove-Item -LiteralPath 'C:\workspace\folder' -Recurse`,
      ],
      executable,
      declaredAccess,
    );
    if (!initialization) throw new Error("Literal initialization fixture was rejected");
    const request = {
      id: "initialized-request",
      executable,
      arguments: initialization.finalArgv.slice(1),
      canonicalCwd: "isolated-scratch:v1",
      declaredAccess,
      providerInitialization: initialization,
    };
    expect(validateApprovalRequest(request).providerInitialization).toEqual(initialization);
    for (const metadata of [
      null,
      {},
      { ...initialization, extra: true },
      { ...initialization, originalArgv: [executable, "-NoProfile", "-Command", "Get-Date"] },
    ])
      expect(() =>
        validateApprovalRequest({ ...request, providerInitialization: metadata }),
      ).toThrow(/Malformed/);
    expect(() =>
      validateApprovalRequest({ ...request, arguments: ["-Command", "Get-Date"] }),
    ).toThrow(/Malformed/);
    expect(() =>
      validateApprovalRequest({ ...request, executable: String.raw`C:\other.exe` }),
    ).toThrow(/Malformed/);
  });

  it("uses a controlled system-only helper environment", () => {
    const environment = createBundledWindowsNodeEnvironment(
      String.raw`C:\Windows`,
      String.raw`C:\MicroClaw\scratch`,
    );

    expect(environment.PATH).toBe(
      String.raw`C:\Windows\System32;C:\Windows\System32\WindowsPowerShell\v1.0`,
    );
    expect(environment.TEMP).toBe(String.raw`C:\MicroClaw\scratch`);
    expect(environment).not.toHaveProperty("APPDATA");
    expect(environment).not.toHaveProperty("USERPROFILE");
  });

  it("preserves ordinary user paths and batch commands only in regular mode", () => {
    const environment = createBundledWindowsNodeEnvironment(
      String.raw`C:\Windows`,
      String.raw`C:\MicroClaw\scratch`,
      {
        PATH: String.raw`C:\Tools;C:\Windows\System32`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        USERPROFILE: String.raw`C:\Users\Alice`,
        APPDATA: String.raw`C:\Users\Alice\AppData\Roaming`,
        OPENCLAW_STATE_DIR: String.raw`C:\private-state`,
        MODEL_API_KEY: "not-forwarded",
      },
    );

    expect(environment).toMatchObject({
      PATH: String.raw`C:\Tools;C:\Windows\System32`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      USERPROFILE: String.raw`C:\Users\Alice`,
      APPDATA: String.raw`C:\Users\Alice\AppData\Roaming`,
      TEMP: String.raw`C:\MicroClaw\scratch`,
    });

    expect(environment).not.toHaveProperty("OPENCLAW_STATE_DIR");
    expect(environment).not.toHaveProperty("MODEL_API_KEY");
    expect(createBundledWindowsNodeEnvironment(String.raw`C:\Windows`, "scratch", {}).PATHEXT).toBe(
      ".COM;.EXE;.BAT;.CMD",
    );
  });

  it("uses the Gateway temporary directory without changing helper probes", () => {
    const environment = createBundledWindowsNodeEnvironment(
      String.raw`C:\Windows`,
      String.raw`C:\MicroClaw\scratch`,
      {},
      String.raw`C:\Users\Alice\AppData\Local\Temp`,
    );
    expect(environment.TEMP).toBe(String.raw`C:\Users\Alice\AppData\Local\Temp`);
    expect(environment.TMP).toBe(environment.TEMP);
    expect(() =>
      createBundledWindowsNodeEnvironment(
        String.raw`C:\Windows`,
        String.raw`C:\MicroClaw\scratch`,
        {},
        "relative-temp",
      ),
    ).toThrow(/absolute Windows path/);
  });

  it("retries a transient Windows atomic replacement without weakening failures", async () => {
    const attempts: string[] = [];
    const waits: number[] = [];
    const rename = async (source: string, destination: string) => {
      attempts.push(`${source}->${destination}`);
      if (attempts.length < 3) {
        throw Object.assign(new Error("destination is briefly locked"), { code: "EPERM" });
      }
    };

    await replaceFileWithRetry("lease.tmp", "lease.json", rename, async (milliseconds) => {
      waits.push(milliseconds);
    });

    expect(attempts).toHaveLength(3);
    expect(waits).toEqual([20, 40]);

    const permanent = Object.assign(new Error("invalid replacement"), { code: "EINVAL" });
    await expect(
      replaceFileWithRetry(
        "lease.tmp",
        "lease.json",
        async () => {
          throw permanent;
        },
        async () => undefined,
      ),
    ).rejects.toBe(permanent);
  });

  it("stops a pending replacement retry when its activation generation is revoked", async () => {
    let currentGeneration = true;
    let renameAttempts = 0;

    await expect(
      replaceFileWithRetry(
        "lease.tmp",
        "lease.json",
        () => {
          renameAttempts += 1;
          throw Object.assign(new Error("destination is briefly locked"), { code: "EPERM" });
        },
        async () => {
          currentGeneration = false;
        },
        () => {
          if (!currentGeneration) throw new Error("activation generation revoked");
        },
      ),
    ).rejects.toThrow("activation generation revoked");
    expect(renameAttempts).toBe(1);
  });

  it("terminates the bundled host when activation lease deletion fails", () => {
    const deletionError = Object.assign(new Error("lease is locked"), { code: "EPERM" });
    let terminated = false;

    expect(
      revokeActivationLeaseFile(
        "activation-lease.json",
        () => {
          terminated = true;
        },
        () => {
          throw deletionError;
        },
      ),
    ).toBe(deletionError);
    expect(terminated).toBe(true);
  });

  it("requires an explicit non-conflicting package architecture", () => {
    const script = path.join(__dirname, "..", "scripts", "prepare-windows-node-resources.mjs");
    const missing = spawnSync(process.execPath, [script], { encoding: "utf8" });
    const conflicting = spawnSync(process.execPath, [script, "--arch=x64"], {
      encoding: "utf8",
      env: { ...process.env, MICROCLAW_WINDOWS_ARCH: "arm64" },
    });

    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("Specify exactly one Windows package architecture");
    expect(conflicting.status).not.toBe(0);
    expect(conflicting.stderr).toContain("Architecture mismatch");
  });
});
