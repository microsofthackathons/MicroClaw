import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  getWindowsNodeMxcWeixinEnvironment,
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
});
