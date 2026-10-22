import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^openclaw\/plugin-sdk\/[^/]+$/,
        replacement: fileURLToPath(new URL("./integration/fixtures/sdk.mjs", import.meta.url)),
      },
    ],
  },
  test: {
    include: [
      "integration/**/*.test.mjs",
      "../plugins/openclaw-weixin/src/security/remote-approval.test.ts",
      "../plugins/openclaw-weixin/src/monitor/monitor.remote-approval.test.ts",
    ],
    environment: "node",
    testTimeout: 10_000,
  },
});
