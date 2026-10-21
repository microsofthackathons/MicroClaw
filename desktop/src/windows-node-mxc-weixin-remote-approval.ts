import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { WindowsNodeMxcGatewayApproval } from "./windows-node-mxc";
import { classifyLiteralFilesystemCommand } from "./windows-node-mxc-literal-filesystem-command";

export const WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT =
  "microclaw.windows-weixin-remote-approval.v1";
export const WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_TTL_MS = 2 * 60_000;
export const WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE = "native-exact-conversation-durable.v2";
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
const SAFE_SIMPLE_ARGUMENT_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,15}$/;
const SAFE_NUMERIC_ARGUMENT_PATTERN = /^-?(?:0|[1-9][0-9]{0,18})(?:\.[0-9]{1,8})?$/;
const SAFE_SWITCH_PATTERN = /^(?:--?[A-Za-z][A-Za-z0-9-]{0,31}|\/[A-Za-z][A-Za-z0-9-]{0,31})$/;
const SAFE_RELATIVE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.[A-Za-z0-9]{1,8}$/;
const SAFE_STRUCTURAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,159}$/;
const SENSITIVE_SEMANTIC_PATTERN =
  /(?:accountkey|authorization|auth|bearer|clientsecret|cookie|credential|key|passphrase|passwd|password|privatekey|proxyauthorization|sas|secret|setcookie|signature|sig|token)/i;
const SAFE_PATH_VALUE_SWITCHES = new Set([
  "-File",
  "--file",
  "--output",
  "--project",
  "--cwd",
  "-o",
]);
const SAFE_ENUM_VALUE_SWITCHES = new Set([
  "--color",
  "--configuration",
  "--format",
  "--mode",
  "--target",
]);
const SAFE_LITERAL_ARGUMENTS = new Set(["false", "null", "true"]);

export interface WeixinRemoteApprovalOwnerBinding {
  contract: typeof WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_CONTRACT;
  accountId: string;
  userId: string;
  boundAt: string;
}

export interface WeixinRemoteApprovalConfiguration {
  enabled: boolean;
  owner: WeixinRemoteApprovalOwnerBinding | null;
  consentScope?: typeof WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE;
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
    return {
      enabled: record.enabled === true,
      owner: normalized,
      ...(record.consentScope === WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE
        ? { consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE }
        : {}),
    };
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
  sentAtUnixMs?: number;
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
  expiresAtUnixMs?: number;
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
  sentAtUnixMs?: number;
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
      decision: "allow-once" | "allow-always" | "deny";
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
        | "malformed"
        | "consent-scope";
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
  deliveredAtUnixMs: number | null;
  reminderAtUnixMs: number | null;
  reminderCount: number;
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

export function weixinRemoteApprovalConsentHash(
  configuration: WeixinRemoteApprovalConfiguration,
): string | null {
  return configuration.enabled &&
    configuration.owner &&
    configuration.consentScope === WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE
    ? hash(canonicalize({ owner: configuration.owner, consentScope: configuration.consentScope }))
    : null;
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

function isSafeAsciiDisplayValue(value: string): boolean {
  return (
    value.length > 0 &&
    /^[\x20-\x7e]+$/.test(value) &&
    !DANGEROUS_PROMPT_UNICODE_PATTERN.test(value)
  );
}

function hasSensitiveSemantics(value: string): boolean {
  return SENSITIVE_SEMANTIC_PATTERN.test(value.replace(/[^A-Za-z0-9]/g, ""));
}

function isSafeWindowsPath(value: string): boolean {
  if (
    !isSafeAsciiDisplayValue(value) ||
    !/^[A-Za-z]:\\/.test(value) ||
    /["'<>|?*=;&]/.test(value)
  ) {
    return false;
  }
  const segments = value.slice(3).split("\\");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment.length <= 80 &&
      !segment.endsWith(" ") &&
      !segment.endsWith(".") &&
      !hasSensitiveSemantics(segment),
  );
}

function isSafeRelativeFile(value: string): boolean {
  return (
    isSafeAsciiDisplayValue(value) &&
    SAFE_RELATIVE_FILE_PATTERN.test(value) &&
    !hasSensitiveSemantics(value)
  );
}

function isSafeSimpleArgument(value: string): boolean {
  return (
    isSafeAsciiDisplayValue(value) &&
    (SAFE_LITERAL_ARGUMENTS.has(value.toLowerCase()) ||
      SAFE_NUMERIC_ARGUMENT_PATTERN.test(value) ||
      (SAFE_SIMPLE_ARGUMENT_PATTERN.test(value) && !hasSensitiveSemantics(value)))
  );
}

function isSafeSwitch(value: string): boolean {
  return (
    isSafeAsciiDisplayValue(value) &&
    SAFE_SWITCH_PATTERN.test(value) &&
    !hasSensitiveSemantics(value)
  );
}

function argumentsCanBeSafelyRendered(values: string[]): boolean {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (isSafeWindowsPath(value) || isSafeRelativeFile(value)) continue;
    if (isSafeSwitch(value)) {
      if (SAFE_PATH_VALUE_SWITCHES.has(value)) {
        const pathValue = values[index + 1];
        if (
          pathValue === undefined ||
          (!isSafeWindowsPath(pathValue) && !isSafeRelativeFile(pathValue))
        ) {
          return false;
        }
        index += 1;
      } else if (SAFE_ENUM_VALUE_SWITCHES.has(value)) {
        const enumValue = values[index + 1];
        if (enumValue === undefined || !isSafeSimpleArgument(enumValue)) return false;
        index += 1;
      } else if (values[index + 1] !== undefined && !isSafeSwitch(values[index + 1])) {
        return false;
      }
      continue;
    }
    if (SAFE_LITERAL_ARGUMENTS.has(value.toLowerCase())) continue;
    return false;
  }
  return true;
}

function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/\s/.test(value) && !value.includes('"')) return value;
  let output = '"';
  let slashes = 0;
  for (const character of value) {
    if (character === "\\") {
      slashes += 1;
      continue;
    }
    if (character === '"') {
      output += `${"\\".repeat(slashes * 2 + 1)}"`;
      slashes = 0;
      continue;
    }
    output += `${"\\".repeat(slashes)}${character}`;
    slashes = 0;
  }
  return `${output}${"\\".repeat(slashes * 2)}"`;
}

