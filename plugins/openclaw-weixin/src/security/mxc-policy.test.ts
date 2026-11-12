import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/api.js", () => ({ getUploadUrl: vi.fn() }));
vi.mock("../util/logger.js", () => ({ logger: { debug: vi.fn(), error: vi.fn() } }));

import { downloadRemoteImageToTemp } from "../cdn/upload.js";
import {
  assertMxcWeixinIngressReleased,
  isMxcManagedWeixin,
  isMxcWeixinIngressReleased,
  isWeixinSenderAllowedByPolicy,
  resolveWeixinLocalMediaPath,
  waitForMxcWeixinIngressRelease,
} from "./mxc-policy.js";

describe("MXC WeChat policy", () => {
  const roots: string[] = [];
  const originalEnvironment = { ...process.env };
  const readerKey = Symbol.for("microclaw.windows-node-mxc.live-policy.v1");

  afterEach(() => {
    process.env = { ...originalEnvironment };
    Reflect.deleteProperty(globalThis, readerKey);
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function configure() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-mxc-policy-"));
    roots.push(root);
    const generation = "generation-1";
    const fingerprint = "a".repeat(64);
    const token = "release-token";
    const releasePath = path.join(root, "release.json");
    process.env.MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT = "1";
    process.env.MICROCLAW_MXC_APPROVAL_PROOF_GATEWAY_GENERATION = generation;
    process.env.MICROCLAW_MXC_APPROVAL_PROOF_POLICY_FINGERPRINT = fingerprint;
    process.env.MICROCLAW_MXC_INGRESS_RELEASE_PATH = releasePath;
    process.env.MICROCLAW_MXC_INGRESS_RELEASE_TOKEN = token;
    return { root, generation, fingerprint, token, releasePath };
  }

  function writeRelease(
    policy: ReturnType<typeof configure>,
    fingerprint = policy.fingerprint,
    generation = policy.generation,
    token = policy.token,
  ) {
    fs.writeFileSync(policy.releasePath, JSON.stringify({
      contract: "microclaw.windows-ingress-release.v1",
      gatewayGeneration: generation,
      policyFingerprint: fingerprint,
      token,
    }));
  }

  it("allows unmanaged installations without a release record", () => {
    delete process.env.MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT;
    expect(isMxcManagedWeixin()).toBe(false);
    expect(isMxcWeixinIngressReleased()).toBe(true);
  });

  it("keeps ingress locked until the exact generation, fingerprint, and token are released", async () => {
    const policy = configure();
    expect(isMxcWeixinIngressReleased()).toBe(false);
    expect(() => assertMxcWeixinIngressReleased()).toThrow(/paused/);
    writeRelease(policy, policy.fingerprint, "stale-generation");
    expect(isMxcWeixinIngressReleased()).toBe(false);
    writeRelease(policy, "b".repeat(64));
    expect(isMxcWeixinIngressReleased()).toBe(false);
    writeRelease(policy, policy.fingerprint, policy.generation, "wrong-token");
    expect(isMxcWeixinIngressReleased()).toBe(false);
    writeRelease(policy);
    expect(isMxcWeixinIngressReleased()).toBe(true);
    await expect(waitForMxcWeixinIngressRelease()).resolves.toBeUndefined();
  });

  it("does not release ingress merely because a live mode change publishes host execution", () => {
    const policy = configure();
    process.env.MICROCLAW_MXC_LIVE_POLICY_PATH = "live-policy";
    let live = {
      gatewayGeneration: policy.generation,
      policyFingerprint: policy.fingerprint,
      policyJson: JSON.stringify({ requestedStrength: "full", effectiveTier: "base-container" }),
    };
    Reflect.set(globalThis, readerKey, () => live);
    writeRelease(policy);
    expect(isMxcManagedWeixin()).toBe(true);
    expect(isMxcWeixinIngressReleased()).toBe(true);

    fs.unlinkSync(policy.releasePath);
    live = {
      ...live,
      policyFingerprint: "b".repeat(64),
      policyJson: JSON.stringify({ requestedStrength: "off", effectiveTier: "host" }),
    };
    expect(isMxcManagedWeixin()).toBe(false);
    expect(isMxcWeixinIngressReleased()).toBe(false);
    writeRelease(policy, live.policyFingerprint);
    expect(isMxcWeixinIngressReleased()).toBe(true);

    live = {
      ...live,
      policyFingerprint: "c".repeat(64),
      policyJson: JSON.stringify({ requestedStrength: "full", effectiveTier: "base-container" }),
    };
    expect(isMxcManagedWeixin()).toBe(true);
    expect(isMxcWeixinIngressReleased()).toBe(false);
    writeRelease(policy, live.policyFingerprint);
    expect(isMxcWeixinIngressReleased()).toBe(true);
  });

  it.each([
    ["full", "base-container"],
    ["limited", "limited-container"],
    ["full", "host"],
    ["off", "base-container"],
  ])("does not treat %s mode with %s tier as host mode", (requestedStrength, effectiveTier) => {
    const policy = configure();
    process.env.MICROCLAW_MXC_LIVE_POLICY_PATH = "live-policy";
    Reflect.set(globalThis, readerKey, () => ({
      gatewayGeneration: policy.generation,
      policyFingerprint: policy.fingerprint,
      policyJson: JSON.stringify({ requestedStrength, effectiveTier }),
    }));
    expect(isMxcManagedWeixin()).toBe(true);
  });

  it.each(["invalid json", "null", "[]", "{}", '{"requestedStrength":"off"}'])(
    "does not exempt malformed or incomplete live policy %s",
    (policyJson) => {
      const policy = configure();
      process.env.MICROCLAW_MXC_LIVE_POLICY_PATH = "live-policy";
      Reflect.set(globalThis, readerKey, () => ({
        gatewayGeneration: policy.generation,
        policyFingerprint: policy.fingerprint,
        policyJson,
      }));
      expect(isMxcManagedWeixin()).toBe(true);
      expect(isMxcWeixinIngressReleased()).toBe(false);
    },
  );

  it("rejects a stale or unauthenticated live policy even with a release record", () => {
    const policy = configure();
    process.env.MICROCLAW_MXC_LIVE_POLICY_PATH = "live-policy";
    writeRelease(policy);
    Reflect.set(globalThis, readerKey, () => ({
      gatewayGeneration: "stale-generation",
      policyFingerprint: policy.fingerprint,
      policyJson: '{"requestedStrength":"off","effectiveTier":"host"}',
    }));
    expect(isMxcManagedWeixin()).toBe(true);
    expect(isMxcWeixinIngressReleased()).toBe(false);
    Reflect.set(globalThis, readerKey, () => {
      throw new Error("Invalid live policy signature");
    });
    expect(isMxcWeixinIngressReleased()).toBe(false);
    Reflect.deleteProperty(globalThis, readerKey);
    expect(isMxcWeixinIngressReleased()).toBe(false);
  });

  it("aborts while waiting for ingress release", async () => {
    configure();
    const controller = new AbortController();
    const waiting = waitForMxcWeixinIngressRelease(controller.signal, 60_000);
    controller.abort();
    await expect(waiting).rejects.toThrow("aborted");
  });

  it("retains normal sender authorization in either mode", () => {
    configure();
    expect(isWeixinSenderAllowedByPolicy("sender@im.wechat", [])).toBe(false);
    expect(isWeixinSenderAllowedByPolicy("owner@im.wechat", ["owner@im.wechat"])).toBe(true);
    delete process.env.MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT;
    expect(isWeixinSenderAllowedByPolicy("sender@im.wechat", [])).toBe(false);
  });

  it("allows ordinary local and remote media without requiring MXC folder grants", async () => {
    const policy = configure();
    const outsideFile = path.join(policy.root, "outside-selected-folders.png");
    fs.writeFileSync(outsideFile, "local");
    expect(resolveWeixinLocalMediaPath(outsideFile)).toBe(outsideFile);
    expect(resolveWeixinLocalMediaPath(pathToFileURL(outsideFile).href)).toBe(outsideFile);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response("remote", { headers: { "content-type": "image/png" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const downloaded = await downloadRemoteImageToTemp("https://example.test/image.png", policy.root);
    expect(fetchMock).toHaveBeenCalledWith("https://example.test/image.png");
    expect(fs.readFileSync(downloaded, "utf8")).toBe("remote");
  });
});
