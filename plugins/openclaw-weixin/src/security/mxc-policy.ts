import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INGRESS_RELEASE_CONTRACT = "microclaw.windows-ingress-release.v1";
const MEDIA_POLICY_CONTRACT = "microclaw.windows-weixin-media.v1";

type MediaRoot = {
  path: string;
  access: "ro" | "rw";
  purpose: "selected-folder" | "weixin-inbound";
};

type MediaPolicy = {
  contract: typeof MEDIA_POLICY_CONTRACT;
  gatewayGeneration: string;
  policyFingerprint: string;
  strictNoHostFallback: true;
  approvedRoots: MediaRoot[];
  inboundRoot: string;
  outboundTempRoot: string;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`MXC WeChat policy is missing ${name}`);
  return value;
}

export function isMxcManagedWeixin(): boolean {
  return process.env.MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT === "1";
}

export function isMxcWeixinIngressReleased(): boolean {
  if (!isMxcManagedWeixin()) return true;
  try {
    const releasePath = requiredEnvironment("MICROCLAW_MXC_INGRESS_RELEASE_PATH");
    const record = JSON.parse(fs.readFileSync(releasePath, "utf8")) as Record<string, unknown>;
    return (
      record.contract === INGRESS_RELEASE_CONTRACT &&
      record.gatewayGeneration ===
        requiredEnvironment("MICROCLAW_MXC_APPROVAL_PROOF_GATEWAY_GENERATION") &&
      record.policyFingerprint ===
        requiredEnvironment("MICROCLAW_MXC_APPROVAL_PROOF_POLICY_FINGERPRINT").toLowerCase() &&
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

export function hasMxcWeixinMediaPolicy(): boolean {
  return isMxcManagedWeixin();
}

function loadMediaPolicy(): MediaPolicy {
  const encoded = requiredEnvironment("MICROCLAW_MXC_WEIXIN_MEDIA_POLICY");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    throw new Error("MXC WeChat media policy is malformed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MXC WeChat media policy is invalid");
  }
  const policy = parsed as Partial<MediaPolicy>;
  const generation = requiredEnvironment("MICROCLAW_MXC_APPROVAL_PROOF_GATEWAY_GENERATION");
  const fingerprint = requiredEnvironment(
    "MICROCLAW_MXC_APPROVAL_PROOF_POLICY_FINGERPRINT",
  ).toLowerCase();
  if (
    policy.contract !== MEDIA_POLICY_CONTRACT ||
    policy.gatewayGeneration !== generation ||
    policy.policyFingerprint !== fingerprint ||
    policy.strictNoHostFallback !== true ||
    !Array.isArray(policy.approvedRoots) ||
    typeof policy.inboundRoot !== "string" ||
    typeof policy.outboundTempRoot !== "string"
  ) {
    throw new Error("MXC WeChat media policy does not match the active generation");
  }
  const approvedRoots = policy.approvedRoots.map((entry) => {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !path.isAbsolute(entry.path) ||
      (entry.access !== "ro" && entry.access !== "rw") ||
      (entry.purpose !== "selected-folder" && entry.purpose !== "weixin-inbound")
    ) {
      throw new Error("MXC WeChat media policy contains an invalid root");
    }
    return { ...entry, path: path.resolve(entry.path) };
  });
  if (!path.isAbsolute(policy.inboundRoot) || !path.isAbsolute(policy.outboundTempRoot)) {
    throw new Error("MXC WeChat media staging roots must be absolute");
  }
  return {
    contract: MEDIA_POLICY_CONTRACT,
    gatewayGeneration: generation,
    policyFingerprint: fingerprint,
    strictNoHostFallback: true,
    approvedRoots,
    inboundRoot: path.resolve(policy.inboundRoot),
    outboundTempRoot: path.resolve(policy.outboundTempRoot),
  };
}

export function resolveWeixinOutboundTempRoot(legacyRoot: string): string {
  if (!hasMxcWeixinMediaPolicy()) return legacyRoot;
  const policy = loadMediaPolicy();
  fs.mkdirSync(policy.outboundTempRoot, { recursive: true });
  assertDirectoryHasNoReparsePoints(policy.outboundTempRoot);
  return policy.outboundTempRoot;
}

export async function stageMxcWeixinInboundMedia(
  buffer: Buffer,
  contentType?: string,
  maxBytes?: number,
  originalFilename?: string,
): Promise<{ path: string }> {
  const policy = loadMediaPolicy();
  if (maxBytes !== undefined && buffer.byteLength > maxBytes) {
    throw new Error(`WeChat inbound media exceeds the ${maxBytes}-byte staging limit`);
  }
  fs.mkdirSync(policy.inboundRoot, { recursive: true });
  assertDirectoryHasNoReparsePoints(policy.inboundRoot);
  const extension = safeExtension(originalFilename, contentType);
  const destination = path.join(policy.inboundRoot, `${randomUUID()}${extension}`);
  await fs.promises.writeFile(destination, buffer, { flag: "wx" });
  const authorized = await authorizeMxcWeixinOutboundMedia(destination);
  return { path: authorized };
}

export function resolveWeixinLocalMediaPath(mediaUrl: string): string {
  if (mediaUrl.startsWith("file://")) return fileURLToPath(mediaUrl);
  return path.resolve(mediaUrl);
}

export async function authorizeMxcWeixinOutboundMedia(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  if (!hasMxcWeixinMediaPolicy()) return resolved;
  const policy = loadMediaPolicy();
  let canonicalFile: string;
  try {
    canonicalFile = await fs.promises.realpath(resolved);
  } catch {
    throw new Error("WeChat media broker rejected an unavailable local file");
  }
  const stat = await fs.promises.stat(canonicalFile);
  if (!stat.isFile()) throw new Error("WeChat media broker accepts regular files only");

  const candidateRoots = [...policy.approvedRoots.map((entry) => entry.path), policy.outboundTempRoot];
  for (const configuredRoot of candidateRoots) {
    const resolvedRoot = path.resolve(configuredRoot);
    if (containsPath(resolvedRoot, resolved)) {
      assertNoReparsePoints(resolvedRoot, resolved);
    }
    let canonicalRoot: string;
    try {
      canonicalRoot = await fs.promises.realpath(resolvedRoot);
    } catch {
      continue;
    }
    if (!containsPath(canonicalRoot, canonicalFile)) continue;
    assertNoReparsePoints(canonicalRoot, canonicalFile);
    return canonicalFile;
  }
  throw new Error(
    "WeChat media broker rejected a file outside selected folders, inbound staging, and broker scratch",
  );
}

function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertDirectoryHasNoReparsePoints(directory: string): void {
  if (fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error("WeChat media broker rejected a reparse-point staging root");
  }
  const canonical = fs.realpathSync(directory);
  assertNoReparsePoints(canonical, canonical);
}

function assertNoReparsePoints(root: string, target: string): void {
  assertPathChainHasNoReparsePoints(root);
  const relative = path.relative(root, target);
  const components = relative ? relative.split(path.sep) : [];
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error("WeChat media broker rejected a reparse-point path");
    }
  }

  function assertPathChainHasNoReparsePoints(target: string): void {
    const parsed = path.parse(target);
    let current = parsed.root;
    const relative = path.relative(parsed.root, target);
    for (const component of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error("WeChat media broker rejected a reparse-point root");
      }
    }
  }
}

function safeExtension(originalFilename?: string, contentType?: string): string {
  const original = originalFilename ? path.extname(path.basename(originalFilename)) : "";
  if (/^\.[a-z0-9]{1,10}$/i.test(original)) return original.toLowerCase();
  const extensions: Record<string, string> = {
    "audio/silk": ".silk",
    "audio/wav": ".wav",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "video/mp4": ".mp4",
  };
  return extensions[contentType ?? ""] ?? ".bin";
}
