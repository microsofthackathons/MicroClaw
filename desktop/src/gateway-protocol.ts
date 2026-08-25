export const GATEWAY_MIN_PROTOCOL_VERSION = 3;
export const GATEWAY_MAX_PROTOCOL_VERSION = 4;
export const GATEWAY_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
] as const;

export type GatewayConnectInput = {
  token: string;
  platform: NodeJS.Platform;
  deviceId: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
};

export function buildGatewayConnectParams(input: GatewayConnectInput): Record<string, unknown> {
  const params: Record<string, unknown> = {
    minProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
    maxProtocol: GATEWAY_MAX_PROTOCOL_VERSION,
    client: {
      id: "gateway-client",
      version: "1.0.0",
      platform: input.platform,
      mode: "backend",
    },
    role: "operator",
    scopes: [...GATEWAY_OPERATOR_SCOPES],
    device: {
      id: input.deviceId,
      publicKey: input.publicKey,
      signature: input.signature,
      signedAt: input.signedAt,
      nonce: input.nonce,
    },
    caps: ["tool-events"],
  };
  if (input.token) params.auth = { token: input.token };
  return params;
}
