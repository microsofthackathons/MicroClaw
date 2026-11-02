export function isMainSessionKey(key: string, canonicalMainKey: string | null = null): boolean {
  if (canonicalMainKey && key === canonicalMainKey) return true;
  if (key === "main") return true;
  const mainName = /^agent:[^:]+:(.+)$/.exec(canonicalMainKey ?? "")?.[1] ?? "main";
  const session = /^agent:[^:]+:(.+)$/.exec(key);
  return session?.[1] === mainName;
}
