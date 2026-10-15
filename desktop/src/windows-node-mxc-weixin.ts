import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { BundledWindowsNodeFolder } from "./bundled-windows-node-host";

export const WINDOWS_NODE_MXC_INGRESS_RELEASE_CONTRACT = "microclaw.windows-ingress-release.v1";
export const WINDOWS_NODE_MXC_WEIXIN_MEDIA_POLICY_CONTRACT = "microclaw.windows-weixin-media.v1";
export const WINDOWS_NODE_MXC_WEIXIN_ENVIRONMENT_KEYS = [
  "MICROCLAW_MXC_INGRESS_RELEASE_PATH",
  "MICROCLAW_MXC_INGRESS_RELEASE_TOKEN",
  "MICROCLAW_MXC_WEIXIN_MEDIA_POLICY",
  "MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_PIPE",
  "MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_TOKEN",
] as const;

export function clearInheritedWindowsNodeMxcWeixinEnvironment(
  environment: Record<string, string>,
): void {
  for (const key of WINDOWS_NODE_MXC_WEIXIN_ENVIRONMENT_KEYS) delete environment[key];
}

export interface WindowsNodeMxcWeixinContext {
  gatewayGeneration: string;
  policyFingerprint: string;
  releasePath: string;
  releaseToken: string;
  inboundRoot: string;
  outboundTempRoot: string;
  mediaPolicyBase64: string;
  remoteApprovalPipe: string | null;
  remoteApprovalToken: string | null;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function safeAccountKey(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const safe = trimmed.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!safe || safe === "_") throw new Error("MXC WeChat account id is invalid");
  return safe;
}

function readJsonRecord(filePath: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch {
    return null;
  }
}

function readAllowFrom(filePath: string): string[] {
  const allowFrom = readJsonRecord(filePath)?.allowFrom;
  return Array.isArray(allowFrom)
    ? allowFrom
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
}

export function resolveStoredWindowsNodeMxcWeixinAccountPath(
  stateDir: string,
  accountId: string,
): string {
  const accountsDir = path.join(stateDir, "openclaw-weixin", "accounts");
  const primary = path.join(accountsDir, `${accountId}.json`);
  if (fs.existsSync(primary)) return primary;
  if (accountId.endsWith("-im-bot")) {
    return path.join(accountsDir, `${accountId.slice(0, -7)}@im.bot.json`);
  }
  if (accountId.endsWith("-im-wechat")) {
    return path.join(accountsDir, `${accountId.slice(0, -10)}@im.wechat.json`);
  }
  return primary;
}

export function readWindowsNodeMxcWeixinAllowedSenders(params: {
  stateDir: string;
  credentialsDir?: string;
  accountId: string;
}): string[] {
  const credentialsDir = params.credentialsDir?.trim() || path.join(params.stateDir, "credentials");
  return readAllowFrom(
    path.join(credentialsDir, `openclaw-weixin-${safeAccountKey(params.accountId)}-allowFrom.json`),
  );
}

export function preflightWindowsNodeMxcWeixinAuthorization(params: {
  stateDir: string;
  credentialsDir?: string;
  config: unknown;
}): { migratedAccountIds: string[] } {
  const root = asRecord(params.config);
  const plugins = asRecord(root.plugins);
  const pluginEntries = asRecord(plugins.entries);
  if (asRecord(pluginEntries["openclaw-weixin"]).enabled !== true) {
    return { migratedAccountIds: [] };
  }

  const accountsPath = path.join(params.stateDir, "openclaw-weixin", "accounts.json");
  if (!fs.existsSync(accountsPath)) return { migratedAccountIds: [] };
  const accountIds = (() => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
      if (
        !Array.isArray(parsed) ||
        parsed.some((value) => typeof value !== "string" || value.trim().length === 0)
      ) {
        throw new Error("account index is invalid");
      }
      return parsed as string[];
    } catch (error) {
      throw new Error(
        `MXC WeChat authorization preflight failed: account index is unreadable: ${String(error)}`,
        { cause: error },
      );
    }
  })();

  const channel = asRecord(asRecord(root.channels)["openclaw-weixin"]);
  const configuredAccounts = asRecord(channel.accounts);
  const credentialsDir = params.credentialsDir?.trim() || path.join(params.stateDir, "credentials");
  const migratedAccountIds: string[] = [];
  const blockedAccountIds: string[] = [];

  for (const accountId of accountIds) {
    const accountConfig = Object.prototype.hasOwnProperty.call(configuredAccounts, accountId)
      ? asRecord(configuredAccounts[accountId])
      : channel;
    if (accountConfig.enabled === false) continue;

    const allowFromPath = path.join(
      credentialsDir,
      `openclaw-weixin-${safeAccountKey(accountId)}-allowFrom.json`,
    );
    if (readAllowFrom(allowFromPath).length > 0) continue;

    const account = readJsonRecord(
      resolveStoredWindowsNodeMxcWeixinAccountPath(params.stateDir, accountId),
    );
    const ownerUserId = typeof account?.userId === "string" ? account.userId.trim() : "";
    if (!ownerUserId) {
      blockedAccountIds.push(accountId);
      continue;
    }

    fs.mkdirSync(credentialsDir, { recursive: true });
    const existing = readJsonRecord(allowFromPath) ?? {};
    fs.writeFileSync(
      allowFromPath,
      JSON.stringify(
        {
          ...existing,
          version: typeof existing.version === "number" ? existing.version : 1,
          allowFrom: [ownerUserId],
        },
        null,
        2,
      ),
      "utf8",
    );
    migratedAccountIds.push(accountId);
  }

  if (blockedAccountIds.length > 0) {
    throw new Error(
      `MXC WeChat authorization preflight failed: enabled account(s) lack an explicit sender allowlist or stored owner userId: ${blockedAccountIds.join(", ")}`,
    );
  }
  return { migratedAccountIds };
}

