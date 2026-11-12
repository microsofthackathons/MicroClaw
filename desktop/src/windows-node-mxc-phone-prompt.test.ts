import { describe, expect, it } from "vitest";
import { normalizeWindowsNodeMxcGatewayApproval } from "./windows-node-mxc";
import { createPowerShellFilesystemInitialization } from "./windows-node-mxc-powershell-scope";
import { renderCanonicalWeixinExecPrompt } from "./windows-node-mxc-weixin-exec-presentation";
// @ts-expect-error External ESM Windows quoting fixture.
import { windowsCommand } from "../integration/windows-command-fixture.mjs";

const powershell = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const cmd = String.raw`C:\Windows\System32\cmd.exe`;
const root = String.raw`C:\Approved`;
const target = `${root}\\sample folder`;
const access = [{ access: "rw" as const, path: root }];
const security = {
  gatewayGeneration: "fixture-generation",
  policyFingerprint: "b".repeat(64),
  nodeId: "c".repeat(64),
  activationLeaseHash: "d".repeat(64),
  requestedMode: "full" as const,
  effectiveMode: "base-container",
};

function normalized(argv: string[], executablePath: string, initialize = false) {
  const initialization = initialize
    ? createPowerShellFilesystemInitialization(argv, executablePath, access)
    : null;
  if (initialize && !initialization) throw new Error("Initializer fixture was not prepared");
  const finalArgv = initialization?.finalArgv ?? argv;
  const plan = {
    argv: finalArgv,
    commandText: windowsCommand(finalArgv),
    commandPreview: `# [declare-access]rw:${root}[/declare-access]\n${finalArgv.at(-1)}`,
    cwd: null,
    cwdBinding: "isolated-scratch:v1",
    agentId: "main",
    sessionKey: "agent:main:fixture",
    executablePath,
    executableSha256: "a".repeat(64),
    declaredAccess: access,
    commandConsent: { required: true, allowAlwaysAvailable: true },
    ...(initialization ? { providerInitialization: initialization } : {}),
  };
  const approval = normalizeWindowsNodeMxcGatewayApproval(
    {
      id: "fixture-approval",
      request: { host: "node", nodeId: security.nodeId, systemRunPlan: plan },
    },
    security.nodeId,
    security.gatewayGeneration,
    security.requestedMode,
  );
  if (!approval) throw new Error("Prepared fixture was not normalized");
  return { approval, plan };
}

