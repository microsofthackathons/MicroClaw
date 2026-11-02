import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export function validateInstallFixture(value) {
  if (
    value?.kind !== "microclaw.performance.install-vm.v1" ||
    value.disposable !== true ||
    value.restorePerSample !== true ||
    !value.imageId ||
    !value.vmId ||
    !path.isAbsolute(value.executable ?? "") ||
    !Array.isArray(value.args) ||
    value.args.some((argument) => typeof argument !== "string")
  )
    throw new Error(
      "Install adapter must explicitly identify a disposable, restored-per-sample VM and an absolute executable",
    );
  return value;
}

export function validateInstallResult(result, request) {
  if (
    result.schemaVersion !== 1 ||
    result.runId !== request.runId ||
    result.sampleId !== request.sampleId
  ) {
    throw new Error("Install adapter result identity does not match this attempt");
  }
  if (!["success", "failed", "timeout", "cancelled"].includes(result.outcome))
    throw new Error("Invalid install adapter outcome");
  if (!Number.isFinite(result.elapsedMs) || result.elapsedMs < 0)
    throw new Error("Install adapter omitted attempt elapsed time");
  if (
    result.outcome === "success" &&
    (result.restored !== true ||
      result.clean !== true ||
      result.serviceReady !== true ||
      result.finalValidation !== true ||
      !Number.isFinite(result.metrics?.totalMs) ||
      result.metrics.totalMs < 0)
  )
    throw new Error(
      "Successful clean installation requires restored/clean fixture, service readiness, final validation and timing",
    );
  for (const value of Object.values(result.metrics ?? {})) {
    if (value !== null && (!Number.isFinite(value) || value < 0))
      throw new Error("Invalid install metric");
  }
  if (
    result.evidence !== undefined &&
    (!Array.isArray(result.evidence) ||
      result.evidence.some(
        (file) =>
          typeof file !== "string" ||
          !file ||
          path.isAbsolute(file) ||
          file.split(/[\\/]/).includes(".."),
      ))
  ) {
    throw new Error("Install evidence paths must be relative to this run directory");
  }
  return result;
}

export async function runInstall(fixture, context) {
  const request = {
    schemaVersion: 1,
    runId: context.runId,
    sampleId: context.sampleId,
    operation: "restore-and-install",
    installer: context.installer ?? null,
    imageId: fixture.imageId,
    vmId: fixture.vmId,
    requiredBoundary: "confirmation-through-service-readiness-and-final-validation",
    timeoutMs: context.timeoutMs,
  };
  const requestPath = path.join(context.output, `${context.sampleId}.install-request.json`);
  const resultPath = path.join(context.output, `${context.sampleId}.install-result.json`);
  await writeFile(requestPath, JSON.stringify(request, null, 2));
  await execute(
    fixture.executable,
    [...fixture.args, "--request", requestPath, "--result", resultPath],
    {
      cwd: context.output,
      timeout: context.timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      signal: context.signal,
    },
  );
  const result = validateInstallResult(JSON.parse(await readFile(resultPath, "utf8")), request);
  result.evidence = [
    ...(result.evidence ?? []),
    path.basename(requestPath),
    path.basename(resultPath),
  ];
  return result;
}
