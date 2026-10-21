import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

function readRepositoryFile(...parts: string[]): string {
  return readFileSync(path.resolve(process.cwd(), "..", ...parts), "utf8");
}

describe("Weixin login lifecycle", () => {
  it.each(["ChannelsView.vue", "PluginsView.vue"])(
    "keeps successful QR login on the plugin's in-process channel reload in %s",
    (viewName) => {
      const source = readRepositoryFile("desktop", "renderer", "src", "views", viewName);
      const poll = source.slice(
        source.indexOf("async function pollForLogin()"),
        source.indexOf("async function cancelLogin()"),
      );

      expect(poll).toContain("result.connected");
      expect(poll).not.toContain("gateway.restart");
      expect(poll).not.toContain("restartGatewayAfterLogin");
    },
  );

  it("persists credentials and requests a channel config reload before reporting QR success", () => {
    const source = readRepositoryFile("plugins", "openclaw-weixin", "src", "channel.ts");
    const waitHandler = source.slice(
      source.indexOf("loginWithQrWait: async"),
      source.indexOf("\n    },\n  },", source.indexOf("loginWithQrWait: async")),
    );

    expect(waitHandler).toContain("replaceWeixinAccount");
    expect(waitHandler).toContain("await triggerWeixinChannelReload");
    expect(waitHandler.indexOf("await triggerWeixinChannelReload")).toBeLessThan(
      waitHandler.indexOf("return {"),
    );
  });

  it("uses a managed restart only when the plugin cannot request its hot reload", () => {
    const source = readRepositoryFile("desktop", "src", "main.ts");
    const handler = source.slice(
      source.indexOf('"plugin:weixin:login-qr-wait"'),
      source.indexOf('ipcMain.handle("plugin:weixin:disconnect"'),
    );

    expect(handler).toContain("result.activationReloadRequested === false");
    expect(handler).toContain(
      'restartManagedGateway("Activating Weixin after channel reload failure")',
    );
  });

  it("does not replace the Gateway after an attested successful CLI login", () => {
    const source = readRepositoryFile("desktop", "src", "main.ts");
    const handler = source.slice(
      source.indexOf('ipcMain.handle("plugin:weixin:login"'),
      source.indexOf('ipcMain.handle("plugin:weixin:cancel-login"'),
    );

    expect(handler).toContain('activationOutcome === "reload-failed"');
    expect(handler).toContain("activationOutcome === null");
    expect(handler).toContain("CLI activation completed without Gateway replacement");
    expect(handler).not.toContain('restartManagedGateway("Activating Weixin after login")');
  });

  it("revalidates the exact remote-approval owner after asynchronous security activation", () => {
    const source = readRepositoryFile("desktop", "src", "main.ts");
    const handler = source.slice(
      source.indexOf("async function handleWindowsNodeMxcWeixinRemoteApprovalInbound"),
      source.indexOf(
        "function configureWindowsNodeMxcWeixinRemoteApprovalBroker",
        source.indexOf("async function handleWindowsNodeMxcWeixinRemoteApprovalInbound"),
      ),
    );

    const activation = handler.indexOf("await requireEffectiveWindowsNodeMxc");
    const revalidation = handler.indexOf("const revalidatedConfiguration");
    const resolution = handler.indexOf(
      "windowsNodeMxcWeixinRemoteApprovalBroker.resolveCandidate",
      revalidation,
    );
    expect(activation).toBeGreaterThanOrEqual(0);
    expect(revalidation).toBeGreaterThan(activation);
    expect(resolution).toBeGreaterThan(revalidation);
    expect(handler).toContain("revalidatedConfiguration.owner.accountId !== inbound.accountId");
    expect(handler).toContain("revalidatedConfiguration.owner.userId !== inbound.senderId");
  });
});
