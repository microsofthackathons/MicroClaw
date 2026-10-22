import path from "node:path";

interface LiteralToken {
  value: string;
  quoted: boolean;
  start?: number;
  quote?: string | null;
}

export function tokenizeLiteralCommand(text: string): LiteralToken[] | null {
  if (
    !text ||
    text.length > 2_048 ||
    /[$`;\r\n|&<>#(){}[\]]/.test(text) ||
    [...text].some((character) => character.charCodeAt(0) < 32 && character !== "\t")
  ) {
    return null;
  }
  const tokens: LiteralToken[] = [];
  let index = 0;
  while (index < text.length) {
    while (text[index] === " " || text[index] === "\t") index++;
    if (index === text.length) break;
    const tokenStart = index;
    const quote = text[index] === "'" || text[index] === '"' ? text[index++] : null;
    const start = index;
    if (quote) {
      while (index < text.length && text[index] !== quote) index++;
      if (index === text.length) return null;
      tokens.push({ value: text.slice(start, index++), quoted: true, start: tokenStart, quote });
      if (index < text.length && text[index] !== " " && text[index] !== "\t") return null;
    } else {
      while (index < text.length && text[index] !== " " && text[index] !== "\t") {
        if (text[index] === "'" || text[index] === '"') return null;
        index++;
      }
      tokens.push({
        value: text.slice(start, index),
        quoted: false,
        start: tokenStart,
        quote: null,
      });
    }
    if (tokens.length > 16) return null;
  }
  return tokens;
}

function literalLocalPath(value: string): boolean {
  if (!/^[A-Za-z]:\\/.test(value)) return false;
  return value
    .slice(3)
    .split("\\")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment.length <= 80 &&
        /^[A-Za-z0-9_ .-]+$/.test(segment) &&
        segment !== "." &&
        segment !== ".." &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment) &&
        !segment.endsWith(".") &&
        !segment.endsWith(" "),
    );
}

function shellPayload(tokens: LiteralToken[]): string | null {
  if (
    !tokens[0] ||
    tokens[0].quoted ||
    !["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(tokens[0].value.toLowerCase())
  ) {
    return null;
  }
  let index = 1;
  const flags = new Set<string>();
  while (index < tokens.length && !tokens[index].quoted) {
    const flag = tokens[index].value.toLowerCase();
    if (flag === "-command") break;
    if (!["-nologo", "-noprofile", "-noninteractive"].includes(flag) || flags.has(flag))
      return null;
    flags.add(flag);
    index++;
  }
  return flags.has("-noprofile") &&
    tokens[index]?.value.toLowerCase() === "-command" &&
    !tokens[index].quoted &&
    index + 2 === tokens.length
    ? tokens[index + 1].value
    : null;
}

type FilesystemOperation =
  | "create-directory"
  | "create-file"
  | "remove-path"
  | "clear-content"
  | "set-content"
  | "append-content";
interface LiteralFilesystemOperation {
  kind: FilesystemOperation;
  path: string;
}

// Only these low-entropy public primitives may be disclosed as inline content.
const PUBLIC_CONTENT_LITERALS = new Set(["", "0", "1", "true", "false", "null"]);

function filesystemPayload(
  text: string,
  allowNestedShell: boolean,
): LiteralFilesystemOperation | null {
  const tokens = tokenizeLiteralCommand(text);
  if (!tokens) return null;
  if (allowNestedShell) {
    const nested = shellPayload(tokens);
    if (nested !== null) return filesystemPayload(nested, false);
  }
  if (!tokens[0] || tokens[0].quoted) return null;
  const command = tokens[0].value.toLowerCase();
  const rules = {
    "new-item": { values: ["-itemtype", "-path", "-value"], flags: ["-force"] },
    "remove-item": { values: ["-path", "-literalpath"], flags: ["-force", "-recurse"] },
    "clear-content": { values: ["-path", "-literalpath"], flags: ["-force"] },
    "set-content": {
      values: ["-path", "-literalpath", "-value", "-encoding"],
      flags: ["-force", "-nonewline"],
    },
    "add-content": {
      values: ["-path", "-literalpath", "-value", "-encoding"],
      flags: ["-force", "-nonewline"],
    },
  };
  const rule = Object.entries(rules).find(([name]) => name === command)?.[1];
  if (!rule) return null;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.quoted) return null;
    const flag = token.value.toLowerCase();
    if (values.has(flag) || flags.has(flag)) return null;
    if (rule.flags.includes(flag)) flags.add(flag);
    else if (rule.values.includes(flag)) {
      const value = tokens[++index];
      if (!value || (!value.quoted && value.value.startsWith("-"))) return null;
      values.set(flag, value.value);
    } else return null;
  }
  if (values.has("-path") && values.has("-literalpath")) return null;
  const target = values.get("-path") ?? values.get("-literalpath");
  if (!target || !literalLocalPath(target)) return null;
  const value = values.get("-value");
  if (value !== undefined && !PUBLIC_CONTENT_LITERALS.has(value)) return null;
  const encoding = values.get("-encoding");
  if (encoding !== undefined && !["ascii", "utf8", "unicode"].includes(encoding.toLowerCase()))
    return null;
  if (command === "new-item") {
    const type = values.get("-itemtype")?.toLowerCase();
    if (type !== "directory" && type !== "file") return null;
    if (type === "directory" && value !== undefined) return null;
    return { kind: type === "directory" ? "create-directory" : "create-file", path: target };
  }
  if (command === "remove-item") return { kind: "remove-path", path: target };
  if (command === "clear-content") return { kind: "clear-content", path: target };
  if (value === undefined) return null;
  return { kind: command === "set-content" ? "set-content" : "append-content", path: target };
}

export function classifyLiteralFilesystemCommand(approval: {
  executable: string;
  executablePath: string;
  arguments: string[];
  declaredAccess: Array<{ access: string; path: string }>;
}): LiteralFilesystemOperation | null {
  const executable = path.win32.basename(approval.executable).toLowerCase();
  const resolvedExecutable = path.win32.basename(approval.executablePath).toLowerCase();
  if (
    !["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(executable) ||
    resolvedExecutable !== `${executable.replace(/\.exe$/, "")}.exe` ||
    (approval.executable.includes("\\") &&
      approval.executable.toLowerCase() !== approval.executablePath.toLowerCase())
  )
    return null;
  const payload = shellPayload([
    { value: executable, quoted: false },
    ...approval.arguments.map((value, index) => ({
      value,
      quoted: index === approval.arguments.length - 1,
    })),
  ]);
  if (payload === null) return null;
  const operation = filesystemPayload(payload, true);
  if (!operation) return null;
  const declared = approval.declaredAccess.some((entry) => {
    if (entry.access !== "rw" || !literalLocalPath(entry.path)) return false;
    const relative = path.win32.relative(entry.path.toLowerCase(), operation.path.toLowerCase());
    return relative === "" || (!relative.startsWith("..") && !path.win32.isAbsolute(relative));
  });
  return declared ? operation : null;
}
