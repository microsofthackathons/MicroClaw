import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";

import { weixinPlugin } from "./src/channel.js";
import { assertHostCompatibility } from "./src/compat.js";
import { WeixinConfigSchema } from "./src/config/config-schema.js";
import { cancelWeixinLogin } from "./src/auth/login-qr.js";

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
