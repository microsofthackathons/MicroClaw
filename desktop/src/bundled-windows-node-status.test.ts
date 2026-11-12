import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUNDLED_WINDOWS_NODE_RUNTIME_CONTRACT,
  BUNDLED_WINDOWS_NODE_REVISION,
  BundledWindowsNodeHost,
} from "./bundled-windows-node-host";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => process.cwd() },
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    readdirSync: vi.fn(actual.readdirSync),
    existsSync: vi.fn(actual.existsSync),
  };
});

const nativeHashes = {
  x64: {
    "mxc_ffi.dll": "bd45522f06dc9cc8001dcd5d7320bc2bf303fb08a39bf10f3404bd9a8001812c",
    "plm.exe": "beffc9c9ab974ca9e7455089fd8ecb36eb8c92811ddd1705db91370a689692c3",
    "wslcsdk.dll": "8d4d55d4283fb32a5909b57e78b576d01363d7b28bb9b2595115e80faf61db5b",
    "wxc-wslc-daemon.exe": "84f61c1bc13abde8da1c3f2ff100e6d59368ecaabdbfeca939e6fdb696202d0c",
  },
  arm64: {
    "mxc_ffi.dll": "1becaf695ad9ab6f6fe21ca4ad2e838d9218996a5d42cb82e609df1eb4d3db6b",
    "plm.exe": "8818982c6b91c78d9198dc03d5efc8a9a34a1075afb4a6a3e9f1a750c5462532",
    "wslcsdk.dll": "ad440e116a64af004fe021b95914163021c2e8f40b0f8b6d8ece210ee5cae3d4",
    "wxc-wslc-daemon.exe": "ad9a7a42a607c2670e493b9f4d5eb4f2cd959c9d05b8882df42f9d8ecc1f6fef",
  },
}[process.arch === "arm64" ? "arm64" : "x64"];

