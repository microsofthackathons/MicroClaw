import type { WindowsNodeMxcGatewayApproval } from "./windows-node-mxc";
import { parseCommandConsentPreview } from "./command-consent";
import { originalPowerShellFilesystemApproval } from "./windows-node-mxc-powershell-scope";

export const CANONICAL_EXEC_PRESENTATION = "microclaw.exec-approval-presentation.v2";
export const PHONE_EXEC_MAX_LINE = 160;
export const PHONE_EXEC_MAX_LENGTH = 6_000;
export const PHONE_EXEC_MAX_FRAME_BYTES = 64 * 1024;

const SENSITIVE_SEMANTICS =
  /(?:accountkey|authorization|auth|bearer|clientsecret|cookie|credential|key|passphrase|passwd|password|privatekey|proxyauthorization|sas|secret|setcookie|signature|sig|token)/i;
const INVISIBLE_DATA = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const MARKUP_DATA = /[<>&*_`[\]#|~!]/;

export function containsPhoneSensitiveSemantics(value: string): boolean {
  return SENSITIVE_SEMANTICS.test(value.replace(/[^A-Za-z0-9]/g, ""));
}

export function hasUnsafePhoneUnicode(value: string): boolean {
  return [...value].some(
    (character) =>
      character !== "\r" &&
      character !== "\n" &&
      character !== "\t" &&
      INVISIBLE_DATA.test(character),
  );
}

export function canonicalWindowsCommand(argv: readonly string[]): string {
  return argv
    .map((value) => {
      if (value.length > 0 && !/\s/.test(value) && !value.includes('"')) return value;
      let output = '"';
      let slashes = 0;
      for (const character of value) {
        if (character === "\\") {
          slashes++;
        } else if (character === '"') {
          output += `${"\\".repeat(slashes * 2 + 1)}"`;
          slashes = 0;
        } else {
          output += `${"\\".repeat(slashes)}${character}`;
          slashes = 0;
        }
      }
      return `${output}${"\\".repeat(slashes * 2)}"`;
    })
    .join(" ");
}

export interface CanonicalExecPresentation {
  contract: typeof CANONICAL_EXEC_PRESENTATION;
  approvalId: string;
  allowedDecisions: WindowsNodeMxcGatewayApproval["allowedDecisions"];
  requestDeadlineUnixMs: number | null;
  command: string;
  executablePath: string;
  executableSha256: string;
  argv: string[];
  canonicalCwd: string;
  agent: string | null;
  sessionKey: string;
  declaredAccess: Array<{ access: "ro" | "rw"; path: string }>;
  folderChanges: Array<{ access: "ro" | "rw"; path: string }>;
  policyFingerprint: string | null;
  planSha256: string | null;
  commandConsent: WindowsNodeMxcGatewayApproval["commandConsent"] | null;
  hasMutableFileOperand: boolean;
  origin: {
    gatewayGeneration: string;
    nodeId: string;
    agentId: string;
    runSessionKey: string;
    executionSessionKey: string;
    runId: string;
    toolCallId: string;
  } | null;
  initialization: {
    contract: string;
    form: "direct" | "nested" | "cmd";
    originalArgv: string[];
    originalCommandPreview: string;
    finalArgv: string[];
  } | null;
}

export interface ExecLiteralField {
  id: string;
  value: string;
}

export interface ExecLiteralDisplay {
  id: string;
  lines: string[];
}

