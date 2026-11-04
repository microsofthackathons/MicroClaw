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
  private displayRefreshes = new Map<string, Promise<void>>();

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
      this.refreshDisplay();
    }
    return this.snapshot();
  }

  fresh(): Promise<T> {
    return this.freshForKey(this.hooks.key());
  }

  private freshForKey(key: string): Promise<T> {
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
    try {
      this.hooks.publish(this.snapshot());
    } catch (error) {
      void operation.catch((completionError: unknown) =>
        console.error("[windows-node-mxc] Status inspection failed:", completionError),
      );
      throw error;
    }
    return operation;
  }

  private refreshDisplay(attempt = 0): void {
    const key = this.hooks.key();
    if (this.displayRefreshes.has(key)) return;
    const refresh = this.freshForKey(key)
      .then(
        () => undefined,
        (error: unknown) => {
          if (this.hooks.key() === key) {
            if (this.failure?.key !== key) throw error;
            return;
          }
          const current = this.snapshot();
          if (current.verifiedAt !== null) return;
          if (attempt < 2) {
            this.refreshDisplay(attempt + 1);
            return;
          }
          if (current.refreshing && this.displayRefreshes.has(this.hooks.key())) return;
          this.failure = {
            key: this.hooks.key(),
            message: "MXC status changed repeatedly during inspection; refresh the current state",
          };
          this.hooks.publish(this.snapshot());
        },
      )
      .catch((error: unknown) => {
        this.hooks.publish({
          status: null,
          verifiedAt: null,
          refreshing: false,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .catch((error: unknown) => {
        console.error("[windows-node-mxc] Could not publish status-refresh failure:", error);
      })
      .finally(() => {
        if (this.displayRefreshes.get(key) === refresh) this.displayRefreshes.delete(key);
      });
    this.displayRefreshes.set(key, refresh);
  }

  private now(): number {
    return this.hooks.now?.() ?? Date.now();
  }
}
