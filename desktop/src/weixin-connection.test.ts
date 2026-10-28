import { describe, expect, it, vi } from "vitest";
import {
  ensureDefaultWeixinPlugin,
  getWeixinRuntimeConnection,
  WeixinQrSession,
} from "./weixin-connection";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const qr = { ok: true, sessionKey: "session-one", qrDataUrl: "qr-one", message: "Scan" };

describe("WeChat QR session owned by the main process", () => {
  it("deduplicates starts and reuses a QR while the long poll is unresolved", async () => {
    const session = new WeixinQrSession();
    const startResult = deferred<typeof qr>();
    const waitResult = deferred<{ connected: boolean; message: string }>();
    const start = vi.fn(() => startResult.promise);
    const wait = vi.fn(() => waitResult.promise);
    const first = session.start(start, wait);
    const second = session.start(start, wait);
    expect(first).toBe(second);
    expect(session.status.state).toBe("starting");
    startResult.resolve(qr);
    await first;
    expect(await session.start(start, wait)).toEqual(qr);
    expect(start).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledExactlyOnceWith("session-one");
    waitResult.resolve({ connected: true, message: "Connected" });
    await vi.waitFor(() => expect(session.status.state).toBe("connected"));
  });

  it("stops polling an expired QR and only starts another login on request", async () => {
    const session = new WeixinQrSession();
    const wait = vi.fn().mockResolvedValue({ connected: false, expired: true, message: "Expired" });
    const start = vi.fn().mockResolvedValue(qr);
    await session.start(start, wait);
    await vi.waitFor(() => expect(session.status.state).toBe("expired"));
    expect(session.status.qrDataUrl).toBe("qr-one");
    expect(start).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);
    await session.start(start, wait);
    expect(start).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("cancels the owned session and ignores a late poll response", async () => {
    const session = new WeixinQrSession();
    const pending = deferred<{ connected: boolean; message: string }>();
    const wait = vi.fn(() => pending.promise);
    await session.start(async () => qr, wait);
    const cancel = vi.fn(async () => {
      pending.resolve({ connected: true, message: "Late response" });
    });
    await session.cancel(cancel);
    expect(cancel).toHaveBeenCalledExactlyOnceWith("session-one");
    expect(session.status).toEqual({ state: "idle", message: "" });
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("cancels a QR that is still being created without beginning a poll", async () => {
    const session = new WeixinQrSession();
    const creation = deferred<typeof qr>();
    const wait = vi.fn();
    const starting = session.start(() => creation.promise, wait);
    const cancel = vi.fn().mockResolvedValue(undefined);
    const stopping = session.cancel(cancel);
    expect(session.status.state).toBe("idle");
    creation.resolve(qr);
    await starting;
    await stopping;
    expect(cancel).toHaveBeenCalledExactlyOnceWith("session-one");
    expect(wait).not.toHaveBeenCalled();
    expect(session.status.state).toBe("idle");
  });

  it("queues an explicit new connection until the cancelled writer is drained", async () => {
    const session = new WeixinQrSession();
    const poll = deferred<{ connected: boolean; message: string }>();
    await session.start(
      async () => qr,
      () => poll.promise,
    );
    const acknowledged = deferred<void>();
    const stopping = session.cancel(async () => {
      poll.resolve({ connected: false, message: "Cancelled" });
      await acknowledged.promise;
    });
    const start = vi.fn().mockResolvedValue({ ...qr, sessionKey: "session-two" });
    const reconnecting = session.start(start, async () => ({
      connected: true,
      message: "Connected",
    }));
    expect(start).not.toHaveBeenCalled();
    acknowledged.resolve();
    await stopping;
    await reconnecting;
    expect(start).toHaveBeenCalledTimes(1);
    expect(session.status.state).toBe("connected");
  });

  it("ignores a late response from a stopped Gateway", async () => {
    const session = new WeixinQrSession();
    const pending = deferred<{ connected: boolean; message: string }>();
    await session.start(
      async () => qr,
      () => pending.promise,
    );
    session.reset();
    pending.resolve({ connected: true, message: "Old connection" });
    await Promise.resolve();
    expect(session.status).toEqual({ state: "idle", message: "" });
  });

  it("does not start a queued connection that was closed before cancellation finished", async () => {
    const session = new WeixinQrSession();
    const poll = deferred<{ connected: boolean; message: string }>();
    await session.start(
      async () => qr,
      () => poll.promise,
    );
    const acknowledged = deferred<void>();
    const stopping = session.cancel(async () => {
      poll.resolve({ connected: false, message: "Cancelled" });
      await acknowledged.promise;
    });
    const start = vi.fn().mockResolvedValue(qr);
    const queued = session.start(start, vi.fn());
    const closingAgain = session.cancel(vi.fn());
    acknowledged.resolve();
    await stopping;
    await closingAgain;
    expect((await queued).ok).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(session.status.state).toBe("idle");
  });

  it("does not start a poll after a start failure or missing session key", async () => {
    const session = new WeixinQrSession();
    const wait = vi.fn();
    await session.start(async () => ({ ...qr, sessionKey: undefined }), wait);
    expect(wait).not.toHaveBeenCalled();
    expect(session.status.state).toBe("error");
    await session.start(async () => {
      throw new Error("Unavailable");
    }, wait);
    expect(session.status.message).toBe("Unavailable");
  });

  it("publishes a transport failure without automatically starting another writer", async () => {
    const session = new WeixinQrSession();
    const start = vi.fn().mockResolvedValue(qr);
    await session.start(start, async () => {
      throw new Error("Timed out");
    });
    await vi.waitFor(() => expect(session.status.state).toBe("error"));
    expect(start).toHaveBeenCalledTimes(1);
    expect(session.status.message).toBe("Timed out");
  });
});

describe("lightweight default plugin and runtime connection", () => {
  it("enables only WeChat and preserves unrelated configuration", () => {
    const config = {
      plugins: {
        entries: {
          other: { enabled: false },
          "openclaw-weixin": { enabled: false, config: { value: 1 } },
        },
        allow: ["other"],
      },
      channels: { other: { enabled: true } },
    };
    expect(ensureDefaultWeixinPlugin(config)).toBe(true);
    expect(config.plugins.entries.other.enabled).toBe(false);
    expect(config.plugins.entries["openclaw-weixin"]).toEqual({
      enabled: true,
      config: { value: 1 },
    });
    expect(config.plugins.allow).toEqual(["other", "openclaw-weixin"]);
    expect(config.channels).toEqual({ other: { enabled: true } });
    expect(ensureDefaultWeixinPlugin(config)).toBe(false);
  });

  it("initializes a new config without fabricating install provenance", () => {
    const config = {};
    ensureDefaultWeixinPlugin(config);
    expect(config).toEqual({
      plugins: { entries: { "openclaw-weixin": { enabled: true } }, allow: ["openclaw-weixin"] },
    });
  });

  it("never treats a registered/running channel or a different account as connected", () => {
    expect(
      getWeixinRuntimeConnection(
        { channels: { "openclaw-weixin": { running: true, connected: true } } },
        "owner",
      ),
    ).toEqual({ connected: false, connecting: false });
    expect(
      getWeixinRuntimeConnection(
        { channelAccounts: { "openclaw-weixin": [{ accountId: "other", connected: true }] } },
        "owner",
      ).connected,
    ).toBe(false);
    expect(
      getWeixinRuntimeConnection(
        { channelAccounts: { "openclaw-weixin": [{ accountId: "owner", running: true }] } },
        "owner",
      ),
    ).toEqual({ connected: false, connecting: true });
    expect(
      getWeixinRuntimeConnection(
        { channelAccounts: { "openclaw-weixin": [{ accountId: "owner", connected: true }] } },
        "owner",
      ).connected,
    ).toBe(true);
  });
});
