import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { BundledWindowsNodeFolder } from "./bundled-windows-node-host";

export const WINDOWS_NODE_MXC_INGRESS_RELEASE_CONTRACT =
  "microclaw.windows-ingress-release.v1";
export const WINDOWS_NODE_MXC_WEIXIN_MEDIA_POLICY_CONTRACT =
  "microclaw.windows-weixin-media.v1";

export interface WindowsNodeMxcWeixinContext {
  gatewayGeneration: string;
  policyFingerprint: string;
  releasePath: string;
  releaseToken: string;
  inboundRoot: string;
  outboundTempRoot: string;
  mediaPolicyBase64: string;
}

export function resolveWindowsNodeMxcWeixinMediaRoots(userDataPath: string): {
  inboundRoot: string;
  outboundTempRoot: string;
} {
  const mediaRoot = path.join(userDataPath, "mxc-weixin-media");
  return {
    inboundRoot: path.join(mediaRoot, "inbound"),
    outboundTempRoot: path.join(mediaRoot, "outbound-temp"),
  };
}

export function prepareWindowsNodeMxcWeixinContext(
  userDataPath: string,
  gatewayGeneration: string,
  policyFingerprint: string,
  folders: BundledWindowsNodeFolder[],
): WindowsNodeMxcWeixinContext {
  if (!gatewayGeneration.trim()) throw new Error("Gateway generation is required");
  if (!/^[a-f0-9]{64}$/i.test(policyFingerprint)) {
    throw new Error("MXC policy fingerprint is invalid");
  }
  const { inboundRoot, outboundTempRoot } =
    resolveWindowsNodeMxcWeixinMediaRoots(userDataPath);
  fs.mkdirSync(inboundRoot, { recursive: true });
  fs.mkdirSync(outboundTempRoot, { recursive: true });
  const releasePath = path.join(userDataPath, "windows-node", "ingress-release.json");
  fs.rmSync(releasePath, { force: true });
  const releaseToken = randomBytes(32).toString("base64url");
  const approvedRoots = [
    ...folders.map((folder) => ({
      path: path.resolve(folder.path),
      access: folder.access,
      purpose: "selected-folder",
    })),
    {
      path: path.resolve(inboundRoot),
      access: "ro" as const,
      purpose: "weixin-inbound",
    },
  ];
  const mediaPolicyBase64 = Buffer.from(
    JSON.stringify({
      contract: WINDOWS_NODE_MXC_WEIXIN_MEDIA_POLICY_CONTRACT,
      gatewayGeneration,
      policyFingerprint: policyFingerprint.toLowerCase(),
      strictNoHostFallback: true,
      approvedRoots,
      inboundRoot: path.resolve(inboundRoot),
      outboundTempRoot: path.resolve(outboundTempRoot),
    }),
    "utf8",
  ).toString("base64");
  return {
    gatewayGeneration,
    policyFingerprint: policyFingerprint.toLowerCase(),
    releasePath,
    releaseToken,
    inboundRoot,
    outboundTempRoot,
    mediaPolicyBase64,
  };
}

export function getWindowsNodeMxcWeixinEnvironment(
  context: WindowsNodeMxcWeixinContext,
): Record<string, string> {
  return {
    MICROCLAW_MXC_INGRESS_RELEASE_PATH: context.releasePath,
    MICROCLAW_MXC_INGRESS_RELEASE_TOKEN: context.releaseToken,
    MICROCLAW_MXC_WEIXIN_MEDIA_POLICY: context.mediaPolicyBase64,
  };
}

export function releaseWindowsNodeMxcWeixinIngress(
  context: WindowsNodeMxcWeixinContext,
): void {
  const record = {
    contract: WINDOWS_NODE_MXC_INGRESS_RELEASE_CONTRACT,
    gatewayGeneration: context.gatewayGeneration,
    policyFingerprint: context.policyFingerprint,
    token: context.releaseToken,
    releasedAtUnixMs: Date.now(),
  };
  fs.mkdirSync(path.dirname(context.releasePath), { recursive: true });
  const temporary = `${context.releasePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, context.releasePath);
}

export function revokeWindowsNodeMxcWeixinIngress(
  context: WindowsNodeMxcWeixinContext | null,
): void {
  if (context) fs.rmSync(context.releasePath, { force: true });
}
