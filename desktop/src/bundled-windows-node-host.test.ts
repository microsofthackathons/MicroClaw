import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BUNDLED_WINDOWS_NODE_CWD_CONTRACT,
  BundledWindowsNodeHost,
  MXC_HOST_PREP_PATCH_REVISION,
  assertApprovalResponseMatches,
  assertLoopbackGateway,
  createBundledWindowsNodeEnvironment,
  findBundledDevicePairRequest,
  findBundledNodePairRequest,
  replaceFileWithRetry,
  revokeActivationLeaseFile,
  sensitiveWindowsRoots,
  validateApprovalRequest,
} from "./bundled-windows-node-host";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => String.raw`C:\Users\Alice\AppData\Roaming\MicroClaw`,
  },
}));

describe("bundled Windows node host", () => {
  it("uses the exact CWD policy contract", () => {
    expect(BUNDLED_WINDOWS_NODE_CWD_CONTRACT).toBe("microclaw.windows-cwd.v1");
  });

  it("pins the reviewed MXC target-only host-prep patch", () => {
    expect(MXC_HOST_PREP_PATCH_REVISION).toBe("695c2b89c6142090a098ec4484f49aff8157f0b3");
  });

  it("creates a fresh 256-bit proof context bound to policy and node identity", () => {
    const host = Object.create(BundledWindowsNodeHost.prototype) as BundledWindowsNodeHost;
    const folders = [
      { path: String.raw`C:\Users\Alice\Documents`, access: "ro" as const },
      { path: String.raw`C:\Users\Alice\Desktop`, access: "rw" as const },
    ];
    const first = host.createApprovalProofContext(
      "generation-1",
      "a".repeat(64),
      folders,
      String.raw`C:\Users\Alice\AppData\Roaming\openclaw`,
    );
    const second = host.createApprovalProofContext(
      "generation-1",
      "a".repeat(64),
      folders,
      String.raw`C:\Users\Alice\AppData\Roaming\openclaw`,
    );

    expect(Buffer.from(first.secretBase64, "base64")).toHaveLength(32);
    expect(first.gatewayGeneration).toBe("generation-1");
    expect(first.nodeId).toBe("a".repeat(64));
    expect(first.policyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.secretBase64).not.toBe(second.secretBase64);
    expect(first.policyFingerprint).toBe(second.policyFingerprint);
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
      path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Mozilla", "Firefox", "Profiles"),
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

  it("approves only the exact app-owned system-only node surface", () => {
    const nodeId = "d".repeat(64);
    const commands = ["system.run", "system.run.prepare", "system.which", "system.run.cwd-policy"];
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
