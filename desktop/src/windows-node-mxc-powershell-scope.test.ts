import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createPowerShellFilesystemInitialization,
  POWERSHELL_FILESYSTEM_INITIALIZER,
  validatePowerShellFilesystemInitialization,
} from "./windows-node-mxc-powershell-scope";
import { normalizeWindowsNodeMxcGatewayApproval } from "./windows-node-mxc";
import {
  normalizeWeixinRemoteApprovalOwner,
  WindowsNodeMxcWeixinRemoteApprovalBroker,
} from "./windows-node-mxc-weixin-remote-approval";
// @ts-expect-error External ESM SDK fixture.
import { runPinnedApprovalRequests } from "../integration/pinned-approval-fixture.mjs";
// @ts-expect-error External ESM Windows quoting fixture.
import { windowsCommand } from "../integration/windows-command-fixture.mjs";
// @ts-expect-error External ESM approval proof compatibility module.
import { computeWindowsNodeMxcApprovalPlanSha256 } from "./openclaw-approval-replay-compat.mjs";

const executable = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const access = [{ access: "rw" as const, path: String.raw`C:\workspace` }];
const operation = String.raw`Remove-Item -Path 'C:\workspace\folder' -Recurse -Force`;
function original(nested: boolean) {
  return [
    executable,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    nested ? `powershell -NoProfile -Command "${operation}"` : operation,
  ];
}
function preview(payload: string) {
  return `# [declare-access]rw:${access[0].path}[/declare-access]\n${payload}`;
}