export function createCanonicalExecPresentation(
  approval: WindowsNodeMxcGatewayApproval,
): CanonicalExecPresentation | null {
  if (
    !approval ||
    !Array.isArray(approval.arguments) ||
    !Array.isArray(approval.declaredAccess) ||
    (approval.folderChanges !== undefined && !Array.isArray(approval.folderChanges)) ||
    !Array.isArray(approval.allowedDecisions) ||
    typeof approval.id !== "string" ||
    !approval.id ||
    (approval.agent !== null && typeof approval.agent !== "string") ||
    typeof approval.hasMutableFileOperand !== "boolean" ||
    typeof approval.executable !== "string" ||
    typeof approval.command !== "string" ||
    typeof approval.executablePath !== "string" ||
    typeof approval.executableSha256 !== "string" ||
    typeof approval.canonicalCwd !== "string" ||
    typeof approval.sessionKey !== "string"
  ) {
    return null;
  }
  const argv = [approval.executable, ...approval.arguments];
  const commandConsent =
    approval.commandConsent === undefined
      ? null
      : parseCommandConsentPreview(approval.commandConsent);
  if (
    !argv.every((value) => typeof value === "string") ||
    !argv[0] ||
    approval.command !== canonicalWindowsCommand(argv) ||
    !/^[a-z]:\\/i.test(approval.executablePath) ||
    !/^[a-f0-9]{64}$/i.test(approval.executableSha256) ||
    (approval.canonicalCwd !== "isolated-scratch:v1" &&
      !/^[a-z]:\\/i.test(approval.canonicalCwd)) ||
    !approval.sessionKey ||
    (approval.policyFingerprint !== undefined &&
      !/^[a-f0-9]{64}$/i.test(approval.policyFingerprint)) ||
    (approval.planSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(approval.planSha256)) ||
    approval.allowedDecisions.some(
      (decision) => !["deny", "allow-once", "allow-always"].includes(decision),
    ) ||
    (approval.expiresAtUnixMs !== undefined &&
      (!Number.isSafeInteger(approval.expiresAtUnixMs) ||
        !Number.isFinite(new Date(approval.expiresAtUnixMs).getTime()))) ||
    approval.declaredAccess.some(
      (entry) =>
        !entry ||
        !["ro", "rw"].includes(entry.access) ||
        typeof entry.path !== "string" ||
        !/^[a-z]:\\/i.test(entry.path),
    ) ||
    (approval.folderChanges ?? []).some(
      (entry) =>
        !entry ||
        !["ro", "rw"].includes(entry.access) ||
        typeof entry.path !== "string" ||
        !/^[a-z]:\\/i.test(entry.path),
    ) ||
    (approval.commandConsent !== undefined && commandConsent === null) ||
    !originalPowerShellFilesystemApproval(approval)
  ) {
    return null;
  }
  const origin = approval.origin;
  const initialization = approval.providerInitialization;
  return {
    contract: CANONICAL_EXEC_PRESENTATION,
    approvalId: approval.id,
    allowedDecisions: [...approval.allowedDecisions],
    requestDeadlineUnixMs: approval.expiresAtUnixMs ?? null,
    command: approval.command,
    executablePath: approval.executablePath,
    executableSha256: approval.executableSha256,
    argv,
    canonicalCwd: approval.canonicalCwd,
    agent: approval.agent,
    sessionKey: approval.sessionKey,
    declaredAccess: approval.declaredAccess.map((entry) => ({ ...entry })),
    folderChanges: (approval.folderChanges ?? []).map((entry) => ({ ...entry })),
    policyFingerprint: approval.policyFingerprint ?? null,
    planSha256: approval.planSha256 ?? null,
    commandConsent,
    hasMutableFileOperand: approval.hasMutableFileOperand,
    origin: origin
      ? {
          gatewayGeneration: origin.gatewayGeneration,
          nodeId: origin.nodeId,
          agentId: origin.agentId,
          runSessionKey: origin.runSessionKey,
          executionSessionKey: origin.executionSessionKey,
          runId: origin.runId,
          toolCallId: origin.toolCallId,
        }
      : null,
    initialization: initialization
      ? {
          contract: initialization.contract,
          form: initialization.form,
          originalArgv: [...initialization.originalArgv],
          originalCommandPreview: initialization.originalCommandPreview,
          finalArgv: [...initialization.finalArgv],
        }
      : null,
  };
}

