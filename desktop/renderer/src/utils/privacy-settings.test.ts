import { describe, expect, it } from "vitest";
import { hydratePrivacyControls, privacyControlsToScanOptions } from "./privacy-settings";

describe("hydratePrivacyControls", () => {
  it("defaults every control off for Basic", () => {
    expect(hydratePrivacyControls("basic")).toEqual({
      phone: false,
      idCard: false,
      bankCard: false,
      email: false,
      apiKey: false,
      fileAccessAudit: false,
    });
  });

  it("defaults every control on for Strict", () => {
    expect(hydratePrivacyControls("strict")).toEqual({
      phone: true,
      idCard: true,
      bankCard: true,
      email: true,
      apiKey: true,
      fileAccessAudit: true,
    });
  });

  it("preserves explicit Strict choices and defaults only missing fields", () => {
    expect(
      hydratePrivacyControls("strict", {
        phone: false,
        email: false,
        fileAccessAudit: false,
      }),
    ).toEqual({
      phone: false,
      idCard: true,
      bankCard: true,
      email: false,
      apiKey: true,
      fileAccessAudit: false,
    });
  });

  it("forces controls off when hydrating Basic", () => {
    expect(hydratePrivacyControls("basic", { phone: true })).toMatchObject({ phone: false });
  });

  it("maps every PII control to typed scanner options", () => {
    expect(
      privacyControlsToScanOptions({
        phone: false,
        idCard: true,
        bankCard: false,
        email: true,
        apiKey: false,
        fileAccessAudit: true,
      }),
    ).toEqual({
      phone: false,
      idCard: true,
      bankCard: false,
      email: true,
      apiKey: false,
    });
  });
});
