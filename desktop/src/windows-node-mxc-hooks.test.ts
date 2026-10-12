import { describe, expect, it } from "vitest";
import {
  WINDOWS_NODE_MXC_HOOKS_GATE_CONTRACT,
  createWindowsNodeMxcHooksGatePolicy,
  getWindowsNodeMxcHooksEnvironment,
  inspectWindowsNodeMxcHooksStatus,
} from "./windows-node-mxc-hooks";

describe("Windows Node MXC Hooks pause policy", () => {
  it("binds requested hook state to the current Gateway generation and MXC mode", () => {
    const policy = createWindowsNodeMxcHooksGatePolicy({
      gatewayGeneration: "generation-1",
      policyFingerprint: "a".repeat(64),
      requestedMode: "limited-dacl",
      hooksConfig: {
        enabled: true,
        path: "automations/",
        internal: { entries: { audit: { enabled: true } } },
      },
    });

    expect(policy).toEqual({
      contract: WINDOWS_NODE_MXC_HOOKS_GATE_CONTRACT,
      gatewayGeneration: "generation-1",
      policyFingerprint: "a".repeat(64),
      requestedMode: "limited-dacl",
      externalRequested: true,
      internalRequested: true,
      basePath: "/automations",
    });
    expect(
      JSON.parse(
        Buffer.from(
          getWindowsNodeMxcHooksEnvironment(policy).MICROCLAW_MXC_HOOKS_GATE_POLICY_BASE64,
          "base64",
        ).toString("utf8"),
      ),
    ).toEqual(policy);
  });

  it("reports backed-up requested hooks as paused rather than disabled by the user", () => {
    expect(
      inspectWindowsNodeMxcHooksStatus(
        { enabled: true, internal: { enabled: true } },
        "full",
      ),
    ).toEqual({
      requestedExternalEnabled: true,
      requestedInternalEnabled: true,
      effectiveExternalEnabled: false,
      effectiveInternalEnabled: false,
      pausedByMxc: true,
    });
  });

  it("reports restored effective state only when MXC is Off", () => {
    expect(
      inspectWindowsNodeMxcHooksStatus(
        { enabled: true, internal: { enabled: false } },
        "off",
      ),
    ).toEqual({
      requestedExternalEnabled: true,
      requestedInternalEnabled: false,
      effectiveExternalEnabled: true,
      effectiveInternalEnabled: false,
      pausedByMxc: false,
    });
  });

  it("rejects an unsafe root hook path and malformed generation binding", () => {
    expect(() =>
      createWindowsNodeMxcHooksGatePolicy({
        gatewayGeneration: "",
        policyFingerprint: "a".repeat(64),
        requestedMode: "full",
        hooksConfig: {},
      }),
    ).toThrow(/generation context/);
    expect(() =>
      createWindowsNodeMxcHooksGatePolicy({
        gatewayGeneration: "generation",
        policyFingerprint: "a".repeat(64),
        requestedMode: "full",
        hooksConfig: { enabled: true, path: "/" },
      }),
    ).toThrow(/root HTTP path/);
  });
});
