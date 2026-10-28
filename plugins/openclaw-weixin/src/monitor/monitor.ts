import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

import { getUpdates, classifyFetchError } from "../api/api.js";
import { WeixinConfigManager } from "../api/config-cache.js";
import { STALE_TOKEN_ERRCODE, pauseSession, getRemainingPauseMs } from "../api/session-guard.js";
import { isActiveWeixinAccount } from "../auth/accounts.js";
import {
  interceptWeixinRemoteApprovalMessage,
  processOneMessage,
} from "../messaging/process-message.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "../storage/sync-buf.js";
import { logger } from "../util/logger.js";
import type { Logger } from "../util/logger.js";
import { redactBody } from "../util/redact.js";
import {
  isMxcWeixinIngressReleased,
  waitForMxcWeixinIngressRelease,
} from "../security/mxc-policy.js";
import {
  WeixinRemoteApprovalTransport,
} from "../security/remote-approval.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

export type MonitorWeixinOpts = {
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  accountId: string;
  /** When non-empty, only messages whose from_user_id is in this list are processed. */
  allowFrom?: string[];
  config: import("openclaw/plugin-sdk/core").OpenClawConfig;
  runtime?: { log?: (msg: string) => void; error?: (msg: string) => void };
  /**
   * Gateway-injected channel runtime surface (reply/routing/session/media/commands/...).
   * Required for inbound message processing; provided by `ChannelGatewayContext.channelRuntime`.
   */
  channelRuntime: PluginRuntime["channel"];
  abortSignal?: AbortSignal;
  longPollTimeoutMs?: number;
  /** Gateway status callback — called on each successful poll and inbound message. */
  setStatus?: (next: ChannelAccountSnapshot) => void;
};

/**
 * Long-poll loop: getUpdates -> normalize -> recordInboundSession -> dispatchReplyFromConfig.
 * Runs until abort.
 */
