// Explicit PowerShell requests remain valid; Gateway exec no longer selects this shell.
export function explicitPowerShellCommand(command, env = process.env) {
  const windowsRoot = (env.SystemRoot ?? env.WINDIR ?? "C:\\Windows").replace(/[\\/]+$/, "");
  return [
    `${windowsRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command,
  ];
}
