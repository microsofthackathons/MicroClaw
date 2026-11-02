import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUNDLED_WINDOWS_NODE_CANVAS_CONTRACT,
  BUNDLED_WINDOWS_NODE_REVISION,
  BundledWindowsNodeHost,
  MXC_EXACT_BACKEND_PROVISIONING,
  MXC_HOST_PREP_PATCH_REVISION,
  MXC_SDK_SOURCE_REVISION,
  sha256DirectoryTree,
  sha256DirectoryTreeAsync,
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

const pinned = {
  x64: {
    probe: "db0a3422be9e1b396cc1b2547c70ff16b27412438a31c10a45abf370cac86ae2",
    official: "531fb3cdb4b0c964908fd71b71d40961417afb399cbab72f92a25e95309a6416",
  },
  arm64: {
    probe: "e430d0e4f44f616e91db684f8d825a6dc93e06a1262b8d00bcaac7522a317aab",
    official: "3ef702332286a39153fc259310b5021e3de3c191751d7522684f6475f73af5ef",
  },
}[process.arch === "arm64" ? "arm64" : "x64"];

describe("nonblocking bundled Windows node status", () => {
  let root: string;
  let canvasRoot: string;
  let host: BundledWindowsNodeHost;
  let manifest: Record<string, unknown>;

  beforeEach(() => {
    vi.mocked(createHash).mockReset();
    root = fs.mkdtempSync(path.join(process.cwd(), ".test-node-status-"));
    canvasRoot = path.join(root, "canvas-host");
    for (const directory of ["host", "mxc", "host-prep", "canvas-host"]) {
      fs.mkdirSync(path.join(root, directory));
    }
    const hostPath = path.join(root, "host", "host.exe");
    const wxcExecPath = path.join(root, "mxc", "wxc-exec.exe");
    const canvasHostPath = path.join(canvasRoot, "canvas.exe");
    fs.writeFileSync(hostPath, "host");
    fs.writeFileSync(wxcExecPath, "probe");
    fs.writeFileSync(path.join(root, "mxc", "wxc-host-prep.exe"), "official");
    fs.writeFileSync(path.join(root, "host-prep", "microclaw-mxc-host-prep.exe"), "patch");
    fs.writeFileSync(canvasHostPath, "canvas");
    fs.writeFileSync(path.join(canvasRoot, "resource.dll"), Buffer.alloc(1024 * 1024, 17));
    manifest = {
      architecture: process.arch,
      mxcVersion: "0.7.0",
      mxcSourceRevision: MXC_SDK_SOURCE_REVISION,
      mxcProductionBfsCompiledIn: false,
      mxcExactBackendProvisioning: MXC_EXACT_BACKEND_PROVISIONING,
      wxcExecSha256: pinned.probe,
      officialWxcHostPrepSha256: pinned.official,
      microclawHostPrepSha256: createHash("sha256").update("patch").digest("hex"),
      windowsNodeRevision: BUNDLED_WINDOWS_NODE_REVISION,
      canvasContract: BUNDLED_WINDOWS_NODE_CANVAS_CONTRACT,
      canvasHostSha256: createHash("sha256").update("canvas").digest("hex"),
      canvasHostTreeSha256: sha256DirectoryTree(canvasRoot),
      mxcHostPrepPatchRevision: MXC_HOST_PREP_PATCH_REVISION,
      microclawHostPrepOrigin: "microclaw-built",
      microclawHostPrepOperations: ["prepare-system-drive", "unprepare-system-drive"],
    };
    saveManifest();
    host = Object.assign(new BundledWindowsNodeHost(), {
      resourceRoot: root,
      hostPath,
      wxcExecPath,
      canvasHostPath,
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

  // Only the two official binary digests are substituted; fixture/tree hashing stays real.
  function acceptOfficialFixtures(includeHost = true) {
    const probe = createHash("sha256");
    const official = createHash("sha256");
    vi.spyOn(probe, "digest").mockReturnValue(pinned.probe);
    vi.spyOn(official, "digest").mockReturnValue(pinned.official);
    vi.mocked(createHash).mockReturnValueOnce(probe);
    if (includeHost) vi.mocked(createHash).mockReturnValueOnce(official);
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
    acceptOfficialFixtures();
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
    acceptOfficialFixtures();
    vi.mocked(execFileSync).mockReturnValue("not-a-node-id");
    expect(() => host.ensureIdentityNodeId()).toThrow("invalid identity");
    expect(host.status().nodeId).toBeNull();
  });

  it("validates the full runtime asynchronously and yields to the event loop", async () => {
    acceptOfficialFixtures();
    let completed = false;
    const validation = host.validateRuntimeIntegrity().then(() => {
      completed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    await validation;
    expectNoBlockingWork();
  });

  it("validates only the probe while Off, without enumerating the Canvas tree", async () => {
    fs.rmSync(canvasRoot, { recursive: true });
    acceptOfficialFixtures(false);
    const readdir = vi.spyOn(fs.promises, "readdir");
    await expect(host.validateRuntimeIntegrity(false)).resolves.toBeUndefined();
    expect(readdir).not.toHaveBeenCalled();
    expectNoBlockingWork();
  });

  it("does not cache successful probe validation across status requests", async () => {
    acceptOfficialFixtures(false);
    await host.validateRuntimeIntegrity(false);
    fs.writeFileSync(path.join(root, "mxc", "wxc-exec.exe"), "tampered");
    await expect(host.validateRuntimeIntegrity(false)).rejects.toThrow("runtime hash mismatch");
    expectNoBlockingWork();
  });

  it.each([
    ["microclawHostPrepSha256", "MicroClaw MXC host-prep hash mismatch"],
    ["officialWxcHostPrepSha256", "Official MXC host-prep hash mismatch"],
    ["canvasHostSha256", "Canvas host hash mismatch"],
    ["canvasHostTreeSha256", "resource tree hash mismatch"],
  ])("rejects a mismatched %s in fresh enabled checks", async (field, error) => {
    manifest[field] = "0".repeat(64);
    saveManifest();
    acceptOfficialFixtures();
    await expect(host.validateRuntimeIntegrity()).rejects.toThrow(error);
    expectNoBlockingWork();
  });

  it("rejects changed Canvas resources after a previous successful validation", async () => {
    acceptOfficialFixtures();
    await host.validateRuntimeIntegrity();
    fs.writeFileSync(path.join(canvasRoot, "resource.dll"), "tampered");
    acceptOfficialFixtures();
    await expect(host.validateRuntimeIntegrity()).rejects.toThrow("resource tree hash mismatch");
    expectNoBlockingWork();
  });

  it("rejects missing files and malformed or incompatible manifests", async () => {
    manifest.mxcVersion = "wrong";
    saveManifest();
    await expect(host.validateRuntimeIntegrity(false)).rejects.toThrow("manifest does not match");
    fs.writeFileSync(path.join(root, "RUNTIME.json"), "{");
    await expect(host.validateRuntimeIntegrity(false)).rejects.toThrow();
    fs.rmSync(path.join(root, "RUNTIME.json"));
    await expect(host.validateRuntimeIntegrity(false)).rejects.toThrow();
    expectNoBlockingWork();
  });

  it("matches the existing tree hash including nested files, ordering and empty files", async () => {
    fs.mkdirSync(path.join(canvasRoot, "a"));
    fs.writeFileSync(path.join(canvasRoot, "a", "Z.dll"), "nested");
    fs.writeFileSync(path.join(canvasRoot, "a", "empty"), "");
    fs.writeFileSync(path.join(canvasRoot, "A.dll"), "uppercase");
    const expected = sha256DirectoryTree(canvasRoot);
    vi.clearAllMocks();
    expect(await sha256DirectoryTreeAsync(canvasRoot)).toBe(expected);
    expectNoBlockingWork();
  });

  it("rejects linked directories in the asynchronous tree hash", async () => {
    fs.symlinkSync(path.join(root, "host"), path.join(canvasRoot, "linked"), "junction");
    await expect(sha256DirectoryTreeAsync(canvasRoot)).rejects.toThrow("tree contains a link");
    expectNoBlockingWork();
  });

  it("retains fresh full-tree validation before launching a host", async () => {
    acceptOfficialFixtures();
    fs.writeFileSync(path.join(canvasRoot, "resource.dll"), "tampered");
    await expect(
      host.start({
        gatewayUrl: "ws://127.0.0.1:18789",
      } as Parameters<BundledWindowsNodeHost["start"]>[0]),
    ).rejects.toThrow("resource tree hash mismatch");
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
