export const WINDOWS_NODE_MXC_DIAGNOSTIC_NODE_ID = "diagnostic-unpaired-local-node";

export interface WindowsNodeMxcSelectableNode {
  id: string;
  platform: string;
  connected: boolean;
  paired: boolean;
  remoteIp?: string | null;
}

export interface WindowsNodeMxcSelectionStatus {
  desiredEnabled: boolean;
  selectedNodeId: string;
  nodes: WindowsNodeMxcSelectableNode[];
}

function isLocalNode(node: WindowsNodeMxcSelectableNode): boolean {
  const remoteIp = node.remoteIp?.trim().toLowerCase();
  return (
    !remoteIp || remoteIp === "127.0.0.1" || remoteIp === "::1" || remoteIp === "::ffff:127.0.0.1"
  );
}

export function getAutomaticWindowsNodeMxcSelection(
  status: WindowsNodeMxcSelectionStatus,
): string | null {
  if (!status.desiredEnabled || status.selectedNodeId !== WINDOWS_NODE_MXC_DIAGNOSTIC_NODE_ID) {
    return null;
  }

  const eligible = status.nodes.filter(
    (node) =>
      node.connected &&
      node.paired &&
      node.platform.trim().toLowerCase() === "windows" &&
      isLocalNode(node),
  );
  return eligible.length === 1 ? eligible[0].id : null;
}