export function resolveWindowsNodeMxcWeixinMediaRoots(userDataPath: string): {
  inboundRoot: string;
  outboundTempRoot: string;
} {
  const mediaRoot = path.join(userDataPath, "mxc-weixin-media");
  return {
    inboundRoot: path.join(mediaRoot, "inbound"),
    outboundTempRoot: path.join(mediaRoot, "outbound-temp"),
  };
}

export function prepareWindowsNodeMxcWeixinContext(
  userDataPath: string,
  gatewayGeneration: string,
  policyFingerprint: string,
  folders: BundledWindowsNodeFolder[],
  remoteApprovalEnabled = false,
): WindowsNodeMxcWeixinContext {
  if (!gatewayGeneration.trim()) throw new Error("Gateway generation is required");
  if (!/^[a-f0-9]{64}$/i.test(policyFingerprint)) {
    throw new Error("MXC policy fingerprint is invalid");
  }
  const { inboundRoot, outboundTempRoot } = resolveWindowsNodeMxcWeixinMediaRoots(userDataPath);
  fs.mkdirSync(inboundRoot, { recursive: true });
  fs.mkdirSync(outboundTempRoot, { recursive: true });
  const releasePath = path.join(userDataPath, "windows-node", "ingress-release.json");
  fs.rmSync(releasePath, { force: true });
  const releaseToken = randomBytes(32).toString("base64url");
  const approvedRoots = [
    ...folders.map((folder) => ({
      path: path.resolve(folder.path),
      access: folder.access,
      purpose: "selected-folder",
    })),
    {
      path: path.resolve(inboundRoot),
      access: "ro" as const,
      purpose: "weixin-inbound",
    },
  ];
  const mediaPolicyBase64 = Buffer.from(
    JSON.stringify({
      contract: WINDOWS_NODE_MXC_WEIXIN_MEDIA_POLICY_CONTRACT,
      gatewayGeneration,
      policyFingerprint: policyFingerprint.toLowerCase(),
      strictNoHostFallback: true,
      approvedRoots,
      inboundRoot: path.resolve(inboundRoot),
      outboundTempRoot: path.resolve(outboundTempRoot),
    }),
    "utf8",
  ).toString("base64");
  return {
    gatewayGeneration,
    policyFingerprint: policyFingerprint.toLowerCase(),
    releasePath,
    releaseToken,
    inboundRoot,
    outboundTempRoot,
    mediaPolicyBase64,
    remoteApprovalPipe: remoteApprovalEnabled
      ? `\\\\.\\pipe\\microclaw-weixin-remote-approval-${process.pid}-${randomBytes(12).toString("hex")}`
      : null,
    remoteApprovalToken: remoteApprovalEnabled ? randomBytes(32).toString("base64url") : null,
  };
}

export function getWindowsNodeMxcWeixinEnvironment(
  context: WindowsNodeMxcWeixinContext,
): Record<string, string> {
  const environment: Record<string, string> = {
    MICROCLAW_MXC_INGRESS_RELEASE_PATH: context.releasePath,
    MICROCLAW_MXC_INGRESS_RELEASE_TOKEN: context.releaseToken,
    MICROCLAW_MXC_WEIXIN_MEDIA_POLICY: context.mediaPolicyBase64,
  };
  if (context.remoteApprovalPipe && context.remoteApprovalToken) {
    environment.MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_PIPE = context.remoteApprovalPipe;
    environment.MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_TOKEN = context.remoteApprovalToken;
  }
  return environment;
}

export function releaseWindowsNodeMxcWeixinIngress(context: WindowsNodeMxcWeixinContext): void {
  const record = {
    contract: WINDOWS_NODE_MXC_INGRESS_RELEASE_CONTRACT,
    gatewayGeneration: context.gatewayGeneration,
    policyFingerprint: context.policyFingerprint,
    token: context.releaseToken,
    releasedAtUnixMs: Date.now(),
  };
  fs.mkdirSync(path.dirname(context.releasePath), { recursive: true });
  const temporary = `${context.releasePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, context.releasePath);
}

export function revokeWindowsNodeMxcWeixinIngress(
  context: WindowsNodeMxcWeixinContext | null,
): void {
  if (context) fs.rmSync(context.releasePath, { force: true });
}
