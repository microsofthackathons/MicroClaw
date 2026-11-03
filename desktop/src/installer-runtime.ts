import { performance } from "node:perf_hooks";
import { RuntimePreparationTiming } from "./runtime-preparation-timing";

export const INSTALLER_RUNTIME_ARGUMENT = "--prepare-installer-runtime";
export const INSTALLER_RUNTIME_RECEIPT = "MICROCLAW_INSTALLER_RUNTIME ";

export async function prepareInstallerRuntime(
  prepare: (timing: RuntimePreparationTiming) => Promise<string | null>,
  write: (message: string) => void = console.log,
): Promise<number> {
  const timing = new RuntimePreparationTiming("desktop", write);
  timing.record("desktop-startup", "success", performance.now());
  const finish = timing.start("preparation-total", "summary");
  try {
    const runtimeRoot = await prepare(timing);
    if (!runtimeRoot) throw new Error("The packaged OpenClaw runtime is unavailable");
    finish("success");
    write(`${INSTALLER_RUNTIME_RECEIPT}${JSON.stringify({ runtimeRoot })}`);
    return 0;
  } catch (error) {
    finish("failed");
    write(
      `[runtime] Installer preparation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
