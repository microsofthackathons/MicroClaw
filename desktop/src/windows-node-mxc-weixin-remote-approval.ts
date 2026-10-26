import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { WindowsNodeMxcGatewayApproval } from "./windows-node-mxc";

export const WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT =
  "microclaw.windows-weixin-remote-approval.v1";
export const WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_TTL_MS = 2 * 60_000;
export const WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_MAX_ATTEMPTS = 3;

const CHALLENGE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CHALLENGE_CODE_LENGTH = 8;
const MAX_GLOBAL_ATTEMPTS_PER_MINUTE = 20;
const MAX_PROMPT_REQUESTS = 8;
const MAX_PROMPT_LINE = 160;
const MAX_PROMPT_LENGTH = 6_000;
const REMOTE_APPROVAL_SCRATCH_CWD = "isolated-scratch:v1";

type WeixinRemoteApprovalProgram =
  | "windows-hostname"
  | "windows-identity"
  | "windows-network"
  | "windows-system-information";
type WeixinRemoteApprovalOption = "none" | "user" | "groups" | "privileges" | "all";
type WeixinRemoteApprovalEffectiveMode =
  | "base-container"
  | "appcontainer-bfs"
  | "appcontainer-dacl"
  | "limited-dacl"
  | "full";

const REMOTE_APPROVAL_TUPLES: ReadonlyArray<{
  program: WeixinRemoteApprovalProgram;
  option: WeixinRemoteApprovalOption;
  executable: string;
  executablePath: string;
  arguments: readonly string[];
  command: string;
}> = [
  {
    program: "windows-hostname",
    option: "none",
    executable: "hostname.exe",
    executablePath: "C:\\Windows\\System32\\hostname.exe",
    arguments: [],
    command: "hostname.exe",
  },
  {
    program: "windows-identity",
    option: "none",
    executable: "whoami.exe",
    executablePath: "C:\\Windows\\System32\\whoami.exe",
    arguments: [],
    command: "whoami.exe",
  },
  ...(["user", "groups", "priv"] as const).map((option) => ({
    program: "windows-identity" as const,
    option: option === "priv" ? ("privileges" as const) : option,
    executable: "whoami.exe",
    executablePath: "C:\\Windows\\System32\\whoami.exe",
    arguments: [`/${option}`],
    command: `whoami.exe /${option}`,
  })),
  {
    program: "windows-network",
    option: "none",
    executable: "ipconfig.exe",
    executablePath: "C:\\Windows\\System32\\ipconfig.exe",
    arguments: [],
    command: "ipconfig.exe",
  },
  {
    program: "windows-network",
    option: "all",
    executable: "ipconfig.exe",
    executablePath: "C:\\Windows\\System32\\ipconfig.exe",
    arguments: ["/all"],
    command: "ipconfig.exe /all",
  },
  {
    program: "windows-system-information",
    option: "none",
    executable: "systeminfo.exe",
    executablePath: "C:\\Windows\\System32\\systeminfo.exe",
    arguments: [],
    command: "systeminfo.exe",
  },
];

export interface WeixinRemoteApprovalOwnerBinding {
  contract: typeof WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT;
  accountId: string;
  userId: string;
  boundAt: string;
}

export interface WeixinRemoteApprovalConfiguration {
  enabled: boolean;
  owner: WeixinRemoteApprovalOwnerBinding | null;
}

export function migrateWeixinRemoteApprovalConfiguration(
  value: unknown,
): WeixinRemoteApprovalConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { enabled: false, owner: null };
  }
  const record = value as Record<string, unknown>;
  const ownerValue = record.owner;
  if (!ownerValue || typeof ownerValue !== "object" || Array.isArray(ownerValue)) {
    return { enabled: false, owner: null };
  }
  const owner = ownerValue as Record<string, unknown>;
  try {
    const normalized = normalizeWeixinRemoteApprovalOwner(
      typeof owner.accountId === "string" ? owner.accountId : "",
      typeof owner.userId === "string" ? owner.userId : "",
      typeof owner.boundAt === "string" ? owner.boundAt : new Date(0).toISOString(),
    );
    return { enabled: record.enabled === true, owner: normalized };
  } catch {
    return { enabled: false, owner: null };
  }
}