function exactWindowsCommand(values: string[]): string {
  return values.map(quoteWindowsArgument).join(" ");
}

function approvalHasSafeStructuredPresentation(approval: WindowsNodeMxcGatewayApproval): boolean {
  const canonicalCwdIsSafe =
    approval.canonicalCwd === "isolated-scratch:v1" || isSafeWindowsPath(approval.canonicalCwd);
  return (
    (isSafeRelativeFile(approval.executable) || isSafeWindowsPath(approval.executable)) &&
    isSafeWindowsPath(approval.executablePath) &&
    canonicalCwdIsSafe &&
    SAFE_STRUCTURAL_ID_PATTERN.test(approval.sessionKey) &&
    (approval.agent === null || SAFE_STRUCTURAL_ID_PATTERN.test(approval.agent)) &&
    (argumentsCanBeSafelyRendered(approval.arguments) ||
      (classifyLiteralFilesystemCommand(approval) !== null &&
        !approval.arguments.some(hasSensitiveSemantics))) &&
    approval.command === exactWindowsCommand([approval.executable, ...approval.arguments]) &&
    approval.declaredAccess.every((entry) => isSafeWindowsPath(entry.path))
  );
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
    if (
      approval.arguments.length > MAX_PROMPT_ARGUMENTS ||
      approval.declaredAccess.length > MAX_PROMPT_DECLARATIONS ||
      !/^[a-f0-9]{64}$/i.test(approval.executableSha256) ||
      !approvalHasSafeStructuredPresentation(approval)
    ) {
      return false;
    }
    return true;
  });
}

function renderExactField(label: string, value: string): string[] {
  if (label.length + value.length + 2 <= MAX_PROMPT_LINE) return [`${label}: ${value}`];
  const fragments: string[] = [];
  for (let index = 0; index < value.length; index += 100) {
    fragments.push(value.slice(index, index + 100));
  }
  return [
    `${label} [JSON fragments; join without separators]:`,
    ...fragments.map((fragment, index) => `  [${index + 1}/${fragments.length}] ${fragment}`),
  ];
}

