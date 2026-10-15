import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { WindowsNodeMxcGatewayApproval } from "./windows-node-mxc";

export const WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT =
  "microclaw.windows-weixin-remote-approval.v1";
export const WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_TTL_MS = 2 * 60_000;
export const WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_MAX_ATTEMPTS = 3;

const CHALLENGE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CHALLENGE_CODE_LENGTH = 8;
const MAX_GLOBAL_ATTEMPTS_PER_MINUTE = 20;
const MAX_PROMPT_ARGUMENTS = 8;
const MAX_PROMPT_DECLARATIONS = 8;
const MAX_PROMPT_REQUESTS = 8;
const MAX_PROMPT_LINE = 160;
const MAX_PROMPT_LENGTH = 6_000;
const DANGEROUS_PROMPT_UNICODE_PATTERN =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const SECRET_NAME_PATTERN =
  /(?:^|[^a-z0-9])(?:api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|id[-_\s]?token|client[-_\s]?secret|private[-_\s]?key|password|passwd|secret|token|authorization|proxy[-_\s]?authorization|cookie|set[-_\s]?cookie|credential)(?:$|[^a-z0-9])/i;
const SECRET_COMPOUND_NAME_PATTERN =
  /(?:apikey|accesstoken|refreshtoken|idtoken|clientsecret|privatekey|password|passwd|authorization|proxyauthorization|setcookie|cookie|credential|secret|token)/i;
const SECRET_VALUE_PATTERN =
  /\b(?:Bearer|Basic|ApiKey)\s+\S+|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,})/i;
const CREDENTIAL_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i;

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

function exactPromptValue(value: string): string {
  /*
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
  */
  return JSON.stringify(value);
}

function canSafelyRenderPromptValue(value: string): boolean {
  const normalizedName = value.normalize("NFKC");
  const compactName = normalizedName.replace(/[^a-z0-9]/gi, "");
  return (
    !DANGEROUS_PROMPT_UNICODE_PATTERN.test(value) &&
    !SECRET_NAME_PATTERN.test(normalizedName) &&
    !SECRET_COMPOUND_NAME_PATTERN.test(compactName) &&
    !SECRET_VALUE_PATTERN.test(value) &&
    !CREDENTIAL_URL_PATTERN.test(value)
  );
}

function argumentsCanBeSafelyRendered(values: string[]): boolean {
  return values.every(canSafelyRenderPromptValue);
}

function renderExactArguments(values: string[]): string {
  return values.map(exactPromptValue).join(" ") || "(none)";
}

function renderExactDeclarations(values: Array<{ access: string; path: string }>): string {
  return (
    values.map((entry) => `${entry.access}:${exactPromptValue(entry.path)}`).join(" ") || "(none)"
  );
}

function promptCanRepresentRequests(requests: WeixinRemoteApprovalBatchRequest[]): boolean {
  if (requests.length === 0 || requests.length > MAX_PROMPT_REQUESTS) return false;
  return requests.every(({ approval }) => {
    const displayedValues = [
      approval.command,
      approval.executablePath || approval.executable,
      approval.executableSha256,
      approval.canonicalCwd,
      approval.agent ?? "",
      approval.sessionKey,
      ...approval.arguments,
      ...approval.declaredAccess.map((entry) => entry.path),
    ];
    if (
      approval.arguments.length > MAX_PROMPT_ARGUMENTS ||
      approval.declaredAccess.length > MAX_PROMPT_DECLARATIONS ||
      !/^[a-f0-9]{64}$/i.test(approval.executableSha256) ||
      !argumentsCanBeSafelyRendered(displayedValues)
    ) {
      return false;
    }
    return [
      exactPromptValue(approval.command),
      exactPromptValue(approval.executablePath || approval.executable),
      approval.executableSha256,
      renderExactArguments(approval.arguments),
      exactPromptValue(approval.canonicalCwd),
      renderExactDeclarations(approval.declaredAccess),
      exactPromptValue(approval.agent ?? ""),
      exactPromptValue(approval.sessionKey),
      String(approval.hasMutableFileOperand),
      approval.allowedDecisions.join(","),
    ].every((line) => line.length <= MAX_PROMPT_LINE);
  });
}