describe("exact Limited PowerShell prepared initialization", () => {
  it.each([false, true])(
    "retains original literal bytes and independently regenerates form nested=%s",
    (nested) => {
      const argv = original(nested);
      const initialization = createPowerShellFilesystemInitialization(argv, executable, access);
      if (!initialization) throw new Error("Supported literal operation rejected");
      expect(initialization.originalArgv).toEqual(argv);
      expect(initialization.form).toBe(nested ? "nested" : "direct");
      expect(initialization.finalArgv.slice(0, -1)).toEqual(argv.slice(0, -1));
      expect(initialization.finalArgv.at(-1)).toContain(
        POWERSHELL_FILESYSTEM_INITIALIZER + operation,
      );
      expect(
        validatePowerShellFilesystemInitialization(
          initialization,
          initialization.finalArgv,
          executable,
          access,
          preview(initialization.finalArgv.at(-1)!),
        ),
      ).toEqual(initialization);
      for (const changed of [
        { ...initialization, contract: "unknown" },
        { ...initialization, form: "encoded" },
        { ...initialization, originalArgv: [...argv.slice(0, -1), "Get-Date"] },
        { ...initialization, finalArgv: argv },
        { ...initialization, extra: "unexpected" },
      ])
        expect(
          validatePowerShellFilesystemInitialization(
            changed,
            initialization.finalArgv,
            executable,
            access,
            preview(initialization.finalArgv.at(-1)!),
          ),
        ).toBeNull();
      argv[argv.length - 1] = "changed";
      expect(initialization.originalArgv.at(-1)).not.toBe("changed");
    },
  );
  it.each([
    String.raw`Remove-Item -Path '.\relative'`,
    String.raw`Remove-Item -Path 'C:\workspace\..\outside'`,
    String.raw`Remove-Item -Path 'C:\workspace\*'`,
    String.raw`Remove-Item -Path 'C:\workspace\folder'; Get-Date`,
    String.raw`powershell -NoProfile -EncodedCommand ZmFrZQ==`,
    String.raw`powershell -NoProfile -File C:\workspace\script.ps1`,
    String.raw`pwsh -NoProfile -Command "Remove-Item -Path 'C:\workspace\folder'"`,
    String.raw`New-Item -ItemType File -Path 'C:\workspace\folder'`,
  ])("does not rewrite unsupported form %s", (payload) => {
    expect(
      createPowerShellFilesystemInitialization(
        [...original(false).slice(0, -1), payload],
        executable,
        access,
      ),
    ).toBeNull();
  });
  it.skipIf(!process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR)(
    "preserves initialization through the actual pinned builder/closed handler and exact phone consent",
    () => {
      const initialization = createPowerShellFilesystemInitialization(
        original(true),
        executable,
        access,
      );
      if (!initialization) throw new Error("Supported nested operation rejected");
      const nodeId = "c".repeat(64);
      const peer = "RawCasePeer@im.wechat";
      const plan = {
        argv: initialization.finalArgv,
        commandText: windowsCommand(initialization.finalArgv),
        commandPreview: preview(initialization.finalArgv.at(-1)!),
        cwd: null,
        cwdBinding: "isolated-scratch:v1",
        agentId: "main",
        sessionKey: "agent:main:main",
        executablePath: executable,
        executableSha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
        declaredAccess: access,
        providerInitialization: initialization,
      };
      const captured = runPinnedApprovalRequests(plan, peer, nodeId).find(
        (entry: { kind: string }) => entry.kind === "trusted",
      );
      expect(captured.request.systemRunPlan.providerInitialization).toEqual(initialization);
      const { providerInitialization: _removed, ...withoutInitialization } = plan;
      void _removed;
      for (const invalid of [
        withoutInitialization,
        { ...plan, providerInitialization: null },
        { ...plan, providerInitialization: { contract: initialization.contract } },
        { ...plan, providerInitialization: { ...initialization, form: "encoded" } },
        { ...plan, providerInitialization: { ...initialization, extra: true } },
        {
          ...plan,
          providerInitialization: { ...initialization, finalArgv: initialization.originalArgv },
        },
      ]) {
        const rejected = runPinnedApprovalRequests(invalid, peer, nodeId).find(
          (entry: { kind: string }) => entry.kind === "trusted",
        );
        expect(rejected.request).toBeNull();
        expect(rejected.response).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
      }
      const envelope = { id: "prepared-initialization-test", request: captured.request };
      const approval = normalizeWindowsNodeMxcGatewayApproval(
        envelope,
        nodeId,
        "test-generation",
        "limited-dacl",
      );
      if (!approval) throw new Error("Initialized native plan failed main normalization");
      expect(approval.providerInitialization).toEqual(initialization);
      expect(
        normalizeWindowsNodeMxcGatewayApproval(envelope, nodeId, "test-generation", "full"),
      ).toBeNull();
      const owner = normalizeWeixinRemoteApprovalOwner("bot", peer, "2026-10-20T00:00:00Z");
      const broker = new WindowsNodeMxcWeixinRemoteApprovalBroker(undefined, () => ({
        accountId: "bot",
        userId: peer,
      }));
      broker.configure({ enabled: true, owner });
      const result = broker.createChallengeResult({
        source: {
          accountId: "bot",
          senderId: peer,
          conversationId: peer,
          agentId: "main",
          sessionKey: "agent:main:main",
          gatewayGeneration: "test-generation",
          runIds: [approval.origin!.runId],
          messageId: "1001",
          cursor: "42",
          direct: true,
          forwarded: false,
          quoted: false,
          receivedAtUnixMs: Date.now(),
        },
        requests: [{ approval }],
        expiresAtUnixMs: Date.now() + 60_000,
        locale: "en-US",
        security: {
          gatewayGeneration: "test-generation",
          policyFingerprint: "b".repeat(64),
          nodeId,
          activationLeaseHash: "d".repeat(64),
          requestedMode: "limited-dacl",
          effectiveMode: "appcontainer-dacl",
        },
      });
      expect(result.status).toBe("created");
      if (result.status !== "created")
        throw new Error(`Phone presentation rejected: ${result.reason}`);
      expect(result.delivery.text).toContain("logical $PWD is MicroClawCwd:");
      expect(result.delivery.text).toContain("filesystem initialization failed");
      expect(result.delivery.text).toContain("Remove-Item");
      expect(computeWindowsNodeMxcApprovalPlanSha256(plan)).not.toBe(
        computeWindowsNodeMxcApprovalPlanSha256({
          ...plan,
          providerInitialization: {
            ...initialization,
            originalCommandPreview: initialization.originalCommandPreview + " ",
          },
        }),
      );
    },
    120_000,
  );
});
