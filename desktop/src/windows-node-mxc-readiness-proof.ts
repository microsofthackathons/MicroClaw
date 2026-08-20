import { createHash, createHmac, randomUUID } from "node:crypto";

export const WINDOWS_NODE_MXC_READINESS_PROOF_CONTRACT = "microclaw.windows-node-readiness.v1";
export const WINDOWS_NODE_MXC_READINESS_COMMAND = "system.run.readiness";
export const WINDOWS_NODE_MXC_READINESS_AGENT_ID = "__microclaw_mxc_readiness__";
export const WINDOWS_NODE_MXC_READINESS_PROOF_TTL_MS = 15_000;
export const WINDOWS_NODE_MXC_APPROVAL_PLAN_CONTRACT = "microclaw.windows-node-approval-plan.v2";
export const WINDOWS_NODE_MXC_SCRATCH_BINDING = "isolated-scratch:v1";

export type WindowsNodeMxcReadinessProbeKind = "hostname" | "powershell";

export const WINDOWS_NODE_MXC_READINESS_PROBES: Record<
  WindowsNodeMxcReadinessProbeKind,
  readonly string[]
> = {
  hostname: [
    "C:\\Windows\\System32\\cmd.exe",
    "/d",
    "/s",
    "/c",
    "C:\\Windows\\System32\\hostname.exe && echo MICROCLAW_MXC_HOSTNAME_OK",
  ],
  powershell: [
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[Console]::Out.Write('MICROCLAW_MXC_POWERSHELL_OK')",
  ],
};

export interface WindowsNodeMxcReadinessPlan {
  argv: string[];
  cwd: string | null;
  commandText: string;
  commandPreview: string | null;
  agentId: string | null;
  sessionKey: string;
  executablePath: string;
  executableSha256: string;
  cwdBinding: string;
  declaredAccess: Array<{ access: "ro" | "rw"; path: string }>;
}

export interface WindowsNodeMxcReadinessProof {
  contract: typeof WINDOWS_NODE_MXC_READINESS_PROOF_CONTRACT;
  transitionId: string;
  nonce: string;
  gatewayGeneration: string;
  policyFingerprint: string;
  nodeId: string;
  probeKind: WindowsNodeMxcReadinessProbeKind;
  planSha256: string;
  issuedAtUnixMs: number;
  expiresAtUnixMs: number;
  signature: string;
}

export interface WindowsNodeMxcReadinessProofContext {
  secretBase64: string;
  gatewayGeneration: string;
  policyFingerprint: string;
  nodeId: string;
  readinessTransitionId: string;
}

function encodeField(name: string, value: string): string {
  return `${name}=${Buffer.byteLength(value, "utf8")}:${value}`;
}

function encodeNullableField(name: string, value: string | null): string {
  return value === null ? `${name}=-1:` : encodeField(name, value);
}

function requireUuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`MicroClaw readiness proof ${label} is invalid`);
  }
  return value.toLowerCase();
}

function requireSha256(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`MicroClaw readiness proof ${label} is invalid`);
  }
  return value.toLowerCase();
}

function probeSessionKey(transitionId: string): string {
  return `microclaw:readiness:${transitionId}`;
}

function assertExactProbePlan(
  transitionId: string,
  probeKind: WindowsNodeMxcReadinessProbeKind,
  plan: WindowsNodeMxcReadinessPlan,
): void {
  const expected = WINDOWS_NODE_MXC_READINESS_PROBES[probeKind];
  if (
    !plan ||
    !Array.isArray(plan.argv) ||
    plan.argv.length !== expected.length ||
    !plan.argv.every((value, index) =>
      index === 0
        ? value.toLowerCase() === expected[index].toLowerCase()
        : value === expected[index],
    ) ||
    plan.cwd !== null ||
    plan.agentId !== WINDOWS_NODE_MXC_READINESS_AGENT_ID ||
    plan.sessionKey !== probeSessionKey(transitionId) ||
    plan.cwdBinding !== WINDOWS_NODE_MXC_SCRATCH_BINDING ||
    !Array.isArray(plan.declaredAccess) ||
    plan.declaredAccess.length !== 0 ||
    plan.commandPreview !== null ||
    typeof plan.commandText !== "string" ||
    plan.commandText.length === 0 ||
    plan.executablePath.toLowerCase() !== expected[0].toLowerCase()
  ) {
    throw new Error("MicroClaw readiness proof plan is not an exact built-in probe");
  }
  requireSha256(plan.executableSha256, "executable hash");
}

