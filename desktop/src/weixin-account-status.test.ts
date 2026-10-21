import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readWeixinAccountStatus,
  shouldRevokeWeixinRemoteApprovalOwner,
} from "./weixin-account-status";

describe("readWeixinAccountStatus", () => {
  let stateDir: string;
  const indexPath = () => path.join(stateDir, "openclaw-weixin", "accounts.json");
  const accountPath = (accountId: string) =>
    path.join(stateDir, "openclaw-weixin", "accounts", `${accountId}.json`);

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-account-status-"));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function writeIndex(value: unknown) {
    fs.mkdirSync(path.dirname(indexPath()), { recursive: true });
    fs.writeFileSync(indexPath(), JSON.stringify(value));
  }

  function writeAccount(accountId: string, value: unknown) {
    fs.mkdirSync(path.dirname(accountPath(accountId)), { recursive: true });
    fs.writeFileSync(accountPath(accountId), JSON.stringify(value));
  }

  it("returns explicit logged-out state when no account exists", () => {
    expect(readWeixinAccountStatus(stateDir)).toEqual({
      loggedIn: false,
      accountCount: 0,
      invariantState: "none",
      currentAccount: null,
    });
  });

  it("returns one safe authenticated identity without exposing its token", () => {
    writeIndex(["account-im-bot"]);
    writeAccount("account-im-bot", {
      token: "secret-token",
      userId: "OWNER@IM.WECHAT",
    });

    const status = readWeixinAccountStatus(stateDir);

    expect(status).toEqual({
      loggedIn: true,
      accountCount: 1,
      invariantState: "single",
      currentAccount: {
        accountId: "account-im-bot",
        userId: "owner@im.wechat",
      },
    });
    expect(JSON.stringify(status)).not.toContain("secret-token");
  });

  it("does not claim an identity from a legacy multiple-account index", () => {
    writeIndex(["first-im-bot", "second-im-bot"]);
    writeAccount("first-im-bot", { token: "first", userId: "first-owner" });
    writeAccount("second-im-bot", { token: "second", userId: "second-owner" });

    expect(readWeixinAccountStatus(stateDir)).toEqual({
      loggedIn: false,
      accountCount: 2,
      invariantState: "multiple",
      currentAccount: null,
    });
  });

  it("fails closed for an index-only account or unsafe account id", () => {
    writeIndex(["missing-im-bot"]);
    expect(readWeixinAccountStatus(stateDir).invariantState).toBe("invalid");

    writeIndex(["../escape"]);
    expect(readWeixinAccountStatus(stateDir)).toMatchObject({
      loggedIn: false,
      accountCount: 1,
      invariantState: "invalid",
      currentAccount: null,
    });
  });

  it("preserves only an exact account and user remote-approval owner", () => {
    const exact = {
      loggedIn: true,
      accountCount: 1,
      invariantState: "single" as const,
      currentAccount: {
        accountId: "account-im-bot",
        userId: "owner@im.wechat",
      },
    };
    expect(
      shouldRevokeWeixinRemoteApprovalOwner(exact, {
        accountId: "account-im-bot",
        userId: "owner@im.wechat",
      }),
    ).toBe(false);
    expect(
      shouldRevokeWeixinRemoteApprovalOwner(exact, {
        accountId: "account-im-bot",
        userId: "replacement@im.wechat",
      }),
    ).toBe(true);
    expect(
      shouldRevokeWeixinRemoteApprovalOwner(
        { ...exact, invariantState: "multiple", currentAccount: null, loggedIn: false },
        {
          accountId: "account-im-bot",
          userId: "owner@im.wechat",
        },
      ),
    ).toBe(true);
  });
});