export interface WeixinRemoteApprovalSource {
  accountId: string;
  senderId: string;
  conversationId: string;
  messageId: string;
  cursor: number;
  agentId: string;
  sessionKey: string;
  direct: boolean;
  forwarded: boolean;
  quoted: boolean;
  receivedAtUnixMs: number;
}

export interface WeixinRemoteApprovalSecurityBinding {
  gatewayGeneration: string;
  policyFingerprint: string;
  nodeId: string;
  activationLeaseHash: string;
  requestedMode: "limited-dacl" | "full";
  effectiveMode: string;
}

export interface WeixinRemoteApprovalBatchRequest {
  approval: WindowsNodeMxcGatewayApproval;
}

export interface WeixinRemoteApprovalCreateInput {
  source: WeixinRemoteApprovalSource;
  requests: WeixinRemoteApprovalBatchRequest[];
  security: WeixinRemoteApprovalSecurityBinding;
  locale: "en-US" | "zh-CN";
  now?: number;
}

export interface WeixinRemoteApprovalPresentation {
  requests: Array<{
    program: WeixinRemoteApprovalProgram;
    option: WeixinRemoteApprovalOption;
  }>;
  requestedMode: "limited-dacl" | "full";
  effectiveMode: WeixinRemoteApprovalEffectiveMode;
}

export interface WeixinRemoteApprovalDelivery {
  contract: typeof WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT;
  challengeId: string;
  challengeHash: string;
  accountId: string;
  senderId: string;
  conversationId: string;
  sourceMessageId: string;
  sourceCursor: number;
  expiresAtUnixMs: number;
  text: string;
}

export interface WeixinRemoteApprovalCandidate {
  accountId: string;
  senderId: string;
  conversationId: string;
  messageId: string;
  cursor: number;
  direct: boolean;
  forwarded: boolean;
  quoted: boolean;
  ambiguous?: boolean;
  text: string;
  now?: number;
  requests?: WeixinRemoteApprovalBatchRequest[];
  security?: WeixinRemoteApprovalSecurityBinding;
}

export type WeixinRemoteApprovalResolution =
  | {
      consumed: false;
      status: "not-candidate";
    }
  | {
      consumed: true;
      status: "approved" | "denied";
      challengeId: string;
      approvalIds: string[];
      decision: "allow-once" | "deny";
      acknowledgement: string;
    }
  | {
      consumed: true;
      status: "rejected";
      reason:
        | "identity"
        | "chat"
        | "group"
        | "forwarded"
        | "quoted"
        | "cursor"
        | "code"
        | "expired"
        | "stale"
        | "rate-limited"
        | "replayed"
        | "inactive"
        | "malformed";
      acknowledgement: string;
    };

export interface WeixinRemoteApprovalAuditEvent {
  contract: typeof WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT;
  timestamp: string;
  challengeHash: string;
  ownerHash: string;
  chatHash: string;
  approvalIdHashes: string[];
  result: string;
  reason: string;
  gatewayGenerationHash: string;
  policyFingerprintHash: string;
  nodeIdHash: string;
  activationLeaseHash: string;
}

interface ActiveChallenge {
  id: string;
  code: string;
  codeHash: string;
  challengeHash: string;
  bindingHash: string;
  source: WeixinRemoteApprovalSource;
  security: WeixinRemoteApprovalSecurityBinding;
  approvalIds: string[];
  createdAtUnixMs: number;
  expiresAtUnixMs: number;
  attempts: number;
  lastCandidateCursor: number;
  locale: "en-US" | "zh-CN";
}

interface ClosedChallenge {
  codeHash: string;
  expiresAtUnixMs: number;
  locale: "en-US" | "zh-CN";
}

export interface WeixinRemoteApprovalNotice {
  challengeId: string;
  accountId: string;
  senderId: string;
  acknowledgement: string;
}

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeOpaqueId(value: string): string {
  return value.trim();
}

