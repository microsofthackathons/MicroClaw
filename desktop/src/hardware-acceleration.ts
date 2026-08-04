export function shouldDisableHardwareAcceleration(environment: NodeJS.ProcessEnv): boolean {
  return environment.ELECTRON_DISABLE_GPU === "1";
}
