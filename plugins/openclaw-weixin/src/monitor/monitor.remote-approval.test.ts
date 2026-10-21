import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUpdates: vi.fn(),
  intercept: vi.fn(),
  process: vi.fn(),
  loadCursor: vi.fn(),
  saveCursor: vi.fn(),
}));

vi.mock("../api/api.js", () => ({
  getUpdates: mocks.getUpdates,
  classifyFetchError: () => ({ type: "test", description: "test" }),
}));
vi.mock("../auth/accounts.js", () => ({
  isActiveWeixinAccount: (accountId: string, token: string) =>
    accountId === "bot@im.wechat" && token === "token",
}));
vi.mock("../api/config-cache.js", () => ({
  WeixinConfigManager: class {
    async getForUser() {
      return {};
    }
  },
}));
vi.mock("../api/session-guard.js", () => ({
  STALE_TOKEN_ERRCODE: 40001,
  pauseSession: vi.fn(),
  getRemainingPauseMs: () => 0,
}));
vi.mock("../messaging/process-message.js", () => ({
  interceptWeixinRemoteApprovalMessage: mocks.intercept,
  processOneMessage: mocks.process,
}));
vi.mock("../storage/sync-buf.js", () => ({
  getSyncBufFilePath: () => "cursor.json",
  loadGetUpdatesBuf: mocks.loadCursor,
  saveGetUpdatesBuf: mocks.saveCursor,
}));
vi.mock("../util/logger.js", () => ({
  logger: {
    withAccount: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));
vi.mock("../util/redact.js", () => ({ redactBody: (value: string) => value }));
vi.mock("../security/mxc-policy.js", () => ({
  isMxcWeixinIngressReleased: () => true,
  waitForMxcWeixinIngressRelease: vi.fn(),
}));
vi.mock("../security/remote-approval.js", () => ({
  classifyWeixinRemoteApprovalCandidate: () => ({ candidateLike: true }),
  WeixinRemoteApprovalTransport: class {
    enabled = true;
    start = vi.fn();
    close = vi.fn();
    shouldReserveInbound = () => true;
  },
}));

import { monitorWeixinProvider } from "./monitor.js";

function message(id: number) {
  return {
    seq: id,
    message_id: id,
    from_user_id: "owner@im.wechat",
    to_user_id: "bot@im.wechat",
    message_type: 1,
    item_list: [{ type: 1, text_item: { text: `message-${id}` } }],
  };
}

function options(signal: AbortSignal) {
  return {
    baseUrl: "https://weixin.test",
    cdnBaseUrl: "https://cdn.test",
    token: "token",
    accountId: "bot@im.wechat",
    config: {},
    channelRuntime: {} as never,
    abortSignal: signal,
    longPollTimeoutMs: 1,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("WeChat long-poll remote approval ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadCursor.mockReturnValue("cursor-0");
    mocks.intercept.mockResolvedValue(false);
  });

  it("consumes approval replies out-of-band and persists their cursor without agent dispatch", async () => {
    const abort = new AbortController();
    mocks.intercept.mockResolvedValueOnce(true);
    mocks.getUpdates
      .mockResolvedValueOnce({ ret: 0, get_updates_buf: "cursor-1", msgs: [message(1)] })
      .mockImplementationOnce(async () => {
        abort.abort();
        throw new Error("aborted");
      });

    await monitorWeixinProvider(options(abort.signal));

    expect(mocks.process).not.toHaveBeenCalled();
    await waitFor(() => mocks.saveCursor.mock.calls.length === 1);
    expect(mocks.saveCursor).toHaveBeenCalledWith("cursor.json", "cursor-1");
  });

  it("does not persist a cursor until every covered ordinary message finishes dispatch", async () => {
    const abort = new AbortController();
    let finishDispatch!: () => void;
    const dispatch = new Promise<void>((resolve) => {
      finishDispatch = resolve;
    });
    mocks.process.mockReturnValueOnce(dispatch);
    mocks.getUpdates
      .mockResolvedValueOnce({ ret: 0, get_updates_buf: "cursor-1", msgs: [message(1)] })
      .mockImplementationOnce(async () => {
        await dispatch;
        abort.abort();
        throw new Error("aborted");
      });

    const monitoring = monitorWeixinProvider(options(abort.signal));
    await waitFor(() => mocks.process.mock.calls.length === 1);
    expect(mocks.saveCursor).not.toHaveBeenCalled();
    finishDispatch();
    await monitoring;
    await waitFor(() => mocks.saveCursor.mock.calls.length === 1);
    expect(mocks.saveCursor).toHaveBeenCalledWith("cursor.json", "cursor-1");
  });

  it("reuses the last durable cursor after dispatch failure instead of losing the message", async () => {
    const abort = new AbortController();
    let releaseSecondPoll!: () => void;
    const secondPoll = new Promise<void>((resolve) => {
      releaseSecondPoll = resolve;
    });
    mocks.process.mockRejectedValueOnce(new Error("dispatch failed"));
    mocks.getUpdates
      .mockResolvedValueOnce({ ret: 0, get_updates_buf: "cursor-1", msgs: [message(1)] })
      .mockImplementationOnce(async () => {
        await secondPoll;
        return { ret: 0, get_updates_buf: "cursor-2", msgs: [] };
      })
      .mockImplementationOnce(async () => {
        abort.abort();
        throw new Error("aborted");
      });

    const monitoring = monitorWeixinProvider(options(abort.signal));
    await waitFor(() => mocks.process.mock.calls.length === 1);
    releaseSecondPoll();
    await monitoring;

    expect(mocks.saveCursor).not.toHaveBeenCalled();
    expect(mocks.getUpdates.mock.calls.at(-1)?.[0]).toMatchObject({
      get_updates_buf: "cursor-0",
    });
  });

  it("drains queued dispatch before monitor shutdown completes", async () => {
    const abort = new AbortController();
    let finishDispatch!: () => void;
    const dispatch = new Promise<void>((resolve) => {
      finishDispatch = resolve;
    });
    let rejectPoll!: (error: Error) => void;
    mocks.process.mockReturnValueOnce(dispatch);
    mocks.getUpdates
      .mockResolvedValueOnce({ ret: 0, get_updates_buf: "cursor-1", msgs: [message(1)] })
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectPoll = reject;
          }),
      );

    let settled = false;
    const monitoring = monitorWeixinProvider(options(abort.signal)).finally(() => {
      settled = true;
    });
    await waitFor(() => mocks.process.mock.calls.length === 1 && Boolean(rejectPoll));
    abort.abort();
    rejectPoll(new Error("aborted"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    finishDispatch();
    await monitoring;
    expect(settled).toBe(true);
    expect(mocks.saveCursor).toHaveBeenCalledWith("cursor.json", "cursor-1");
  });
});
