import { createHash } from "node:crypto";
import type { WindowsNodeMxcGatewayApproval } from "./windows-node-mxc";
import type { WeixinRemoteApprovalSecurityBinding } from "./windows-node-mxc-weixin-remote-approval";
import { POWERSHELL_FILESYSTEM_SCOPE_MARKER } from "./windows-node-mxc-powershell-scope";
import {
  CANONICAL_EXEC_PRESENTATION,
  PHONE_EXEC_MAX_FRAME_BYTES,
  PHONE_EXEC_MAX_LENGTH,
  canonicalExecLiteralFields,
  canonicalWindowsCommand,
  containsPhoneSensitiveSemantics,
  createCanonicalExecPresentation,
  encodeExecLiteralField,
  hasUnsafePhoneUnicode,
  type ExecLiteralField,
} from "./windows-node-mxc-exec-presentation";

export const WEIXIN_EXEC_PROMPT_PRESENTATION = "microclaw.wechat-exec-readable.v3";

export type GenericPhonePresentationCategory =
  | "unsafe-literal"
  | "sensitive-or-encoded"
  | "invalid-canonical-plan"
  | "complete-display-too-long";

export type CanonicalPhoneExecResult =
  | { status: "supported"; text: string; presentationDigest: string }
  | {
      status: "unsupported";
      reason:
        | "presentation-sensitive"
        | "presentation-unsupported"
        | "presentation-too-long"
        | "security-binding-invalid";
      category: GenericPhonePresentationCategory;
    };

const OPAQUE_CONTENT =
  /(?:encodedcommand|frombase64string|tobase64string|fromhexstring|base64|-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b)/i;
