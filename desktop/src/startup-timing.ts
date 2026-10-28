import { performance } from "perf_hooks";

type StartupOwner = "microclaw" | "openclaw" | "integration";
type GatewayStartupMode = "pending" | "spawned" | "reused";

interface StartupTimingContext {
  attempt: number;
  gatewayGeneration: string | null;
  mode: GatewayStartupMode;
  phase: string;
  appElapsedMs: number;
}

interface StartupPhaseTiming extends StartupTimingContext {
  kind: "phase";
  owner: StartupOwner;
  durationMs: number;
}

interface StartupSummaryTiming extends StartupTimingContext {
  kind: "summary";
  appBeforeAttemptMs: number;
  microclawPreflightMs: number;
  openclawHttpMs: number | null;
  integrationMs: number | null;
  attemptElapsedMs: number;
}

export type StartupTimingEvent = StartupPhaseTiming | StartupSummaryTiming;

export class GatewayStartupTiming {
  private readonly startedAt: number;
  private phaseStartedAt: number;
  private generation: string | null = null;
  private mode: GatewayStartupMode = "pending";
  private preparedAt: number | null = null;
  private httpReadyAt: number | null = null;
  private integrationStartedAt: number | null = null;
  private readonly milestones = new Set<string>();

  constructor(
    private readonly attempt: number,
    private readonly write: (event: StartupTimingEvent) => void,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.startedAt = now();
    this.phaseStartedAt = this.startedAt;
  }

  completeMicroclawPhase(phase: string): void {
    const now = this.now();
    this.recordPhase("microclaw", phase, this.phaseStartedAt, now);
    this.phaseStartedAt = now;
  }

  spawned(generation: string): void {
    this.generation = generation;
    this.mode = "spawned";
    this.completeMicroclawPhase("spawn-preparation");
    this.preparedAt = this.phaseStartedAt;
  }

  reused(generation: string | null): void {
    this.generation = generation;
    this.mode = "reused";
    this.completeMicroclawPhase("reuse-preparation");
    this.preparedAt = this.phaseStartedAt;
    this.integrationStartedAt = this.preparedAt;
    this.summarize("gateway-reused", this.preparedAt);
  }

  httpReady(): void {
    if (this.mode !== "spawned" || this.preparedAt === null || this.httpReadyAt !== null) {
      return;
    }
    this.httpReadyAt = this.now();
    this.integrationStartedAt = this.httpReadyAt;
    this.recordPhase("openclaw", "gateway-http-ready", this.preparedAt, this.httpReadyAt);
    this.summarize("gateway-http-ready", this.httpReadyAt);
  }

  connected(generation: string | null): void {
    this.markIntegration("gateway-ws-connected", generation);
  }

  serviceReady(generation: string | null): void {
    this.markIntegration("application-service-ready", generation);
  }

  historyReady(generation: string | null): void {
    this.markIntegration("first-history-response", generation);
  }

  private markIntegration(phase: string, generation: string | null): void {
    if (this.preparedAt === null || this.generation !== generation || this.milestones.has(phase)) {
      return;
    }
    this.milestones.add(phase);
    const now = this.now();
    this.recordPhase("integration", phase, this.integrationStartedAt ?? this.preparedAt, now);
    this.integrationStartedAt = now;
    this.summarize(phase, now);
  }

  private context(phase: string, now: number): StartupTimingContext {
    return {
      attempt: this.attempt,
      gatewayGeneration: this.generation,
      mode: this.mode,
      phase,
      appElapsedMs: Math.round(now),
    };
  }

  private recordPhase(owner: StartupOwner, phase: string, startedAt: number, now: number): void {
    this.write({
      ...this.context(phase, now),
      kind: "phase",
      owner,
      durationMs: Math.round(now - startedAt),
    });
  }

  private summarize(phase: string, now: number): void {
    this.write({
      ...this.context(phase, now),
      kind: "summary",
      appBeforeAttemptMs: Math.round(this.startedAt),
      microclawPreflightMs: Math.round((this.preparedAt ?? now) - this.startedAt),
      openclawHttpMs:
        this.mode === "spawned" && this.httpReadyAt !== null && this.preparedAt !== null
          ? Math.round(this.httpReadyAt - this.preparedAt)
          : null,
      integrationMs:
        this.httpReadyAt !== null
          ? Math.round(now - this.httpReadyAt)
          : this.mode === "reused" && this.preparedAt !== null
            ? Math.round(now - this.preparedAt)
            : null,
      attemptElapsedMs: Math.round(now - this.startedAt),
    });
  }
}
