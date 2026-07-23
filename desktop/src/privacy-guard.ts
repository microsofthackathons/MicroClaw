import * as path from "path";

export function isPathWithinDirectories(
  targetPath: unknown,
  directories: readonly string[],
): boolean {
  if (typeof targetPath !== "string" || !targetPath) return false;

  let target: string;
  try {
    target = path.resolve(targetPath).toLowerCase();
  } catch {
    return false;
  }

  return directories.some((directory) => {
    if (!directory) return false;
    let base: string;
    try {
      base = path.resolve(directory).toLowerCase();
    } catch {
      return false;
    }
    const relative = path.relative(base, target);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
  });
}

export function shouldRejectStrictFilePermission(
  privacyLevel: string,
  requestKind: unknown,
  targetPath: unknown,
  configuredDirectories: readonly string[],
): boolean {
  if (privacyLevel !== "strict") return false;
  return (
    requestKind !== "sensitive-file" || !isPathWithinDirectories(targetPath, configuredDirectories)
  );
}

export function shouldRejectStrictRuntimeGrant(privacyLevel: string): boolean {
  return privacyLevel === "strict";
}
