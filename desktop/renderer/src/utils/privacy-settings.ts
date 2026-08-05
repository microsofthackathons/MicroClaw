export type PrivacyLevel = "basic" | "strict";

export interface PrivacyControls {
  phone: boolean;
  idCard: boolean;
  bankCard: boolean;
  email: boolean;
  apiKey: boolean;
  fileAccessAudit: boolean;
}

export function hydratePrivacyControls(
  level: PrivacyLevel,
  saved?: Partial<PrivacyControls>,
): PrivacyControls {
  const defaultEnabled = level === "strict";
  const persisted = level === "strict" ? saved : undefined;
  return {
    phone: persisted?.phone ?? defaultEnabled,
    idCard: persisted?.idCard ?? defaultEnabled,
    bankCard: persisted?.bankCard ?? defaultEnabled,
    email: persisted?.email ?? defaultEnabled,
    apiKey: persisted?.apiKey ?? defaultEnabled,
    fileAccessAudit: persisted?.fileAccessAudit ?? defaultEnabled,
  };
}
