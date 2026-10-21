import type { ChatSessionRuntime } from "../../../src/chat-run-lifecycle";

export class ChatRunTracker {
  private runs = new Map<string, Map<string, number>>();
  private revisions = new Map<string, number>();
  private closed = new Set<string>();
  private committed = new Set<string>();

  revision(key: string): number {
    return this.revisions.get(key) ?? 0;
  }
  isClosed(key: string, id: string): boolean {
    return this.closed.has(`${key}\0${id}`);
  }
  outputCommitted(key: string, id: string): boolean {
    return this.committed.has(`${key}\0${id}`);
  }
  commitOutput(key: string, id: string): void {
    this.committed.add(`${key}\0${id}`);
    const oldest = this.committed.values().next().value;
    if (this.committed.size > 512 && oldest !== undefined) this.committed.delete(oldest);
  }
  private change(key: string) {
    this.revisions.set(key, this.revision(key) + 1);
  }
  begin(key: string, id: string): boolean {
    if (!id || this.isClosed(key, id)) return false;
    this.change(key);
    const runs = this.runs.get(key) ?? new Map<string, number>();
    if (!runs.has(id)) runs.set(id, Date.now());
    this.runs.set(key, runs);
    return true;
  }
  finish(key: string, id: string): void {
    if (!id) return;
    this.change(key);
    this.closed.add(`${key}\0${id}`);
    const oldest = this.closed.values().next().value;
    if (this.closed.size > 512 && oldest !== undefined) this.closed.delete(oldest);
    const runs = this.runs.get(key);
    runs?.delete(id);
    if (!runs?.size) this.runs.delete(key);
  }
  active(key: string, preferred?: string | null): { id: string; startedAt: number } | null {
    const runs = this.runs.get(key);
    const id = preferred && runs?.has(preferred) ? preferred : [...(runs?.keys() ?? [])].at(-1);
    const startedAt = id ? runs?.get(id) : undefined;
    return id && startedAt !== undefined ? { id, startedAt } : null;
  }
  snapshot(key: string, runtime: ChatSessionRuntime | undefined, revision: number): boolean {
    if (runtime === undefined || this.revision(key) !== revision) return false;
    if (
      runtime.key !== key ||
      typeof runtime.hasActiveRun !== "boolean" ||
      !Array.isArray(runtime.activeRunIds) ||
      !runtime.activeRunIds.every((id) => typeof id === "string" && id) ||
      runtime.hasActiveRun !== runtime.activeRunIds.length > 0
    ) {
      throw new Error("Invalid Gateway chat runtime snapshot");
    }
    const incoming = new Set(runtime.activeRunIds);
    for (const id of this.runs.get(key)?.keys() ?? []) {
      if (!incoming.has(id)) this.finish(key, id);
    }
    for (const id of incoming) this.begin(key, id);
    return true;
  }
}
