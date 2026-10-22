/** Validate the decimal wire contract again at the authenticated plugin/main boundary. */
export function normalizeWeixinProviderInteger(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    value = String(value);
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return null;
  if (value.length === 20 && value > "18446744073709551615") return null;
  return value;
}

export function isLaterWeixinProviderCursor(value: unknown, previous: unknown): boolean {
  const left = normalizeWeixinProviderInteger(value);
  const right = normalizeWeixinProviderInteger(previous);
  return (
    left !== null &&
    right !== null &&
    (left.length > right.length || (left.length === right.length && left > right))
  );
}
