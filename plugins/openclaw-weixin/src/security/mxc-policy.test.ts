import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertMxcWeixinOutboundMediaSource,
  authorizeMxcWeixinOutboundMedia,
  fetchWeixinRemoteMediaWithPolicy,
  hasMxcWeixinMediaPolicy,
  isMxcManagedWeixin,
  isMxcWeixinIngressReleased,
  isWeixinSenderAllowedByPolicy,
  stageMxcWeixinInboundMedia,
  waitForMxcWeixinIngressRelease,
} from "./mxc-policy.js";

describe("MXC WeChat policy", () => {
  const roots: string[] = [];
  const originalEnvironment = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnvironment };
    Reflect.deleteProperty(globalThis, Symbol.for("microclaw.windows-node-mxc.live-policy.v1"));
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function configure() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-mxc-policy-"));
    roots.push(root);
    const selected = path.join(root, "selected");
    const inbound = path.join(root, "inbound");
    const outbound = path.join(root, "outbound");
    fs.mkdirSync(selected);
    fs.mkdirSync(inbound);
    fs.mkdirSync(outbound);
    const generation = "generation-1";
    const fingerprint = "a".repeat(64);
    const token = "release-token";
    const releasePath = path.join(root, "release.json");
    process.env.MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT = "1";
    process.env.MICROCLAW_MXC_APPROVAL_PROOF_GATEWAY_GENERATION = generation;
    process.env.MICROCLAW_MXC_APPROVAL_PROOF_POLICY_FINGERPRINT = fingerprint;
    process.env.MICROCLAW_MXC_INGRESS_RELEASE_PATH = releasePath;
    process.env.MICROCLAW_MXC_INGRESS_RELEASE_TOKEN = token;
    process.env.MICROCLAW_MXC_WEIXIN_MEDIA_POLICY = Buffer.from(
      JSON.stringify({
        contract: "microclaw.windows-weixin-media.v1",
        gatewayGeneration: generation,
        policyFingerprint: fingerprint,
        strictNoHostFallback: true,
        approvedRoots: [
          { path: selected, access: "rw", purpose: "selected-folder" },
          { path: inbound, access: "ro", purpose: "weixin-inbound" },
        ],
        inboundRoot: inbound,
        outboundTempRoot: outbound,
      }),
    ).toString("base64");
    return { root, selected, inbound, outbound, generation, fingerprint, token, releasePath };
  }

  function configureLivePolicy(policyJson: string, gatewayGeneration = "generation-1") {
    process.env.MICROCLAW_MXC_LIVE_POLICY_PATH = "live-policy";
    Reflect.set(globalThis, Symbol.for("microclaw.windows-node-mxc.live-policy.v1"), () => ({
      gatewayGeneration,
      policyFingerprint: "a".repeat(64),
      policyJson,
    }));
  }

  it("keeps host-mode polling and media available with approval compatibility enabled", async () => {
    configure();
    configureLivePolicy(JSON.stringify({ requestedStrength: "off", effectiveTier: "host" }));
    delete process.env.MICROCLAW_MXC_INGRESS_RELEASE_PATH;
    delete process.env.MICROCLAW_MXC_INGRESS_RELEASE_TOKEN;
    delete process.env.MICROCLAW_MXC_WEIXIN_MEDIA_POLICY;
    const response = new Response("image");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);

    expect(isMxcManagedWeixin()).toBe(false);
    expect(isMxcWeixinIngressReleased()).toBe(true);
    await expect(waitForMxcWeixinIngressRelease()).resolves.toBeUndefined();
    expect(hasMxcWeixinMediaPolicy()).toBe(false);
    await expect(
      fetchWeixinRemoteMediaWithPolicy("https://example.test/image.png", fetchMock),
    ).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledWith("https://example.test/image.png");
  });

  it.each([
    ["full", "base-container"],
    ["limited", "limited-container"],
    ["full", "host"],
    ["limited", "host"],
    ["off", "base-container"],
  ])("retains containment for %s mode with %s tier", (requestedStrength, effectiveTier) => {
    configure();
    configureLivePolicy(JSON.stringify({ requestedStrength, effectiveTier }));

    expect(isMxcManagedWeixin()).toBe(true);
    expect(isMxcWeixinIngressReleased()).toBe(false);
    expect(hasMxcWeixinMediaPolicy()).toBe(true);
    expect(() => assertMxcWeixinOutboundMediaSource("https://example.test/image.png")).toThrow(
      /blocks remote HTTP\(S\) media/,
    );
  });

  it("rechecks the authenticated mode instead of caching a host-mode exemption", () => {
    configure();
    configureLivePolicy(JSON.stringify({ requestedStrength: "off", effectiveTier: "host" }));
    expect(isMxcWeixinIngressReleased()).toBe(true);

    configureLivePolicy(JSON.stringify({ requestedStrength: "full", effectiveTier: "base-container" }));
    expect(isMxcManagedWeixin()).toBe(true);
    expect(isMxcWeixinIngressReleased()).toBe(false);
  });

  it.each(["invalid json", "null", "[]", "{}", '{"requestedStrength":"off"}'])(
    "fails closed for malformed or incomplete live policy %s",
    (policyJson) => {
      configure();
      configureLivePolicy(policyJson);

      expect(isMxcManagedWeixin()).toBe(true);
      expect(isMxcWeixinIngressReleased()).toBe(false);
    },
  );

  it("does not accept an unauthenticated or stale host-mode policy", () => {
    configure();
    const policyJson = JSON.stringify({ requestedStrength: "off", effectiveTier: "host" });
    configureLivePolicy(policyJson, "stale-generation");
    expect(isMxcManagedWeixin()).toBe(true);
    expect(isMxcWeixinIngressReleased()).toBe(false);

    Reflect.set(globalThis, Symbol.for("microclaw.windows-node-mxc.live-policy.v1"), () => {
      throw new Error("Invalid live policy signature");
    });
    expect(isMxcManagedWeixin()).toBe(true);
    expect(isMxcWeixinIngressReleased()).toBe(false);

    Reflect.deleteProperty(globalThis, Symbol.for("microclaw.windows-node-mxc.live-policy.v1"));
    expect(isMxcManagedWeixin()).toBe(true);
    expect(isMxcWeixinIngressReleased()).toBe(false);
  });

  it("uses live grants and requires the new fingerprint before ingress resumes", async () => {
    const policy = configure();
    const file = path.join(policy.selected, "report.txt");
    fs.writeFileSync(file, "selected");
    const key = Symbol.for("microclaw.windows-node-mxc.live-policy.v1");
    process.env.MICROCLAW_MXC_LIVE_POLICY_PATH = "live-policy";
    let live = {
      gatewayGeneration: policy.generation, policyFingerprint: policy.fingerprint,
      policyJson: JSON.stringify({ approvedRoots: [{ path: policy.selected, access: "ReadOnly" }] }),
    };
    Reflect.set(globalThis, key, () => live);
    fs.writeFileSync(policy.releasePath, JSON.stringify({
      contract: "microclaw.windows-ingress-release.v1", gatewayGeneration: policy.generation,
      policyFingerprint: policy.fingerprint, token: policy.token,
    }));
    await expect(authorizeMxcWeixinOutboundMedia(file)).resolves.toBe(fs.realpathSync(file));
    expect(isMxcWeixinIngressReleased()).toBe(true);
    live = { ...live, policyFingerprint: "b".repeat(64), policyJson: '{"approvedRoots":[]}' };
    expect(isMxcWeixinIngressReleased()).toBe(false);
    await expect(authorizeMxcWeixinOutboundMedia(file)).rejects.toThrow(/outside selected folders/);
    Reflect.deleteProperty(globalThis, key);
    await expect(authorizeMxcWeixinOutboundMedia(file)).rejects.toThrow(/reader is unavailable/);
  });

  it("keeps inbound polling paused until the exact release record exists", () => {
    const policy = configure();
    expect(isMxcWeixinIngressReleased()).toBe(false);
    fs.writeFileSync(
      policy.releasePath,
      JSON.stringify({
        contract: "microclaw.windows-ingress-release.v1",
        gatewayGeneration: policy.generation,
        policyFingerprint: policy.fingerprint,
        token: policy.token,
      }),
    );
    expect(isMxcWeixinIngressReleased()).toBe(true);
    fs.writeFileSync(
      policy.releasePath,
      JSON.stringify({
        contract: "microclaw.windows-ingress-release.v1",
        gatewayGeneration: "stale-generation",
        policyFingerprint: policy.fingerprint,
        token: policy.token,
      }),
    );
    expect(isMxcWeixinIngressReleased()).toBe(false);
  });

  it("fails closed for an empty sender policy in every security mode", () => {
    process.env.MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT = "1";
    expect(isWeixinSenderAllowedByPolicy("sender@im.wechat", [])).toBe(false);
    expect(isWeixinSenderAllowedByPolicy("owner@im.wechat", ["owner@im.wechat"])).toBe(true);

    delete process.env.MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT;
    expect(isWeixinSenderAllowedByPolicy("sender@im.wechat", [])).toBe(false);
  });

  it("rejects remote outbound media under MXC before fetch", async () => {
    process.env.MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT = "1";
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      fetchWeixinRemoteMediaWithPolicy("https://example.test/image.png", fetchMock),
    ).rejects.toThrow(/blocks remote HTTP\(S\) media/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stages inbound media and permits selected or staged files only", async () => {
    const policy = configure();
    const selectedFile = path.join(policy.selected, "report.txt");
    const outsideFile = path.join(policy.root, "secret.txt");
    fs.writeFileSync(selectedFile, "selected");
    fs.writeFileSync(outsideFile, "outside");

    await expect(authorizeMxcWeixinOutboundMedia(selectedFile)).resolves.toBe(
      fs.realpathSync(selectedFile),
    );
    await expect(authorizeMxcWeixinOutboundMedia(outsideFile)).rejects.toThrow(
      /outside selected folders/,
    );
    const staged = await stageMxcWeixinInboundMedia(Buffer.from("image"), "image/png", 1024);
    expect(path.dirname(staged.path)).toBe(fs.realpathSync(policy.inbound));
    expect(path.extname(staged.path)).toBe(".png");
  });

  it("permits local outbound media sources to continue through broker policy", async () => {
    const policy = configure();
    const selectedFile = path.join(policy.selected, "photo.png");
    fs.writeFileSync(selectedFile, "image");

    expect(() => assertMxcWeixinOutboundMediaSource(selectedFile)).not.toThrow();
    await expect(authorizeMxcWeixinOutboundMedia(selectedFile)).resolves.toBe(
      fs.realpathSync(selectedFile),
    );
  });

  it("rejects reparse-point escapes without falling back to host access", async () => {
    const policy = configure();
    const outside = path.join(policy.root, "outside");
    fs.mkdirSync(outside);
    const outsideFile = path.join(outside, "secret.txt");
    fs.writeFileSync(outsideFile, "secret");
    const link = path.join(policy.selected, "escape");
    fs.symlinkSync(outside, link, "junction");

    await expect(authorizeMxcWeixinOutboundMedia(path.join(link, "secret.txt"))).rejects.toThrow();
  });

  it("fails closed when the media policy belongs to a stale generation", async () => {
    const policy = configure();
    const selectedFile = path.join(policy.selected, "report.txt");
    fs.writeFileSync(selectedFile, "selected");
    process.env.MICROCLAW_MXC_APPROVAL_PROOF_GATEWAY_GENERATION = "generation-2";

    await expect(authorizeMxcWeixinOutboundMedia(selectedFile)).rejects.toThrow(
      /does not match the active generation/,
    );
  });
});