describe("generic WeChat presentation of the prepared exec plan", () => {
  for (const locale of ["en-US", "zh-CN"] as const) {
    it(`shows only the requested command, choices, and remaining seconds in ${locale}`, () => {
      const { approval } = normalized([cmd, "/d", "/s", "/c", "whoami"], cmd);
      approval.hasMutableFileOperand = true;
      const result = renderCanonicalWeixinExecPrompt({
        approval,
        security,
        code: "23456789",
        expiresAtUnixMs: 123_000,
        nowUnixMs: 1_000,
        locale,
      });
      if (result.status !== "supported") throw new Error("Simple prompt was not supported");
      expect(result.text).toBe(
        (locale === "en-US"
          ? [
              "🛡️ MicroClaw Security Approval",
              "",
              "Your agent wants to run the following command:",
              `${cmd} /d /s /c whoami`,
              "",
              "Reply 1: allow once",
              "3: deny",
              "",
              "Expire in 122 seconds",
            ]
          : [
              "🛡️ MicroClaw 安全审批",
              "",
              "你的智能体希望运行以下命令：",
              `${cmd} /d /s /c whoami`,
              "",
              "回复 1：仅允许一次",
              "3：拒绝",
              "",
              "将在 122 秒后过期",
            ]
        ).join("\n"),
      );
    });

    it(`shows only requested folder grants in a combined approval in ${locale}`, () => {
      const { approval } = normalized([cmd, "/d", "/s", "/c", "whoami"], cmd);
      approval.folderChanges = [
        { path: root, access: "rw" },
        { path: "C:\\Reference", access: "ro" },
      ];
      const result = renderCanonicalWeixinExecPrompt({
        approval,
        security,
        code: "23456789",
        expiresAtUnixMs: 123_000,
        nowUnixMs: 1_000,
        locale,
      });
      if (result.status !== "supported") throw new Error("Combined prompt was not supported");
      expect(result.text).toBe(
        (locale === "en-US"
          ? [
              "🛡️ MicroClaw Security Approval",
              "",
              "Your agent wants to run the following command:",
              `${cmd} /d /s /c whoami`,
              "",
              "Folders to Add or Upgrade:",
              `Read/write: ${root}`,
              "Read-only: C:\\Reference",
              "",
              "Reply 1: allow",
              "3: deny",
              "",
              "Expire in 122 seconds",
            ]
          : [
              "🛡️ MicroClaw 安全审批",
              "",
              "你的智能体希望运行以下命令：",
              `${cmd} /d /s /c whoami`,
              "",
              "要添加或升级的文件夹：",
              `读写： ${root}`,
              "只读： C:\\Reference",
              "",
              "回复 1：允许",
              "3：拒绝",
              "",
              "将在 122 秒后过期",
            ]
        ).join("\n"),
      );
    });
  }

  it("retains coded replies when bare replies are disabled", () => {
    const { approval } = normalized([cmd, "/d", "/s", "/c", "whoami"], cmd);
    const result = renderCanonicalWeixinExecPrompt({
      approval,
      security,
      code: "23456789",
      expiresAtUnixMs: 123_000,
      nowUnixMs: 1_000,
      locale: "en-US",
      bareReplies: false,
    });
    if (result.status !== "supported") throw new Error("Coded prompt was not supported");
    expect(result.text).toContain("Reply 1 23456789: allow once\n3 23456789: deny");
    expect(result.text).not.toMatch(/^2[: ]/m);
  });

  it.each(["en-US", "zh-CN"] as const)(
    "shows an unchanged stock CMD wrapper and complete PowerShell payload in %s",
    (locale) => {
      const payload = `powershell -NoProfile -Command "Test-Path '${target}'"`;
      const argv = [cmd, "/d", "/s", "/c", payload];
      const { approval, plan } = normalized(argv, cmd);
      const before = structuredClone({ approval, plan });
      const result = renderCanonicalWeixinExecPrompt({
        approval,
        security,
        code: "23456789",
        expiresAtUnixMs: 123_000,
        nowUnixMs: 1_000,
        locale,
      });
      expect(result.status).toBe("supported");
      if (result.status !== "supported") throw new Error("CMD prompt was not supported");
      expect(result.text).toContain(cmd);
      expect(result.text).toContain("Test-Path");
      expect(result.text).toContain(target);
      expect(result.text).toMatch(
        locale === "en-US" ? /Reply 1: allow once/ : /回复 1：仅允许一次/,
      );
      expect(result.text).toMatch(locale === "en-US" ? /3: deny/ : /3：拒绝/);
      expect(result.text).not.toMatch(/^(?:Reply |回复 )?2[:：]/m);
      expect(result.text.length).toBeLessThanOrEqual(6000);
      expect([approval.executable, ...approval.arguments]).toEqual(argv);
      expect(approval.command).toBe(plan.commandText);
      expect(approval.providerInitialization).toBeUndefined();
      expect({ approval, plan }).toEqual(before);
    },
  );

  it.each([
    `New-Item -ItemType Directory -Path '${target}' -Force`,
    `Remove-Item -Path '${target}' -Recurse -Force`,
  ])("presents a validated initialization through its original exact command: %s", (script) => {
    const argv = [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
    const { approval, plan } = normalized(argv, powershell, true);
    const before = structuredClone(approval);
    const result = renderCanonicalWeixinExecPrompt({
      approval,
      security,
      code: "23456789",
      expiresAtUnixMs: 123_000,
      nowUnixMs: 1_000,
      locale: "en-US",
    });
    expect(result.status).toBe("supported");
    if (result.status !== "supported") throw new Error("Initialized prompt was not supported");
    expect(result.text).toContain(target);
    expect(result.text).toContain(script.includes("Remove-Item") ? "Remove-Item" : "New-Item");
    expect(result.text).toContain("Force");
    expect(result.text).not.toContain("initialization");
    expect(result.text).not.toContain("microclaw.powershell-filesystem-scope.v1");
    expect(approval.command).toBe(plan.commandText);
    expect(approval.arguments).toEqual(plan.argv.slice(1));
    expect(approval).toEqual(before);
  });

  it.each(["en-US", "zh-CN"] as const)(
    "shows every persistent folder addition and prevents durable command decisions in %s",
    (locale) => {
      const { approval } = normalized([cmd, "/d", "/s", "/c", "dir"], cmd);
      approval.folderChanges = [
        { path: root, access: "rw" },
        { path: "C:\\Reference", access: "ro" },
      ];
      const result = renderCanonicalWeixinExecPrompt({
        approval,
        security,
        code: "23456789",
        expiresAtUnixMs: 123_000,
        nowUnixMs: 1_000,
        locale,
      });
      expect(result.status).toBe("supported");
      if (result.status !== "supported") throw new Error("Folder prompt was not supported");
      expect(result.text).toContain(root);
      expect(result.text).toContain("C:\\Reference");
      expect(result.text).toMatch(locale === "en-US" ? /Read\/write/ : /读写/);
      expect(result.text).toMatch(locale === "en-US" ? /Read-only/ : /只读/);
      expect(result.text).not.toMatch(/until removed in Settings|直到在设置中移除/);
      expect(result.text).not.toMatch(/command runs once|当前命令仅批准一次/);
      expect(result.text).not.toMatch(/^(?:Reply |回复 )?2[:：]/m);
    },
  );
});
