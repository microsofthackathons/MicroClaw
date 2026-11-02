import { lstatSync, type Stats } from "node:fs";
import { win32 } from "node:path";
import type { WindowsNodeMxcFolderPolicy } from "./windows-node-mxc-folder-transaction";

type InspectFolderPath = (candidate: string) => Pick<Stats, "isDirectory" | "isSymbolicLink">;

interface WindowsNodeMxcFolderStore {
  get(key: "windowsNodeMxcFolders"): WindowsNodeMxcFolderPolicy | undefined;
  set(key: "windowsNodeMxcFolders", policy: WindowsNodeMxcFolderPolicy): unknown;
}

function isMissingFolder(folderPath: string, inspectPath: InspectFolderPath): boolean {
  if (!/^[a-z]:[\\/]/i.test(folderPath)) return false;
  const fullPath = win32.normalize(folderPath);
  const root = win32.parse(fullPath).root;
  const components = [root, ...fullPath.slice(root.length).split("\\").filter(Boolean)];
  let currentPath = "";
  for (const component of components) {
    currentPath = currentPath ? win32.join(currentPath, component) : component;
    try {
      const metadata = inspectPath(currentPath);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) return false;
    } catch (error) {
      return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
    }
  }
  return false;
}

export function pruneMissingWindowsNodeMxcFolders(
  policy: WindowsNodeMxcFolderPolicy,
  inspectPath: InspectFolderPath = lstatSync,
): WindowsNodeMxcFolderPolicy {
  return {
    rw: policy.rw.filter((folderPath) => !isMissingFolder(folderPath, inspectPath)),
    ro: policy.ro.filter((folderPath) => !isMissingFolder(folderPath, inspectPath)),
  };
}

export function reconcileWindowsNodeMxcFolders(
  store: WindowsNodeMxcFolderStore,
  inspectPath: InspectFolderPath = lstatSync,
): WindowsNodeMxcFolderPolicy {
  const current = store.get("windowsNodeMxcFolders");
  if (!current) throw new Error("The saved MXC folder policy is unavailable");
  const next = pruneMissingWindowsNodeMxcFolders(current, inspectPath);
  if (next.rw.length !== current.rw.length || next.ro.length !== current.ro.length) {
    store.set("windowsNodeMxcFolders", next);
  }
  return next;
}
