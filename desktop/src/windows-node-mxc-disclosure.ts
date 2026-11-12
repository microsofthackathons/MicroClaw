import type { WindowsNodeMxcRequestedMode } from "./windows-node-mxc-modes";

export const WINDOWS_NODE_MXC_CAPABILITY_DISCLOSURE_VERSION = 3 as const;

export type WindowsNodeMxcDisclosureTargetMode = Exclude<WindowsNodeMxcRequestedMode, "off">;

export type WindowsNodeMxcDisclosureGroupId = "contained" | "outside-mxc";

export type WindowsNodeMxcDisclosureItemId =
  | "windows-node-exec"
  | "gateway-native-filesystem"
  | "gateway-runtime"
  | "canvas";

export interface WindowsNodeMxcDisclosureItem {
  id: WindowsNodeMxcDisclosureItemId;
  translationKey: `settings.windowsNodeMxcConsent.item.${WindowsNodeMxcDisclosureItemId}`;
}

export interface WindowsNodeMxcDisclosureGroup {
  id: WindowsNodeMxcDisclosureGroupId;
  titleKey: `settings.windowsNodeMxcConsent.group.${WindowsNodeMxcDisclosureGroupId}`;
  summaryKey: `settings.windowsNodeMxcConsent.groupSummary.${WindowsNodeMxcDisclosureGroupId}`;
  items: readonly WindowsNodeMxcDisclosureItem[];
}

export interface WindowsNodeMxcCapabilityDisclosure {
  version: typeof WINDOWS_NODE_MXC_CAPABILITY_DISCLOSURE_VERSION;
  groups: readonly WindowsNodeMxcDisclosureGroup[];
}

export const WINDOWS_NODE_MXC_CAPABILITY_DISCLOSURE = {
  version: WINDOWS_NODE_MXC_CAPABILITY_DISCLOSURE_VERSION,
  groups: [
    {
      id: "contained",
      titleKey: "settings.windowsNodeMxcConsent.group.contained",
      summaryKey: "settings.windowsNodeMxcConsent.groupSummary.contained",
      items: [
        {
          id: "windows-node-exec",
          translationKey: "settings.windowsNodeMxcConsent.item.windows-node-exec",
        },
      ],
    },
    {
      id: "outside-mxc",
      titleKey: "settings.windowsNodeMxcConsent.group.outside-mxc",
      summaryKey: "settings.windowsNodeMxcConsent.groupSummary.outside-mxc",
      items: [
        {
          id: "gateway-native-filesystem",
          translationKey: "settings.windowsNodeMxcConsent.item.gateway-native-filesystem",
        },
        {
          id: "gateway-runtime",
          translationKey: "settings.windowsNodeMxcConsent.item.gateway-runtime",
        },
        { id: "canvas", translationKey: "settings.windowsNodeMxcConsent.item.canvas" },
      ],
    },
  ],
} as const satisfies WindowsNodeMxcCapabilityDisclosure;
