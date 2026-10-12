import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  authorizeMxcWeixinOutboundMedia,
  isMxcWeixinIngressReleased,
  stageMxcWeixinInboundMedia,
} from "./mxc-policy.js";

describe("MXC WeChat policy", () => {
  const roots: string[] = [];
  const originalEnvironment = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnvironment };
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
    const staged = await stageMxcWeixinInboundMedia(
      Buffer.from("image"),
      "image/png",
      1024,
    );
    expect(path.dirname(staged.path)).toBe(fs.realpathSync(policy.inbound));
    expect(path.extname(staged.path)).toBe(".png");
  });

  it("rejects reparse-point escapes without falling back to host access", async () => {
    const policy = configure();
    const outside = path.join(policy.root, "outside");
    fs.mkdirSync(outside);
    const outsideFile = path.join(outside, "secret.txt");
    fs.writeFileSync(outsideFile, "secret");
    const link = path.join(policy.selected, "escape");
    fs.symlinkSync(outside, link, "junction");

    await expect(
      authorizeMxcWeixinOutboundMedia(path.join(link, "secret.txt")),
    ).rejects.toThrow();
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
