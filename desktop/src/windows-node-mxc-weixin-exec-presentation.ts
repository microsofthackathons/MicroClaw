import { createHash } from "node:crypto";
import type { WindowsNodeMxcGatewayApproval } from "./windows-node-mxc";
import type { WeixinRemoteApprovalSecurityBinding } from "./windows-node-mxc-weixin-remote-approval";
import { POWERSHELL_FILESYSTEM_SCOPE_MARKER } from "./windows-node-mxc-powershell-scope";
import {
  CANONICAL_EXEC_PRESENTATION,
  PHONE_EXEC_MAX_FRAME_BYTES,
  PHONE_EXEC_MAX_LENGTH,
  PHONE_EXEC_MAX_LINE,
  canonicalExecLiteralFields,
  canonicalWindowsCommand,
  containsPhoneSensitiveSemantics,
  createCanonicalExecPresentation,
  encodeExecLiteralField,
  hasUnsafePhoneUnicode,
  type ExecLiteralField,
} from "./windows-node-mxc-exec-presentation";

export const WEIXIN_EXEC_PROMPT_PRESENTATION = "microclaw.wechat-exec-readable.v2";

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

/** Closed data lines preserve edge spaces; only ambiguous values need escaped literal parts. */
function literalBlock(value: string, zh: boolean): string[] {
  if (
    value.trim() !== value ||
    /[\r\n\t]|\p{Zs}/u.test(value.replaceAll(" ", "")) ||
    /<\/?[a-z][^>]*>|```|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~/i.test(value)
  ) {
    return [
      zh
        ? "  转义文本：各行引号内文本依次拼接；\\r/\\n/\\t 表示原始换行/制表符，\\uXXXX 表示字符。"
        : "  Escaped text: join quoted parts; \\r/\\n/\\t preserve original controls, \\uXXXX preserves characters.",
      ...encodeExecLiteralField({ id: "literal", value }).lines.map(
        (line, index) => `${index ? "  + " : "  | "}${line.slice(line.indexOf(" ") + 1)} |`,
      ),
    ];
  }
  const lines: string[] = [];
  let remaining = value;
  const width = PHONE_EXEC_MAX_LINE - 6;
  while (remaining.length > width) {
    let end = remaining.lastIndexOf(" ", width);
    if (end < width / 2) end = width;
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    lines.push(`${lines.length ? "  + " : "  | "}${remaining.slice(0, end)} |`);
    remaining = remaining.slice(end);
  }
  lines.push(`${lines.length ? "  + " : "  | "}${remaining} |`);
  return lines;
}

export function renderCanonicalWeixinExecPrompt(params: {
  approval: WindowsNodeMxcGatewayApproval;
  security: WeixinRemoteApprovalSecurityBinding;
  expiresAtUnixMs: number;
  code: string;
  locale: "en-US" | "zh-CN";
  bareReplies?: boolean;
}): CanonicalPhoneExecResult {
  const view = createCanonicalExecPresentation(params.approval);
  if (
    !view ||
    !Number.isSafeInteger(params.expiresAtUnixMs) ||
    !Number.isFinite(new Date(params.expiresAtUnixMs).getTime()) ||
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
  const suffix = params.bareReplies === false ? ` ${params.code}` : "";
  const command = canonicalWindowsCommand(view.initialization?.originalArgv ?? view.argv);
  if (!view.initialization && command.includes(POWERSHELL_FILESYSTEM_SCOPE_MARKER)) {
    return {
      status: "unsupported",
      reason: "security-binding-invalid",
      category: "invalid-canonical-plan",
    };
  }
  const visibleValues = [
    command,
    view.executablePath,
    view.canonicalCwd,
    ...view.declaredAccess.map((entry) => entry.path),
    ...view.folderChanges.map((entry) => entry.path),
  ];
  if (visibleValues.reduce((length, value) => length + value.length, 0) > PHONE_EXEC_MAX_LENGTH) {
    return {
      status: "unsupported",
      reason: "presentation-too-long",
      category: "complete-display-too-long",
    };
  }
  const lines = [
    zh ? "🛡️ MicroClaw 安全审批" : "🛡️ MicroClaw Security Approval",
    "",
    zh
      ? "命令（完整原文；| 内为内容，+ 接续上一行，不添加换行）："
      : "Command (exact; text is between | marks; + continues the previous line):",
    ...literalBlock(command, zh),
    "",
    zh ? "程序：" : "Program:",
    ...literalBlock(view.executablePath, zh),
    zh ? "工作目录：" : "Working folder:",
    ...(view.canonicalCwd === "isolated-scratch:v1"
      ? [zh ? "  每次执行独立的临时目录" : "  Isolated temporary folder for this execution"]
      : literalBlock(view.canonicalCwd, zh)),
    zh ? "额外文件访问：" : "Additional file access:",
    ...(view.declaredAccess.length
      ? view.declaredAccess.flatMap((entry) => [
          zh
            ? `  ${entry.access === "rw" ? "读写" : "只读"}：`
            : `  ${entry.access === "rw" ? "Read/write" : "Read-only"}:`,
          ...literalBlock(entry.path, zh),
        ])
      : [zh ? "  无额外授权" : "  None"]),
    ...(view.folderChanges.length
      ? [
          zh ? "将新增的持久文件夹权限：" : "New persistent folder grants:",
          ...view.folderChanges.flatMap((entry) => [
            zh
              ? `  ${entry.access === "rw" ? "读写" : "只读"}：`
              : `  ${entry.access === "rw" ? "Read/write" : "Read-only"}:`,
            ...literalBlock(entry.path, zh),
          ]),
          zh
            ? "允许将保存这些文件夹权限，直到在设置中移除；当前命令仅批准一次。"
            : "Allow saves these folder grants until removed in Settings; this command runs once.",
        ]
      : []),
    ...(params.security.requestedMode === "full"
      ? [
          zh
            ? "Full 模式：可访问 Windows 账户原本有权访问的内容，不仅是上面列出的文件夹。"
            : "Full mode can access anything its Windows account allows, not just the folders listed above.",
        ]
      : [
          zh
            ? "Limited 模式：增加上面列出的访问权限。已有的 Windows 权限也可能允许其他访问。"
            : "Limited mode: adds the access listed above. Existing Windows permissions may allow other access too.",
        ]),
    ...(view.initialization
      ? [
          zh
            ? "含已验证的工作目录初始化；不增加文件权限。完整执行详情见桌面。"
            : "Verified folder initialization: no extra file access. Full execution details: Desktop.",
        ]
      : []),
    ...(view.hasMutableFileOperand
      ? [
          zh
            ? "引用的文件可能改变；此审批不能保存供以后使用。"
            : "A referenced file may change; this approval cannot be saved for later.",
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
    `${zh ? "到期" : "Expires"}: ${new Date(params.expiresAtUnixMs).toISOString().replace("T", " ").replace("Z", " UTC (UTC+00:00)")}`,
    zh
      ? "仅限当前会话的当前审批。完整技术详情见桌面；批准不等于执行成功。"
      : "Current prompt/conversation only. Technical details: Desktop. Approval is not execution success.",
  ];
  const text = lines.join("\n");
  if (
    text.length > PHONE_EXEC_MAX_LENGTH ||
    lines.some((line) => line.length > PHONE_EXEC_MAX_LINE)
  ) {
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