export function computeWindowsNodeMxcReadinessPlanSha256(
  plan: WindowsNodeMxcReadinessPlan,
): string {
  const declaredAccess = [...plan.declaredAccess].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const fields = [
    WINDOWS_NODE_MXC_APPROVAL_PLAN_CONTRACT,
    `argv=${plan.argv.length}`,
    ...plan.argv.map((argument) => encodeField("arg", argument)),
    encodeNullableField("cwd", plan.cwd),
    encodeField("commandText", plan.commandText),
    encodeNullableField("commandPreview", plan.commandPreview),
    encodeNullableField("agentId", plan.agentId),
    encodeField("sessionKey", plan.sessionKey),
    encodeField("executablePath", plan.executablePath),
    encodeField("executableSha256", plan.executableSha256.toLowerCase()),
    encodeField("cwdBinding", plan.cwdBinding),
    `declaredAccess=${declaredAccess.length}`,
    ...declaredAccess.flatMap((entry) => [
      encodeField("access", entry.access),
      encodeField("path", entry.path),
    ]),
  ];
  return createHash("sha256").update(fields.join("\n"), "utf8").digest("hex");
}

export function computeWindowsNodeMxcReadinessProofSignature(
  secret: Buffer,
  proof: Omit<WindowsNodeMxcReadinessProof, "signature">,
): string {
  const fields = [
    WINDOWS_NODE_MXC_READINESS_PROOF_CONTRACT,
    encodeField("transitionId", proof.transitionId),
    encodeField("nonce", proof.nonce),
    encodeField("gatewayGeneration", proof.gatewayGeneration),
    encodeField("policyFingerprint", proof.policyFingerprint.toLowerCase()),
    encodeField("nodeId", proof.nodeId.toLowerCase()),
    encodeField("probeKind", proof.probeKind),
    encodeField("planSha256", proof.planSha256.toLowerCase()),
    `issuedAtUnixMs=${proof.issuedAtUnixMs}`,
    `expiresAtUnixMs=${proof.expiresAtUnixMs}`,
  ];
  return createHmac("sha256", secret).update(fields.join("\n"), "utf8").digest("hex");
}

export function createWindowsNodeMxcReadinessProofMinter(
  context: WindowsNodeMxcReadinessProofContext,
  dependencies: { now?: () => number; randomUUID?: () => string } = {},
): {
  mint(input: {
    transitionId: string;
    nodeId: string;
    probeKind: WindowsNodeMxcReadinessProbeKind;
    plan: WindowsNodeMxcReadinessPlan;
  }): WindowsNodeMxcReadinessProof;
} {
  const secret = Buffer.from(context.secretBase64 ?? "", "base64");
  if (secret.length !== 32 || secret.toString("base64") !== context.secretBase64) {
    throw new Error("MicroClaw readiness proof secret must contain exactly 256 bits");
  }
  const transitionId = requireUuid(context.readinessTransitionId, "transition");
  if (!context.gatewayGeneration) {
    throw new Error("MicroClaw readiness proof Gateway generation is invalid");
  }
  const policyFingerprint = requireSha256(context.policyFingerprint, "policy fingerprint");
  const nodeId = requireSha256(context.nodeId, "node identity");
  const now = dependencies.now ?? Date.now;
  const createNonce = dependencies.randomUUID ?? randomUUID;

  return Object.freeze({
    mint(input) {
      if (
        requireUuid(input.transitionId, "transition") !== transitionId ||
        requireSha256(input.nodeId, "node identity") !== nodeId ||
        !Object.hasOwn(WINDOWS_NODE_MXC_READINESS_PROBES, input.probeKind)
      ) {
        throw new Error("MicroClaw readiness proof request is outside the current transition");
      }
      assertExactProbePlan(transitionId, input.probeKind, input.plan);
      const issuedAtUnixMs = Math.floor(now());
      const unsigned = {
        contract: WINDOWS_NODE_MXC_READINESS_PROOF_CONTRACT,
        transitionId,
        nonce: requireUuid(createNonce(), "nonce"),
        gatewayGeneration: context.gatewayGeneration,
        policyFingerprint,
        nodeId,
        probeKind: input.probeKind,
        planSha256: computeWindowsNodeMxcReadinessPlanSha256(input.plan),
        issuedAtUnixMs,
        expiresAtUnixMs: issuedAtUnixMs + WINDOWS_NODE_MXC_READINESS_PROOF_TTL_MS,
      } satisfies Omit<WindowsNodeMxcReadinessProof, "signature">;
      return {
        ...unsigned,
        signature: computeWindowsNodeMxcReadinessProofSignature(secret, unsigned),
      };
    },
  });
}

export function windowsNodeMxcReadinessSessionKey(transitionId: string): string {
  return probeSessionKey(requireUuid(transitionId, "transition"));
}