describe("nonblocking bundled Windows node status", () => {
  let root: string;
  let host: BundledWindowsNodeHost;
  let manifest: Record<string, unknown>;

  beforeEach(() => {
    vi.mocked(createHash).mockReset();
    root = fs.mkdtempSync(path.join(process.cwd(), ".test-node-status-"));
    fs.mkdirSync(path.join(root, "host"));
    const hostPath = path.join(root, "host", "host.exe");
    fs.writeFileSync(hostPath, "host");
    manifest = {
      architecture: process.arch,
      runtimeIdentifier: `win-${process.arch}`,
      mxcVersion: "1.0.1",
      mxcManagedSha256: "59761d9a868cde01ef05139775ad6d072f9425b5b73b911bdf465b29b4bf20a6",
      mxcNativeSha256: nativeHashes,
      hostSha256: createHash("sha256").update("host").digest("hex"),
      windowsNodeRevision: BUNDLED_WINDOWS_NODE_REVISION,
      contract: BUNDLED_WINDOWS_NODE_RUNTIME_CONTRACT,
    };
    saveManifest();
    host = Object.assign(new BundledWindowsNodeHost(), {
      resourceRoot: root,
      hostPath,
    });
    vi.mocked(execFileSync).mockReturnValue("A".repeat(64));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function saveManifest() {
    fs.writeFileSync(path.join(root, "RUNTIME.json"), JSON.stringify(manifest));
  }

  function expectNoBlockingWork() {
    expect(execFileSync).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.readdirSync).not.toHaveBeenCalled();
    expect(fs.existsSync).not.toHaveBeenCalled();
  }

  it("does not initialize an identity or touch artifacts for a cold status snapshot", () => {
    expect(host.status().nodeId).toBeNull();
    expectNoBlockingWork();
    expect(createHash).not.toHaveBeenCalled();
  });

  it("reuses the initialized identity but still validates every explicit identity request", () => {
    expect(host.ensureIdentityNodeId()).toBe("a".repeat(64));
    expect(execFileSync).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    expect(host.status().nodeId).toBe("a".repeat(64));
    expect(host.status().nodeId).toBe("a".repeat(64));
    expectNoBlockingWork();
    expect(createHash).not.toHaveBeenCalled();

    fs.rmSync(path.join(root, "host", "host.exe"));
    expect(() => host.ensureIdentityNodeId()).toThrow("host is missing");
    expect(host.status().nodeId).toBeNull();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("does not remember an invalid native identity", () => {
    vi.mocked(execFileSync).mockReturnValue("not-a-node-id");
    expect(() => host.ensureIdentityNodeId()).toThrow("invalid identity");
    expect(host.status().nodeId).toBeNull();
  });

  it("pairs in regular mode with the bundled host", async () => {
    Object.assign(host, {
      startOptions: { requestedStrength: "off" },
      process: { exitCode: null, signalCode: null },
    });
    const gateway = { request: vi.fn().mockRejectedValue(new Error("gateway reached")) };
    await expect(host.ensurePaired(gateway)).rejects.toThrow("gateway reached");
    expect(gateway.request).toHaveBeenCalledWith("device.pair.list", {});
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it("requires the bundled host before pairing in sandboxed mode", async () => {
    fs.rmSync(path.join(root, "host", "host.exe"));
    Object.assign(host, {
      startOptions: { requestedStrength: "full" },
      process: { exitCode: null, signalCode: null },
    });
    const gateway = { request: vi.fn() };
    await expect(host.ensurePaired(gateway)).rejects.toThrow("host is missing");
    expect(gateway.request).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("validates the full runtime asynchronously and yields to the event loop", async () => {
    let completed = false;
    const validation = host.validateRuntimeIntegrity().then(() => {
      completed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    await validation;
    expectNoBlockingWork();
  });

  it("validates the exec runtime without requiring or enumerating Canvas resources", async () => {
    const readdir = vi.spyOn(fs.promises, "readdir");
    await expect(host.validateRuntimeIntegrity()).resolves.toBeUndefined();
    expect(readdir).not.toHaveBeenCalled();
    expectNoBlockingWork();
  });

  it("does not cache successful probe validation across status requests", async () => {
    await host.validateRuntimeIntegrity();
    fs.writeFileSync(path.join(root, "host", "host.exe"), "tampered");
    await expect(host.validateRuntimeIntegrity()).rejects.toThrow("host hash mismatch");
    expectNoBlockingWork();
  });

  it("rejects a mismatched host hash in fresh enabled checks", async () => {
    manifest.hostSha256 = "0".repeat(64);
    saveManifest();
    await expect(host.validateRuntimeIntegrity()).rejects.toThrow(
      "Windows node host hash mismatch",
    );
    expectNoBlockingWork();
  });

  it("rejects legacy runtime manifests so old Canvas-capable hosts cannot start", async () => {
    delete manifest.contract;
    manifest.canvasContract = "microclaw.windows-node-mxc.canvas.v1";
    saveManifest();
    await expect(host.validateRuntimeIntegrity()).rejects.toThrow("manifest does not match");
    expectNoBlockingWork();
  });

  it("rejects missing files and malformed or incompatible manifests", async () => {
    manifest.mxcVersion = "wrong";
    saveManifest();
    await expect(host.validateRuntimeIntegrity()).rejects.toThrow("manifest does not match");
    fs.writeFileSync(path.join(root, "RUNTIME.json"), "{");
    await expect(host.validateRuntimeIntegrity()).rejects.toThrow();
    fs.rmSync(path.join(root, "RUNTIME.json"));
    await expect(host.validateRuntimeIntegrity()).rejects.toThrow();
    expectNoBlockingWork();
  });

  it("retains fresh executable validation before launching a host", async () => {
    fs.writeFileSync(path.join(root, "host", "host.exe"), "tampered");
    await expect(
      host.start({
        gatewayUrl: "ws://127.0.0.1:18789",
      } as Parameters<BundledWindowsNodeHost["start"]>[0]),
    ).rejects.toThrow("host hash mismatch");
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
