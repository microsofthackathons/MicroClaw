export interface MxcStatusSnapshot<T> {
  status: T | null;
  verifiedAt: number | null;
  refreshing: boolean;
  error: string | null;
}

/** Display snapshots are never used to satisfy a fresh enforcement check. */
export class WindowsNodeMxcStatusCache<T> {
  private latest: { key: string; status: T; verifiedAt: number } | null = null;
  private failure: { key: string; message: string } | null = null;
  private pending = new Map<string, Promise<T>>();

  constructor(
    private readonly hooks: {
      key(): string;
      inspect(): Promise<T>;
      publish(snapshot: MxcStatusSnapshot<T>): void;
      now?: () => number;
    },
  ) {}

  snapshot(): MxcStatusSnapshot<T> {
    const key = this.hooks.key();
    const latest = this.latest?.key === key ? this.latest : null;
    return {
      status: latest?.status ?? null,
      verifiedAt: latest?.verifiedAt ?? null,
      refreshing: this.pending.has(key),
      error: this.failure?.key === key ? this.failure.message : null,
    };
  }

  display(): MxcStatusSnapshot<T> {
    const snapshot = this.snapshot();
    if (snapshot.verifiedAt === null || this.now() - snapshot.verifiedAt >= 10_000) {
      // Errors are published to the display and still reject enforcement callers.
      void this.fresh().catch(() => undefined);
    }
    return this.snapshot();
  }

  fresh(): Promise<T> {
    const key = this.hooks.key();
    const pending = this.pending.get(key);
    if (pending) return pending;
    const operation = Promise.resolve()
      .then(() => this.hooks.inspect())
      .then((status) => {
        if (this.hooks.key() !== key)
          throw new Error("MXC status changed during inspection; refresh the current state");
        this.latest = { key, status, verifiedAt: this.now() };
        this.failure = null;
        return status;
      })
      .catch((error: unknown) => {
        if (this.hooks.key() === key) {
          this.latest = null;
          this.failure = { key, message: error instanceof Error ? error.message : String(error) };
        }
        throw error;
      })
      .finally(() => {
        this.pending.delete(key);
        this.hooks.publish(this.snapshot());
      });
    this.pending.set(key, operation);
    return operation;
  }

  private now(): number {
    return this.hooks.now?.() ?? Date.now();
  }
}