export function renderWeixinRemoteApprovalPrompt(params: {
  code: string;
  expiresAtUnixMs: number;
  requests: WeixinRemoteApprovalBatchRequest[];
  security: WeixinRemoteApprovalSecurityBinding;
  locale: "en-US" | "zh-CN";
}): string {
  const lines =
    params.locale === "zh-CN"
      ? [
          `[MicroClaw 安全审批 #${params.code}]`,
          "仅批准下列当前请求；不会创建永久授权，也不会批准未来请求。",
          ...params.requests.flatMap(({ approval }, index) => [
            `请求 ${index + 1} 命令: ${exactPromptValue(approval.command)}`,
            `可执行文件: ${exactPromptValue(approval.executablePath || approval.executable)}`,
            `SHA-256: ${approval.executableSha256}`,
            `参数: ${renderExactArguments(approval.arguments)}`,
            `工作目录: ${exactPromptValue(approval.canonicalCwd)}`,
            `文件访问: ${renderExactDeclarations(approval.declaredAccess)}`,
            `代理/会话: ${exactPromptValue(approval.agent ?? "")} / ${exactPromptValue(approval.sessionKey)}`,
            `可变文件操作数: ${approval.hasMutableFileOperand ? "是" : "否"}`,
            `本地可用决策: ${approval.allowedDecisions.join(", ")}`,
          ]),
          `模式: ${params.security.requestedMode} / ${exactPromptValue(params.security.effectiveMode)}`,
          `过期时间: ${new Date(params.expiresAtUnixMs).toISOString()}`,
          `回复: 1 ${params.code}（仅批准此请求一次）`,
          `      2 ${params.code}（拒绝）`,
          `      3 ${params.code}（仅批准本消息列出的全部 ${params.requests.length} 个请求一次）`,
        ]
      : [
          `[MicroClaw Security Approval #${params.code}]`,
          "This approves only the current request(s); it creates no durable or future approval.",
          ...params.requests.flatMap(({ approval }, index) => [
            `Request ${index + 1} command: ${exactPromptValue(approval.command)}`,
            `Executable: ${exactPromptValue(approval.executablePath || approval.executable)}`,
            `SHA-256: ${approval.executableSha256}`,
            `Args: ${renderExactArguments(approval.arguments)}`,
            `CWD: ${exactPromptValue(approval.canonicalCwd)}`,
            `File access: ${renderExactDeclarations(approval.declaredAccess)}`,
            `Agent/session: ${exactPromptValue(approval.agent ?? "")} / ${exactPromptValue(approval.sessionKey)}`,
            `Mutable file operand: ${approval.hasMutableFileOperand ? "yes" : "no"}`,
            `Locally available decisions: ${approval.allowedDecisions.join(", ")}`,
          ]),
          `Mode: ${params.security.requestedMode} / ${exactPromptValue(params.security.effectiveMode)}`,
          `Expires: ${new Date(params.expiresAtUnixMs).toISOString()}`,
          `Reply: 1 ${params.code} (approve this request once)`,
          `       2 ${params.code} (deny)`,
          `       3 ${params.code} (approve all ${params.requests.length} listed request(s) once)`,
        ];
  return lines.join("\n");
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
      !promptCanRepresentRequests(input.requests) ||
      !canSafelyRenderPromptValue(input.security.effectiveMode)
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
      requests: input.requests,
      security: input.security,
      locale: input.locale,
    });
    if (
      text.length > MAX_PROMPT_LENGTH ||
      text.split("\n").some((line) => line.length > MAX_PROMPT_LINE)
    ) {
      return null;
    }
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
