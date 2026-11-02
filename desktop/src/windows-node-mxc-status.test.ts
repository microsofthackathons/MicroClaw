import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { WindowsNodeMxcRequestedMode } from "./windows-node-mxc-modes";
import { WindowsNodeMxcStatusCache } from "./windows-node-mxc-status-cache";

const source = readFileSync(resolve(process.cwd(), "src", "main.ts"), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const declarations = [
  "getWindowsNodeMxcStatus",
  "inspectWindowsNodeMxcStatus",
  "requireEffectiveWindowsNodeMxc",
].map((name) => {
  const declaration = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!declaration) throw new Error(`Missing status function: ${name}`);
  return declaration.getText(ast);
});
const js = ts.transpileModule(declarations.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness(mode: WindowsNodeMxcRequestedMode) {
  const cache = new WindowsNodeMxcStatusCache({
    key: () => "generation-policy-lease",
    inspect: () => functions.inspectWindowsNodeMxcStatus(),
    publish: () => {},
  });
  const validate = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const snapshot = vi.fn(() => ({ nodeId: "a".repeat(64), ambientAccess: null }));
  const inspect = vi.fn(async (options) => ({
    desiredEnabled: mode !== "off",
    effectiveEnabled: mode !== "off" && !options.runtimeIntegrityError,
    blockers: options.runtimeIntegrityError ? [options.runtimeIntegrityError] : [],
  }));
  const failClosed = vi.fn().mockResolvedValue(undefined);
  const renewLease = vi.fn().mockResolvedValue(undefined);
  const synchronousValidation = vi.fn(() => {
    throw new Error("Status must not invoke synchronous validation or identity");
  });
  const context = {
    Error,
    readConfig: () => ({}),
    getWindowsNodeMxcRequestedMode: () => mode,
    isWindowsNodeMxcDesired: () => mode !== "off",
    settingsStore: { get: () => null },
    getWindowsNodeMxcIngressBackup: () => null,
    getBundledWindowsNodeFolders: () => [],
    bundledWindowsNodeHost: {
      status: snapshot,
      validateRuntimeIntegrity: validate,
      getValidatedMxcExecutablePath: synchronousValidation,
      ensureIdentityNodeId: synchronousValidation,
      setActivationLease: renewLease,
    },
    inspectWindowsNodeMxc: inspect,
    gwClient: { connected: true },
    gatewaySpawnedByUs: true,
    isManagedGatewayProcessAlive: () => true,
    gatewayGenerationId: "generation",
    getWindowsNodeMxcDurableApprovalStore: () => ({ inspect: () => ({}) }),
    windowsNodeMxcSecurityTransitionInProgress: false,
    windowsNodeMxcLifecycleState: "idle",
    windowsNodeMxcLifecycleDetail: null,
    windowsNodeMxcLifecycleUpdatedAt: "",
    inspectWindowsNodeMxcHooksStatus: () => ({}),
    isWindowsNodeMxcIngressReleased: () => true,
    windowsNodeMxcIngressGeneration: "generation",
    windowsNodeMxcActivationInProgress: false,
    failClosedWindowsNodeMxc: failClosed,
    captureGatewayReadinessCheckpoint: () => () => true,
    windowsNodeMxcStatusCache: cache,
  };
  const functions = runInNewContext(
    `${js}\n({ getWindowsNodeMxcStatus, inspectWindowsNodeMxcStatus, requireEffectiveWindowsNodeMxc })`,
    context,
  ) as {
    getWindowsNodeMxcStatus: () => Promise<{ effectiveEnabled: boolean }>;
    inspectWindowsNodeMxcStatus: () => Promise<{ effectiveEnabled: boolean }>;
    requireEffectiveWindowsNodeMxc: () => Promise<void>;
  };
  return {
    ...functions,
    validate,
    snapshot,
    inspect,
    failClosed,
    renewLease,
    synchronousValidation,
  };
}

describe("main-process Windows node MXC status", () => {
  it.each(["off", "full", "limited-dacl"] as const)(
    "awaits fresh asynchronous validation before inspecting %s",
    async (mode) => {
      const test = harness(mode);
      let release!: () => void;
      test.validate.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const status = test.getWindowsNodeMxcStatus();
      await Promise.resolve();
      expect(test.validate).toHaveBeenCalledWith(mode !== "off");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(test.snapshot).not.toHaveBeenCalled();
      expect(test.inspect).not.toHaveBeenCalled();
      release();
      await status;
      expect(test.snapshot).toHaveBeenCalledTimes(1);
      expect(test.inspect).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedMode: mode,
          bundledHost: { nodeId: "a".repeat(64), ambientAccess: null },
          runtimeIntegrityError: undefined,
        }),
      );
      expect(test.synchronousValidation).not.toHaveBeenCalled();
    },
  );

  it.each(["off", "full", "limited-dacl"] as const)(
    "preserves runtime integrity errors in %s status",
    async (mode) => {
      const test = harness(mode);
      test.validate.mockRejectedValue(new Error("resource tree hash mismatch"));
      await expect(test.getWindowsNodeMxcStatus()).resolves.toMatchObject({
        effectiveEnabled: false,
      });
      expect(test.inspect).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeIntegrityError: "resource tree hash mismatch",
        }),
      );
      expect(test.synchronousValidation).not.toHaveBeenCalled();
    },
  );

  it("revalidates every enabled ingress check rather than trusting a previous snapshot", async () => {
    const test = harness("full");
    await test.requireEffectiveWindowsNodeMxc();
    expect(test.renewLease).toHaveBeenCalledTimes(1);
    test.validate.mockRejectedValue(new Error("resource tree hash mismatch"));
    await expect(test.requireEffectiveWindowsNodeMxc()).rejects.toThrow("execution is blocked");
    expect(test.validate).toHaveBeenCalledTimes(2);
    expect(test.validate).toHaveBeenLastCalledWith(true);
    expect(test.failClosed).toHaveBeenCalledWith(
      "Runtime attestation drifted: resource tree hash mismatch",
    );
    expect(test.renewLease).toHaveBeenCalledTimes(1);
  });
});
