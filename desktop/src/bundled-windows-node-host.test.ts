import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  BUNDLED_WINDOWS_NODE_CWD_CONTRACT,
  BUNDLED_WINDOWS_NODE_CANVAS_CONTRACT,
  BUNDLED_WINDOWS_NODE_REVISION,
  BundledWindowsNodeHost,
  MXC_EXACT_BACKEND_PROVISIONING,
  MXC_HOST_PREP_PATCH_REVISION,
  MXC_SDK_SOURCE_REVISION,
  assertApprovalResponseMatches,
  assertLoopbackGateway,
  createBundledWindowsNodeEnvironment,
  endBundledWindowsNodeBootstrap,
  execFileText,
  classifyBundledHostDiagnostic,
  findBundledDevicePairRequest,
  findBundledNodePairRequest,
  inspectBundledNodeList,
  replaceFileWithRetry,
  revokeActivationLeaseFile,
  sanitizeBundledHostDiagnostic,
  sha256DirectoryTree,
  terminateBundledWindowsNodeProcessTree,
  sensitiveWindowsRoots,
  validateApprovalRequest,
  validateBundledWindowsNodeRuntimeManifest,
} from "./bundled-windows-node-host";
import { WINDOWS_NODE_MXC_NODE_COMMANDS } from "./windows-node-mxc";
import { createPowerShellFilesystemInitialization } from "./windows-node-mxc-powershell-scope";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => String.raw`C:\Users\Alice\AppData\Roaming\MicroClaw`,
  },
}));

const policyCanvasRoot = mkdtempSync(path.join(os.tmpdir(), "microclaw-policy-canvas-"));
const policyCanvasHostPath = path.join(policyCanvasRoot, "canvas-host.exe");
writeFileSync(policyCanvasHostPath, "canvas-host");
afterAll(() => rmSync(policyCanvasRoot, { recursive: true, force: true }));

