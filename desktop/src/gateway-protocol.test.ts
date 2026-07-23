import { describe, expect, it } from "vitest";
import {
  buildGatewayConnectParams,
  GATEWAY_MAX_PROTOCOL_VERSION,
  GATEWAY_MIN_PROTOCOL_VERSION,
} from "./gateway-protocol";

describe("buildGatewayConnectParams", () => {
  it("offers v3-v4 compatibility and preserves signed device fields", () => {
    expect(
      buildGatewayConnectParams({
        token: "token",
        platform: "win32",
        deviceId: "device",
        publicKey: "public",
        signature: "signature",
        signedAt: 123,
        nonce: "nonce",
      }),
    ).toEqual({
      minProtocol: 3,
      maxProtocol: 4,
      client: {
        id: "gateway-client",
        version: "1.0.0",
        platform: "win32",
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      device: {
        id: "device",
        publicKey: "public",
        signature: "signature",
        signedAt: 123,
        nonce: "nonce",
      },
      caps: ["tool-events"],
      auth: { token: "token" },
    });
    expect(GATEWAY_MIN_PROTOCOL_VERSION).toBe(3);
    expect(GATEWAY_MAX_PROTOCOL_VERSION).toBe(4);
  });

  it("omits auth when no token is configured", () => {
    const params = buildGatewayConnectParams({
      token: "",
      platform: "win32",
      deviceId: "device",
      publicKey: "public",
      signature: "signature",
      signedAt: 123,
      nonce: "nonce",
    });

    expect(params).not.toHaveProperty("auth");
  });
});
