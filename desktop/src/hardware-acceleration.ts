const MAX_TESTED_WINDOWS_BUILD = 26100;

export function shouldDisableHardwareAcceleration(
  environment: NodeJS.ProcessEnv,
  platform = "",
  osRelease = "",
): boolean {
  if (environment.ELECTRON_DISABLE_GPU === "1") return true;
  if (platform !== "win32") return false;

  const build = Number.parseInt(osRelease.split(".")[2] ?? "", 10);
  return Number.isFinite(build) && build > MAX_TESTED_WINDOWS_BUILD;
}
