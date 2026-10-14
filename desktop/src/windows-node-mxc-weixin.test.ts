import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  getWindowsNodeMxcWeixinEnvironment,
  preflightWindowsNodeMxcWeixinAuthorization,
  prepareWindowsNodeMxcWeixinContext,
  releaseWindowsNodeMxcWeixinIngress,
  revokeWindowsNodeMxcWeixinIngress,
  WINDOWS_NODE_MXC_INGRESS_RELEASE_CONTRACT,
  WINDOWS_NODE_MXC_WEIXIN_MEDIA_POLICY_CONTRACT,
} from "./windows-node-mxc-weixin";

describe("Windows Node MXC WeChat lifecycle", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("binds ingress release and media roots to one Gateway generation and policy", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-weixin-"));
    roots.push(root);
    const selected = path.join(root, "selected");
    fs.mkdirSync(selected);
    const context = prepareWindowsNodeMxcWeixinContext(
      root,
      "generation-1",
      "a".repeat(64),
      [{ path: selected, access: "rw" }],
    );

    expect(fs.existsSync(context.releasePath)).toBe(false);
    const environment = getWindowsNodeMxcWeixinEnvironment(context);
    expect(environment.MICROCLAW_MXC_INGRESS_RELEASE_TOKEN).toBe(context.releaseToken);
    const policy = JSON.parse(
      Buffer.from(environment.MICROCLAW_MXC_WEIXIN_MEDIA_POLICY, "base64").toString("utf8"),
    );
    expect(policy).toMatchObject({
      contract: WINDOWS_NODE_MXC_WEIXIN_MEDIA_POLICY_CONTRACT,
      gatewayGeneration: "generation-1",
      policyFingerprint: "a".repeat(64),
      strictNoHostFallback: true,
      inboundRoot: context.inboundRoot,
      outboundTempRoot: context.outboundTempRoot,
    });
    expect(policy.approvedRoots).toEqual([
      { path: selected, access: "rw", purpose: "selected-folder" },
      { path: context.inboundRoot, access: "ro", purpose: "weixin-inbound" },
    ]);

    releaseWindowsNodeMxcWeixinIngress(context);
    expect(JSON.parse(fs.readFileSync(context.releasePath, "utf8"))).toMatchObject({
      contract: WINDOWS_NODE_MXC_INGRESS_RELEASE_CONTRACT,
      gatewayGeneration: "generation-1",
      policyFingerprint: "a".repeat(64),
      token: context.releaseToken,
    });
    revokeWindowsNodeMxcWeixinIngress(context);
    expect(fs.existsSync(context.releasePath)).toBe(false);
  });

  it("migrates a stored owner id and accepts explicit allowlists for enabled accounts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-weixin-auth-"));
    roots.push(root);
    const accountsDir = path.join(root, "openclaw-weixin", "accounts");
    const credentialsDir = path.join(root, "credentials");
    fs.mkdirSync(accountsDir, { recursive: true });
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.writeFileSync(
      path.join(root, "openclaw-weixin", "accounts.json"),
      JSON.stringify(["owner-im-bot", "paired-im-bot", "disabled-im-bot"]),
    );
    fs.writeFileSync(
      path.join(accountsDir, "owner-im-bot.json"),
      JSON.stringify({ userId: "owner@im.wechat" }),
    );
    fs.writeFileSync(
      path.join(credentialsDir, "openclaw-weixin-paired-im-bot-allowFrom.json"),
      JSON.stringify({ version: 1, allowFrom: ["paired@im.wechat"] }),
    );

    expect(
      preflightWindowsNodeMxcWeixinAuthorization({
        stateDir: root,
        credentialsDir,
        config: {
          plugins: { entries: { "openclaw-weixin": { enabled: true } } },
          channels: {
            "openclaw-weixin": {
              accounts: { "disabled-im-bot": { enabled: false } },
            },
          },
        },
      }),
    ).toEqual({ migratedAccountIds: ["owner-im-bot"] });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(credentialsDir, "openclaw-weixin-owner-im-bot-allowFrom.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ version: 1, allowFrom: ["owner@im.wechat"] });
  });

  it("blocks ingress release when an enabled account has no explicit sender identity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-weixin-auth-"));
    roots.push(root);
    const accountsDir = path.join(root, "openclaw-weixin", "accounts");
    fs.mkdirSync(accountsDir, { recursive: true });
    fs.writeFileSync(
      path.join(root, "openclaw-weixin", "accounts.json"),
      JSON.stringify(["unknown-im-bot"]),
    );
    fs.writeFileSync(
      path.join(accountsDir, "unknown-im-bot.json"),
      JSON.stringify({ token: "token-without-owner" }),
    );

    expect(() =>
      preflightWindowsNodeMxcWeixinAuthorization({
        stateDir: root,
        config: {
          plugins: { entries: { "openclaw-weixin": { enabled: true } } },
        },
      }),
    ).toThrow(/unknown-im-bot/);
  });
});
