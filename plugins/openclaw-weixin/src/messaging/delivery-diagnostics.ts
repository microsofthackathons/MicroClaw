export interface WeixinDeliveryDiagnostic {
  code:
    | "context-unavailable"
    | "owner-changed"
    | "http-rejected"
    | "request-timeout"
    | "request-failed"
    | "provider-response-invalid"
    | "provider-rejected"
    | "provider-accepted";
  providerClientHash?: string;
  httpStatus?: number;
  providerRet?: number;
}

export const WEIXIN_DELIVERY_DIAGNOSTIC_CONTRACT = "microclaw.weixin-delivery-diagnostic.v1";
export type WeixinDeliveryKind =
  | "prompt" | "fallback" | "terminal" | "reminder" | "acknowledgement" | "notification";
export function isWeixinDeliveryKind(value: unknown): value is WeixinDeliveryKind {
  return value === "prompt" || value === "fallback" || value === "terminal" ||
    value === "reminder" || value === "acknowledgement" || value === "notification";
}

export interface WeixinDeliveryMetadata extends WeixinDeliveryDiagnostic {
  contract: typeof WEIXIN_DELIVERY_DIAGNOSTIC_CONTRACT;
  stage: "provider";
  kind: WeixinDeliveryKind;
  deliveryHash?: string;
  challengeHash?: string;
  inboundHash?: string;
}

export class WeixinMessageDeliveryError extends Error {
  constructor(readonly diagnostic: WeixinDeliveryDiagnostic) {
    super("WeChat message delivery is unconfirmed");
    this.name = "WeixinMessageDeliveryError";
  }
}
