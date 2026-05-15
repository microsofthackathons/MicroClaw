/**
 * Ed25519 device identity for gateway authentication.
 *
 * Generates and persists an Ed25519 key pair used to sign connect handshake
 * payloads, mirroring the browser Control UI's device-auth protocol.
 * Keys are stored in the OpenClaw state directory.
 */

import { createHash, createPrivateKey, generateKeyPairSync, sign } from "crypto";
import fs from "fs";
import path from "path";
import { getOpenClawStateDir } from "./path-resolver";

export type DeviceIdentity = {
  deviceId: string;
  publicKey: string; // base64url-encoded raw 32-byte Ed25519 public key
  privateKey: string; // base64url-encoded raw 32-byte Ed25519 private key seed
};

const IDENTITY_FILE = "device-identity.json";

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function base64UrlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function fingerprintPublicKey(rawPub: Buffer): string {
  return createHash("sha256").update(rawPub).digest("hex");
}

function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  // Extract raw 32-byte keys from DER-encoded SPKI/PKCS8
  // Ed25519 SPKI = 12-byte header + 32-byte key
  const rawPub = (publicKey as Buffer).subarray(-32);
  // Ed25519 PKCS8 = 16-byte header + 32-byte seed
  const rawPriv = (privateKey as Buffer).subarray(-32);
  const deviceId = fingerprintPublicKey(rawPub);

  return {
    deviceId,
    publicKey: base64UrlEncode(rawPub),
    privateKey: base64UrlEncode(rawPriv),
  };
}

export function loadOrCreateDeviceIdentity(): DeviceIdentity {
  const dir = getOpenClawStateDir();
  const filePath = path.join(dir, IDENTITY_FILE);

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      parsed?.version === 1 &&
      typeof parsed.deviceId === "string" &&
      typeof parsed.publicKey === "string" &&
      typeof parsed.privateKey === "string"
    ) {
      // Verify deviceId matches public key
      const derivedId = fingerprintPublicKey(base64UrlDecode(parsed.publicKey));
      return {
        deviceId: derivedId,
        publicKey: parsed.publicKey,
        privateKey: parsed.privateKey,
      };
    }
  } catch {
    // fall through to regenerate
  }

  const identity = generateIdentity();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      privateKey: identity.privateKey,
      createdAtMs: Date.now(),
    }),
    "utf-8",
  );
  return identity;
}

export function signDevicePayload(privateKeyBase64Url: string, payload: string): string {
  const rawSeed = base64UrlDecode(privateKeyBase64Url);
  // Reconstruct PKCS8 DER for Ed25519 from raw 32-byte seed
  const pkcs8Header = Buffer.from("302e020100300506032b657004220420", "hex");
  const pkcs8 = Buffer.concat([pkcs8Header, rawSeed]);
  const keyObj = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const sig = sign(null, Buffer.from(payload, "utf-8"), keyObj);
  return base64UrlEncode(sig);
}

export function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce: string;
}): string {
  return [
    "v2",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
  ].join("|");
}
