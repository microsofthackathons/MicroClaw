import { performance } from "node:perf_hooks";

export const RUNTIME_PREPARATION_TIMING_PREFIX = "MICROCLAW_RUNTIME_TIMING ";

interface RuntimeTimingDetails {
  cache?: "hit" | "miss";
  attempt?: number;
  errorCode?: string;
}

export interface RuntimePreparationTimingEvent extends RuntimeTimingDetails {
  scope: string;
  phase: string;
  kind: "phase" | "summary";
  status: "started" | "success" | "failed";
  elapsedMs: number;
  durationMs?: number;
}

export class RuntimePreparationTiming {
  constructor(
    private readonly scope: string,
    private readonly write: (message: string) => void = console.log,
    private readonly clock: () => number = () => performance.now(),
  ) {}

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