const PADDED_ENCODING =
  /(?:^|[\s"'=:])(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)(?=$|[\s"';,)])/;
const REDACTED_CONTENT = /(?:\[redacted\]|\[masked\]|<redacted>|<masked>|\*{3,})/i;
const KNOWN_CREDENTIAL =
  /(?:\bgh[opsu]_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bnpm_[A-Za-z0-9]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|https?:\/\/[^/\s:@]+:[^/\s@]+@)/i;

/** Escape ambiguous values without permitting injected prompt lines. */
function literalBlock(value: string): string[] {
  if (
    value.trim() !== value ||
    /[\r\n\t]|\p{Zs}/u.test(value.replaceAll(" ", "")) ||
    /^(?:(?:reply\s+|回复\s*)?[123](?:\s+[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8})?[:：])/i.test(
      value,
    ) ||
    /<\/?[a-z][^>]*>|```|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~/i.test(value)
  ) {
    return encodeExecLiteralField({ id: "literal", value }).lines.map(
      (line, index) => `${index ? "  + " : "  = "}${line.slice(line.indexOf(" ") + 1)} |`,
    );
  }
  return [value];
}

function folderGrantLines(entry: { access: "ro" | "rw"; path: string }, zh: boolean): string[] {
  const label = zh
    ? `${entry.access === "rw" ? "读写" : "只读"}：`
    : `${entry.access === "rw" ? "Read/write" : "Read-only"}:`;
  const path = literalBlock(entry.path);
  if (path.length === 1 && !path[0].startsWith("  = ")) {
    return [`${label} ${path[0]}`];
  }
  return [label, ...path];
}

export function renderCanonicalWeixinExecPrompt(params: {
  approval: WindowsNodeMxcGatewayApproval;
  security: WeixinRemoteApprovalSecurityBinding;
  expiresAtUnixMs: number;
  code: string;
  locale: "en-US" | "zh-CN";
  bareReplies?: boolean;
  nowUnixMs: number;
}): CanonicalPhoneExecResult {
  const view = createCanonicalExecPresentation(params.approval);
  const { nowUnixMs } = params;
  if (
    !view ||
    !Number.isSafeInteger(nowUnixMs) ||
    !Number.isSafeInteger(params.expiresAtUnixMs) ||
    !Number.isFinite(new Date(params.expiresAtUnixMs).getTime()) ||
    params.expiresAtUnixMs <= nowUnixMs ||
    (view.requestDeadlineUnixMs !== null && params.expiresAtUnixMs > view.requestDeadlineUnixMs) ||
    !/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(params.code)
  ) {
    return {
      status: "unsupported",
      reason: "security-binding-invalid",
      category: "invalid-canonical-plan",
    };
  }
  const fields: ExecLiteralField[] = [
    ...canonicalExecLiteralFields(view),
    { id: "prompt.deadline.unixms", value: String(params.expiresAtUnixMs) },
    { id: "security.requested", value: params.security.requestedMode },
    { id: "security.effective", value: params.security.effectiveMode },
    { id: "security.policy", value: params.security.policyFingerprint },
    { id: "security.lease", value: params.security.activationLeaseHash },
  ];
  if (fields.some(({ value }) => hasUnsafePhoneUnicode(value))) {
    return {
      status: "unsupported",
      reason: "presentation-unsupported",
      category: "unsafe-literal",
    };
  }
  if (
    fields.some(
      ({ value }) =>
        containsPhoneSensitiveSemantics(value) ||
        OPAQUE_CONTENT.test(value) ||
        KNOWN_CREDENTIAL.test(value) ||
        PADDED_ENCODING.test(value) ||
        REDACTED_CONTENT.test(value),
    )
  ) {
    return {
      status: "unsupported",
      reason: "presentation-sensitive",
      category: "sensitive-or-encoded",
    };
  }
  const zh = params.locale === "zh-CN";
  const remainingSeconds = Math.ceil((params.expiresAtUnixMs - nowUnixMs) / 1000);
  const suffix = params.bareReplies === false ? ` ${params.code}` : "";
  const command = canonicalWindowsCommand(view.initialization?.originalArgv ?? view.argv);
  if (!view.initialization && command.includes(POWERSHELL_FILESYSTEM_SCOPE_MARKER)) {
    return {
      status: "unsupported",
      reason: "security-binding-invalid",
      category: "invalid-canonical-plan",
    };
  }
  const boundedValues = [
    command,
    view.executablePath,
    view.canonicalCwd,
    ...view.declaredAccess.map((entry) => entry.path),
    ...view.folderChanges.map((entry) => entry.path),
  ];
  if (boundedValues.reduce((length, value) => length + value.length, 0) > PHONE_EXEC_MAX_LENGTH) {
    return {
      status: "unsupported",
      reason: "presentation-too-long",
      category: "complete-display-too-long",
    };
  }
  const lines = [
    zh ? "🛡️ MicroClaw 安全审批" : "🛡️ MicroClaw Security Approval",
    "",
    zh ? "你的智能体希望运行以下命令：" : "Your agent wants to run the following command:",
    ...literalBlock(command),
    ...(view.folderChanges.length
      ? [
          "",
          zh ? "要添加或升级的文件夹：" : "Folders to Add or Upgrade:",
          ...view.folderChanges.flatMap((entry) => folderGrantLines(entry, zh)),
        ]
      : []),
    "",
    ...(view.allowedDecisions.includes("allow-once")
      ? [
          zh
            ? `回复 1${suffix}：${view.folderChanges.length ? "允许" : "仅允许一次"}`
            : `Reply 1${suffix}: ${view.folderChanges.length ? "allow" : "allow once"}`,
        ]
      : []),
    ...(view.allowedDecisions.includes("deny")
      ? [zh ? `3${suffix}：拒绝` : `3${suffix}: deny`]
      : []),
    "",
    zh ? `将在 ${remainingSeconds} 秒后过期` : `Expire in ${remainingSeconds} seconds`,
  ];
  const text = lines.join("\n");
  if (text.length > PHONE_EXEC_MAX_LENGTH) {
    return {
      status: "unsupported",
      reason: "presentation-too-long",
      category: "complete-display-too-long",
    };
  }
  const frame = JSON.stringify({
    contract: CANONICAL_EXEC_PRESENTATION,
    presentation: WEIXIN_EXEC_PROMPT_PRESENTATION,
    view,
    security: params.security,
    text,
  });
  if (Buffer.byteLength(frame, "utf8") > PHONE_EXEC_MAX_FRAME_BYTES) {
    return {
      status: "unsupported",
      reason: "presentation-too-long",
      category: "complete-display-too-long",
    };
  }
  return {
    status: "supported",
    text,
    presentationDigest: createHash("sha256").update(frame, "utf8").digest("hex"),
  };
}
