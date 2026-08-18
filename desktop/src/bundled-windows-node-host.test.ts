import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_WINDOWS_NODE_CWD_CONTRACT,
  assertApprovalResponseMatches,
  assertLoopbackGateway,
  createBundledWindowsNodeEnvironment,
  findBundledDevicePairRequest,
} from "./bundled-windows-node-host";

describe("bundled Windows node host", () => {
  it("uses the exact CWD policy contract", () => {
    expect(BUNDLED_WINDOWS_NODE_CWD_CONTRACT).toBe("microclaw.windows-cwd.v1");
  });

  it.each(["ws://127.0.0.1:18789", "ws://localhost:18789", "wss://[::1]:18789"])(
    "accepts loopback gateway %s",
    (url) => expect(() => assertLoopbackGateway(url)).not.toThrow(),
  );

  it.each(["ws://192.168.1.2:18789", "wss://gateway.example.com", "http://127.0.0.1"])(
    "rejects non-loopback gateway %s",
    (url) => expect(() => assertLoopbackGateway(url)).toThrow(/loopback/),
  );

  it("selects only the exact app-owned loopback device pairing request", () => {
    const nodeId = "a".repeat(64);
    const requestId = findBundledDevicePairRequest(
      {
        pending: [
          {
            requestId: "wrong-client",
            deviceId: nodeId,
            clientId: "openclaw-control-ui",
            role: "operator",
            remoteIp: "127.0.0.1",
          },
          {
            requestId: "remote-node",
            deviceId: nodeId,
            clientId: "node-host",
            role: "node",
            remoteIp: "192.168.1.20",
          },
          {
            requestId: "owned-node",
            deviceId: nodeId.toUpperCase(),
            clientId: "node-host",
            role: "node",
            remoteIp: "::1",
          },
        ],
      },
      nodeId,
    );

    expect(requestId).toBe("owned-node");
  });

  it("refuses ambiguous requests for the app-owned identity", () => {
    const nodeId = "b".repeat(64);
    const request = {
      deviceId: nodeId,
      clientId: "node-host",
      role: "node",
      remoteIp: "127.0.0.1",
    };

    expect(() =>
      findBundledDevicePairRequest(
        {
          pending: [
            { ...request, requestId: "first" },
            { ...request, requestId: "second" },
          ],
        },
        nodeId,
      ),
    ).toThrow(/Multiple pairing requests/);
  });

  it("accepts omitted remote metadata but rejects an explicit remote address", () => {
    const nodeId = "c".repeat(64);
    const request = {
      requestId: "owned-node",
      deviceId: nodeId,
      clientId: "node-host",
      role: "node",
    };

    expect(findBundledDevicePairRequest({ pending: [request] }, nodeId)).toBe("owned-node");
    expect(
      findBundledDevicePairRequest({ pending: [{ ...request, remoteIp: "203.0.113.10" }] }, nodeId),
    ).toBeNull();
  });

  it("binds approval responses to the exact pending request", () => {
    expect(() => assertApprovalResponseMatches("request-1", "request-1")).not.toThrow();
    expect(() => assertApprovalResponseMatches("request-1", "request-2")).toThrow(/does not match/);
  });

  it("uses a controlled system-only helper environment", () => {
    const environment = createBundledWindowsNodeEnvironment(
      String.raw`C:\Windows`,
      String.raw`C:\MicroClaw\scratch`,
    );

    expect(environment.PATH).toBe(
      String.raw`C:\Windows\System32;C:\Windows\System32\WindowsPowerShell\v1.0`,
    );
    expect(environment.TEMP).toBe(String.raw`C:\MicroClaw\scratch`);
    expect(environment).not.toHaveProperty("APPDATA");
    expect(environment).not.toHaveProperty("USERPROFILE");
  });

  it("requires an explicit non-conflicting package architecture", () => {
    const script = path.join(__dirname, "..", "scripts", "prepare-windows-node-resources.mjs");
    const missing = spawnSync(process.execPath, [script], { encoding: "utf8" });
    const conflicting = spawnSync(process.execPath, [script, "--arch=x64"], {
      encoding: "utf8",
      env: { ...process.env, MICROCLAW_WINDOWS_ARCH: "arm64" },
    });

    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("Specify exactly one Windows package architecture");
    expect(conflicting.status).not.toBe(0);
    expect(conflicting.stderr).toContain("Architecture mismatch");
  });
});
