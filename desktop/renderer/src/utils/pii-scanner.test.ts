import { describe, it, expect } from "vitest";
import {
  scanPii,
  redactPii,
  normalizeScanOptions,
  renderPiiHighlights,
  type PiiType,
} from "./pii-scanner";

// ── Helpers ────────────────────────────────────────────────────────────
function typesOf(text: string): PiiType[] {
  return scanPii(text).map((m) => m.type);
}

// ── Chinese mainland phone ─────────────────────────────────────────────
describe("scanPii — phone (CN mainland)", () => {
  it("detects a bare 11-digit mobile number", () => {
    const matches = scanPii("联系电话 13812345678 请拨打");
    const phones = matches.filter((m) => m.type === "phone");
    expect(phones).toHaveLength(1);
    expect(phones[0].value).toBe("13812345678");
    expect(phones[0].redacted).toBe("138****5678");
  });

  it("does not match numbers that start with 1x where x<3", () => {
    // 12xxxxxxxxx and 10xxxxxxxxx are not valid CN mobile prefixes
    const matches = scanPii("12812345678 10012345678");
    expect(matches.filter((m) => m.type === "phone")).toHaveLength(0);
  });

  it("does not match 10- or 12-digit numbers (lookaround boundary)", () => {
    expect(scanPii("138123456789")).toEqual([]); // 12 digits — adjacent digit
    expect(scanPii("1381234567")).toEqual([]); // 10 digits
  });
});

// ── International phone ────────────────────────────────────────────────
describe("scanPii — phone (international)", () => {
  it("detects +86 prefix numbers", () => {
    const matches = scanPii("Call +86 13812345678 now");
    // Both international and CN mobile rules will match — both are fine
    const phones = matches.filter((m) => m.type === "phone");
    expect(phones.length).toBeGreaterThanOrEqual(1);
  });

  it("detects +1 US-style numbers", () => {
    const matches = scanPii("Contact +1 2025550100");
    const phones = matches.filter((m) => m.type === "phone");
    expect(phones).toHaveLength(1);
    expect(phones[0].value).toContain("+1");
  });
});

// ── Chinese ID card ─────────────────────────────────────────────────────
describe("scanPii — idCard", () => {
  it("detects 18-digit ID card ending in digit", () => {
    // 6-digit region + year 1990 + month 05 + day 15 + 4 tail digits
    const matches = scanPii("身份证 110101199005151234 办理");
    const ids = matches.filter((m) => m.type === "idCard");
    expect(ids).toHaveLength(1);
    expect(ids[0].redacted).toBe("110101********1234");
  });

  it("detects 18-digit ID card ending in X", () => {
    const matches = scanPii("ID: 11010119900515123X");
    const ids = matches.filter((m) => m.type === "idCard");
    expect(ids).toHaveLength(1);
  });

  it("rejects invalid month/day combos", () => {
    const matches = scanPii("110101199013151234"); // month 13 invalid
    expect(matches.filter((m) => m.type === "idCard")).toHaveLength(0);
  });
});

// ── Bank cards ─────────────────────────────────────────────────────────
describe("scanPii — bankCard", () => {
  it("detects a 16-digit card starting with 4 (Visa-ish)", () => {
    const matches = scanPii("卡号 4111111111111234 谢谢");
    const cards = matches.filter((m) => m.type === "bankCard");
    expect(cards).toHaveLength(1);
    expect(cards[0].redacted).toBe("4111 **** **** 1234");
  });

  it("does not match 12-digit numbers (too short)", () => {
    const matches = scanPii("411111111111"); // 12 digits
    expect(matches.filter((m) => m.type === "bankCard")).toHaveLength(0);
  });
});

// ── Emails ─────────────────────────────────────────────────────────────
describe("scanPii — email", () => {
  it("detects simple emails and redacts local part", () => {
    const matches = scanPii("reach me at alice@example.com ok?");
    const emails = matches.filter((m) => m.type === "email");
    expect(emails).toHaveLength(1);
    expect(emails[0].value).toBe("alice@example.com");
    expect(emails[0].redacted).toBe("al***@example.com");
  });

  it("detects emails with dots/plus in local part", () => {
    const matches = scanPii("first.last+tag@sub.example.co");
    const emails = matches.filter((m) => m.type === "email");
    expect(emails).toHaveLength(1);
  });
});

