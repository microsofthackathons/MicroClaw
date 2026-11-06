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
const cmd = String.raw`C:\Windows\System32\cmd.exe`;
function original(form: boolean | "cmd") {
  if (form === "cmd") return [cmd, "/d", "/s", "/c", `powershell -Command "${operation}"`];
  return [
    executable,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    form ? `powershell -NoProfile -Command "${operation}"` : operation,
  ];
}
function preview(payload: string) {
  return `# [declare-access]rw:${access[0].path}[/declare-access]\n${payload}`;
}

describe("exact contained PowerShell prepared initialization", () => {
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
  it.each([
    operation,
    String.raw`Move-Item -LiteralPath 'C:\workspace\a.txt' -Destination 'C:\workspace\b.txt' -ErrorAction Stop`,
    String.raw`Rename-Item -Path 'C:\workspace\a.txt' -NewName 'b.txt' -Force`,
  ])("prepares quoted and simple unquoted stock CMD commands: %s", (script) => {
    for (const quoted of [false, true]) {
      const payload = `powershell -Command ${quoted ? `"${script}"` : script}`;
      const argv = [cmd, "/d", "/s", "/c", payload];
      const initialization = createPowerShellFilesystemInitialization(argv, cmd, access);
      expect(initialization).toEqual({
        contract: "microclaw.powershell-filesystem-scope.v1",
        form: "cmd",
        originalArgv: argv,
        originalCommandPreview: preview(payload),
        finalArgv: [
          cmd,
          "/d",
          "/s",
          "/c",
          `powershell -Command "${POWERSHELL_FILESYSTEM_INITIALIZER}${script}"`,
        ],
      });
      if (!initialization) throw new Error("Missing CMD initialization");
      expect(
        validatePowerShellFilesystemInitialization(
          initialization,
          initialization.finalArgv,
          cmd,
          access,
          preview(initialization.finalArgv[4]),
        ),
      ).toEqual(initialization);
      expect(createPowerShellFilesystemInitialization(argv, cmd, [])).toBeNull();
      expect(
        createPowerShellFilesystemInitialization(argv, cmd, [
          { access: "ro", path: access[0].path },
        ]),
      ).toBeNull();
      expect(
        validatePowerShellFilesystemInitialization(
          {
            ...initialization,
            originalArgv: [cmd, "/d", "/s", "/c", "powershell -Command Get-Date"],
          },
          initialization.finalArgv,
          cmd,
          access,
          preview(initialization.finalArgv[4]),
        ),
      ).toBeNull();
    }
  });
  it.each([
    `powershell -Command "${operation}; Get-Date"`,
    `powershell -Command "${operation}" & echo changed`,
    String.raw`powershell -Command "Move-Item -Path 'C:\workspace\a' -Destination 'C:\other\b'"`,
    String.raw`powershell -Command "Rename-Item -Path 'C:\workspace\a' -NewName '..\outside'"`,
    String.raw`powershell -Command Remove-Item -Path "C:\workspace\a"`,
    `powershell -File C:\\workspace\\script.ps1`,
    `powershell -EncodedCommand ZmFrZQ==`,
    `pwsh -Command "${operation}"`,
    `C:\\untrusted\\powershell.exe -Command "${operation}"`,
  ])("leaves unsupported CMD input unchanged: %s", (payload) => {
    expect(
      createPowerShellFilesystemInitialization([cmd, "/d", "/s", "/c", payload], cmd, access),
    ).toBeNull();
  });
  it.skipIf(!process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR).each([true, "cmd"] as const)(
    "preserves initialization through the pinned handler and exact phone consent (form=%s)",
    (form) => {
      const shell = form === "cmd" ? cmd : executable;
      const initialization = createPowerShellFilesystemInitialization(
        original(form),
        shell,
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
        executablePath: shell,
        executableSha256: createHash("sha256").update(readFileSync(shell)).digest("hex"),
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
        expect(rejected.response).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST" },
        });
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
      ).toEqual(expect.objectContaining({ providerInitialization: initialization }));
      const owner = normalizeWeixinRemoteApprovalOwner("bot", peer, "2026-10-20T00:00:00Z");
      const broker = new WindowsNodeMxcWeixinRemoteApprovalBroker(undefined, () => ({
        accountId: "bot",
        userId: peer,
      }));
      broker.configure({
        enabled: true,
        owner,
      });
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
      expect(result.delivery.text.split("\n\n")[1]).toBe(
        `Your agent wants to run the following command:\n${windowsCommand(initialization.originalArgv)}`,
      );
      expect(result.delivery.text).not.toContain("Verified folder initialization");
      expect(result.delivery.text).not.toContain(POWERSHELL_FILESYSTEM_INITIALIZER);
      expect(result.delivery.text).toContain("Remove-Item");
      expect(result.delivery.text).not.toContain("filesystem initialization failed");
      expect(approval.command).toBe(plan.commandText);
      expect(approval.providerInitialization).toEqual(initialization);
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
