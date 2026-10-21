import fs from "node:fs";
import path from "node:path";

const SAFE_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._@-]{1,160}$/;
const SAFE_USER_ID_PATTERN = /^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]{1,320}$/u;

export type WeixinAccountInvariantState = "none" | "single" | "multiple" | "invalid";

export interface SafeWeixinAccountIdentity {
  accountId: string;
  userId?: string;
}

export interface WeixinAccountStatus {
  loggedIn: boolean;
  accountCount: number;
  invariantState: WeixinAccountInvariantState;
  currentAccount: SafeWeixinAccountIdentity | null;
}

export function shouldRevokeWeixinRemoteApprovalOwner(
  status: WeixinAccountStatus,
  owner: { accountId: string; userId: string } | null,
): boolean {
  if (!owner) return false;
  return !(
    status.loggedIn &&
    status.invariantState === "single" &&
    status.currentAccount?.accountId === owner.accountId &&
    status.currentAccount.userId === owner.userId
  );
}

function normalizeSafeAccountId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const accountId = value.trim().toLowerCase();
  if (!accountId || accountId.includes("..") || !SAFE_ACCOUNT_ID_PATTERN.test(accountId)) {
    return null;
  }
  return accountId;
}

function normalizeSafeUserId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const userId = value.trim().toLowerCase();
  return SAFE_USER_ID_PATTERN.test(userId) ? userId : undefined;
}

export function readWeixinAccountStatus(stateDir: string): WeixinAccountStatus {
  const indexPath = path.join(stateDir, "openclaw-weixin", "accounts.json");
  if (!fs.existsSync(indexPath)) {
    return {
      loggedIn: false,
      accountCount: 0,
      invariantState: "none",
      currentAccount: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch {
    return {
      loggedIn: false,
      accountCount: 0,
      invariantState: "invalid",
      currentAccount: null,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      loggedIn: false,
      accountCount: 0,
      invariantState: "invalid",
      currentAccount: null,
    };
  }
  if (parsed.length === 0) {
    return {
      loggedIn: false,
      accountCount: 0,
      invariantState: "none",
      currentAccount: null,
    };
  }
  if (parsed.length !== 1) {
    return {
      loggedIn: false,
      accountCount: parsed.length,
      invariantState: "multiple",
      currentAccount: null,
    };
  }

  const accountId = normalizeSafeAccountId(parsed[0]);
  if (!accountId || accountId !== parsed[0]) {
    return {
      loggedIn: false,
      accountCount: 1,
      invariantState: "invalid",
      currentAccount: null,
    };
  }

  try {
    const accountPath = path.join(stateDir, "openclaw-weixin", "accounts", `${accountId}.json`);
    const account = JSON.parse(fs.readFileSync(accountPath, "utf8")) as Record<string, unknown>;
    if (typeof account.token !== "string" || !account.token.trim()) {
      throw new Error("missing token");
    }
    const userId = normalizeSafeUserId(account.userId);
    return {
      loggedIn: true,
      accountCount: 1,
      invariantState: "single",
      currentAccount: {
        accountId,
        ...(userId ? { userId } : {}),
      },
    };
  } catch {
    return {
      loggedIn: false,
      accountCount: 1,
      invariantState: "invalid",
      currentAccount: null,
    };
  }
}
