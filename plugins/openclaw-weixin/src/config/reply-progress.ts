import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

type WeixinChannelConfig = {
  replyProgressMessages?: boolean;
};

export function resolveReplyProgressMessagesEnabled(cfg: OpenClawConfig): boolean {
  const section = cfg.channels?.["openclaw-weixin"] as WeixinChannelConfig | undefined;
  return section?.replyProgressMessages !== false;
}
