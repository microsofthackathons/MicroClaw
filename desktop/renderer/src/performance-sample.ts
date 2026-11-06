export interface PerformanceChatEvent {
  sessionKey: string;
  runId: string;
  state: string;
  lifecyclePhase?: string;
}

export class PerformanceChatSample {
  sessionKey: string | null = null;
  runId: string | null = null;
  sessionReadyAt: number | null = null;
  sentAt: number | null = null;
  firstTextAt: number | null = null;
  finalRenderedAt: number | null = null;
  terminal: string | null = null;
  outcome: string | null = null;
  responseText: string | null = null;
  emptySessionVerified = false;
  private pendingEvents: PerformanceChatEvent[] = [];
  private pendingFirstText = new Map<string, number>();

  constructor(
    readonly startedAt: number,
    readonly previousSessionKey: string | null = null,
  ) {}

  sessionReady(sessionKey: string, now: number, messageCount = 0): void {
    if (this.sessionReadyAt !== null || this.outcome) return;
    this.sessionKey = sessionKey;
    if (sessionKey === this.previousSessionKey) {
      this.outcome = "session-not-new";
      return;
    }
    if (messageCount !== 0) {
      this.outcome = "session-not-empty";
      return;
    }
    this.emptySessionVerified = true;
    this.sessionReadyAt = now;
  }

  sent(now: number): void {
    if (this.sentAt === null) this.sentAt = now;
  }

  submitted(sessionKey: string, acknowledgment: unknown): void {
    if (this.outcome || this.sentAt === null || sessionKey !== this.sessionKey || this.runId)
      return;
    const runId =
      acknowledgment && typeof acknowledgment === "object" && "runId" in acknowledgment
        ? acknowledgment.runId
        : null;
    if (typeof runId !== "string" || !runId.trim()) {
      this.fail("missing-run-ack");
      return;
    }
    this.runId = runId;
    this.firstTextAt = this.pendingFirstText.get(runId) ?? null;
    const events = this.pendingEvents;
    this.pendingEvents = [];
    this.pendingFirstText.clear();
    for (const event of events) this.event(event);
  }

  fail(outcome: string): void {
    if (!this.outcome) this.outcome = outcome;
  }

  event(event: PerformanceChatEvent): void {
    if (
      this.outcome ||
      this.sentAt === null ||
      event.sessionKey !== this.sessionKey ||
      !event.runId ||
      (this.runId && this.runId !== event.runId)
    )
      return;
    if (!this.runId) {
      if (this.pendingEvents.length >= 256) this.fail("event-buffer-overflow");
      else this.pendingEvents.push(event);
      return;
    }
    if (event.state === "error" || event.lifecyclePhase === "error") {
      this.outcome = "model-error";
    } else if (event.state === "aborted") {
      this.outcome = "cancelled";
    } else if (event.state === "final") {
      this.terminal = "final";
    }
  }

  rendered(runId: string, text: string, settled: boolean, now: number): void {
    if (this.outcome || this.sentAt === null || !runId) return;
    const hasBody = Boolean(text.trim());
    if (!this.runId) {
      if (hasBody && !this.pendingFirstText.has(runId) && this.pendingFirstText.size < 32)
        this.pendingFirstText.set(runId, now);
      return;
    }
    if (runId !== this.runId) return;
    if (hasBody && this.firstTextAt === null) this.firstTextAt = now;
    if (this.terminal === "final" && settled) {
      this.outcome = hasBody ? "success" : "empty-response";
      if (hasBody) {
        this.finalRenderedAt = now;
        this.responseText = text.trim();
      }
    }
  }

  snapshot() {
    return {
      sessionKey: this.sessionKey,
      previousSessionKey: this.previousSessionKey,
      emptySessionVerified: this.emptySessionVerified,
      runId: this.runId,
      outcome: this.outcome,
      responseText: this.responseText,
      metrics: {
        totalMs: this.finalRenderedAt === null ? null : this.finalRenderedAt - this.startedAt,
        sessionReadyMs: this.sessionReadyAt === null ? null : this.sessionReadyAt - this.startedAt,
        sendToFirstTextMs:
          this.firstTextAt === null || this.sentAt === null ? null : this.firstTextAt - this.sentAt,
        sendToFinalRenderedMs:
          this.finalRenderedAt === null || this.sentAt === null
            ? null
            : this.finalRenderedAt - this.sentAt,
      },
    };
  }
}