export function normalizeWeixinRemoteApprovalOwner(
  accountId: string,
  userId: string,
  boundAt = new Date().toISOString(),
): WeixinRemoteApprovalOwnerBinding {
  const normalizedAccountId = normalizeIdentity(accountId);
  const normalizedUserId = normalizeIdentity(userId);
  if (!normalizedAccountId || !normalizedUserId || !normalizedUserId.endsWith("@im.wechat")) {
    throw new Error("A valid authenticated WeChat account and owner user ID are required");
  }
  return {
    contract: WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT,
    accountId: normalizedAccountId,
    userId: normalizedUserId,
    boundAt,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function securityBindingHash(
  source: WeixinRemoteApprovalSource,
  requests: WeixinRemoteApprovalBatchRequest[],
  security: WeixinRemoteApprovalSecurityBinding,
  challenge: {
    id: string;
    codeHash: string;
    createdAtUnixMs: number;
    expiresAtUnixMs: number;
  },
): string {
  return hash(
    canonicalize({
      source: {
        accountId: normalizeIdentity(source.accountId),
        senderId: normalizeIdentity(source.senderId),
        conversationId: normalizeOpaqueId(source.conversationId),
        messageId: normalizeOpaqueId(source.messageId),
        cursor: source.cursor,
        agentId: normalizeOpaqueId(source.agentId),
        sessionKey: normalizeOpaqueId(source.sessionKey),
        direct: source.direct,
        forwarded: source.forwarded,
        quoted: source.quoted,
        receivedAtUnixMs: source.receivedAtUnixMs,
      },
      requests: requests.map(({ approval }) => ({
        id: approval.id,
        command: approval.command,
        executable: approval.executable,
        executablePath: approval.executablePath,
        executableSha256: approval.executableSha256.toLowerCase(),
        arguments: approval.arguments,
        canonicalCwd: approval.canonicalCwd,
        declaredAccess: approval.declaredAccess,
        agent: approval.agent,
        sessionKey: approval.sessionKey,
        hasMutableFileOperand: approval.hasMutableFileOperand,
        allowedDecisions: approval.allowedDecisions,
      })),
      security,
      challenge,
    }),
  );
}

function constantTimeCodeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function createCode(): string {
  const bytes = randomBytes(CHALLENGE_CODE_LENGTH);
  let result = "";
  for (const byte of bytes) result += CHALLENGE_ALPHABET[byte % CHALLENGE_ALPHABET.length];
  return result;
}

function exactStringArrayEquals(left: string[], right: readonly string[]): boolean {
  /*
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
  */
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isEffectiveMode(value: string): value is WeixinRemoteApprovalEffectiveMode {
  return (
    value === "base-container" ||
    value === "appcontainer-bfs" ||
    value === "appcontainer-dacl" ||
    value === "limited-dacl" ||
    value === "full"
  );
}

function findRemoteApprovalTuple(approval: WeixinRemoteApprovalBatchRequest["approval"]) {
  return REMOTE_APPROVAL_TUPLES.find(
    (candidate) =>
      approval.executable === candidate.executable &&
      approval.executablePath === candidate.executablePath &&
      approval.command === candidate.command &&
      exactStringArrayEquals(approval.arguments, candidate.arguments),
  );
}

function isPromptLineLengthValid(lines: string[]): boolean {
  return lines.every((line) => line.length <= MAX_PROMPT_LINE);
}

export function classifyWeixinRemoteApprovalPresentation(
  requests: WeixinRemoteApprovalBatchRequest[],
  security: WeixinRemoteApprovalSecurityBinding,
): WeixinRemoteApprovalPresentation | null {
  if (
    requests.length === 0 ||
    requests.length > MAX_PROMPT_REQUESTS ||
    !isEffectiveMode(security.effectiveMode)
  ) {
    return null;
  }
  const presentationRequests: WeixinRemoteApprovalPresentation["requests"] = [];
  for (const { approval } of requests) {
    if (
      approval.canonicalCwd !== REMOTE_APPROVAL_SCRATCH_CWD ||
      approval.declaredAccess.length !== 0 ||
      approval.hasMutableFileOperand ||
      !approval.allowedDecisions.includes("allow-once") ||
      !approval.allowedDecisions.includes("deny") ||
      !/^[a-f0-9]{64}$/i.test(approval.executableSha256)
    ) {
      return null;
    }
    const tuple = findRemoteApprovalTuple(approval);
    if (!tuple) return null;
    presentationRequests.push({ program: tuple.program, option: tuple.option });
  }
  return {
    requests: presentationRequests,
    requestedMode: security.requestedMode,
    effectiveMode: security.effectiveMode,
  };
}

const PROGRAM_LABELS: Record<WeixinRemoteApprovalProgram, Record<"en-US" | "zh-CN", string>> = {
  "windows-hostname": {
    "en-US": "Windows host name",
    "zh-CN": "Windows 主机名",
  },
  "windows-identity": {
    "en-US": "Current Windows identity",
    "zh-CN": "当前 Windows 身份",
  },
  "windows-network": {
    "en-US": "Windows network configuration",
    "zh-CN": "Windows 网络配置",
  },
  "windows-system-information": {
    "en-US": "Windows system information",
    "zh-CN": "Windows 系统信息",
  },
};

const OPTION_LABELS: Record<WeixinRemoteApprovalOption, Record<"en-US" | "zh-CN", string>> = {
  none: { "en-US": "none", "zh-CN": "无" },
  user: { "en-US": "user details", "zh-CN": "用户详情" },
  groups: { "en-US": "group memberships", "zh-CN": "组成员身份" },
  privileges: { "en-US": "privileges", "zh-CN": "权限列表" },
  all: { "en-US": "all details", "zh-CN": "全部详情" },
};

const REQUESTED_MODE_LABELS: Record<
  WeixinRemoteApprovalPresentation["requestedMode"],
  Record<"en-US" | "zh-CN", string>
> = {
  "limited-dacl": {
    "en-US": "Limited containment (DACL)",
    "zh-CN": "有限隔离（DACL）",
  },
  full: { "en-US": "Full containment", "zh-CN": "完整隔离" },
};

const EFFECTIVE_MODE_LABELS: Record<
  WeixinRemoteApprovalEffectiveMode,
  Record<"en-US" | "zh-CN", string>
> = {
  "base-container": { "en-US": "Base Container", "zh-CN": "Base Container" },
  "appcontainer-bfs": { "en-US": "AppContainer BFS", "zh-CN": "AppContainer BFS" },
  "appcontainer-dacl": {
    "en-US": "AppContainer DACL",
    "zh-CN": "AppContainer DACL",
  },
  "limited-dacl": {
    "en-US": "Limited containment (DACL)",
    "zh-CN": "有限隔离（DACL）",
  },
  full: { "en-US": "Full containment", "zh-CN": "完整隔离" },
};

export function renderWeixinRemoteApprovalPrompt(params: {
  code: string;
  expiresAtUnixMs: number;
  presentation: WeixinRemoteApprovalPresentation;
  locale: "en-US" | "zh-CN";
}): string {
  const requestLines = params.presentation.requests.flatMap((request, index) =>
    params.locale === "zh-CN"
      ? [
          `请求 ${index + 1}: ${PROGRAM_LABELS[request.program]["zh-CN"]}`,
          `选项: ${OPTION_LABELS[request.option]["zh-CN"]}`,
        ]
      : [
          `Request ${index + 1}: ${PROGRAM_LABELS[request.program]["en-US"]}`,
          `Options: ${OPTION_LABELS[request.option]["en-US"]}`,
        ],
  );
  const lines =
    params.locale === "zh-CN"
      ? [
          `[MicroClaw 安全审批 #${params.code}]`,
          "仅批准下列当前请求；不会创建永久授权，也不会批准未来请求。",
          "远程显示仅支持预定义、无不透明操作数的只读系统查询。",
          ...requestLines,
          `隔离模式: ${REQUESTED_MODE_LABELS[params.presentation.requestedMode]["zh-CN"]} / ${EFFECTIVE_MODE_LABELS[params.presentation.effectiveMode]["zh-CN"]}`,
          `过期时间: ${new Date(params.expiresAtUnixMs).toISOString()}`,
          `回复: 1 ${params.code}（仅批准此请求一次）`,
          `      2 ${params.code}（拒绝）`,
          `      3 ${params.code}（仅批准本消息列出的全部 ${params.presentation.requests.length} 个请求一次）`,
        ]
      : [
          `[MicroClaw Security Approval #${params.code}]`,
          "This approves only the current request(s); it creates no durable or future approval.",
          "Remote display supports only predefined read-only system queries with no opaque operands.",
          ...requestLines,
          `Containment: ${REQUESTED_MODE_LABELS[params.presentation.requestedMode]["en-US"]} / ${EFFECTIVE_MODE_LABELS[params.presentation.effectiveMode]["en-US"]}`,
          `Expires: ${new Date(params.expiresAtUnixMs).toISOString()}`,
          `Reply: 1 ${params.code} (approve this request once)`,
          `       2 ${params.code} (deny)`,
          `       3 ${params.code} (approve all ${params.presentation.requests.length} listed request(s) once)`,
        ];
  if (!isPromptLineLengthValid(lines)) {
    throw new Error("Remote approval prompt exceeded its fixed line limit");
  }
  const prompt = lines.join("\n");
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error("Remote approval prompt exceeded its fixed total limit");
  }
  return prompt;
}

function acknowledgement(locale: "en-US" | "zh-CN", result: string): string {
  const zh: Record<string, string> = {
    approved: "MicroClaw 安全审批：已批准一次。",
    denied: "MicroClaw 安全审批：已拒绝。",
    expired: "MicroClaw 安全审批：已过期。",
    invalid: "MicroClaw 安全审批：无效或已失效。",
  };
  const en: Record<string, string> = {
    approved: "MicroClaw Security Approval: approved once.",
    denied: "MicroClaw Security Approval: denied.",
    expired: "MicroClaw Security Approval: expired.",
    invalid: "MicroClaw Security Approval: invalid or no longer active.",
  };
  return (locale === "zh-CN" ? zh : en)[result] ?? en.invalid;
}

export class WindowsNodeMxcWeixinRemoteApprovalBroker {
  private configuration: WeixinRemoteApprovalConfiguration = { enabled: false, owner: null };
  private readonly challengesByChat = new Map<string, ActiveChallenge>();
  private readonly closedByChat = new Map<string, ClosedChallenge>();
  private readonly pendingResolutions = new Map<string, ActiveChallenge>();
  private readonly globalAttemptTimes: number[] = [];
  private readonly auditEvents: WeixinRemoteApprovalAuditEvent[] = [];

  constructor(private readonly onAudit?: (event: WeixinRemoteApprovalAuditEvent) => void) {}

  configure(configuration: WeixinRemoteApprovalConfiguration): void {
    const changed =
      this.configuration.enabled !== configuration.enabled ||
      canonicalize(this.configuration.owner) !== canonicalize(configuration.owner);
    this.configuration = {
      enabled: configuration.enabled,
      owner: configuration.owner
        ? normalizeWeixinRemoteApprovalOwner(
            configuration.owner.accountId,
            configuration.owner.userId,
            configuration.owner.boundAt,
          )
        : null,
    };
    if (changed) this.invalidateAll("configuration-changed");
  }

  getConfiguration(): WeixinRemoteApprovalConfiguration {
    return {
      enabled: this.configuration.enabled,
      owner: this.configuration.owner ? { ...this.configuration.owner } : null,
    };
  }

  getAuditEvents(): WeixinRemoteApprovalAuditEvent[] {
    return this.auditEvents.map((event) => ({
      ...event,
      approvalIdHashes: [...event.approvalIdHashes],
    }));
  }

  createChallenge(input: WeixinRemoteApprovalCreateInput): WeixinRemoteApprovalDelivery | null {
    const now = input.now ?? Date.now();
    const owner = this.configuration.owner;
    const presentation = classifyWeixinRemoteApprovalPresentation(input.requests, input.security);
    if (
      !this.configuration.enabled ||
      !owner ||
      !input.source.direct ||
      input.source.forwarded ||
      input.source.quoted ||
      normalizeIdentity(input.source.accountId) !== owner.accountId ||
      normalizeIdentity(input.source.senderId) !== owner.userId ||
      normalizeOpaqueId(input.source.conversationId) !== normalizeOpaqueId(input.source.senderId) ||
      !Number.isSafeInteger(input.source.cursor) ||
      input.source.cursor < 0 ||
      !presentation
    ) {
      return null;
    }
    const approvalIds = input.requests.map(({ approval }) => approval.id);
    if (
      new Set(approvalIds).size !== approvalIds.length ||
      input.requests.some(
        ({ approval }) =>
          approval.sessionKey !== input.source.sessionKey ||
          (approval.agent ?? "") !== input.source.agentId,
      )
    ) {
      return null;
    }
    const chatKey = this.chatKey(input.source.accountId, input.source.conversationId);
    this.invalidateChat(chatKey, "superseded");
    const code = createCode();
    const id = randomBytes(16).toString("hex");
    const codeHash = hash(code);
    const challengeHash = hash(id);
    const expiresAtUnixMs = now + WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_TTL_MS;
    const challenge: ActiveChallenge = {
      id,
      code,
      codeHash,
      challengeHash,
      bindingHash: securityBindingHash(input.source, input.requests, input.security, {
        id,
        codeHash,
        createdAtUnixMs: now,
        expiresAtUnixMs,
      }),
      source: {
        ...input.source,
        accountId: normalizeIdentity(input.source.accountId),
        senderId: normalizeIdentity(input.source.senderId),
      },
      security: { ...input.security },
      approvalIds,
      createdAtUnixMs: now,
      expiresAtUnixMs,
      attempts: 0,
      lastCandidateCursor: input.source.cursor,
      locale: input.locale,
    };
    const text = renderWeixinRemoteApprovalPrompt({
      code,
      expiresAtUnixMs,
      presentation,
      locale: input.locale,
    });
    this.challengesByChat.set(chatKey, challenge);
    return {
      contract: WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT,
      challengeId: id,
      challengeHash,
      accountId: challenge.source.accountId,
      senderId: challenge.source.senderId,
      conversationId: challenge.source.conversationId,
      sourceMessageId: challenge.source.messageId,
      sourceCursor: challenge.source.cursor,
      expiresAtUnixMs,
      text,
    };
  }

  resolveCandidate(candidate: WeixinRemoteApprovalCandidate): WeixinRemoteApprovalResolution {
    const chatKey = this.chatKey(candidate.accountId, candidate.conversationId);
    const challenge = this.challengesByChat.get(chatKey);
    if (candidate.ambiguous) {
      if (!challenge) {
        return {
          consumed: true,
          status: "rejected",
          reason: "inactive",
          acknowledgement: acknowledgement("en-US", "invalid"),
        };
      }
      return this.rejectChallenge(chatKey, challenge, "malformed", true);
    }

    const parsed = /^([123]) ([23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8})$/i.exec(candidate.text);
    if (!parsed) return { consumed: false, status: "not-candidate" };

    const now = candidate.now ?? Date.now();
    this.globalAttemptTimes.push(now);
    while (this.globalAttemptTimes[0] != null && this.globalAttemptTimes[0] < now - 60_000) {
      this.globalAttemptTimes.shift();
    }
    if (!challenge) {
      const candidateCodeHash = hash(parsed[2].toUpperCase());
      for (const [activeChatKey, active] of this.challengesByChat) {
        if (!constantTimeCodeEquals(candidateCodeHash, active.codeHash)) continue;
        active.attempts += 1;
        if (active.attempts >= WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_MAX_ATTEMPTS) {
          this.invalidateChat(activeChatKey, "identity");
        }
        return {
          consumed: true,
          status: "rejected",
          reason: "identity",
          acknowledgement: acknowledgement(active.locale, "invalid"),
        };
      }
      const closed = this.closedByChat.get(chatKey);
      if (
        !closed ||
        now > closed.expiresAtUnixMs ||
        !constantTimeCodeEquals(hash(parsed[2].toUpperCase()), closed.codeHash)
      ) {
        return {
          consumed: true,
          status: "rejected",
          reason: "inactive",
          acknowledgement: acknowledgement("en-US", "invalid"),
        };
      }
      return {
        consumed: true,
        status: "rejected",
        reason: "replayed",
        acknowledgement: acknowledgement(closed.locale, "invalid"),
      };
    }
    const reject = (
      reason: Exclude<
        Extract<WeixinRemoteApprovalResolution, { status: "rejected" }>["reason"],
        never
      >,
      invalidate = false,
    ): WeixinRemoteApprovalResolution => {
      return this.rejectChallenge(chatKey, challenge, reason, invalidate);
    };

    if (this.globalAttemptTimes.length > MAX_GLOBAL_ATTEMPTS_PER_MINUTE) {
      return reject("rate-limited", true);
    }
    if (now > challenge.expiresAtUnixMs) return reject("expired", true);
    if (!candidate.direct) return reject("group", true);
    if (candidate.forwarded) return reject("forwarded", true);
    if (candidate.quoted) return reject("quoted", true);
    if (normalizeIdentity(candidate.accountId) !== challenge.source.accountId) {
      return reject("identity");
    }
    if (normalizeIdentity(candidate.senderId) !== challenge.source.senderId) {
      return reject("identity");
    }
    if (normalizeOpaqueId(candidate.conversationId) !== challenge.source.conversationId) {
      return reject("chat");
    }
    if (
      !Number.isSafeInteger(candidate.cursor) ||
      candidate.cursor <= challenge.source.cursor ||
      candidate.cursor <= challenge.lastCandidateCursor ||
      normalizeOpaqueId(candidate.messageId) === challenge.source.messageId
    ) {
      return reject("cursor");
    }
    challenge.lastCandidateCursor = candidate.cursor;
    if (!constantTimeCodeEquals(parsed[2].toUpperCase(), challenge.code)) {
      return reject("code");
    }
    if (!candidate.requests || !candidate.security) {
      return reject("stale", true);
    }
    if (
      canonicalize(candidate.security) !== canonicalize(challenge.security) ||
      securityBindingHash(challenge.source, candidate.requests, candidate.security, {
        id: challenge.id,
        codeHash: challenge.codeHash,
        createdAtUnixMs: challenge.createdAtUnixMs,
        expiresAtUnixMs: challenge.expiresAtUnixMs,
      }) !== challenge.bindingHash
    ) {
      return reject("stale", true);
    }
    this.challengesByChat.delete(chatKey);
    this.closedByChat.set(chatKey, {
      codeHash: challenge.codeHash,
      expiresAtUnixMs: challenge.expiresAtUnixMs,
      locale: challenge.locale,
    });
    this.pendingResolutions.set(challenge.id, challenge);
    const option = parsed[1];
    const decision = option === "2" ? "deny" : "allow-once";
    const approvalIds = option === "3" ? [...challenge.approvalIds] : [challenge.approvalIds[0]];
    return {
      consumed: true,
      status: decision === "deny" ? "denied" : "approved",
      challengeId: challenge.id,
      approvalIds,
      decision,
      acknowledgement: acknowledgement(
        challenge.locale,
        decision === "deny" ? "denied" : "approved",
      ),
    };
  }

  markLocallyResolved(approvalId: string, result: "approved" | "denied"): void {
    for (const [chatKey, challenge] of this.challengesByChat) {
      if (!challenge.approvalIds.includes(approvalId)) continue;
      this.recordAudit(challenge, "invalidated", `local-${result}`);
      this.closedByChat.set(chatKey, {
        codeHash: challenge.codeHash,
        expiresAtUnixMs: challenge.expiresAtUnixMs,
        locale: challenge.locale,
      });
      this.challengesByChat.delete(chatKey);
    }
    for (const [challengeId, challenge] of this.pendingResolutions) {
      if (!challenge.approvalIds.includes(approvalId)) continue;
      this.recordAudit(challenge, "invalidated", `local-${result}`);
      this.pendingResolutions.delete(challengeId);
    }
  }

  completeResolution(challengeId: string, result: "approved" | "denied"): void {
    const challenge = this.pendingResolutions.get(challengeId);
    if (!challenge) return;
    this.pendingResolutions.delete(challengeId);
    this.recordAudit(challenge, result, result);
  }

  failResolution(challengeId: string, reason: string): void {
    const challenge = this.pendingResolutions.get(challengeId);
    if (!challenge) return;
    this.pendingResolutions.delete(challengeId);
    this.recordAudit(challenge, "invalidated", reason);
  }

  expireChallenge(challengeId: string, now = Date.now()): WeixinRemoteApprovalNotice | null {
    for (const [chatKey, challenge] of this.challengesByChat) {
      if (challenge.id !== challengeId || now < challenge.expiresAtUnixMs) continue;
      this.invalidateChat(chatKey, "expired");
      return this.notice(challenge, "expired");
    }
    return null;
  }

  invalidateChallenge(challengeId: string, reason: string): WeixinRemoteApprovalNotice | null {
    for (const [chatKey, challenge] of this.challengesByChat) {
      if (challenge.id !== challengeId) continue;
      this.invalidateChat(chatKey, reason);
      return this.notice(challenge, "invalid");
    }
    const pending = this.pendingResolutions.get(challengeId);
    if (!pending) return null;
    this.pendingResolutions.delete(challengeId);
    this.recordAudit(pending, "invalidated", reason);
    return this.notice(pending, "invalid");
  }

  invalidateAll(reason: string): WeixinRemoteApprovalNotice[] {
    const notices: WeixinRemoteApprovalNotice[] = [];
    for (const [chatKey, challenge] of this.challengesByChat) {
      this.recordAudit(challenge, "invalidated", reason);
      this.closedByChat.set(chatKey, {
        codeHash: challenge.codeHash,
        expiresAtUnixMs: challenge.expiresAtUnixMs,
        locale: challenge.locale,
      });
      notices.push(this.notice(challenge, "invalid"));
    }
    this.challengesByChat.clear();
    for (const [challengeId, challenge] of this.pendingResolutions) {
      this.recordAudit(challenge, "invalidated", reason);
      this.pendingResolutions.delete(challengeId);
    }
    return notices;
  }

  private invalidateChat(chatKey: string, reason: string): void {
    const challenge = this.challengesByChat.get(chatKey);
    if (!challenge) return;
    this.recordAudit(challenge, "invalidated", reason);
    this.closedByChat.set(chatKey, {
      codeHash: challenge.codeHash,
      expiresAtUnixMs: challenge.expiresAtUnixMs,
      locale: challenge.locale,
    });
    this.challengesByChat.delete(chatKey);
  }

  private rejectChallenge(
    chatKey: string,
    challenge: ActiveChallenge,
    reason: Extract<WeixinRemoteApprovalResolution, { status: "rejected" }>["reason"],
    invalidate: boolean,
  ): WeixinRemoteApprovalResolution {
    challenge.attempts += 1;
    if (invalidate || challenge.attempts >= WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_MAX_ATTEMPTS) {
      this.invalidateChat(chatKey, reason);
    }
    return {
      consumed: true,
      status: "rejected",
      reason,
      acknowledgement: acknowledgement(
        challenge.locale,
        reason === "expired" ? "expired" : "invalid",
      ),
    };
  }

  private chatKey(accountId: string, conversationId: string): string {
    return `${normalizeIdentity(accountId)}\n${normalizeOpaqueId(conversationId)}`;
  }

  private recordAudit(challenge: ActiveChallenge, result: string, reason: string): void {
    const event: WeixinRemoteApprovalAuditEvent = {
      contract: WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT,
      timestamp: new Date().toISOString(),
      challengeHash: challenge.challengeHash,
      ownerHash: hash(`${challenge.source.accountId}\n${challenge.source.senderId}`),
      chatHash: hash(challenge.source.conversationId),
      approvalIdHashes: challenge.approvalIds.map(hash),
      result,
      reason,
      gatewayGenerationHash: hash(challenge.security.gatewayGeneration),
      policyFingerprintHash: hash(challenge.security.policyFingerprint),
      nodeIdHash: hash(challenge.security.nodeId),
      activationLeaseHash: challenge.security.activationLeaseHash,
    };
    this.auditEvents.push(event);
    this.onAudit?.({ ...event, approvalIdHashes: [...event.approvalIdHashes] });
  }

  private notice(
    challenge: ActiveChallenge,
    result: "expired" | "invalid",
  ): WeixinRemoteApprovalNotice {
    return {
      challengeId: challenge.id,
      accountId: challenge.source.accountId,
      senderId: challenge.source.senderId,
      acknowledgement: acknowledgement(challenge.locale, result),
    };
  }
}
