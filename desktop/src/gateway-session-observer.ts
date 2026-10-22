type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
const SUBSCRIPTION_ID = "microclaw-desktop-chat";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class GatewaySessionObserver {
  private wanted: string | null = null;
  private bound: { requested: string; key: string; agentId?: string } | null = null;
  private connected = false;
  private epoch = 0;
  private metadataSubscribed = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(private request: Request) {}

  select(key: string | null): Promise<void> {
    if (key !== null && !key.trim()) return Promise.reject(new Error("Invalid observed session"));
    this.wanted = key;
    return this.enqueue();
  }

  connect(): Promise<void> {
    this.disconnect();
    this.connected = true;
    return this.enqueue();
  }

  disconnect(): void {
    this.connected = false;
    this.epoch++;
    this.bound = null;
    this.metadataSubscribed = false;
  }

  accepts(payload: unknown): boolean {
    const value = record(payload);
    return Boolean(
      this.connected &&
      this.bound &&
      this.bound.requested === this.wanted &&
      value?.sessionKey === this.bound.key &&
      (value.agentId === undefined || value.agentId === this.bound.agentId),
    );
  }

  private enqueue(): Promise<void> {
    const operation = this.tail.then(() => this.synchronize());
    this.tail = operation.catch(() => {});
    return operation;
  }

  private async synchronize(): Promise<void> {
    if (!this.connected) return;
    const epoch = this.epoch;
    const current = () => this.connected && this.epoch === epoch;
    if (this.bound?.requested === this.wanted) return;
    if (this.bound) {
      await this.request("sessions.messages.unsubscribe", {
        key: this.bound.key,
        ...(this.bound.agentId ? { agentId: this.bound.agentId } : {}),
        subscriptionId: SUBSCRIPTION_ID,
      });
      if (!current()) return;
      this.bound = null;
    }
    if (!this.wanted) return;
    if (!this.metadataSubscribed) {
      // Lifecycle snapshots are catalog events; only the selected session is forwarded.
      const acknowledgement = record(await this.request("sessions.subscribe", {}));
      if (acknowledgement?.subscribed !== true) {
        throw new Error("Gateway rejected the session lifecycle subscription");
      }
      if (!current()) return;
      this.metadataSubscribed = true;
    }
    const requested = this.wanted;
    const agentId = /^agent:([^:]+):/.exec(requested)?.[1];
    const reply = record(
      await this.request("sessions.messages.subscribe", {
        key: requested,
        ...(agentId ? { agentId } : {}),
        subscriptionId: SUBSCRIPTION_ID,
      }),
    );
    if (!current()) return;
    if (
      reply?.subscribed !== true ||
      typeof reply.key !== "string" ||
      !reply.key ||
      (agentId && reply.agentId !== agentId)
    )
      throw new Error("Invalid Gateway session subscription acknowledgement");
    this.bound = {
      requested,
      key: reply.key,
      ...(typeof reply.agentId === "string" ? { agentId: reply.agentId } : {}),
    };
  }
}
