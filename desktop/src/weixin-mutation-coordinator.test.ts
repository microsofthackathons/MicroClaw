import { describe, expect, it, vi } from "vitest";
import { WeixinMutationCoordinator } from "./weixin-mutation-coordinator";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("WeChat account mutation versus MXC activation", () => {
  it("wires the actual main active/transition guard before every account mutation and activation", () => {
    const source = readFileSync(path.join(process.cwd(), "src", "main.ts"), "utf8");
    expect(source).toContain(
      "isWindowsNodeMxcDesired() || windowsNodeMxcSecurityTransitionInProgress",
    );
    for (const action of [
      "set-enabled",
      "login",
      "login-qr-start",
      "login-qr-wait",
      "disconnect",
    ]) {
      const start = source.indexOf(`"plugin:weixin:${action}"`);
      const block = source.slice(start, start + 800);
      expect(block).toContain("weixinMutations.run(assertWindowsNodeMxcConfigurationMutable");
    }
    const begin = source.slice(
      source.indexOf("function beginWindowsNodeMxcLifecycleOperation"),
      source.indexOf("function endWindowsNodeMxcLifecycleOperation"),
    );
    expect(begin.indexOf("weixinMutations.assertActivationAvailable")).toBeLessThan(
      begin.indexOf("windowsNodeMxcSecurityTransitionInProgress = true"),
    );
  });

  it.each(["active", "transitioning"])(
    "rejects before writes/spawns/RPC when MXC is %s",
    async () => {
      const coordinator = new WeixinMutationCoordinator();
      const effects = vi.fn().mockResolvedValue(undefined);
      await expect(
        coordinator.run(() => {
          throw new Error("MXC locked");
        }, effects),
      ).rejects.toThrow("MXC locked");
      expect(effects).not.toHaveBeenCalled();
      expect(() => coordinator.assertActivationAvailable(false)).not.toThrow();
    },
  );

  it("acquires the account mutation fence synchronously, before its first await", async () => {
    const coordinator = new WeixinMutationCoordinator();
    let finish!: () => void;
    const operation = coordinator.run(
      () => {},
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    expect(() => coordinator.assertActivationAvailable(false)).toThrow("pending WeChat");
    finish();
    await operation;
    expect(() => coordinator.assertActivationAvailable(false)).not.toThrow();
  });

  it("holds QR ownership between polls, waits for cancellation drain, and refuses stale QR waits", async () => {
    const coordinator = new WeixinMutationCoordinator();
    coordinator.beginQr();
    expect(() => coordinator.assertActivationAvailable(false)).toThrow();
    let finish!: () => void;
    const poll = coordinator.run(
      () => {},
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const cancellation = coordinator.cancelQr();
    expect(() => coordinator.assertActivationAvailable(false)).toThrow();
    await expect(
      coordinator.run(
        () => {},
        async () => {},
      ),
    ).rejects.toThrow("cancellation");
    finish();
    await poll;
    await cancellation;
    expect(() => coordinator.requireQr()).toThrow("No current");
    expect(() => coordinator.assertActivationAvailable(false)).not.toThrow();
  });

  it("does not treat an unknown login outcome or a subsequent status as proof that a writer stopped", async () => {
    const coordinator = new WeixinMutationCoordinator();
    coordinator.beginQr();
    coordinator.qrUnconfirmed();
    coordinator.qrConnected();
    await expect(coordinator.cancelQr()).rejects.toThrow("may still be committing");
    expect(() => coordinator.assertActivationAvailable(false)).toThrow();
    expect(() => coordinator.beginQr()).toThrow("unconfirmed");
    coordinator.gatewayStopped();
    expect(() => coordinator.assertActivationAvailable(false)).not.toThrow();
  });

  it("also fences a running CLI login and releases rejected operations", async () => {
    const coordinator = new WeixinMutationCoordinator();
    expect(() => coordinator.assertActivationAvailable(true)).toThrow();
    await expect(
      coordinator.run(
        () => {},
        async () => {
          throw new Error("failed");
        },
      ),
    ).rejects.toThrow("failed");
    expect(() => coordinator.assertActivationAvailable(false)).not.toThrow();
  });

  it("releases a known negative QR start followed by known failed CLI fallback", async () => {
    const coordinator = new WeixinMutationCoordinator();
    await coordinator.run(
      () => {},
      async () => {
        coordinator.beginQr();
        coordinator.settleKnownQrStart(false);
        return { ok: false, error: "No QR login is available" };
      },
    );
    await coordinator.run(
      () => {},
      async () => {
        coordinator.prepareCliLogin();
        return { ok: false, error: "OpenClaw CLI not found" };
      },
    );
    expect(() => coordinator.requireQr()).toThrow("No current");
    expect(() => coordinator.assertActivationAvailable(false)).not.toThrow();
    await coordinator.cancelQr();
    expect(() => coordinator.assertActivationAvailable(false)).not.toThrow();
  });

  it("requires explicit cancellation before replacing a valid pending QR login with CLI", async () => {
    const coordinator = new WeixinMutationCoordinator();
    coordinator.beginQr();
    coordinator.settleKnownQrStart(true);
    await expect(
      coordinator.run(
        () => {},
        async () => {
          coordinator.prepareCliLogin();
        },
      ),
    ).rejects.toThrow("may still be committing");
    expect(() => coordinator.assertActivationAvailable(false)).toThrow();
    await coordinator.cancelQr();
    await coordinator.run(
      () => {},
      async () => {
        coordinator.prepareCliLogin();
      },
    );
    expect(() => coordinator.assertActivationAvailable(false)).not.toThrow();
  });

  it("keeps an uncertain QR start fenced through failed fallback and cancel until its Gateway stops", async () => {
    const coordinator = new WeixinMutationCoordinator();
    await coordinator.run(
      () => {},
      async () => {
        coordinator.beginQr();
        coordinator.qrUnconfirmed();
      },
    );
    await expect(
      coordinator.run(
        () => {},
        async () => {
          coordinator.prepareCliLogin();
        },
      ),
    ).rejects.toThrow("may still be committing");
    coordinator.settleKnownQrStart(false);
    await expect(coordinator.cancelQr()).rejects.toThrow("may still be committing");
    expect(() => coordinator.assertActivationAvailable(false)).toThrow();
    coordinator.gatewayStopped();
    expect(() => coordinator.assertActivationAvailable(false)).not.toThrow();
  });

  it("does not clear a known failed QR attempt until every possible writer drains", async () => {
    const coordinator = new WeixinMutationCoordinator();
    coordinator.beginQr();
    let finish!: () => void;
    const writer = coordinator.run(
      () => {},
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await coordinator.run(
      () => {},
      async () => {
        coordinator.settleKnownQrStart(false);
        expect(() => coordinator.prepareCliLogin()).toThrow("may still be committing");
      },
    );
    expect(() => coordinator.assertActivationAvailable(false)).toThrow();
    finish();
    await writer;
    expect(() => coordinator.assertActivationAvailable(false)).not.toThrow();
  });

  it("ignores late outcomes from the stopped Gateway without clearing a new QR attempt", () => {
    const coordinator = new WeixinMutationCoordinator();
    const oldEpoch = coordinator.beginQr();
    coordinator.gatewayStopped();
    coordinator.qrUnconfirmed(oldEpoch);
    expect(() => coordinator.assertActivationAvailable(false)).not.toThrow();
    coordinator.beginQr();
    coordinator.settleKnownQrStart(false, oldEpoch);
    coordinator.qrConnected(oldEpoch);
    expect(() => coordinator.assertActivationAvailable(false)).toThrow();
  });
});
