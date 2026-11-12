import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INGRESS_RELEASE_CONTRACT = "microclaw.windows-ingress-release.v1";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`MXC WeChat policy is missing ${name}`);
  return value;
}

function currentLivePolicy(): { policyFingerprint: string; policyJson: string } | null {
  if (!process.env.MICROCLAW_MXC_LIVE_POLICY_PATH) return null;
  const reader: unknown = Reflect.get(
    globalThis, Symbol.for("microclaw.windows-node-mxc.live-policy.v1"),
  );
  if (typeof reader !== "function")
    throw new Error("The authenticated MXC live policy reader is unavailable");
  const value: unknown = reader();
  if (!value || typeof value !== "object"
      || !("gatewayGeneration" in value)
      || value.gatewayGeneration !== requiredEnvironment("MICROCLAW_MXC_APPROVAL_PROOF_GATEWAY_GENERATION")
      || !("policyFingerprint" in value) || typeof value.policyFingerprint !== "string"
      || !("policyJson" in value) || typeof value.policyJson !== "string")
    throw new Error("The live policy does not match the Gateway generation");
  return { policyFingerprint: value.policyFingerprint, policyJson: value.policyJson };
}

export function isMxcManagedWeixin(): boolean {
  if (process.env.MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT !== "1") return false;
  try {
    const livePolicy = currentLivePolicy();
    if (!livePolicy) return true;
    const policy: unknown = JSON.parse(livePolicy.policyJson);
    return !(
      policy &&
      typeof policy === "object" &&
      !Array.isArray(policy) &&
      "requestedStrength" in policy &&
      policy.requestedStrength === "off" &&
      "effectiveTier" in policy &&
      policy.effectiveTier === "host"
    );
  } catch {
    return true;
  }
}

export function isMxcWeixinIngressReleased(): boolean {
  if (process.env.MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT !== "1") return true;
  try {
    const releasePath = requiredEnvironment("MICROCLAW_MXC_INGRESS_RELEASE_PATH");
    const record = JSON.parse(fs.readFileSync(releasePath, "utf8")) as Record<string, unknown>;
    return (
      record.contract === INGRESS_RELEASE_CONTRACT &&
      record.gatewayGeneration ===
        requiredEnvironment("MICROCLAW_MXC_APPROVAL_PROOF_GATEWAY_GENERATION") &&
      record.policyFingerprint === (currentLivePolicy()?.policyFingerprint ??
        requiredEnvironment("MICROCLAW_MXC_APPROVAL_PROOF_POLICY_FINGERPRINT").toLowerCase()) &&
      record.token === requiredEnvironment("MICROCLAW_MXC_INGRESS_RELEASE_TOKEN")
    );
  } catch {
    return false;
  }
}

export function assertMxcWeixinIngressReleased(): void {
  if (!isMxcWeixinIngressReleased()) {
    throw new Error("WeChat delivery is paused until the current MXC generation is active");
  }
}

export function isWeixinSenderAllowedByPolicy(senderId: string, allowFrom: string[]): boolean {
  return allowFrom.includes(senderId);
}

export async function waitForMxcWeixinIngressRelease(
  signal?: AbortSignal,
  intervalMs = 1000,
): Promise<void> {
  while (!isMxcWeixinIngressReleased()) {
    if (signal?.aborted) throw new Error("aborted");
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, intervalMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export function resolveWeixinLocalMediaPath(mediaUrl: string): string {
  if (mediaUrl.startsWith("file://")) return fileURLToPath(mediaUrl);
  return path.resolve(mediaUrl);
}
