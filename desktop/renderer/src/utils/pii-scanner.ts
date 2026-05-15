/**
 * PII (Personally Identifiable Information) scanner.
 *
 * Detects sensitive patterns in text before sending to AI models.
 * Used by the privacy protection system in MicroClaw.
 */

export interface PiiMatch {
  type: PiiType;
  value: string;
  start: number;
  end: number;
  redacted: string;
}

export type PiiType = "phone" | "idCard" | "bankCard" | "email" | "apiKey";

interface PiiRule {
  type: PiiType;
  pattern: RegExp;
  redact: (match: string) => string;
}

const PII_RULES: PiiRule[] = [
  // Chinese mainland phone numbers: 1xx-xxxx-xxxx
  {
    type: "phone",
    pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
    redact: (m) => m.slice(0, 3) + "****" + m.slice(7),
  },
  // International phone with country code: +xx xxx...
  {
    type: "phone",
    pattern: /\+\d{1,3}[\s-]?\d{6,14}/g,
    redact: (m) => m.slice(0, 4) + "****" + m.slice(-3),
  },
  // Chinese ID card number (18 digits, last may be X)
  {
    type: "idCard",
    pattern: /(?<!\d)\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g,
    redact: (m) => m.slice(0, 6) + "********" + m.slice(14),
  },
  // Bank card numbers (13-19 digits, typically starting with 4/5/6/3)
  {
    type: "bankCard",
    pattern: /(?<!\d)[3-6]\d{12,18}(?!\d)/g,
    redact: (m) => m.slice(0, 4) + " **** **** " + m.slice(-4),
  },
  // Email addresses
  {
    type: "email",
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    redact: (m) => {
      const [local, domain] = m.split("@");
      return local.slice(0, 2) + "***@" + domain;
    },
  },
  // API keys / secrets (long hex, base64, or common patterns)
  {
    type: "apiKey",
    pattern: /(?:sk-|api[_-]?key|secret|token|bearer)\s*[:=]\s*['"]?[A-Za-z0-9_\-/.+]{20,}['"]?/gi,
    redact: (m) => {
      const sepIdx = m.search(/[:=]/);
      if (sepIdx === -1) return m.slice(0, 8) + "****";
      return m.slice(0, sepIdx + 2) + "****";
    },
  },
];

export interface ScanOptions {
  phone?: boolean;
  idCard?: boolean;
  bankCard?: boolean;
  email?: boolean;
  apiKey?: boolean;
}

/**
 * Scan text for PII matches.
 * @param text - The text to scan
 * @param options - Which PII types to detect (all enabled by default)
 * @returns Array of PII matches found
 */
export function scanPii(text: string, options: ScanOptions = {}): PiiMatch[] {
  const enabledTypes = new Set<PiiType>();
  if (options.phone !== false) enabledTypes.add("phone");
  if (options.idCard !== false) enabledTypes.add("idCard");
  if (options.bankCard !== false) enabledTypes.add("bankCard");
  if (options.email !== false) enabledTypes.add("email");
  if (options.apiKey !== false) enabledTypes.add("apiKey");

  const matches: PiiMatch[] = [];

  for (const rule of PII_RULES) {
    if (!enabledTypes.has(rule.type)) continue;

    // Reset lastIndex for global regex
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = rule.pattern.exec(text)) !== null) {
      matches.push({
        type: rule.type,
        value: match[0],
        start: match.index,
        end: match.index + match[0].length,
        redacted: rule.redact(match[0]),
      });
    }
  }

  // Sort by position
  matches.sort((a, b) => a.start - b.start);
  return matches;
}

/**
 * Redact all PII in text, replacing matches with redacted versions.
 * @param text - The text to redact
 * @param options - Which PII types to redact
 * @returns Redacted text
 */
export function redactPii(text: string, options: ScanOptions = {}): string {
  const matches = scanPii(text, options);
  if (matches.length === 0) return text;

  let result = "";
  let lastEnd = 0;
  for (const m of matches) {
    result += text.slice(lastEnd, m.start) + m.redacted;
    lastEnd = m.end;
  }
  result += text.slice(lastEnd);
  return result;
}
