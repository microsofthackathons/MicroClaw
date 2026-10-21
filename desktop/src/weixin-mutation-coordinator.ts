export class WeixinMutationCoordinator {
  private inFlight = 0;
  private qrPending = false;
  private qrOutcomeUnknown = false;
  private qrClearWhenIdle = false;
  private gatewayEpoch = 0;
  private cancelling = false;
  private readonly idleWaiters = new Set<() => void>();

  async run<T>(assertMutable: () => void, operation: () => Promise<T>): Promise<T> {
    assertMutable();
    if (this.cancelling) throw new Error("WeChat login cancellation is still in progress");
    this.inFlight++;
    try {
      return await operation();
    } finally {
      this.inFlight--;
      if (!this.inFlight) {
        if (this.qrClearWhenIdle && !this.qrOutcomeUnknown) this.qrPending = false;
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    }
  }

  beginQr(): number {
    if (this.qrOutcomeUnknown) {
      throw new Error(
        "The previous WeChat login outcome is unconfirmed; stop its Gateway before starting another login",
      );
    }
    this.qrPending = true;
    this.qrClearWhenIdle = false;
    return this.gatewayEpoch;
  }

  settleKnownQrStart(hasQr: boolean, epoch = this.gatewayEpoch): void {
    if (epoch !== this.gatewayEpoch) return;
    this.qrClearWhenIdle = !hasQr;
    if (!hasQr && !this.qrOutcomeUnknown && this.inFlight <= 1) this.qrPending = false;
  }

  prepareCliLogin(): void {
    if (this.qrOutcomeUnknown || this.qrPending || this.inFlight > 1) {
      throw new Error(
        "A previous WeChat login may still be committing; finish it or explicitly stop its Gateway",
      );
    }
    this.qrClearWhenIdle = false;
  }

  requireQr(): number {
    if (!this.qrPending || this.qrClearWhenIdle)
      throw new Error("No current WeChat QR login is pending");
    return this.gatewayEpoch;
  }

  qrConnected(epoch = this.gatewayEpoch): void {
    if (epoch !== this.gatewayEpoch) return;
    this.qrPending = false;
  }

  qrUnconfirmed(epoch = this.gatewayEpoch): void {
    if (epoch !== this.gatewayEpoch) return;
    this.qrOutcomeUnknown = true;
  }

  async cancelQr(): Promise<void> {
    if (this.cancelling) throw new Error("WeChat login cancellation is still in progress");
    this.cancelling = true;
    try {
      if (this.inFlight) await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
      if (this.qrOutcomeUnknown) {
        throw new Error(
          "A WeChat login may still be committing; explicitly stop its Gateway before enabling MXC",
        );
      }
      this.qrPending = false;
      this.qrClearWhenIdle = false;
    } finally {
      this.cancelling = false;
    }
  }

  gatewayStopped(): void {
    this.gatewayEpoch++;
    this.qrPending = false;
    this.qrOutcomeUnknown = false;
    this.qrClearWhenIdle = false;
  }

  assertActivationAvailable(cliLoginRunning: boolean): void {
    if (
      this.inFlight ||
      this.cancelling ||
      this.qrPending ||
      this.qrOutcomeUnknown ||
      cliLoginRunning
    ) {
      throw new Error("Finish or cancel the pending WeChat account change before enabling MXC");
    }
  }
}
