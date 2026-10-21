import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  planWeixinRemoteApprovalTransition,
  readWeixinRemoteApprovalActivationOptions,
  type WeixinRemoteApprovalActivationOptions,
} from "./windows-node-mxc-weixin-remote-approval-activation";

describe("MXC WeChat remote approval activation", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-weixin-activation-"));
    roots.push(stateDir);
    const accountsDir = path.join(stateDir, "openclaw-weixin", "accounts");
    const credentialsDir = path.join(stateDir, "credentials");
    fs.mkdirSync(accountsDir, { recursive: true });
    fs.mkdirSync(credentialsDir, { recursive: true });
    return { stateDir, accountsDir, credentialsDir };
  }

  function config(accountEnabled = true, pluginEnabled = true) {
    return {
      plugins: { entries: { "openclaw-weixin": { enabled: pluginEnabled } } },
      channels: { "openclaw-weixin": { enabled: accountEnabled } },
    };
  }

  function writeAccounts(
    target: ReturnType<typeof fixture>,
    accounts: Array<{
      accountId: string;
      userId?: string;
      token?: string;
      allowlisted?: boolean;
    }>,
  ) {
    fs.writeFileSync(
      path.join(target.stateDir, "openclaw-weixin", "accounts.json"),
      JSON.stringify(accounts.map((account) => account.accountId)),
    );
    for (const account of accounts) {
      fs.writeFileSync(
        path.join(target.accountsDir, `${account.accountId}.json`),
        JSON.stringify({ userId: account.userId, token: account.token }),
      );
      if (account.allowlisted && account.userId) {
        fs.writeFileSync(
          path.join(target.credentialsDir, `openclaw-weixin-${account.accountId}-allowFrom.json`),
          JSON.stringify({ version: 1, allowFrom: [account.userId] }),
        );
      }
    }
  }

  const eligibleOptions = (): WeixinRemoteApprovalActivationOptions => ({
    weixinEnabled: true,
    linkedAccountCount: 1,
    authenticatedAccountCount: 1,
    invariantState: "single",
    account: { accountId: "owner@im.wechat", userId: "user@im.wechat" },
    enableAvailable: true,
    unavailableReason: null,
  });

  it("reports zero accounts without inventing an approval identity", () => {
    const target = fixture();

    expect(
      readWeixinRemoteApprovalActivationOptions({
        ...target,
        config: config(),
      }),
    ).toEqual({
      weixinEnabled: true,
      linkedAccountCount: 0,
      authenticatedAccountCount: 0,
      invariantState: "none",
      account: null,
      enableAvailable: false,
      unavailableReason: "no-account",
    });
  });

  it("returns the one exact authenticated and allowlisted identity", () => {
    const target = fixture();
    writeAccounts(target, [
      {
        accountId: "owner@im.wechat",
        userId: "user@im.wechat",
        token: "token",
        allowlisted: true,
      },
    ]);

    expect(
      readWeixinRemoteApprovalActivationOptions({
        ...target,
        config: config(),
      }),
    ).toEqual(eligibleOptions());
  });

  it("fails closed for a legacy multiple-account invariant violation", () => {
    const target = fixture();
    writeAccounts(target, [
      {
        accountId: "first@im.wechat",
        userId: "first-owner@im.wechat",
        token: "first",
        allowlisted: true,
      },
      {
        accountId: "second@im.wechat",
        userId: "second-owner@im.wechat",
        token: "second",
        allowlisted: true,
      },
    ]);

    expect(
      readWeixinRemoteApprovalActivationOptions({
        ...target,
        config: config(),
      }),
    ).toEqual({
      weixinEnabled: true,
      linkedAccountCount: 2,
      authenticatedAccountCount: 0,
      invariantState: "multiple",
      account: null,
      enableAvailable: false,
      unavailableReason: "multiple-accounts",
    });
  });

  it("shows the exact identity but disables approval when it is not allowlisted", () => {
    const target = fixture();
    writeAccounts(target, [
      {
        accountId: "owner@im.wechat",
        userId: "user@im.wechat",
        token: "token",
      },
    ]);

    expect(
      readWeixinRemoteApprovalActivationOptions({
        ...target,
        config: config(),
      }),
    ).toEqual({
      ...eligibleOptions(),
      enableAvailable: false,
      unavailableReason: "not-allowlisted",
    });
  });

  it("binds only the one exact identity supplied by the read-only context", () => {
    const options = eligibleOptions();
    expect(
      planWeixinRemoteApprovalTransition({
        currentMode: "off",
        requestedMode: "limited-dacl",
        options,
        selection: { enabled: true, owner: options.account! },
        now: new Date("2026-10-20T00:00:00.000Z"),
      }),
    ).toEqual({
      action: "persist",
      configuration: {
        enabled: true,
        owner: {
          contract: "microclaw.windows-weixin-remote-approval.v1",
          accountId: "owner@im.wechat",
          userId: "user@im.wechat",
          boundAt: "2026-10-20T00:00:00.000Z",
        },
      },
    });
  });

  it("defaults to disabled, clears on Off, and preserves only the exact active identity", () => {
    const disabled = {
      action: "persist",
      configuration: { enabled: false, owner: null },
    };
    expect(
      planWeixinRemoteApprovalTransition({
        currentMode: "off",
        requestedMode: "full",
      }),
    ).toEqual(disabled);
    expect(
      planWeixinRemoteApprovalTransition({
        currentMode: "limited-dacl",
        requestedMode: "off",
      }),
    ).toEqual(disabled);

    const currentConfiguration = {
      enabled: true,
      owner: {
        contract: "microclaw.windows-weixin-remote-approval.v1" as const,
        accountId: "owner@im.wechat",
        userId: "user@im.wechat",
        boundAt: "2026-10-20T00:00:00.000Z",
      },
    };
    expect(
      planWeixinRemoteApprovalTransition({
        currentMode: "limited-dacl",
        requestedMode: "full",
        currentConfiguration,
        options: eligibleOptions(),
      }),
    ).toEqual({ action: "preserve" });
    expect(
      planWeixinRemoteApprovalTransition({
        currentMode: "limited-dacl",
        requestedMode: "full",
        currentConfiguration,
        options: {
          ...eligibleOptions(),
          account: { accountId: "replacement@im.wechat", userId: "other@im.wechat" },
        },
      }),
    ).toEqual(disabled);
  });

  it("rejects stale boundary identity and disabled-channel enablement", () => {
    const initial = eligibleOptions();
    expect(() =>
      planWeixinRemoteApprovalTransition({
        currentMode: "off",
        requestedMode: "full",
        options: {
          ...initial,
          enableAvailable: false,
          unavailableReason: "not-allowlisted",
        },
        selection: { enabled: true, owner: initial.account! },
      }),
    ).toThrow("no longer eligible");
    expect(() =>
      planWeixinRemoteApprovalTransition({
        currentMode: "off",
        requestedMode: "full",
        options: { ...initial, weixinEnabled: false },
        selection: { enabled: true, owner: initial.account! },
      }),
    ).toThrow("channel is disabled");
  });
});
