import { describe, expect, it } from "vitest";
import { createWindowsNodeMxcApprovalProofMinter } from "../src/openclaw-approval-replay-compat.mjs";
import { normalizeWindowsNodeMxcGatewayApproval } from "../src/windows-node-mxc";
import { runPinnedApprovalRequests } from "./pinned-approval-fixture.mjs";
import { windowsCommand } from "./windows-command-fixture.mjs";

describe.skipIf(!process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR)(
  "pinned Gateway command consent contract",
  () => {
    it.each([
      [{ required: true, allowAlwaysAvailable: true }, "allow-once"],
      [{ required: false, allowAlwaysAvailable: false }, "policy"],
    ])(
      "preserves stock CMD argv and consent preview through the real request handler",
      (preview, decision) => {
        const nodeId = "a".repeat(64);
        const command = String.raw`"C:\Program Files\Example\tool.exe" "A & B"`;
        const argv = [String.raw`C:\Windows\System32\cmd.exe`, "/d", "/s", "/c", command];
        const plan = {
          argv,
          commandText: windowsCommand(argv),
          commandPreview: command,
          cwd: null,
          cwdBinding: "isolated-scratch:v1",
          agentId: "main",
          sessionKey: "agent:main:main",
          executablePath: argv[0],
          executableSha256: "c".repeat(64),
          declaredAccess: [],
          commandConsent: preview,
        };
        const captured = runPinnedApprovalRequests(plan, "owner@im.wechat", nodeId).find(
          (entry) => entry.kind === "trusted",
        );
        expect(captured.request.systemRunPlan.argv).toEqual(argv);
        expect(captured.request.systemRunPlan.commandConsent).toEqual(preview);
        const approval = normalizeWindowsNodeMxcGatewayApproval(
          { id: "consent-wire", request: captured.request },
          nodeId,
          "test-generation",
          "off",
        );
        expect(approval?.commandConsent).toEqual(preview);
        expect(approval.allowedDecisions.includes("allow-always")).toBe(
          preview.allowAlwaysAvailable,
        );
        const minter = createWindowsNodeMxcApprovalProofMinter({
          secretBase64: Buffer.alloc(32, 1).toString("base64"),
          gatewayGeneration: "test-generation",
          policyFingerprint: "b".repeat(64),
          nodeId,
        });
        expect(
          minter.mint({
            approvalId: "consent-wire",
            nodeId,
            plan: captured.request.systemRunPlan,
          }).consentDecision,
        ).toBe(decision);
      },
      60_000,
    );
  },
);
