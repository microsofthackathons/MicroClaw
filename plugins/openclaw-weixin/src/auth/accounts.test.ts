import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isActiveWeixinAccount,
  listIndexedWeixinAccountIds,
  loadWeixinAccount,
  replaceWeixinAccount,
  onWeixinAccountChanged,
  watchWeixinAccountState,
} from "./accounts.js";
import { resolveFrameworkAllowFromPath } from "./pairing.js";

describe("single WeChat account replacement", () => {
  let stateDir: string;

  const accountsDir = () => path.join(stateDir, "openclaw-weixin", "accounts");
  const indexPath = () => path.join(stateDir, "openclaw-weixin", "accounts.json");
  const accountPath = (accountId: string) => path.join(accountsDir(), `${accountId}.json`);
  const syncPath = (accountId: string) => path.join(accountsDir(), `${accountId}.sync.json`);
  const contextPath = (accountId: string) =>
    path.join(accountsDir(), `${accountId}.context-tokens.json`);

  function seedAccount(accountId: string, userId: string, token = `token-${accountId}`) {
    fs.mkdirSync(accountsDir(), { recursive: true });
    fs.writeFileSync(
      accountPath(accountId),
      JSON.stringify({ token, userId, baseUrl: "https://example.test" }),
    );
  }

  function seedIndex(accountIds: string[]) {
    fs.mkdirSync(path.dirname(indexPath()), { recursive: true });
    fs.writeFileSync(indexPath(), JSON.stringify(accountIds, null, 2));
  }

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-single-account-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    delete process.env.OPENCLAW_OAUTH_DIR;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENCLAW_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("updates the same account without deleting sync, context, or allowFrom state", () => {
    seedAccount("same-im-bot", "owner-one", "old-token");
    seedIndex(["same-im-bot"]);
    fs.writeFileSync(syncPath("same-im-bot"), "sync-state");
    fs.writeFileSync(contextPath("same-im-bot"), "context-state");
    fs.mkdirSync(path.dirname(resolveFrameworkAllowFromPath("same-im-bot")), { recursive: true });
    fs.writeFileSync(
      resolveFrameworkAllowFromPath("same-im-bot"),
      JSON.stringify({ version: 1, allowFrom: ["owner-one", "paired-user"] }),
    );

    const result = replaceWeixinAccount({
      accountId: "same@im.bot",
      token: "new-token",
      userId: "owner-one",
    });

    expect(result).toEqual({
      accountId: "same-im-bot",
      userId: "owner-one",
      replacedAccounts: [],
    });
    expect(listIndexedWeixinAccountIds()).toEqual(["same-im-bot"]);
    expect(loadWeixinAccount("same-im-bot")?.token).toBe("new-token");
    expect(fs.readFileSync(syncPath("same-im-bot"), "utf8")).toBe("sync-state");
    expect(fs.readFileSync(contextPath("same-im-bot"), "utf8")).toBe("context-state");
    expect(
      JSON.parse(fs.readFileSync(resolveFrameworkAllowFromPath("same-im-bot"), "utf8")),
    ).toEqual({ version: 1, allowFrom: ["owner-one", "paired-user"] });
  });

  it("normalizes a legacy raw ID while preserving its same-account state", () => {
    seedAccount("legacy@im.bot", "owner-one", "old-token");
    seedIndex(["legacy@im.bot"]);
    fs.writeFileSync(syncPath("legacy@im.bot"), "sync-state");
    fs.writeFileSync(contextPath("legacy@im.bot"), "context-state");
    fs.mkdirSync(path.dirname(resolveFrameworkAllowFromPath("legacy@im.bot")), {
      recursive: true,
    });
    fs.writeFileSync(
      resolveFrameworkAllowFromPath("legacy@im.bot"),
      JSON.stringify({ version: 1, allowFrom: ["owner-one"] }),
    );

    const result = replaceWeixinAccount({
      accountId: "legacy@im.bot",
      token: "new-token",
      userId: "owner-one",
    });

    expect(result.replacedAccounts).toEqual([]);
    expect(listIndexedWeixinAccountIds()).toEqual(["legacy-im-bot"]);
    expect(fs.readFileSync(syncPath("legacy-im-bot"), "utf8")).toBe("sync-state");
    expect(fs.readFileSync(contextPath("legacy-im-bot"), "utf8")).toBe("context-state");
    expect(
      JSON.parse(fs.readFileSync(resolveFrameworkAllowFromPath("legacy-im-bot"), "utf8")),
    ).toEqual({ version: 1, allowFrom: ["owner-one"] });
    expect(fs.existsSync(accountPath("legacy@im.bot"))).toBe(false);
  });

  it("replaces a different account and removes all of its canonical state", () => {
    seedAccount("old-im-bot", "old-owner");
    seedIndex(["old-im-bot"]);
    fs.writeFileSync(syncPath("old-im-bot"), "sync-state");
    fs.writeFileSync(contextPath("old-im-bot"), "context-state");
    fs.mkdirSync(path.dirname(resolveFrameworkAllowFromPath("old-im-bot")), { recursive: true });
    fs.writeFileSync(resolveFrameworkAllowFromPath("old-im-bot"), "allow-state");
    const cleared: string[] = [];
    const changed = vi.fn();
    const unsubscribe = onWeixinAccountChanged(changed);

    const result = replaceWeixinAccount(
      {
        accountId: "new@im.bot",
        token: "new-token",
        userId: "new-owner",
      },
      (accountId) => cleared.push(accountId),
    );

    expect(result.replacedAccounts).toEqual([{ accountId: "old-im-bot", userId: "old-owner" }]);
    expect(listIndexedWeixinAccountIds()).toEqual(["new-im-bot"]);
    expect(loadWeixinAccount("new-im-bot")).toMatchObject({
      token: "new-token",
      userId: "new-owner",
    });
    expect(cleared).toEqual(["old-im-bot"]);
    expect(isActiveWeixinAccount("old-im-bot")).toBe(false);
    expect(isActiveWeixinAccount("new-im-bot")).toBe(true);
    expect(isActiveWeixinAccount("new-im-bot", "new-token")).toBe(true);
    expect(isActiveWeixinAccount("new-im-bot", "old-token")).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(
      JSON.parse(fs.readFileSync(resolveFrameworkAllowFromPath("new-im-bot"), "utf8")),
    ).toEqual({ version: 1, allowFrom: ["new-owner"] });
    for (const filePath of [
      accountPath("old-im-bot"),
      syncPath("old-im-bot"),
      contextPath("old-im-bot"),
      resolveFrameworkAllowFromPath("old-im-bot"),
    ]) {
      expect(fs.existsSync(filePath)).toBe(false);
    }
  });

  it("collapses multiple legacy indexed accounts to exactly the new normalized account", () => {
    seedAccount("first-im-bot", "owner-one");
    seedAccount("second-im-bot", "owner-two");
    seedAccount("new-im-bot", "new-owner", "old-new-token");
    seedIndex(["first-im-bot", "second-im-bot", "new-im-bot", "first-im-bot"]);

    const result = replaceWeixinAccount({
      accountId: "new@im.bot",
      token: "fresh-token",
      userId: "new-owner",
    });

    expect(result.replacedAccounts.map(({ accountId }) => accountId)).toEqual([
      "first-im-bot",
      "second-im-bot",
    ]);
    expect(JSON.parse(fs.readFileSync(indexPath(), "utf8"))).toEqual(["new-im-bot"]);
    expect(loadWeixinAccount("new-im-bot")?.token).toBe("fresh-token");
  });

  it("rejects incomplete login data without changing the current account", () => {
    seedAccount("current-im-bot", "current-owner", "current-token");
    seedIndex(["current-im-bot"]);
    const beforeIndex = fs.readFileSync(indexPath());
    const beforeAccount = fs.readFileSync(accountPath("current-im-bot"));

    expect(() =>
      replaceWeixinAccount({
        accountId: "new@im.bot",
        token: "",
        userId: "new-owner",
      }),
    ).toThrow("complete WeChat account ID, token, and user ID");

    expect(fs.readFileSync(indexPath())).toEqual(beforeIndex);
    expect(fs.readFileSync(accountPath("current-im-bot"))).toEqual(beforeAccount);
    expect(fs.existsSync(accountPath("new-im-bot"))).toBe(false);
    expect(isActiveWeixinAccount("current-im-bot")).toBe(true);
  });

  it("rolls back credentials and index when old-account cleanup fails", () => {
    seedAccount("old-im-bot", "old-owner", "old-token");
    seedIndex(["old-im-bot"]);
    fs.writeFileSync(syncPath("old-im-bot"), "sync-state");
    const originalUnlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync").mockImplementation((filePath) => {
      if (filePath === syncPath("old-im-bot")) {
        const error = new Error("simulated cleanup failure") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return originalUnlink(filePath);
    });

    expect(() =>
      replaceWeixinAccount({
        accountId: "new@im.bot",
        token: "new-token",
        userId: "new-owner",
      }),
    ).toThrow("simulated cleanup failure");

    expect(JSON.parse(fs.readFileSync(indexPath(), "utf8"))).toEqual(["old-im-bot"]);
    expect(loadWeixinAccount("old-im-bot")?.token).toBe("old-token");
    expect(fs.readFileSync(syncPath("old-im-bot"), "utf8")).toBe("sync-state");
    expect(fs.existsSync(accountPath("new-im-bot"))).toBe(false);
  });

  it("observes an account-index replacement performed by another process", async () => {
    seedAccount("old-im-bot", "old-owner", "old-token");
    seedIndex(["old-im-bot"]);
    let resolveObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      resolveObserved = resolve;
    });
    const unwatch = watchWeixinAccountState(resolveObserved);

    try {
      const temporaryIndex = `${indexPath()}.external`;
      fs.writeFileSync(temporaryIndex, JSON.stringify(["new-im-bot"]));
      fs.renameSync(temporaryIndex, indexPath());
      await Promise.race([
        observed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("account state watcher did not fire")), 2000),
        ),
      ]);
    } finally {
      unwatch();
    }
  });
});
