import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

export const WINDOWS_NODE_MXC_LIVE_POLICY_CONTRACT = "microclaw.windows-node-live-policy.v1";

export interface LivePolicyApproval {
  approvalId: string;
  planSha256: string;
  expiresAtUnixMs: number;
}

export interface WindowsNodeMxcLivePolicyPayload {
  contract: typeof WINDOWS_NODE_MXC_LIVE_POLICY_CONTRACT;
  gatewayGeneration: string;
  revision: number;
  policyFingerprint: string;
  policyJson: string;
  approval: LivePolicyApproval | null;
}

export interface WindowsNodeMxcSignedPolicy {
  payload: string;
  signature: string;
}

export class WindowsNodeMxcPolicyAuthority {
  readonly publicKey: string;
  private readonly privateKey: KeyObject;
  private revision = 0;

  constructor(readonly gatewayGeneration: string) {
    if (!gatewayGeneration) throw new Error("Live policy requires a Gateway generation");
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    this.privateKey = keys.privateKey;
    this.publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  }

  issue(
    policyJson: string,
    approval: LivePolicyApproval | null = null,
  ): { envelope: WindowsNodeMxcSignedPolicy; policy: WindowsNodeMxcLivePolicyPayload } {
    if (
      approval &&
      (!approval.approvalId ||
        !/^[a-f0-9]{64}$/i.test(approval.planSha256) ||
        !Number.isSafeInteger(approval.expiresAtUnixMs) ||
        approval.expiresAtUnixMs <= Date.now())
    ) {
      throw new Error("Live policy approval binding is invalid or expired");
    }
    const policy: WindowsNodeMxcLivePolicyPayload = {
      contract: WINDOWS_NODE_MXC_LIVE_POLICY_CONTRACT,
      gatewayGeneration: this.gatewayGeneration,
      revision: ++this.revision,
      policyFingerprint: createHash("sha256").update(policyJson, "utf8").digest("hex"),
      policyJson,
      approval,
    };
    const payload = JSON.stringify(policy);
    return {
      policy,
      envelope: {
        payload,
        signature: sign("sha256", Buffer.from(payload, "utf8"), {
          key: this.privateKey,
          dsaEncoding: "ieee-p1363",
        }).toString("base64"),
      },
    };
  }
}
