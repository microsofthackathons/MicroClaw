import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  pruneMissingWindowsNodeMxcFolders,
  reconcileWindowsNodeMxcFolders,
} from "./windows-node-mxc-folder-cleanup";
import type { WindowsNodeMxcFolderPolicy } from "./windows-node-mxc-folder-transaction";

const directory = { isDirectory: () => true, isSymbolicLink: () => false };

function inspectMissing(...missingPaths: string[]) {
  return vi.fn((candidate: string) => {
    if (missingPaths.includes(candidate)) {
      throw Object.assign(new Error("Path does not exist"), { code: "ENOENT" });
    }
    return directory;
  });
}

function createStore(initial: WindowsNodeMxcFolderPolicy) {
  let saved = structuredClone(initial);
  return {
    get: vi.fn(() => structuredClone(saved)),
    set: vi.fn((_key: string, next: WindowsNodeMxcFolderPolicy) => {
      saved = structuredClone(next);
    }),
  };
}

describe("missing MXC folder cleanup", () => {
  it("removes missing RO and RW grants without changing valid grants or the input", () => {
    const policy = {
      ro: ["C:\\Gone", "D:\\Reference"],
      rw: ["C:\\Work", "D:\\Removed"],
    };
    expect(
      pruneMissingWindowsNodeMxcFolders(policy, inspectMissing("C:\\Gone", "D:\\Removed")),
    ).toEqual({ ro: ["D:\\Reference"], rw: ["C:\\Work"] });
    expect(policy).toEqual({
      ro: ["C:\\Gone", "D:\\Reference"],
      rw: ["C:\\Work", "D:\\Removed"],
    });
  });

  it("removes grants whose drive or parent directory no longer exists", () => {
    expect(
      pruneMissingWindowsNodeMxcFolders(
        { ro: ["D:\\Reference"], rw: ["C:\\Removed\\Work"] },
        inspectMissing("D:\\", "C:\\Removed"),
      ),
    ).toEqual({ ro: [], rw: [] });
  });

  it("persists deletions once and never restores them when directories reappear", () => {
    const store = createStore({ ro: ["C:\\Gone"], rw: ["C:\\Work"] });
    const cleaned = reconcileWindowsNodeMxcFolders(store, inspectMissing("C:\\Gone"));
    expect(cleaned).toEqual({ ro: [], rw: ["C:\\Work"] });
    expect(store.set).toHaveBeenCalledExactlyOnceWith("windowsNodeMxcFolders", cleaned);
    expect(store.get()).toEqual(cleaned);
    expect(reconcileWindowsNodeMxcFolders(store, inspectMissing())).toEqual(cleaned);
    expect(store.set).toHaveBeenCalledTimes(1);
  });

  it("persists an empty policy when every grant is missing", () => {
    const store = createStore({ ro: ["C:\\Gone"], rw: ["D:\\Gone"] });
    expect(reconcileWindowsNodeMxcFolders(store, inspectMissing("C:\\Gone", "D:\\Gone"))).toEqual({
      ro: [],
      rw: [],
    });
    expect(store.get()).toEqual({ ro: [], rw: [] });
  });

  it("does not rewrite an unchanged policy", () => {
    const store = createStore({ ro: ["C:\\Reference"], rw: ["C:\\Work"] });
    expect(reconcileWindowsNodeMxcFolders(store, inspectMissing())).toEqual(store.get());
    expect(store.set).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "EPERM", "EIO", "ENOTDIR"])(
    "does not mistake %s for a missing grant",
    (code) => {
      const store = createStore({ ro: ["C:\\Gone", "C:\\Unknown"], rw: [] });
      const inspector = vi.fn((candidate: string) => {
        if (candidate === "C:\\Gone") {
          throw Object.assign(new Error("Missing"), { code: "ENOENT" });
        }
        if (candidate === "C:\\Unknown") {
          throw Object.assign(new Error("Inspection failed"), { code });
        }
        return directory;
      });
      expect(reconcileWindowsNodeMxcFolders(store, inspector)).toEqual({
        ro: ["C:\\Unknown"],
        rw: [],
      });
      expect(store.get()).toEqual({ ro: ["C:\\Unknown"], rw: [] });
    },
  );

  it("retains invalid namespaces for the existing policy validator to reject", () => {
    const policy = {
      ro: ["relative\\folder", "C:relative", "\\\\server\\share", "\\\\?\\C:\\Work"],
      rw: ["\\Device\\HarddiskVolume1\\Work"],
    };
    const inspector = inspectMissing();
    expect(pruneMissingWindowsNodeMxcFolders(policy, inspector)).toEqual(policy);
    expect(inspector).not.toHaveBeenCalled();
  });

  it("retains files and reparse components rather than bypassing native validation", () => {
    const policy = { ro: ["C:\\File", "C:\\Link\\Missing"], rw: [] };
    const inspector = vi.fn((candidate: string) => {
      if (candidate === "C:\\File") {
        return { isDirectory: () => false, isSymbolicLink: () => false };
      }
      if (candidate === "C:\\Link") {
        return { isDirectory: () => false, isSymbolicLink: () => true };
      }
      if (candidate === "C:\\Link\\Missing") {
        throw Object.assign(new Error("Missing link target"), { code: "ENOENT" });
      }
      return directory;
    });
    expect(pruneMissingWindowsNodeMxcFolders(policy, inspector)).toEqual(policy);
    expect(inspector).not.toHaveBeenCalledWith("C:\\Link\\Missing");
  });

  it("does not proceed with an unpersisted cleanup if saving fails", () => {
    const store = createStore({ ro: ["C:\\Gone"], rw: [] });
    store.set.mockImplementation(() => {
      throw new Error("Settings write failed");
    });
    expect(() => reconcileWindowsNodeMxcFolders(store, inspectMissing("C:\\Gone"))).toThrow(
      "Settings write failed",
    );
    expect(store.get()).toEqual({ ro: ["C:\\Gone"], rw: [] });
  });

  it.runIf(process.platform === "win32")(
    "cleans real missing folders but preserves dangling junctions for rejection",
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "microclaw-folder-cleanup-"));
      try {
        const valid = path.join(root, "valid");
        const missing = path.join(root, "missing");
        const target = path.join(root, "target");
        const junction = path.join(root, "junction");
        mkdirSync(valid);
        mkdirSync(target);
        symlinkSync(target, junction, "junction");
        rmSync(target, { recursive: true });
        const store = createStore({ ro: [missing, junction], rw: [valid] });
        expect(reconcileWindowsNodeMxcFolders(store)).toEqual({ ro: [junction], rw: [valid] });
        mkdirSync(missing);
        expect(reconcileWindowsNodeMxcFolders(store)).toEqual({ ro: [junction], rw: [valid] });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
