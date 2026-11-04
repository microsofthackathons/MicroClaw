import * as fs from "fs";
import * as path from "path";

export interface ElectronLifecycleDiagnosticContext {
  lifecycleActive: boolean;
  lifecyclePhase: string;
  windowRecoveryActive: boolean;
  gatewayPid: number | null;
  gatewayGeneration: string | null;
  explicitQuitRequested: boolean;
}

type DiagnosticValue = string | number | boolean | null;

function sanitizeText(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(proof|secret|token|authorization)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1$2[redacted]",
    )
    .replace(/\b[A-Za-z0-9+/=_-]{80,}\b/g, "[redacted-long-value]")
    .slice(0, 2048);
}

export function summarizeLifecycleError(error: unknown): string {
  const seen = new Set<unknown>();
  const summarize = (value: unknown): string => {
    if (seen.has(value)) return "[cyclic error]";
    if (value && typeof value === "object") seen.add(value);
    if (value instanceof AggregateError) {
      return sanitizeText(`${value.message}: ${value.errors.map(summarize).join(" | ")}`);
    }
    if (value instanceof Error) {
      const cause =
        "cause" in value && value.cause !== undefined ? `; cause=${summarize(value.cause)}` : "";
      return `${value.name}: ${sanitizeText(value.message)}${cause}`;
    }
    return sanitizeText(String(value));
  };
  return summarize(error);
}

export class ElectronLifecycleDiagnostics {
  constructor(
    private readonly filePath: () => string,
    private readonly context: () => ElectronLifecycleDiagnosticContext,
  ) {}

  log(event: string, details: Record<string, DiagnosticValue> = {}): void {
    try {
      const target = this.filePath();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const sanitizedDetails = Object.fromEntries(
        Object.entries(details).map(([key, value]) => [
          key,
          typeof value === "string" ? sanitizeText(value) : value,
        ]),
      );
      const record = {
        timestamp: new Date().toISOString(),
        event,
        ...this.context(),
        ...sanitizedDetails,
      };
      const fd = fs.openSync(target, "a");
      try {
        fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Diagnostics must never destabilize lifecycle recovery.
    }
  }
}
