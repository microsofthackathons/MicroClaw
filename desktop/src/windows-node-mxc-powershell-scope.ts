import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  classifyLiteralFilesystemCommand,
  tokenizeLiteralCommand,
} from "./windows-node-mxc-literal-filesystem-command";

export const POWERSHELL_FILESYSTEM_SCOPE_CONTRACT = "microclaw.powershell-filesystem-scope.v1";
export const POWERSHELL_FILESYSTEM_SCOPE_MARKER = "[void]'microclaw.powershell-filesystem-scope.";
export const POWERSHELL_FILESYSTEM_INITIALIZER =
  "[void]'microclaw.powershell-filesystem-scope.v1';" +
  "try{New-PSDrive -Name MicroClawCwd -PSProvider FileSystem -Root ([Environment]::CurrentDirectory) -Scope Script -ErrorAction Stop|Out-Null;" +
  "Set-Location -LiteralPath 'MicroClawCwd:\\' -ErrorAction Stop}" +
  "catch{[Console]::Error.WriteLine('MicroClaw PowerShell filesystem initialization failed; command not executed.');exit 125};";

export interface PowerShellFilesystemInitialization {
  contract: typeof POWERSHELL_FILESYSTEM_SCOPE_CONTRACT;
  form: "direct" | "nested";
  originalArgv: string[];
  originalCommandPreview: string;
  finalArgv: string[];
}

type Access = Array<{ access: "ro" | "rw"; path: string }>;

function preview(access: Access, payload: string): string {
  const entries = [...access].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return `# [declare-access]${entries.map((entry) => `${entry.access}:${entry.path}`).join(";")}[/declare-access]\n${payload}`;
}

export function createPowerShellFilesystemInitialization(
  argv: string[],
  executablePath: string,
  access: Access,
): PowerShellFilesystemInitialization | null {
  if (
    argv.length < 4 ||
    argv.length > 8 ||
    argv.some((value) => value.length > 4096) ||
    !["powershell", "powershell.exe"].includes(path.win32.basename(argv[0]).toLowerCase())
  )
    return null;
  const operation = classifyLiteralFilesystemCommand({
    executable: argv[0],
    executablePath,
    arguments: argv.slice(1),
    declaredAccess: access,
  });
  if (!operation || (operation.kind !== "create-directory" && operation.kind !== "remove-path"))
    return null;
  const payload = argv[argv.length - 1];
  const tokens = tokenizeLiteralCommand(payload);
  if (!tokens) return null;
  const nested = ["powershell", "powershell.exe"].includes(tokens[0]?.value.toLowerCase());
  if (!nested && !["new-item", "remove-item"].includes(tokens[0]?.value.toLowerCase())) return null;
  const last = tokens[tokens.length - 1];
  if (nested && (last.quote !== '"' || last.start === undefined)) return null;
  const finalPayload =
    nested && last.start !== undefined
      ? payload.slice(0, last.start + 1) +
        POWERSHELL_FILESYSTEM_INITIALIZER +
        payload.slice(last.start + 1)
      : POWERSHELL_FILESYSTEM_INITIALIZER + payload;
  const finalArgv = [...argv];
  finalArgv[finalArgv.length - 1] = finalPayload;
  return {
    contract: POWERSHELL_FILESYSTEM_SCOPE_CONTRACT,
    form: nested ? "nested" : "direct",
    originalArgv: [...argv],
    originalCommandPreview: preview(access, payload),
    finalArgv,
  };
}

export function validatePowerShellFilesystemInitialization(
  value: unknown,
  argv: string[],
  executablePath: string,
  access: Access,
  commandPreview: string,
): PowerShellFilesystemInitialization | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 5 ||
    !("originalArgv" in value) ||
    !Array.isArray(value.originalArgv) ||
    value.originalArgv.some((item) => typeof item !== "string" || !item)
  )
    return null;
  const originalArgv: string[] = [];
  for (const argument of value.originalArgv) {
    if (typeof argument !== "string") return null;
    originalArgv.push(argument);
  }
  const expected = createPowerShellFilesystemInitialization(originalArgv, executablePath, access);
  return expected &&
    isDeepStrictEqual(value, expected) &&
    isDeepStrictEqual(argv, expected.finalArgv) &&
    commandPreview === preview(access, expected.finalArgv[expected.finalArgv.length - 1])
    ? expected
    : null;
}

export function originalPowerShellFilesystemApproval(approval: {
  executable: string;
  executablePath: string;
  arguments: string[];
  declaredAccess: Access;
  providerInitialization?: PowerShellFilesystemInitialization;
}) {
  const initialization = approval.providerInitialization;
  if (!initialization) return approval;
  const expected = createPowerShellFilesystemInitialization(
    initialization.originalArgv,
    approval.executablePath,
    approval.declaredAccess,
  );
  if (
    !expected ||
    !isDeepStrictEqual(initialization, expected) ||
    !isDeepStrictEqual([approval.executable, ...approval.arguments], expected.finalArgv)
  )
    return null;
  return {
    ...approval,
    executable: expected.originalArgv[0],
    arguments: expected.originalArgv.slice(1),
  };
}

export function validateNativePowerShellFilesystemInitialization(
  value: unknown,
  executablePath: string,
  args: string[],
  access: Access,
): PowerShellFilesystemInitialization | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("finalArgv" in value) ||
    !Array.isArray(value.finalArgv)
  )
    return null;
  const argv: string[] = [];
  for (const argument of value.finalArgv) {
    if (typeof argument !== "string") return null;
    argv.push(argument);
  }
  if (!isDeepStrictEqual(args, argv.slice(1))) return null;
  return validatePowerShellFilesystemInitialization(
    value,
    argv,
    executablePath,
    access,
    preview(access, argv[argv.length - 1]),
  );
}
