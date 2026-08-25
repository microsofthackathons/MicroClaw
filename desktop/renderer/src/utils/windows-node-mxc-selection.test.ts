import { describe, expect, it } from "vitest";
import {
  getAutomaticWindowsNodeMxcSelection,
  WINDOWS_NODE_MXC_DIAGNOSTIC_NODE_ID,
  type WindowsNodeMxcSelectableNode,
} from "./windows-node-mxc-selection";

const localNode: WindowsNodeMxcSelectableNode = {
  id: "node-local",
  platform: "windows",
  connected: true,
  paired: true,
  remoteIp: "127.0.0.1",
};

describe("Windows Node MXC selection", () => {
  it("replaces only the exact diagnostic sentinel with one eligible local node", () => {
    expect(
      getAutomaticWindowsNodeMxcSelection({
        desiredEnabled: true,
        selectedNodeId: WINDOWS_NODE_MXC_DIAGNOSTIC_NODE_ID,
        nodes: [localNode],
      }),
    ).toBe("node-local");

    expect(
      getAutomaticWindowsNodeMxcSelection({
        desiredEnabled: true,
        selectedNodeId: "node-explicit",
        nodes: [localNode],
      }),
    ).toBeNull();
  });

  it("does not choose among multiple eligible nodes", () => {
    expect(
      getAutomaticWindowsNodeMxcSelection({
        desiredEnabled: true,
        selectedNodeId: WINDOWS_NODE_MXC_DIAGNOSTIC_NODE_ID,
        nodes: [localNode, { ...localNode, id: "node-other" }],
      }),
    ).toBeNull();
  });

  it("rejects disconnected, unpaired, non-Windows, and remote nodes", () => {
    for (const node of [
      { ...localNode, connected: false },
      { ...localNode, paired: false },
      { ...localNode, platform: "linux" },
      { ...localNode, remoteIp: null },
      { ...localNode, remoteIp: "192.0.2.10" },
    ]) {
      expect(
        getAutomaticWindowsNodeMxcSelection({
          desiredEnabled: true,
          selectedNodeId: WINDOWS_NODE_MXC_DIAGNOSTIC_NODE_ID,
          nodes: [node],
        }),
      ).toBeNull();
    }
  });
});