export async function monitorWeixinProvider(opts: MonitorWeixinOpts): Promise<void> {
  const {
    baseUrl,
    cdnBaseUrl,
    token,
    accountId,
    config,
    channelRuntime,
    abortSignal,
    longPollTimeoutMs,
    setStatus,
  } = opts;
  const log = opts.runtime?.log ?? (() => {});
  const errLog = opts.runtime?.error ?? ((m: string) => log(m));
  const aLog: Logger = logger.withAccount(accountId);
  const remoteApprovalTransport = new WeixinRemoteApprovalTransport({
    accountId,
    baseUrl,
    token,
    error: errLog,
    diagnostic: (record) => aLog.info(`weixin-remote-approval ${JSON.stringify(record)}`),
    deliveryDiagnostic: (record) =>
      aLog.info(`weixin-remote-approval-delivery ${JSON.stringify(record)}`),
  });
  if (remoteApprovalTransport.enabled) {
    try {
      await remoteApprovalTransport.start();
    } catch (error) {
      errLog(`weixin remote approval transport unavailable: ${String(error)}`);
    }
  }
  abortSignal?.addEventListener("abort", () => remoteApprovalTransport.close(), { once: true });

  if (!channelRuntime) {
    const msg =
      "channelRuntime missing on monitor opts; gateway must inject ChannelGatewayContext.channelRuntime";
    aLog.error(msg);
    throw new Error(msg);
  }

  log(`weixin monitor started (${baseUrl}, account=${accountId})`);
  aLog.info(
    `Monitor started: baseUrl=${baseUrl} timeoutMs=${longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS}`,
  );

  const syncFilePath = getSyncBufFilePath(accountId);
  aLog.debug(`syncFilePath: ${syncFilePath}`);

  const previousGetUpdatesBuf = loadGetUpdatesBuf(syncFilePath);
  let getUpdatesBuf = previousGetUpdatesBuf ?? "";
  let lastPersistedUpdatesBuf = getUpdatesBuf;
  let dispatchTail = Promise.resolve();
  let cursorPersistenceBlocked = false;
  let replayRequired = false;

  if (previousGetUpdatesBuf) {
    log(`[weixin] resuming from previous sync buf (${getUpdatesBuf.length} bytes)`);
    aLog.debug(`Using previous get_updates_buf (${getUpdatesBuf.length} bytes)`);
  } else {
    log(`[weixin] no previous sync buf, starting fresh`);
    aLog.info(`No previous get_updates_buf found, starting fresh`);
  }

  const configManager = new WeixinConfigManager({ baseUrl, token }, log);

  let nextTimeoutMs = longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    try {
      while (cursorPersistenceBlocked && !abortSignal?.aborted) {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
      if (replayRequired) {
        await dispatchTail;
        getUpdatesBuf = lastPersistedUpdatesBuf;
        replayRequired = false;
      }
      if (!isMxcWeixinIngressReleased()) {
        setStatus?.({ accountId, running: true, connected: false, lastError: "Paused until MXC ingress release" });
        await waitForMxcWeixinIngressRelease(abortSignal);
        setStatus?.({ accountId, running: true, lastError: null });
      }
      aLog.debug(
        `getUpdates: get_updates_buf=${getUpdatesBuf.substring(0, 50)}..., timeoutMs=${nextTimeoutMs}`,
      );
      let pollTimedOut = false;
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
        // Stop/hot-reload should cancel the in-flight long-poll immediately
        // instead of waiting for the server-side long-poll timeout.
        abortSignal,
        onPollTimeout: () => { pollTimedOut = true; },
      });
      if (abortSignal?.aborted) break;
      if (!isMxcWeixinIngressReleased()) {
        aLog.info("getUpdates response ignored because MXC ingress was relocked");
        continue;
      }
      aLog.debug(
        `getUpdates response: ret=${resp.ret}, msgs=${resp.msgs?.length ?? 0}, get_updates_buf_length=${resp.get_updates_buf?.length ?? 0}`,
      );

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
        aLog.debug(`Updated next poll timeout: ${nextTimeoutMs}ms`);
      }
      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);
      if (isApiError) {
        setStatus?.({ accountId, connected: false, lastError: resp.errmsg || "WeChat API error" });
        const isStaleToken =
          resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE;

        if (isStaleToken) {
          pauseSession(accountId);
          const pauseMs = getRemainingPauseMs(accountId);
          aLog.error(
            `getUpdates: token for ${accountId} is stale, pausing all requests for ${Math.ceil(pauseMs / 60_000)} min`,
          );
          consecutiveFailures = 0;
          await sleep(pauseMs, abortSignal);
          continue;
        }

        consecutiveFailures += 1;
        errLog(
          `weixin getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        );
        aLog.error(
          `getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg} response=${redactBody(JSON.stringify(resp))}`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          errLog(
            `weixin getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`,
          );
          aLog.error(
            `getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`,
          );
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }
      consecutiveFailures = 0;
      setStatus?.({
        accountId,
        connected: !pollTimedOut,
        lastError: pollTimedOut ? "WeChat updates request timed out" : null,
        ...(!pollTimedOut ? { lastEventAt: Date.now() } : {}),
      });
      const responseUpdatesBuf =
        resp.get_updates_buf != null && resp.get_updates_buf !== "" ? resp.get_updates_buf : null;
      if (responseUpdatesBuf) getUpdatesBuf = responseUpdatesBuf;
      const list = resp.msgs ?? [];
      for (const full of list) {
        aLog.info(
          `inbound message: from=${full.from_user_id} types=${full.item_list?.map((i) => i.type).join(",") ?? "none"}`,
        );

        const now = Date.now();
        setStatus?.({ accountId, lastEventAt: now, lastInboundAt: now });

        // allowFrom filtering is delegated to processOneMessage via the framework
        // authorization pipeline (resolveSenderCommandAuthorizationWithRuntime).

        const baseMessageDeps = {
          accountId,
          config,
          channelRuntime,
          baseUrl,
          cdnBaseUrl,
          token,
          remoteApprovalTransport,
          log: opts.runtime?.log ?? (() => {}),
          errLog,
        };
        if (!token?.trim() || !isActiveWeixinAccount(accountId, token)) {
          aLog.warn("account is no longer the active authenticated WeChat identity; stopping");
          return;
        }
        let consumedByRemoteApproval = false;
        try {
          consumedByRemoteApproval = await interceptWeixinRemoteApprovalMessage(
            full,
            baseMessageDeps,
          );
        } catch (error) {
          errLog(`weixin remote approval interception failed: ${String(error)}`);
          consumedByRemoteApproval = remoteApprovalTransport.shouldReserveInbound(full);
        }
        if (consumedByRemoteApproval) {
          aLog.info("remote approval: consumed system reply before agent dispatch");
          continue;
        }
        dispatchTail = dispatchTail
          .then(async () => {
            if (replayRequired) return;
            const fromUserId = full.from_user_id ?? "";
            const cachedConfig = await configManager.getForUser(fromUserId, full.context_token);
            await processOneMessage(full, {
              ...baseMessageDeps,
              typingTicket: cachedConfig.typingTicket,
            });
          })
          .finally(() =>
            interceptWeixinRemoteApprovalMessage(full, baseMessageDeps, "complete").catch(
              () => false,
            ),
          )
          .catch((error) => {
            replayRequired = true;
            getUpdatesBuf = lastPersistedUpdatesBuf;
            errLog(`weixin message dispatch failed: ${String(error)}`);
          });
      }
      if (responseUpdatesBuf) {
        dispatchTail = dispatchTail
          .then(async () => {
            if (replayRequired) return;
            for (;;) {
              try {
                saveGetUpdatesBuf(syncFilePath, responseUpdatesBuf);
                lastPersistedUpdatesBuf = responseUpdatesBuf;
                cursorPersistenceBlocked = false;
                aLog.debug(`Saved new get_updates_buf (${responseUpdatesBuf.length} bytes)`);
                return;
              } catch (error) {
                cursorPersistenceBlocked = true;
                errLog(`weixin sync cursor persistence failed; retrying: ${String(error)}`);
                await sleep(RETRY_DELAY_MS, abortSignal);
              }
            }
          })
          .catch((error) => {
            if (!abortSignal?.aborted) {
              errLog(`weixin sync cursor persistence stopped: ${String(error)}`);
            }
          });
      }
    } catch (err) {
      setStatus?.({ accountId, connected: false });
      if (abortSignal?.aborted) {
        await dispatchTail;
        aLog.info(`Monitor stopped (aborted)`);
        return;
      }
      consecutiveFailures += 1;
      const classified = classifyFetchError(err);
      errLog(
        `weixin getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)} type=${classified.type} description=${classified.description}${classified.code ? ` code=${classified.code}` : ""}`,
      );
      aLog.error(
        `getUpdates error: ${String(err)}, type=${classified.type} code=${classified.code ?? "none"}, stack=${(err as Error).stack}`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        errLog(
          `weixin getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`,
        );
        aLog.error(`getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`);
        consecutiveFailures = 0;
        await sleep(30_000, abortSignal);
      } else {
        await sleep(2000, abortSignal);
      }
    }
  }
  setStatus?.({ accountId, connected: false, running: false });
  await dispatchTail;
  aLog.info(`Monitor ended`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
