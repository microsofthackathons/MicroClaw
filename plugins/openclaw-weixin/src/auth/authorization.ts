import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  resolveCommandAuthorizedFromAuthorizers,
  shouldComputeCommandAuthorized,
} from "openclaw/plugin-sdk/command-auth-native";

import { isWeixinSenderAllowedByPolicy } from "../security/mxc-policy.js";

export function resolveWeixinCommandAuthorization(
  cfg: OpenClawConfig,
  rawBody: string,
  senderId: string,
  allowFrom: string[],
): { senderAllowedForCommands: boolean; commandAuthorized: boolean | undefined } {
  const senderAllowedForCommands = isWeixinSenderAllowedByPolicy(senderId, allowFrom);
  const commandAuthorized = shouldComputeCommandAuthorized(rawBody, cfg)
    ? resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: cfg.commands?.useAccessGroups !== false,
        authorizers: [
          { configured: allowFrom.length > 0, allowed: senderAllowedForCommands },
        ],
      })
    : undefined;
  return { senderAllowedForCommands, commandAuthorized };
}