// ── API keys / secrets ─────────────────────────────────────────────────
describe("scanPii — apiKey", () => {
  it("detects sk- prefix with an assignment separator", () => {
    // Current rule requires `[:=]` after the prefix — the `sk-` alternative
    // matches forms like `sk-: <key>` or `sk-= <key>`, not bare `sk-xxxx`.
    const matches = scanPii("sk-: abcdefghijklmnopqrstuvwxyz0123456789");
    const keys = matches.filter((m) => m.type === "apiKey");
    expect(keys).toHaveLength(1);
    expect(keys[0].redacted).toContain("****");
  });

  it("detects api_key= assignments", () => {
    const matches = scanPii("api_key=abcdefghijklmnopqrstuvwx");
    const keys = matches.filter((m) => m.type === "apiKey");
    expect(keys).toHaveLength(1);
  });

  it("detects bearer tokens (case-insensitive)", () => {
    const matches = scanPii("Bearer: abcdefghijklmnopqrstuvwxyz");
    const keys = matches.filter((m) => m.type === "apiKey");
    expect(keys).toHaveLength(1);
  });

  it("does not match short 'token=abc' strings", () => {
    const matches = scanPii("token=short");
    expect(matches.filter((m) => m.type === "apiKey")).toHaveLength(0);
  });
});

// ── Options filtering ──────────────────────────────────────────────────
describe("scanPii — options", () => {
  it("disables phone detection when phone=false", () => {
    const text = "13812345678 and alice@example.com";
    const matches = scanPii(text, { phone: false });
    expect(matches.map((m) => m.type)).toEqual(["email"]);
  });

  it("disables all types when everything is false", () => {
    const text = "13812345678 alice@example.com 4111111111111234";
    const matches = scanPii(text, {
      phone: false,
      email: false,
      bankCard: false,
      idCard: false,
      apiKey: false,
    });
    expect(matches).toEqual([]);
  });

  it("defaults to enabling every type when no option given", () => {
    const types = typesOf("13812345678 alice@example.com");
    expect(types).toContain("phone");
    expect(types).toContain("email");
  });

  it("normalizes persisted options and defaults missing values to enabled", () => {
    expect(normalizeScanOptions({ phone: false, email: true })).toEqual({
      phone: false,
      idCard: true,
      bankCard: true,
      email: true,
      apiKey: true,
    });
    expect(normalizeScanOptions(null)).toEqual({
      phone: true,
      idCard: true,
      bankCard: true,
      email: true,
      apiKey: true,
    });
  });
});

// ── Sort + position stability ──────────────────────────────────────────
describe("scanPii — ordering", () => {
  it("returns matches sorted by start index", () => {
    const text = "alice@example.com called 13812345678";
    const matches = scanPii(text);
    const starts = matches.map((m) => m.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("exposes accurate start/end offsets", () => {
    const text = "AAA 13812345678 BBB";
    const [m] = scanPii(text);
    expect(text.slice(m.start, m.end)).toBe(m.value);
  });

  it("removes overlapping matches so redaction cannot duplicate text", () => {
    const matches = scanPii("Call +86 13812345678 now");
    expect(matches.filter((match) => match.type === "phone")).toHaveLength(1);
    expect(redactPii("Call +86 13812345678 now")).toBe("Call +86 ****678 now");
  });
});

// ── Idempotency & repeatability ────────────────────────────────────────
describe("scanPii — repeatability (regex lastIndex reset)", () => {
  it("produces identical results across repeated calls", () => {
    const text = "13812345678 foo@bar.com 13912345678";
    const a = scanPii(text);
    const b = scanPii(text);
    const c = scanPii(text);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});

// ── redactPii ──────────────────────────────────────────────────────────
describe("redactPii", () => {
  it("returns text unchanged when no PII", () => {
    expect(redactPii("hello world")).toBe("hello world");
  });

  it("replaces all matches with their redacted forms", () => {
    const out = redactPii("phone 13812345678 and email alice@example.com.");
    expect(out).toBe("phone 138****5678 and email al***@example.com.");
  });

  it("handles empty input", () => {
    expect(redactPii("")).toBe("");
  });

  it("preserves non-PII whitespace and punctuation", () => {
    const out = redactPii("  13812345678 !! ");
    expect(out).toBe("  138****5678 !! ");
  });
});

describe("renderPiiHighlights", () => {
  it("highlights matches while escaping all user-controlled HTML", () => {
    const text = '<script>alert("x")</script> 13812345678';
    const matches = scanPii(text);
    const html = renderPiiHighlights(text, matches);

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('<mark data-pii-type="phone">13812345678</mark>');
  });
});
