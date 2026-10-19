import type { WindowsNodeMxcRequestedMode } from "./windows-node-mxc-modes";

export const WINDOWS_NODE_MXC_CAPABILITY_DISCLOSURE_VERSION = 1 as const;

export type WindowsNodeMxcDisclosureTargetMode = Exclude<WindowsNodeMxcRequestedMode, "off">;

export type WindowsNodeMxcDisclosureGroupId = "disabled" | "paused" | "available-restricted";

export type WindowsNodeMxcDisclosureItemId =
  | "gateway-native-filesystem"
  | "browser-automation"
  | "mcp"
  | "screen"
  | "camera"
  | "location"
  | "tts"
  | "stt"
  | "gateway-memory"
  | "cron"
  | "hooks-webhooks"
  | "exec"
  | "gateway-web"
  | "wechat-message"
  | "canvas-phase-1";

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
      id: "disabled",
      titleKey: "settings.windowsNodeMxcConsent.group.disabled",
      summaryKey: "settings.windowsNodeMxcConsent.groupSummary.disabled",
      items: [
        {
          id: "gateway-native-filesystem",
          translationKey: "settings.windowsNodeMxcConsent.item.gateway-native-filesystem",
        },
        {
          id: "browser-automation",
          translationKey: "settings.windowsNodeMxcConsent.item.browser-automation",
        },
        { id: "mcp", translationKey: "settings.windowsNodeMxcConsent.item.mcp" },
        { id: "screen", translationKey: "settings.windowsNodeMxcConsent.item.screen" },
        { id: "camera", translationKey: "settings.windowsNodeMxcConsent.item.camera" },
        { id: "location", translationKey: "settings.windowsNodeMxcConsent.item.location" },
        { id: "tts", translationKey: "settings.windowsNodeMxcConsent.item.tts" },
        { id: "stt", translationKey: "settings.windowsNodeMxcConsent.item.stt" },
        {
          id: "gateway-memory",
          translationKey: "settings.windowsNodeMxcConsent.item.gateway-memory",
        },
      ],
    },
    {
      id: "paused",
      titleKey: "settings.windowsNodeMxcConsent.group.paused",
      summaryKey: "settings.windowsNodeMxcConsent.groupSummary.paused",
      items: [
        { id: "cron", translationKey: "settings.windowsNodeMxcConsent.item.cron" },
        {
          id: "hooks-webhooks",
          translationKey: "settings.windowsNodeMxcConsent.item.hooks-webhooks",
        },
      ],
    },
    {
      id: "available-restricted",
      titleKey: "settings.windowsNodeMxcConsent.group.available-restricted",
      summaryKey: "settings.windowsNodeMxcConsent.groupSummary.available-restricted",
      items: [
        { id: "exec", translationKey: "settings.windowsNodeMxcConsent.item.exec" },
        {
          id: "gateway-web",
          translationKey: "settings.windowsNodeMxcConsent.item.gateway-web",
        },
        {
          id: "wechat-message",
          translationKey: "settings.windowsNodeMxcConsent.item.wechat-message",
        },
        {
          id: "canvas-phase-1",
          translationKey: "settings.windowsNodeMxcConsent.item.canvas-phase-1",
        },
      ],
    },
  ],
} as const satisfies WindowsNodeMxcCapabilityDisclosure;
