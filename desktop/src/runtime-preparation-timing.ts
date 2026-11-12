import { performance } from "node:perf_hooks";

export const RUNTIME_PREPARATION_TIMING_PREFIX = "MICROCLAW_RUNTIME_TIMING ";

interface RuntimeTimingDetails {
  cache?: "hit" | "miss";
  attempt?: number;
  errorCode?: string;
  concurrency?: number;
  fileCount?: number;
  byteCount?: number;
}

export interface RuntimePreparationTimingEvent extends RuntimeTimingDetails {
  scope: string;
  phase: string;
  kind: "phase" | "summary";
  status: "started" | "success" | "failed";
  elapsedMs: number;
  durationMs?: number;
}

// Only timing fields cross the worker/log boundary; never forward arbitrary output.
export function parseRuntimeTiming(message: unknown): RuntimePreparationTimingEvent | null {
  if (typeof message !== "string" || !message.startsWith(RUNTIME_PREPARATION_TIMING_PREFIX))
    return null;
  try {
    const value = JSON.parse(message.slice(RUNTIME_PREPARATION_TIMING_PREFIX.length));
    if (
      !value ||
      typeof value.scope !== "string" ||
      typeof value.phase !== "string" ||
      !["phase", "summary"].includes(value.kind) ||
      !["started", "success", "failed"].includes(value.status) ||
      !Number.isFinite(value.elapsedMs) ||
      value.elapsedMs < 0 ||
      (value.durationMs !== undefined &&
        (!Number.isFinite(value.durationMs) || value.durationMs < 0))
    )
      return null;
    return {
      scope: value.scope,
      phase: value.phase,
      kind: value.kind,
      status: value.status,
      elapsedMs: value.elapsedMs,
      ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
      ...(["hit", "miss"].includes(value.cache) ? { cache: value.cache } : {}),
      ...(Number.isSafeInteger(value.attempt) && value.attempt > 0
        ? { attempt: value.attempt }
        : {}),
      ...(typeof value.errorCode === "string" ? { errorCode: value.errorCode } : {}),
      ...(Number.isSafeInteger(value.concurrency) && value.concurrency >= 0
        ? { concurrency: value.concurrency }
        : {}),
      ...(Number.isSafeInteger(value.fileCount) && value.fileCount >= 0
        ? { fileCount: value.fileCount }
        : {}),
      ...(Number.isSafeInteger(value.byteCount) && value.byteCount >= 0
        ? { byteCount: value.byteCount }
        : {}),
    };
  } catch {
    return null;
  }
}

export class RuntimePreparationTiming {
  constructor(
    private readonly scope: string,
    private readonly write: (message: string) => void = console.log,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  forward(message: unknown): void {
    const event = parseRuntimeTiming(message);
    if (!event) return;
    try {
      this.write(`${RUNTIME_PREPARATION_TIMING_PREFIX}${JSON.stringify(event)}`);
    } catch {
      /* Diagnostics must not change runtime preparation. */
    }
  }

  record(
    phase: string,
    status: RuntimePreparationTimingEvent["status"],
    durationMs?: number,
    details: RuntimeTimingDetails = {},
    kind: RuntimePreparationTimingEvent["kind"] = "phase",
  ): void {
    try {
      const event: RuntimePreparationTimingEvent = {
        scope: this.scope,
        phase,
        kind,
        status,
        elapsedMs: Math.max(0, Math.round(this.clock())),
        ...details,
        ...(durationMs === undefined ? {} : { durationMs: Math.max(0, Math.round(durationMs)) }),
      };
      this.write(`${RUNTIME_PREPARATION_TIMING_PREFIX}${JSON.stringify(event)}`);
    } catch {
      return;
    }
  }

  start(phase: string, kind: RuntimePreparationTimingEvent["kind"] = "phase") {
    const startedAt = this.clock();
    this.record(phase, "started", undefined, {}, kind);
    let finished = false;
    return (status: "success" | "failed", details: RuntimeTimingDetails = {}) => {
      if (finished) return;
      finished = true;
      this.record(phase, status, this.clock() - startedAt, details, kind);
    };
  }

  measure<Result>(
    phase: string,
    operation: () => Result,
    details?: (result: Result) => RuntimeTimingDetails,
  ): Result {
    const finish = this.start(phase);
    try {
      const result = operation();
      finish("success", details?.(result));
      return result;
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException)?.code;
      finish("failed", typeof errorCode === "string" ? { errorCode } : {});
      throw error;
    }
  }
}

export function measureRuntimePhase<Result>(
  timing: RuntimePreparationTiming | undefined,
  phase: string,
  operation: () => Result,
  details?: (result: Result) => RuntimeTimingDetails,
): Result {
  return timing ? timing.measure(phase, operation, details) : operation();
}
