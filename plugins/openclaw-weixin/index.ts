import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";

import { weixinPlugin } from "./src/channel.js";
import { assertHostCompatibility } from "./src/compat.js";
import { WeixinConfigSchema } from "./src/config/config-schema.js";
import { cancelWeixinLogin } from "./src/auth/login-qr.js";
import { listIndexedWeixinAccountIds, isActiveWeixinAccount } from "./src/auth/accounts.js";

export default {
  id: "openclaw-weixin",
  name: "Weixin",
  description: "Weixin channel (getUpdates long-poll + sendMessage)",
  configSchema: buildChannelConfigSchema(WeixinConfigSchema),
  register(api: OpenClawPluginApi) {
    // Fail-fast: reject incompatible host versions before any side-effects.
    assertHostCompatibility(api.runtime?.version);

    api.registerChannel({ plugin: weixinPlugin });
    api.registerGatewayMethod(
      "weixin.login.resume",
      async ({ context, respond }) => {
        const accountIds = listIndexedWeixinAccountIds();
        if (accountIds.length === 0) {
          respond(true, { resumed: true });
          return;
        }
        if (accountIds.length !== 1 || !isActiveWeixinAccount(accountIds[0])) {
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: "No single authenticated WeChat account to resume",
          });
          return;
        }
        try {
          const outcomes = await context.startChannel("openclaw-weixin", accountIds[0]);
          const running =
            context.getRuntimeSnapshot().channelAccounts?.["openclaw-weixin"]?.[accountIds[0]]
              ?.running === true;
          if (outcomes.get(accountIds[0])?.status !== "handed-off" && !running)
            throw new Error("WeChat channel did not accept the resume request");
          respond(true, { resumed: true });
        } catch (error) {
          respond(false, undefined, {
            code: "UNAVAILABLE",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      { scope: "operator.admin" },
    );
    api.registerGatewayMethod(
      "weixin.login.cancel",
      ({ params, respond }) => {
        if (typeof params.sessionKey !== "string" || !params.sessionKey.trim()) {
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: "A QR session key is required",
          });
          return;
        }
        cancelWeixinLogin(params.sessionKey);
        respond(true, { cancelled: true });
      },
      { scope: "operator.admin" },
    );
  },
};
