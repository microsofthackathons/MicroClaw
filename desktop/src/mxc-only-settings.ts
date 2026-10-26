import {
  migrateWindowsNodeMxcSelection,
  type WindowsNodeMxcSelection,
} from "./windows-node-mxc-modes";
import type { WindowsNodeMxcFolderPolicy } from "./windows-node-mxc-folder-transaction";

const RETIRED_SETTINGS = [
  "securityMode",
  "sandboxEnabled",
  "sandboxExternalApps",
  "sandboxCapabilities",
  "sandboxUserDirsRW",
  "sandboxUserDirsRO",
  "sandboxGrantHistory",
  "windowsNodeMxcPreviousSandboxEnabled",
] as const;

function folderPaths(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`Invalid saved MXC folder policy: ${key}`);
  }
  return [...value];
}

export function migrateMxcOnlySecuritySettings<T extends Record<string, unknown>>(
  settings: T,
): T & {
  windowsNodeMxcSelection: WindowsNodeMxcSelection;
  windowsNodeMxcFolders: WindowsNodeMxcFolderPolicy;
} {
  const folders = settings.windowsNodeMxcFolders;
  if (
    folders !== undefined &&
    (!folders || typeof folders !== "object" || Array.isArray(folders))
  ) {
    throw new Error("Invalid saved MXC folder policy");
  }
  const current = folders as Record<string, unknown> | undefined;
  const migrated = {
    ...settings,
    windowsNodeMxcSelection: migrateWindowsNodeMxcSelection(
      settings.windowsNodeMxcSelection,
      settings.securityMode === "windows-node-mxc",
    ),
    windowsNodeMxcFolders: {
      rw: folderPaths(current ? current.rw : settings.sandboxUserDirsRW, "rw"),
      ro: folderPaths(current ? current.ro : settings.sandboxUserDirsRO, "ro"),
    },
  };
  for (const key of RETIRED_SETTINGS) Reflect.deleteProperty(migrated, key);
  return migrated;
}
