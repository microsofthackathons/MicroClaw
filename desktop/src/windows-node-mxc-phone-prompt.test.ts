import { describe, expect, it } from "vitest";
import { normalizeWindowsNodeMxcGatewayApproval } from "./windows-node-mxc";
import { createPowerShellFilesystemInitialization } from "./windows-node-mxc-powershell-scope";
import { renderWeixinRemoteApprovalPrompt } from "./windows-node-mxc-weixin-remote-approval";
// @ts-expect-error External ESM Windows quoting fixture.
import { windowsCommand } from "../integration/windows-command-fixture.mjs";

const executable = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const root = String.raw`C:\Users\sunt\Desktop`;
const target = `${root}\\phone_approval_fixture`;
const access = [{ access: "rw" as const, path: root }];
const security = {
  gatewayGeneration: "fixture-generation",
  policyFingerprint: "b".repeat(64),
  nodeId: "c".repeat(64),
  activationLeaseHash: "d".repeat(64),
  requestedMode: "limited-dacl" as const,
  effectiveMode: "appcontainer-dacl",
};

function prepared(script: string) {
  const argv = [
    executable,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `powershell -NoProfile -Command "${script}"`,
  ];
  const initialization = createPowerShellFilesystemInitialization(argv, executable, access);
  if (!initialization) throw new Error("Closed literal fixture was not prepared");
  const plan = {
    argv: initialization.finalArgv,
    commandText: windowsCommand(initialization.finalArgv),
    commandPreview: `# [declare-access]rw:${root}[/declare-access]\n${initialization.finalArgv.at(-1)}`,
    cwd: null,
    cwdBinding: "isolated-scratch:v1",
    agentId: "main",
    sessionKey: "agent:main:fixture",
    executablePath: executable,
    executableSha256: "a".repeat(64),
    declaredAccess: access,
    providerInitialization: initialization,
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
  if (!approval) throw new Error("Actual prepared plan was not normalized");
  return { approval, plan };
}

describe("short phone summary of the independently validated actual prepared plan", () => {
  it.each(["ro", "rw"] as const)(
    "renders the literal existence operation with unchanged target, %s grants and no write initialization",
    (grant) => {
      const { approval } = prepared(`New-Item -ItemType Directory -Path '${target}'`);
      const argv = [
        executable,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `powershell -NoProfile -Command "Test-Path '${target}'"`,
      ];
      const declaredAccess = [{ access: grant, path: root }];
      expect(createPowerShellFilesystemInitialization(argv, executable, declaredAccess)).toBeNull();
      const direct = {
        ...approval,
        arguments: argv.slice(1),
        command: windowsCommand(argv),
        providerInitialization: undefined,
        declaredAccess,
      };
      const before = JSON.stringify(direct);
      for (const locale of ["en-US", "zh-CN"] as const) {
        const text = renderWeixinRemoteApprovalPrompt({
          code: "23456789",
          expiresAtUnixMs: Date.parse("2026-10-22T11:30:00Z"),
          requests: [{ approval: direct }],
          security,
          locale,
          allowDurable: false,
        });
        console.info(
          JSON.stringify({
            fixture: `exists-${grant}-${locale}`,
            renderedCharacters: text.length,
            renderedUtf8Bytes: Buffer.byteLength(text),
          }),
        );
        expect(text).toContain(
          locale === "en-US" ? "Check whether path exists" : "检查路径是否存在",
        );
        expect(text).toContain(target);
        expect(text).toContain(executable);
        expect(text).toContain(
          locale === "en-US"
            ? grant === "ro"
              ? "read-only"
              : "read/write"
            : grant === "ro"
              ? "只读"
              : "读写",
        );
        expect(text).not.toMatch(/initialization|2:|23456789|Force|Recurse/);
        expect(text.length).toBeLessThanOrEqual(600);
        expect(JSON.stringify(direct)).toBe(before);
        expect(direct.command).toBe(windowsCommand([direct.executable, ...direct.arguments]));
      }
    },
  );

  it.each([
    ["create", `New-Item -ItemType Directory -Path '${target}' -Force`],
    ["delete", `Remove-Item -Path '${target}' -Recurse -Force`],
  ])(
    "measures actual initialized %s rendering with available choices first",
    (operation, script) => {
      const { approval, plan } = prepared(script);
      const before = JSON.stringify(approval);
      const text = renderWeixinRemoteApprovalPrompt({
        code: "23456789",
        expiresAtUnixMs: Date.parse("2026-10-22T11:30:00Z"),
        requests: [{ approval }],
        security,
        locale: "en-US",
        allowDurable: false,
      });
      console.info(
        JSON.stringify({
          fixture: operation,
          renderedCharacters: text.length,
          renderedUtf8Bytes: Buffer.byteLength(text),
          firstChoiceOffset: text.indexOf("Reply 1:"),
          denyChoiceOffset: text.indexOf("3: deny"),
        }),
      );
      expect(text.length).toBeLessThanOrEqual(600);
      expect(text.indexOf("Reply 1:")).toBeGreaterThan(0);
      expect(text.indexOf("Reply 1:")).toBeLessThan(120);
      expect(text.indexOf("3: deny")).toBeGreaterThan(0);
      expect(text.indexOf("3: deny")).toBeLessThan(160);
      expect(text).toContain(target);
      expect(text).toContain(root);
      expect(text).toMatch(/read\/write/i);
      expect(text).toMatch(/force/i);
      if (operation === "delete") expect(text).toMatch(/recursive|all children/i);
      expect(text).toMatch(/scoped.*initialization/i);
      expect(text).toMatch(/Desktop/);
      expect(text).toContain(executable);
      expect(text).not.toContain("23456789");
      expect(text).not.toContain("2:");
      expect(text).not.toMatch(/off and|enable again|JSON fragments|Args:|SHA-256/);
      expect(text).not.toContain(approval.command);
      expect(text).not.toContain(approval.sessionKey);
      expect(JSON.stringify(approval)).toBe(before);
      expect(windowsCommand([approval.executable, ...approval.arguments])).toBe(plan.commandText);
      expect(approval.command).toBe(plan.commandText);
      expect(approval.providerInitialization).toEqual(plan.providerInitialization);
    },
  );

  it.each(["en-US", "zh-CN"] as const)(
    "retains executable identity, every grant and every content effect (%s)",
    (locale) => {
      const { approval } = prepared(`New-Item -ItemType Directory -Path '${target}' -Force`);
      const customExecutable = String.raw`C:\custom\powershell.exe`;
      const argv = [
        customExecutable,
        "-NoProfile",
        "-Command",
        `Set-Content -LiteralPath '${target}' -Value '' -Encoding Unicode -NoNewline -Force`,
      ];
      const direct = {
        ...approval,
        executable: customExecutable,
        executablePath: customExecutable,
        arguments: argv.slice(1),
        command: windowsCommand(argv),
        providerInitialization: undefined,
        declaredAccess: [...access, { access: "ro" as const, path: String.raw`C:\ApprovedRead` }],
      };
      const before = JSON.stringify(direct);
      const text = renderWeixinRemoteApprovalPrompt({
        code: "23456789",
        expiresAtUnixMs: 123_000,
        requests: [{ approval: direct }],
        security,
        locale,
        allowDurable: true,
      });
      expect(text).toContain(customExecutable);
      expect(text).toContain(target);
      expect(text).toContain(root);
      expect(text).toContain(String.raw`C:\ApprovedRead`);
      expect(text).toContain('""');
      expect(text).toContain("Unicode");
      expect(text).toContain("Force");
      expect(text).toMatch(locale === "en-US" ? /No added newline/ : /不添加换行/);
      expect(text).toMatch(locale === "en-US" ? /read-only/ : /只读/);
      expect(text).toMatch(locale === "en-US" ? /read\/write/ : /读写/);
      expect(JSON.stringify(direct)).toBe(before);
    },
  );

  it.each([
    ["New-Item -ItemType File -Path", "-Value '0' -Force", /Create file/, /overwrite/],
    ["Clear-Content -LiteralPath", "-Force", /Clear file content/, /Force/],
    ["Add-Content -Path", "-Value '1' -NoNewline", /Append file content/, /No added newline/],
  ] as const)(
    "discloses the closed operation and its effects: %s",
    (operation, flags, action, effect) => {
      const { approval } = prepared(`New-Item -ItemType Directory -Path '${target}'`);
      const argv = [executable, "-NoProfile", "-Command", `${operation} '${target}' ${flags}`];
      const direct = {
        ...approval,
        arguments: argv.slice(1),
        command: windowsCommand(argv),
        providerInitialization: undefined,
      };
      const text = renderWeixinRemoteApprovalPrompt({
        code: "23456789",
        expiresAtUnixMs: 123_000,
        requests: [{ approval: direct }],
        security,
        locale: "en-US",
      });
      expect(text).toMatch(action);
      expect(text).toMatch(effect);
      expect(text).toContain(target);
    },
  );
});