describe("bundled Windows node host", () => {
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

  it("binds every Canvas host code and resource file into one tree hash", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "microclaw-canvas-tree-"));
    try {
      mkdirSync(path.join(root, "nested"));
      writeFileSync(path.join(root, "host.exe"), "apphost");
      writeFileSync(path.join(root, "nested", "host.dll"), "managed-code");
      const original = sha256DirectoryTree(root);
      expect(sha256DirectoryTree(root)).toBe(original);
      writeFileSync(path.join(root, "nested", "host.dll"), "changed-code");
      expect(sha256DirectoryTree(root)).not.toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins the reviewed MXC target-only host-prep patch", () => {
    expect(MXC_HOST_PREP_PATCH_REVISION).toBe("695c2b89c6142090a098ec4484f49aff8157f0b3");
  });

  it("attests the exact MXC package provenance and backend build contract", () => {
    expect(() =>
      validateBundledWindowsNodeRuntimeManifest(
        {
          architecture: "x64",
          mxcVersion: "0.7.0",
          mxcSourceRevision: MXC_SDK_SOURCE_REVISION,
          mxcProductionBfsCompiledIn: false,
          mxcExactBackendProvisioning: MXC_EXACT_BACKEND_PROVISIONING,
          wxcExecSha256: "db0a3422be9e1b396cc1b2547c70ff16b27412438a31c10a45abf370cac86ae2",
          windowsNodeRevision: BUNDLED_WINDOWS_NODE_REVISION,
          canvasContract: BUNDLED_WINDOWS_NODE_CANVAS_CONTRACT,
          canvasHostSha256: "1".repeat(64),
          canvasHostTreeSha256: "2".repeat(64),
          mxcHostPrepPatchRevision: MXC_HOST_PREP_PATCH_REVISION,
          microclawHostPrepOrigin: "microclaw-built",
          microclawHostPrepOperations: ["prepare-system-drive", "unprepare-system-drive"],
        },
        "x64",
      ),
    ).not.toThrow();
  });

  it.each([
    ["version", { mxcVersion: "0.7.1" }],
    ["source revision", { mxcSourceRevision: "0".repeat(40) }],
    ["BFS build flag", { mxcProductionBfsCompiledIn: true }],
    ["backend provisioning contract", { mxcExactBackendProvisioning: "appcontainer-bfs" }],
    ["runtime hash", { wxcExecSha256: "0".repeat(64) }],
  ])("rejects an MXC runtime manifest with a mismatched %s", (_label, override) => {
    expect(() =>
      validateBundledWindowsNodeRuntimeManifest(
        {
          architecture: "x64",
          mxcVersion: "0.7.0",
          mxcSourceRevision: MXC_SDK_SOURCE_REVISION,
          mxcProductionBfsCompiledIn: false,
          mxcExactBackendProvisioning: MXC_EXACT_BACKEND_PROVISIONING,
          wxcExecSha256: "db0a3422be9e1b396cc1b2547c70ff16b27412438a31c10a45abf370cac86ae2",
          windowsNodeRevision: BUNDLED_WINDOWS_NODE_REVISION,
          canvasContract: BUNDLED_WINDOWS_NODE_CANVAS_CONTRACT,
          canvasHostSha256: "1".repeat(64),
          canvasHostTreeSha256: "2".repeat(64),
          mxcHostPrepPatchRevision: MXC_HOST_PREP_PATCH_REVISION,
          microclawHostPrepOrigin: "microclaw-built",
          microclawHostPrepOperations: ["prepare-system-drive", "unprepare-system-drive"],
          ...override,
        },
        "x64",
      ),
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
      String.raw`C:\Users\Alice\AppData\Roaming\openclaw`,
      "12345678-1234-4234-8234-123456789abc",
    );
    const second = host.createApprovalProofContext(
      "generation-1",
      "a".repeat(64),
      folders,
      String.raw`C:\Users\Alice\AppData\Roaming\openclaw`,
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

  it("binds requested strength, effective tier, and ambient assessment into policy identity", () => {
    const host = createPolicyHost();
    const folders = [{ path: String.raw`C:\Approved`, access: "rw" as const }];
    const args = [
      "generation-1",
      "a".repeat(64),
      folders,
      String.raw`C:\OpenClaw`,
      "12345678-1234-4234-8234-123456789abc",
    ] as const;
    const full = host.createApprovalProofContext(...args, "full", "base-container", null);
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
    const limited = host.createApprovalProofContext(
      ...args,
      "limited-dacl",
      "appcontainer-dacl",
      ambient,
    );

    expect(full.policyFingerprint).not.toBe(limited.policyFingerprint);
  });

  it("protects both helper state and the resolved OpenClaw state root", () => {
    const roots = sensitiveWindowsRoots(
      "C:\\Users\\Alice\\AppData\\Roaming\\MicroClaw\\windows-node",
      "D:\\OpenClawState",
    );

    expect(roots).toContain("C:\\Users\\Alice\\AppData\\Roaming\\MicroClaw\\windows-node");
    expect(roots).toContain("D:\\OpenClawState");
    expect(roots).toContain(path.join(os.homedir(), ".gnupg"));
    expect(roots).toContain(path.join(os.homedir(), ".config", "gcloud"));
    expect(roots).toContain(
      path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "Mozilla",
        "Firefox",
        "Profiles",
      ),
    );
    expect(roots).toContain(
      path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "Microsoft",
        "Windows",
        "PowerShell",
        "PSReadLine",
      ),
    );
    expect(roots).toContain(
      path.join(
        process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
        "BraveSoftware",
        "Brave-Browser",
        "User Data",
      ),
    );
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

  it("approves only the exact app-owned system and Canvas node surface", () => {
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
      canvasHostPath: policyCanvasHostPath,
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

  it("settles a timed out ambient helper and terminates its process tree", async () => {
    const startedAt = Date.now();

    await expect(
      execFileText(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], 100),
    ).rejects.toThrow("ambient assessment timed out after 100ms");

    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it.runIf(process.platform === "win32")(
    "kills pipe-holding descendants before settling a helper timeout",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "microclaw-ambient-timeout-"));
      const pidsPath = path.join(root, "pids.json");
      const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        stdio: "inherit", windowsHide: true,
      });
      child.on("spawn", () => require("node:fs").writeFileSync(
        process.argv[1], JSON.stringify([process.pid, child.pid]),
      ));
      setTimeout(() => {}, 30000);
    `;
      try {
        await expect(
          execFileText(process.execPath, ["-e", script, pidsPath], 2000),
        ).rejects.toThrow("ambient assessment timed out after 2000ms");
        const pids = JSON.parse(readFileSync(pidsPath, "utf8")) as number[];
        expect(pids).toHaveLength(2);
        for (const pid of pids) {
          expect(() => process.kill(pid, 0)).toThrow();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

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