export function renderWeixinRemoteApprovalPrompt(params: {
  code: string;
  expiresAtUnixMs: number;
  requests: WeixinRemoteApprovalBatchRequest[];
  security: WeixinRemoteApprovalSecurityBinding;
  locale: "en-US" | "zh-CN";
  bareReplies?: boolean;
  allowDurable?: boolean;
}): string {
  const suffix = params.bareReplies ? "" : ` ${params.code}`;
  const lines =
    params.locale === "zh-CN"
      ? [
          `[MicroClaw 安全审批 #${params.code}]`,
          "决策仅绑定下列精确命令、可执行内容、参数、目录、文件权限、策略、代理和会话；永久审批也不会扩大范围。",
          ...params.requests.flatMap(({ approval }, index) => [
            `请求标识: ${hash(approval.id).slice(0, 16)}`,
            ...renderExactField(`请求 ${index + 1} 命令`, exactPromptValue(approval.command)),
            `可执行文件: ${exactPromptValue(approval.executablePath || approval.executable)}`,
            `SHA-256: ${approval.executableSha256}`,
            ...renderExactField("参数", renderExactArguments(approval.arguments)),
            ...renderExactField("工作目录", exactPromptValue(approval.canonicalCwd)),
            ...renderExactField("文件访问", renderExactDeclarations(approval.declaredAccess)),
            ...renderExactField(
              "代理/会话",
              `${exactPromptValue(approval.agent ?? "")} / ${exactPromptValue(approval.sessionKey)}`,
            ),
            `可变文件操作数: ${approval.hasMutableFileOperand ? "是" : "否"}`,
            `本地可用决策: ${approval.allowedDecisions.join(", ")}`,
          ]),
          `模式: ${params.security.requestedMode} / ${exactPromptValue(params.security.effectiveMode)}`,
          `过期时间: ${new Date(params.expiresAtUnixMs).toISOString()}`,
          `回复: 1${suffix}（仅允许一次）`,
          params.allowDurable
            ? `      2${suffix}（在此精确范围永久允许）`
            : `      2${suffix} 不可用：须先关闭 MXC，再通过唯一的本地原生提示重新启用审批。`,
          `      3${suffix}（拒绝）`,
          params.bareReplies
            ? `若无法验证回复时序，请附带本请求代码，例如 1 ${params.code}。其他输入不作决策，截止时间不延长。`
            : "无法预先验证裸数字回复的时序；请使用上述带代码的回复。其他输入不作决策，截止时间不延长。",
        ]
      : [
          `[MicroClaw Security Approval #${params.code}]`,
          "Decisions bind only the exact command/content, arguments, CWD, access, policy, agent and conversation shown. Always does not broaden that scope.",
          ...params.requests.flatMap(({ approval }, index) => [
            `Request reference: ${hash(approval.id).slice(0, 16)}`,
            ...renderExactField(`Request ${index + 1} command`, exactPromptValue(approval.command)),
            `Executable: ${exactPromptValue(approval.executablePath || approval.executable)}`,
            `SHA-256: ${approval.executableSha256}`,
            ...renderExactField("Args", renderExactArguments(approval.arguments)),
            ...renderExactField("CWD", exactPromptValue(approval.canonicalCwd)),
            ...renderExactField("File access", renderExactDeclarations(approval.declaredAccess)),
            ...renderExactField(
              "Agent/session",
              `${exactPromptValue(approval.agent ?? "")} / ${exactPromptValue(approval.sessionKey)}`,
            ),
            `Mutable file operand: ${approval.hasMutableFileOperand ? "yes" : "no"}`,
            `Locally available decisions: ${approval.allowedDecisions.join(", ")}`,
          ]),
          `Mode: ${params.security.requestedMode} / ${exactPromptValue(params.security.effectiveMode)}`,
          `Expires: ${new Date(params.expiresAtUnixMs).toISOString()}`,
          `Reply: 1${suffix} (allow once)`,
          params.allowDurable
            ? `       2${suffix} (always for this exact scope)`
            : `       2${suffix} unavailable: renew local native consent by turning MXC off and enabling it again.`,
          `       3${suffix} (deny)`,
          params.bareReplies
            ? `If reply freshness cannot be verified, include this request's code, e.g. 1 ${params.code}. Other input makes no decision or deadline extension.`
            : "Bare-reply freshness cannot be established in advance: use the coded replies above. Other input makes no decision or deadline extension.",
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

export type WeixinRemoteApprovalRejectionReason =
  | "disabled"
  | "source-not-direct"
  | "source-identity-mismatch"
  | "source-metadata-invalid"
  | "source-session-mismatch"
  | "source-agent-mismatch"
  | "ambiguous-request-set"
  | "presentation-sensitive"
  | "presentation-unsupported"
  | "presentation-too-long"
  | "security-binding-invalid";

export type WeixinRemoteApprovalChallengeResult =
  | { status: "created"; delivery: WeixinRemoteApprovalDelivery }
  | { status: "rejected"; reason: WeixinRemoteApprovalRejectionReason };

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
      this.configuration.consentScope !== configuration.consentScope ||
      canonicalize(this.configuration.owner) !== canonicalize(configuration.owner);
    this.configuration = {
      enabled: configuration.enabled,
      ...(configuration.consentScope ? { consentScope: configuration.consentScope } : {}),
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
      ...(this.configuration.consentScope ? { consentScope: this.configuration.consentScope } : {}),
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
    const result = this.createChallengeResult(input);
    return result.status === "created" ? result.delivery : null;
  }

  createChallengeResult(
    input: WeixinRemoteApprovalCreateInput,
  ): WeixinRemoteApprovalChallengeResult {
    const now = input.now ?? Date.now();
    const owner = this.configuration.owner;
    const reject = (
      reason: WeixinRemoteApprovalRejectionReason,
    ): WeixinRemoteApprovalChallengeResult => ({ status: "rejected", reason });
    if (!this.configuration.enabled || !owner) return reject("disabled");
    if (!input.source.direct || input.source.forwarded || input.source.quoted)
      return reject("source-not-direct");
    if (
      normalizeIdentity(input.source.accountId) !== owner.accountId ||
      normalizeIdentity(input.source.senderId) !== owner.userId ||
      normalizeIdentity(input.source.conversationId) !== owner.userId
    )
      return reject("source-identity-mismatch");
    if (
      !Number.isSafeInteger(input.source.cursor) ||
      input.source.cursor < 0 ||
      !input.source.messageId.trim()
    ) {
      return reject("source-metadata-invalid");
    }
    if (!SAFE_STRUCTURAL_ID_PATTERN.test(input.security.effectiveMode))
      return reject("security-binding-invalid");
    const approvalIds = input.requests.map(({ approval }) => approval.id);
    if (!approvalIds.length || new Set(approvalIds).size !== approvalIds.length)
      return reject("ambiguous-request-set");
    if (input.requests.some(({ approval }) => approval.sessionKey !== input.source.sessionKey))
      return reject("source-session-mismatch");
    if (input.requests.some(({ approval }) => (approval.agent ?? "") !== input.source.agentId))
      return reject("source-agent-mismatch");
    if (!promptCanRepresentRequests(input.requests)) {
      return reject(
        input.requests.some(
          ({ approval }) =>
            approval.arguments.some(hasSensitiveSemantics) ||
            approval.declaredAccess.some((entry) => hasSensitiveSemantics(entry.path)),
        )
          ? "presentation-sensitive"
          : "presentation-unsupported",
      );
    }
    const chatKey = this.chatKey(input.source.accountId, input.source.conversationId);
    this.invalidateChat(chatKey, "superseded");
    const code = createCode();
    const id = randomBytes(16).toString("hex");
    const codeHash = hash(code);
    const challengeHash = hash(id);
    const expiresAtUnixMs = Math.min(
      now + WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_TTL_MS,
      input.expiresAtUnixMs ?? Number.POSITIVE_INFINITY,
    );
    if (expiresAtUnixMs <= now) return reject("security-binding-invalid");
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
      deliveredAtUnixMs: null,
      reminderAtUnixMs: null,
      reminderCount: 0,
    };
    const text = renderWeixinRemoteApprovalPrompt({
      code,
      expiresAtUnixMs,
      requests: input.requests,
      security: input.security,
      locale: input.locale,
      bareReplies: false,
      allowDurable:
        weixinRemoteApprovalConsentHash(this.configuration) !== null &&
        input.requests.every(
          ({ approval }) =>
            approval.allowedDecisions.includes("allow-always") && !approval.hasMutableFileOperand,
        ),
    });
    if (
      text.length > MAX_PROMPT_LENGTH ||
      text.split("\n").some((line) => line.length > MAX_PROMPT_LINE)
    ) {
      return reject("presentation-too-long");
    }
    this.challengesByChat.set(chatKey, challenge);
    return {
      status: "created",
      delivery: {
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
      },
    };
  }

  markDelivered(challengeId: string, now = Date.now()): boolean {
    for (const challenge of this.challengesByChat.values()) {
      if (challenge.id !== challengeId || now >= challenge.expiresAtUnixMs) continue;
      challenge.deliveredAtUnixMs = now;
      return true;
    }
    return false;
  }

  resolveCandidate(candidate: WeixinRemoteApprovalCandidate): WeixinRemoteApprovalResolution {
    const chatKey = this.chatKey(candidate.accountId, candidate.conversationId);
    const challenge = this.challengesByChat.get(chatKey);
    const now = candidate.now ?? Date.now();
    const activeOwnerConversation =
      challenge &&
      challenge.deliveredAtUnixMs !== null &&
      now < challenge.expiresAtUnixMs &&
      candidate.direct &&
      normalizeIdentity(candidate.accountId) === challenge.source.accountId &&
      normalizeIdentity(candidate.senderId) === challenge.source.senderId;
    const remind = (
      reason: "malformed" | "cursor" | "quoted" | "forwarded" | "consent-scope",
    ): WeixinRemoteApprovalResolution => {
      let text = "";
      if (
        challenge &&
        challenge.reminderCount < 3 &&
        (challenge.reminderAtUnixMs === null || now - challenge.reminderAtUnixMs >= 5_000)
      ) {
        challenge.reminderAtUnixMs = now;
        challenge.reminderCount++;
        text =
          weixinRemoteApprovalConsentHash(this.configuration) === null
            ? challenge.locale === "zh-CN"
              ? `MicroClaw 安全审批：尚未作出决策，原截止时间不变。2 须先关闭 MXC，再通过唯一的本地原生提示重新启用审批。现在可回复 1 ${challenge.code}（仅一次）或 3 ${challenge.code}（拒绝）。`
              : `MicroClaw Security Approval: no decision; original deadline unchanged. 2 requires renewed local native consent: turn MXC off and enable again. Reply 1 ${challenge.code} (once) or 3 ${challenge.code} (deny).`
            : challenge.locale === "zh-CN"
              ? `MicroClaw 安全审批：尚未作出决策，原截止时间不变。请回复 1 ${challenge.code}（仅一次）、2 ${challenge.code}（此精确范围永久允许）或 3 ${challenge.code}（拒绝）。`
              : `MicroClaw Security Approval: no decision; original deadline unchanged. Reply 1 ${challenge.code} (once), 2 ${challenge.code} (always for this exact scope), or 3 ${challenge.code} (deny).`;
      }
      return { consumed: true, status: "rejected", reason, acknowledgement: text };
    };
    if (activeOwnerConversation && (candidate.quoted || candidate.forwarded))
      return remind(candidate.quoted ? "quoted" : "forwarded");
    const bare = /^[123]$/.test(candidate.text);
    // This provider has no authenticated delivery cursor/time fence.
    if (activeOwnerConversation && bare) return remind("cursor");
    if (
      activeOwnerConversation &&
      !bare &&
      !/^([123]) ([23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8})$/i.test(candidate.text)
    ) {
      return remind("malformed");
    }
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
    if (now >= challenge.expiresAtUnixMs) return reject("expired", true);
    if (challenge.deliveredAtUnixMs === null) return reject("inactive");
    if (!candidate.direct) return reject("group", true);
    if (candidate.forwarded) return reject("forwarded", true);
    if (candidate.quoted) return reject("quoted", true);
    if (normalizeIdentity(candidate.accountId) !== challenge.source.accountId) {
      return reject("identity");
    }
    if (normalizeIdentity(candidate.senderId) !== challenge.source.senderId) {
      return reject("identity");
    }
    if (
      normalizeIdentity(candidate.conversationId) !==
      normalizeIdentity(challenge.source.conversationId)
    ) {
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
    if (parsed[1] === "2" && weixinRemoteApprovalConsentHash(this.configuration) === null) {
      return remind("consent-scope");
    }
    if (
      parsed[1] === "2" &&
      candidate.requests.some(
        ({ approval }) =>
          !approval.allowedDecisions.includes("allow-always") || approval.hasMutableFileOperand,
      )
    ) {
      return remind("malformed");
    }
    this.challengesByChat.delete(chatKey);
    this.closedByChat.set(chatKey, {
      codeHash: challenge.codeHash,
      expiresAtUnixMs: challenge.expiresAtUnixMs,
      locale: challenge.locale,
    });
    this.pendingResolutions.set(challenge.id, challenge);
    const option = parsed[1];
    const decision = option === "3" ? "deny" : option === "2" ? "allow-always" : "allow-once";
    const approvalIds = [...challenge.approvalIds];
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

  settleApproval(approvalId: string, result: string, origin: string): void {
    for (const [chatKey, challenge] of this.challengesByChat) {
      if (!challenge.approvalIds.includes(approvalId)) continue;
      this.closedByChat.set(chatKey, {
        codeHash: challenge.codeHash,
        expiresAtUnixMs: challenge.expiresAtUnixMs,
        locale: challenge.locale,
      });
      this.challengesByChat.delete(chatKey);
      this.recordAudit(challenge, result, origin);
    }
    for (const [id, challenge] of this.pendingResolutions) {
      if (!challenge.approvalIds.includes(approvalId)) continue;
      this.pendingResolutions.delete(id);
      this.recordAudit(challenge, result, origin);
    }
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
    return `${normalizeIdentity(accountId)}\n${normalizeIdentity(conversationId)}`;
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
