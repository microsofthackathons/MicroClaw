import fs from "node:fs";
import path from "node:path";

import type { WindowsNodeMxcRequestedMode } from "./windows-node-mxc-modes";
import {
  normalizeWeixinRemoteApprovalOwner,
  type WeixinRemoteApprovalConfiguration,
} from "./windows-node-mxc-weixin-remote-approval";
import {
  readWindowsNodeMxcWeixinAllowedSenders,
  resolveStoredWindowsNodeMxcWeixinAccountPath,
} from "./windows-node-mxc-weixin";

const CANDIDATE_BOUND_AT = new Date(0).toISOString();
const SAFE_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._@-]{1,160}$/;

type JsonRecord = Record<string, unknown>;

export type WeixinRemoteApprovalIneligibleReason =
  | "account-disabled"
  | "not-authenticated"
  | "not-allowlisted";

export interface WeixinRemoteApprovalActivationOwner {
  accountId: string;
  userId: string;
}

export interface WeixinRemoteApprovalIneligibleAccount {
  accountId: string;
  userId: string | null;
  reason: WeixinRemoteApprovalIneligibleReason;
}

export interface WeixinRemoteApprovalActivationOptions {
  weixinEnabled: boolean;
  linkedAccountCount: number;
  authenticatedAccountCount: number;
  eligibleOwners: WeixinRemoteApprovalActivationOwner[];
  ineligibleAccounts: WeixinRemoteApprovalIneligibleAccount[];
}

export type WeixinRemoteApprovalActivationSelection =
  | { enabled: false }
  | {
      enabled: true;
      owner: WeixinRemoteApprovalActivationOwner;
    };

export type WeixinRemoteApprovalTransitionPlan =
  | { action: "preserve" }
  | {
      action: "persist";
      configuration: WeixinRemoteApprovalConfiguration;
    };

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function normalizeAccountId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const accountId = value.trim().toLowerCase();
  if (
    !accountId ||
    accountId.includes("..") ||
    !SAFE_ACCOUNT_ID_PATTERN.test(accountId)
  ) {
    return null;
  }
  return accountId;
}

function normalizeOwner(
  accountId: string,
  userId: unknown,
): WeixinRemoteApprovalActivationOwner | null {
  if (typeof userId !== "string" || !userId.trim()) return null;
  try {
    const owner = normalizeWeixinRemoteApprovalOwner(accountId, userId, CANDIDATE_BOUND_AT);
    return { accountId: owner.accountId, userId: owner.userId };
  } catch {
    return null;
  }
}

function isAccountEnabled(config: JsonRecord, accountId: string): boolean {
  const channels = asRecord(config.channels);
  const channel = asRecord(channels["openclaw-weixin"]);
  const accounts = asRecord(channel.accounts);
  const account = Object.prototype.hasOwnProperty.call(accounts, accountId)
    ? asRecord(accounts[accountId])
    : channel;
  return account.enabled !== false;
}

