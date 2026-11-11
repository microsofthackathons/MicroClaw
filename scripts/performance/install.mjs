import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export function collectInstallTiming(logs, request) {
  const events = logs
    .flatMap((log) => log.split(/\r?\n/))
    .flatMap((line) => {
      const prefix = ["MICROCLAW_INSTALL_TIMING ", "MICROCLAW_RUNTIME_TIMING "].find((value) =>
        line.includes(value),
      );
      if (!prefix) return [];
      const offset = line.indexOf(prefix);
      if (offset < 0) return [];
      try {
        const event = JSON.parse(line.slice(offset + prefix.length));
        if (
          event.schemaVersion !== 2 ||
          event.runId !== request.runId ||
          event.sampleId !== request.sampleId ||
          !["step", "phase", "summary"].includes(event.kind) ||
          !["started", "success", "failed", "timeout", "cancelled"].includes(event.status) ||
          typeof event.stageId !== "string" ||
          typeof event.phase !== "string" ||
          !Number.isFinite(event.elapsedMs) ||
          event.elapsedMs < 0
        )
          return [];
        const selected = Object.fromEntries(
          ["stageId", "phase", "kind", "status", "elapsedMs"].map((key) => [key, event[key]]),
        );
        selected.scope = ["installer", "desktop", "worker"].includes(event.scope)
          ? event.scope
          : "installer";
        if (["hit", "miss"].includes(event.cache)) selected.cache = event.cache;
        for (const key of ["durationMs", "humanWaitMs", "activeMs", "attempt", "stepCount"])
          if (Number.isFinite(event[key]) && event[key] >= 0) selected[key] = event[key];
        return [selected];
      } catch {
        return [];
      }
    });
  const summary = events.findLast(
    (event) =>
      event.phase === "installation-total" &&
      event.kind === "summary" &&
      event.status !== "started" &&
      Number.isFinite(event.durationMs),
  );
  const steps = events.filter((event) => event.kind === "step");
  const complete =
    summary &&
    Number.isSafeInteger(summary.stepCount) &&
    steps.filter((event) => event.status !== "started" && Number.isFinite(event.durationMs))
      .length === summary.stepCount &&
    steps
      .filter((event) => event.status === "started")
      .every((start) =>
        steps.some((end) => end.stageId === start.stageId && end.status !== "started"),
      );
  return {
    version: 2,
    coverage: complete ? "complete" : events.length ? "partial" : "unavailable",
    events,
  };
}

export function validateInstallFixture(value) {
  if (
    value?.kind !== "microclaw.performance.install-vm.v2" ||
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
    result.schemaVersion !== 2 ||
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
      result.installationComplete !== true ||
      result.finalValidation !== true ||
      !Number.isFinite(result.metrics?.totalMs) ||
      result.metrics.totalMs < 0)
  )
    throw new Error(
      "Successful clean installation requires restored/clean fixture, installation completion, final validation and timing",
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
    schemaVersion: 2,
    runId: context.runId,
    sampleId: context.sampleId,
    operation: "restore-and-install",
    installer: context.installer ?? null,
    imageId: fixture.imageId,
    vmId: fixture.vmId,
    requiredBoundary: "confirmation-through-installation-completion-and-final-validation",
    timeoutMs: context.timeoutMs,
    timingEnvironment: {
      MICROCLAW_PERF_RUN_ID: context.runId,
      MICROCLAW_PERF_SAMPLE_ID: context.sampleId,
    },
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
  const logs = [];
  for (const file of result.evidence ?? [])
    logs.push(await readFile(path.join(context.output, file), "utf8"));
  result.installTiming = collectInstallTiming(logs, request);
  result.evidence = [
    ...(result.evidence ?? []),
    path.basename(requestPath),
    path.basename(resultPath),
  ];
  return result;
}