export function canonicalExecLiteralFields(view: CanonicalExecPresentation): ExecLiteralField[] {
  const field = (id: string, value: string): ExecLiteralField => ({ id, value });
  return [
    field("approval", view.approvalId),
    field("decisions.count", String(view.allowedDecisions.length)),
    ...view.allowedDecisions.map((value, index) => field(`decision.${index}`, value)),
    ...(view.requestDeadlineUnixMs === null
      ? [field("request.deadline.absent", "true")]
      : [field("request.deadline.unixms", String(view.requestDeadlineUnixMs))]),
    field("command", view.command),
    field("executable.path", view.executablePath),
    field("executable.sha256", view.executableSha256),
    field("argv.count", String(view.argv.length)),
    ...view.argv.map((value, index) => field(`argv.${index}`, value)),
    field("cwd", view.canonicalCwd),
    ...(view.agent === null ? [field("agent.null", "true")] : [field("agent", view.agent)]),
    field("session", view.sessionKey),
    field("grants.count", String(view.declaredAccess.length)),
    ...view.declaredAccess.flatMap((entry, index) => [
      field(`grant.${index}.access`, entry.access),
      field(`grant.${index}.path`, entry.path),
    ]),
    field("folderchanges.count", String(view.folderChanges.length)),
    ...view.folderChanges.flatMap((entry, index) => [
      field(`folderchange.${index}.access`, entry.access),
      field(`folderchange.${index}.path`, entry.path),
    ]),
    ...(view.policyFingerprint ? [field("policy.fingerprint", view.policyFingerprint)] : []),
    ...(view.planSha256 ? [field("plan.sha256", view.planSha256)] : []),
    ...(view.commandConsent
      ? [
          field("consent.required", String(view.commandConsent.required)),
          field("consent.allowalways", String(view.commandConsent.allowAlwaysAvailable)),
        ]
      : []),
    field("mutable.operand", String(view.hasMutableFileOperand)),
    ...(view.origin
      ? [
          field("origin.generation", view.origin.gatewayGeneration),
          field("origin.node", view.origin.nodeId),
          field("origin.agent", view.origin.agentId),
          field("origin.session", view.origin.runSessionKey),
          field("origin.execution.session", view.origin.executionSessionKey),
          field("origin.run", view.origin.runId),
          field("origin.tool", view.origin.toolCallId),
        ]
      : []),
    ...(view.initialization
      ? [
          field("init.contract", view.initialization.contract),
          field("init.form", view.initialization.form),
          field("original.argv.count", String(view.initialization.originalArgv.length)),
          ...view.initialization.originalArgv.map((value, index) =>
            field(`original.argv.${index}`, value),
          ),
          field("original.command", canonicalWindowsCommand(view.initialization.originalArgv)),
          field("original.preview", view.initialization.originalCommandPreview),
        ]
      : []),
  ];
}

function literalCharacter(character: string): string {
  if (
    MARKUP_DATA.test(character) ||
    (INVISIBLE_DATA.test(character) && !["\r", "\n", "\t"].includes(character)) ||
    (/\p{Zs}/u.test(character) && character !== " ")
  ) {
    return Array.from(
      { length: character.length },
      (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`,
    ).join("");
  }
  return JSON.stringify(character).slice(1, -1);
}

/** Numbered JSON string parts preserve literal boundaries without raw markup or line breaks. */
export function encodeExecLiteralField(
  field: ExecLiteralField,
  maximumLine = PHONE_EXEC_MAX_LINE,
): ExecLiteralDisplay {
  if (!/^[a-z][a-z0-9.]*$/.test(field.id)) {
    throw new Error("Invalid app-owned exec presentation field identifier");
  }
  for (let digits = 1; ; digits++) {
    const available = maximumLine - field.id.length - digits * 2 - 6;
    if (available < 12) throw new Error("Exec presentation field cannot fit a literal part");
    const parts: string[] = [];
    let part = "";
    for (const character of field.value) {
      const encoded = literalCharacter(character);
      if (part.length + encoded.length > available) {
        parts.push(part);
        part = "";
      }
      part += encoded;
    }
    parts.push(part);
    if (String(parts.length).length > digits) continue;
    return {
      id: field.id,
      lines: parts.map((value, index) => `${field.id}[${index + 1}/${parts.length}] "${value}"`),
    };
  }
}

export function decodeExecLiteralFields(text: string): ExecLiteralField[] {
  const fields = new Map<string, { count: number; parts: string[] }>();
  for (const line of text.split("\n")) {
    const match = /^([a-z][a-z0-9.]*)\[(\d+)\/(\d+)\] (".*")$/.exec(line);
    if (!match) continue;
    const [, id, part, count, literal] = match;
    const value: unknown = JSON.parse(literal);
    const existing = fields.get(id) ?? { count: Number(count), parts: [] };
    if (
      typeof value !== "string" ||
      existing.count !== Number(count) ||
      Number(part) !== existing.parts.length + 1 ||
      Number(part) > Number(count)
    ) {
      throw new Error("Invalid ordered exec literal parts");
    }
    existing.parts.push(value);
    fields.set(id, existing);
  }
  return [...fields].map(([id, field]) => {
    if (field.parts.length !== field.count) throw new Error("Incomplete exec literal field");
    return { id, value: field.parts.join("") };
  });
}