export function readWeixinRemoteApprovalActivationOptions(params: {
  stateDir: string;
  credentialsDir?: string;
  config: unknown;
}): WeixinRemoteApprovalActivationOptions {
  const config = asRecord(params.config);
  const pluginEntries = asRecord(asRecord(config.plugins).entries);
  const weixinEnabled = asRecord(pluginEntries["openclaw-weixin"]).enabled === true;
  const rawAccountIds = readJson(
    path.join(params.stateDir, "openclaw-weixin", "accounts.json"),
  );
  const accountIds = Array.isArray(rawAccountIds)
    ? [
        ...new Set(
          rawAccountIds
            .map(normalizeAccountId)
            .filter((accountId): accountId is string => accountId !== null),
        ),
      ]
    : [];
  const eligibleOwners: WeixinRemoteApprovalActivationOwner[] = [];
  const ineligibleAccounts: WeixinRemoteApprovalIneligibleAccount[] = [];
  let authenticatedAccountCount = 0;

  for (const accountId of accountIds) {
    const account = asRecord(
      readJson(resolveStoredWindowsNodeMxcWeixinAccountPath(params.stateDir, accountId)),
    );
    const owner = normalizeOwner(accountId, account.userId);
    const authenticated =
      typeof account.token === "string" && account.token.trim().length > 0 && owner !== null;
    if (authenticated) authenticatedAccountCount += 1;

    if (!isAccountEnabled(config, accountId)) {
      ineligibleAccounts.push({
        accountId,
        userId: owner?.userId ?? null,
        reason: "account-disabled",
      });
      continue;
    }
    if (!authenticated || !owner) {
      ineligibleAccounts.push({
        accountId,
        userId: owner?.userId ?? null,
        reason: "not-authenticated",
      });
      continue;
    }
    const allowedSenders = readWindowsNodeMxcWeixinAllowedSenders({
      stateDir: params.stateDir,
      credentialsDir: params.credentialsDir,
      accountId,
    }).map((senderId) => senderId.trim().toLowerCase());
    if (!allowedSenders.includes(owner.userId)) {
      ineligibleAccounts.push({
        accountId,
        userId: owner.userId,
        reason: "not-allowlisted",
      });
      continue;
    }
    eligibleOwners.push(owner);
  }

  const byIdentity = (
    left: WeixinRemoteApprovalActivationOwner,
    right: WeixinRemoteApprovalActivationOwner,
  ) =>
    left.accountId.localeCompare(right.accountId) || left.userId.localeCompare(right.userId);
  eligibleOwners.sort(byIdentity);
  ineligibleAccounts.sort(
    (left, right) =>
      left.accountId.localeCompare(right.accountId) ||
      (left.userId ?? "").localeCompare(right.userId ?? ""),
  );

  return {
    weixinEnabled,
    linkedAccountCount: accountIds.length,
    authenticatedAccountCount,
    eligibleOwners,
    ineligibleAccounts,
  };
}

export function planWeixinRemoteApprovalTransition(params: {
  currentMode: WindowsNodeMxcRequestedMode;
  requestedMode: WindowsNodeMxcRequestedMode;
  currentConfiguration?: WeixinRemoteApprovalConfiguration;
  options?: WeixinRemoteApprovalActivationOptions;
  selection?: WeixinRemoteApprovalActivationSelection;
  now?: Date;
}): WeixinRemoteApprovalTransitionPlan {
  if (params.requestedMode === "off") {
    return {
      action: "persist",
      configuration: { enabled: false, owner: null },
    };
  }
  if (params.currentMode !== "off") {
    const current = params.currentConfiguration ?? { enabled: false, owner: null };
    if (!current.enabled) {
      return current.owner
        ? {
            action: "persist",
            configuration: { enabled: false, owner: null },
          }
        : { action: "preserve" };
    }
    const owner = current.owner;
    const stillEligible =
      owner &&
      params.options?.weixinEnabled === true &&
      params.options.eligibleOwners.some(
        (candidate) =>
          candidate.accountId === owner.accountId && candidate.userId === owner.userId,
      );
    return stillEligible
      ? { action: "preserve" }
      : {
          action: "persist",
          configuration: { enabled: false, owner: null },
        };
  }

  const selection = params.selection;
  if (selection === undefined || selection.enabled === false) {
    return {
      action: "persist",
      configuration: { enabled: false, owner: null },
    };
  }
  if (
    selection.enabled !== true ||
    !selection.owner ||
    typeof selection.owner.accountId !== "string" ||
    typeof selection.owner.userId !== "string"
  ) {
    throw new Error("A valid WeChat remote approval activation choice is required");
  }
  const options = params.options;
  if (!options?.weixinEnabled) {
    throw new Error("WeChat remote approval is unavailable because the WeChat channel is disabled");
  }
  const selectedOwner = normalizeOwner(selection.owner.accountId, selection.owner.userId);
  const eligible =
    selectedOwner &&
    options.eligibleOwners.some(
      (owner) =>
        owner.accountId === selectedOwner.accountId && owner.userId === selectedOwner.userId,
    );
  if (!selectedOwner || !eligible) {
    throw new Error("The selected WeChat remote approval owner is no longer eligible");
  }
  return {
    action: "persist",
    configuration: {
      enabled: true,
      owner: normalizeWeixinRemoteApprovalOwner(
        selectedOwner.accountId,
        selectedOwner.userId,
        (params.now ?? new Date()).toISOString(),
      ),
    },
  };
}
