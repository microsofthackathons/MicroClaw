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

  function config(accounts: Record<string, unknown> = {}) {
    return {
      plugins: { entries: { "openclaw-weixin": { enabled: true } } },
      channels: { "openclaw-weixin": { accounts } },
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
          path.join(
            target.credentialsDir,
            `openclaw-weixin-${account.accountId}-allowFrom.json`,
          ),
          JSON.stringify({ version: 1, allowFrom: [account.userId] }),
        );
      }
    }
  }

  it("reports zero linked accounts without inventing an owner", () => {
    const target = fixture();
    fs.mkdirSync(path.join(target.stateDir, "openclaw-weixin"), { recursive: true });
    fs.writeFileSync(
      path.join(target.stateDir, "openclaw-weixin", "accounts.json"),
      JSON.stringify([]),
    );

    expect(
      readWeixinRemoteApprovalActivationOptions({
        ...target,
        config: config(),
      }),
    ).toEqual({
      weixinEnabled: true,
      linkedAccountCount: 0,
      authenticatedAccountCount: 0,
      eligibleOwners: [],
      ineligibleAccounts: [],
    });
  });

  it("returns every eligible authenticated and allowlisted identity for explicit selection", () => {
    const target = fixture();
    writeAccounts(target, [
      {
        accountId: "second@im.wechat",
        userId: "owner-two@im.wechat",
        token: "token-two",
        allowlisted: true,
      },
      {
        accountId: "first@im.wechat",
        userId: "owner-one@im.wechat",
        token: "token-one",
        allowlisted: true,
      },
    ]);

    const options = readWeixinRemoteApprovalActivationOptions({
      ...target,
      config: config(),
    });

    expect(options.eligibleOwners).toEqual([
      { accountId: "first@im.wechat", userId: "owner-one@im.wechat" },
      { accountId: "second@im.wechat", userId: "owner-two@im.wechat" },
    ]);
    expect(options.authenticatedAccountCount).toBe(2);
  });

  it("marks disabled, unauthenticated, and non-allowlisted accounts ineligible", () => {
    const target = fixture();
    writeAccounts(target, [
      {
        accountId: "disabled@im.wechat",
        userId: "disabled-owner@im.wechat",
        token: "token",
        allowlisted: true,
      },
      {
        accountId: "logged-out@im.wechat",
        userId: "logged-out-owner@im.wechat",
      },
      {
        accountId: "missing-allowlist@im.wechat",
        userId: "missing-owner@im.wechat",
        token: "token",
      },
    ]);

    const options = readWeixinRemoteApprovalActivationOptions({
      ...target,
      config: config({ "disabled@im.wechat": { enabled: false } }),
    });

    expect(options.eligibleOwners).toEqual([]);
    expect(options.ineligibleAccounts).toEqual([
      {
        accountId: "disabled@im.wechat",
        userId: "disabled-owner@im.wechat",
        reason: "account-disabled",
      },
      {
        accountId: "logged-out@im.wechat",
        userId: "logged-out-owner@im.wechat",
        reason: "not-authenticated",
      },
      {
        accountId: "missing-allowlist@im.wechat",
        userId: "missing-owner@im.wechat",
        reason: "not-allowlisted",
      },
    ]);
  });

  it("binds exactly the selected account ID and user ID", () => {
    const options: WeixinRemoteApprovalActivationOptions = {
      weixinEnabled: true,
      linkedAccountCount: 2,
      authenticatedAccountCount: 2,
      eligibleOwners: [
        { accountId: "first@im.wechat", userId: "one@im.wechat" },
        { accountId: "second@im.wechat", userId: "two@im.wechat" },
      ],
      ineligibleAccounts: [],
    };

    expect(
      planWeixinRemoteApprovalTransition({
        currentMode: "off",
        requestedMode: "limited-dacl",
        options,
        selection: {
          enabled: true,
          owner: { accountId: "second@im.wechat", userId: "two@im.wechat" },
        },
        now: new Date("2026-10-20T00:00:00.000Z"),
      }),
    ).toEqual({
      action: "persist",
      configuration: {
        enabled: true,
        owner: {
          contract: "microclaw.windows-weixin-remote-approval.v1",
          accountId: "second@im.wechat",
          userId: "two@im.wechat",
          boundAt: "2026-10-20T00:00:00.000Z",
        },
      },
    });
  });

  it("defaults to disabled, clears the owner on MXC Off, and preserves an eligible active owner", () => {
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
    expect(
      planWeixinRemoteApprovalTransition({
        currentMode: "limited-dacl",
        requestedMode: "full",
        currentConfiguration: {
          enabled: true,
          owner: {
            contract: "microclaw.windows-weixin-remote-approval.v1",
            accountId: "owner@im.wechat",
            userId: "user@im.wechat",
            boundAt: "2026-10-20T00:00:00.000Z",
          },
        },
        options: {
          weixinEnabled: true,
          linkedAccountCount: 1,
          authenticatedAccountCount: 1,
          eligibleOwners: [{ accountId: "owner@im.wechat", userId: "user@im.wechat" }],
          ineligibleAccounts: [],
        },
        selection: { enabled: false },
      }),
    ).toEqual({ action: "preserve" });
  });

  it("clears an invalid or stale active owner instead of rebinding in place", () => {
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
        currentMode: "full",
        requestedMode: "limited-dacl",
        currentConfiguration,
        options: {
          weixinEnabled: true,
          linkedAccountCount: 1,
          authenticatedAccountCount: 1,
          eligibleOwners: [],
          ineligibleAccounts: [
            {
              accountId: "owner@im.wechat",
              userId: "user@im.wechat",
              reason: "not-allowlisted",
            },
          ],
        },
      }),
    ).toEqual({
      action: "persist",
      configuration: { enabled: false, owner: null },
    });
  });

  it("rejects a stale selected owner after its allowlist eligibility changes", () => {
    const target = fixture();
    writeAccounts(target, [
      {
        accountId: "owner@im.wechat",
        userId: "user@im.wechat",
        token: "token",
        allowlisted: true,
      },
    ]);
    const initial = readWeixinRemoteApprovalActivationOptions({
      ...target,
      config: config(),
    });
    fs.rmSync(
      path.join(
        target.credentialsDir,
        "openclaw-weixin-owner@im.wechat-allowFrom.json",
      ),
    );
    const current = readWeixinRemoteApprovalActivationOptions({
      ...target,
      config: config(),
    });

    expect(initial.eligibleOwners).toHaveLength(1);
    expect(() =>
      planWeixinRemoteApprovalTransition({
        currentMode: "off",
        requestedMode: "full",
        options: current,
        selection: {
          enabled: true,
          owner: initial.eligibleOwners[0],
        },
      }),
    ).toThrow("no longer eligible");
  });

  it("rejects enablement when WeChat is disabled or the IPC choice is malformed", () => {
    const options: WeixinRemoteApprovalActivationOptions = {
      weixinEnabled: false,
      linkedAccountCount: 1,
      authenticatedAccountCount: 1,
      eligibleOwners: [{ accountId: "owner@im.wechat", userId: "user@im.wechat" }],
      ineligibleAccounts: [],
    };
    expect(() =>
      planWeixinRemoteApprovalTransition({
        currentMode: "off",
        requestedMode: "full",
        options,
        selection: {
          enabled: true,
          owner: options.eligibleOwners[0],
        },
      }),
    ).toThrow("channel is disabled");
    expect(() =>
      planWeixinRemoteApprovalTransition({
        currentMode: "off",
        requestedMode: "full",
        options: { ...options, weixinEnabled: true },
        selection: { enabled: true, owner: null } as never,
      }),
    ).toThrow("valid WeChat remote approval activation choice");
  });
});
