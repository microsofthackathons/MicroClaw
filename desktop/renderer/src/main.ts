import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import router from "./router";
import App from "./App.vue";
import "./styles/global.css";

// Browser dev mode: mock window.openclaw so the app bypasses gateway/IPC checks
const isBrowserDev = !window.openclaw;
if (isBrowserDev) {
  const noop = () => {};
  const noopAsync = () => Promise.resolve();
  const noopSub = () => noop;
  (window as any).openclaw = {
    gateway: {
      getStatus: () => Promise.resolve("running"),
      getPort: () => Promise.resolve(18789),
      restart: noopAsync,
      onStatus: noopSub,
      onLog: noopSub,
      onWsConnected: noopSub,
      onWsDisconnected: noopSub,
    },
    config: {
      getStateDir: () => Promise.resolve(""),
      read: () => Promise.resolve({}),
      readEnv: () => Promise.resolve({}),
      write: noopAsync,
      isConfigured: () => Promise.resolve(true),
      needsSetup: () => Promise.resolve(false),
    },
    skills: {
      list: () => Promise.resolve([]),
      integrityCheck: () => Promise.resolve({ signatureValid: true, changes: [] }),
      generateSnapshot: noopAsync,
    },
    settings: {
      get: () =>
        Promise.resolve({
          language: "en-US",
          autoStart: false,
          startMinimized: false,
          themeMode: "light",
          accentColor: "#1e1f25",
          privacyLevel: "balanced",
        }),
      set: noopAsync,
    },
    agents: {
      list: () => Promise.resolve({ agents: [] }),
      add: (agentId: string) =>
        Promise.resolve({
          agents: [
            { id: "main", name: "Assistant" },
            { id: agentId, name: agentId },
          ],
        }),
      remove: () =>
        Promise.resolve({
          agents: [{ id: "main", name: "Assistant" }],
        }),
    },
    updates: {
      check: () =>
        Promise.resolve({
          status: "up-to-date",
          currentVersion: "1.0.0",
          latestVersion: "1.0.0",
        }),
    },
    chat: {
      send: noopAsync,
      abort: noopAsync,
      onStreamEvent: noopSub,
    },
    model: {
      testConnection: () => Promise.resolve({ ok: true, message: "Connection successful" }),
      prepareGitHubCopilot: () => Promise.resolve({ restartRequired: false }),
      startGitHubCopilotLogin: () => Promise.resolve({ sessionId: "browser-dev" }),
      cancelGitHubCopilotLogin: () => Promise.resolve({ cancelled: true }),
      disconnectGitHubCopilot: () =>
        Promise.resolve({ disconnected: true as const, removedProfiles: 0 }),
      getGitHubCopilotStatus: () => Promise.resolve({ authenticated: false }),
      listGitHubCopilotModels: () => Promise.resolve([]),
      onGitHubCopilotLoginEvent: noopSub,
    },
    plugin: {
      weixin: {
        getStatus: () => Promise.resolve({ loggedIn: false }),
      },
    },
    app: {
      quit: noop,
    },
    shell: {
      openExternal: noopAsync,
    },
  };
}

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(router);
app.use(ElementPlus);
app.mount("#app");

// In browser dev mode, mark gateway ready after pinia stores are initialized
if (isBrowserDev) {
  setTimeout(async () => {
    const { useGatewayStore } = await import("@/stores/gateway");
    useGatewayStore().markReady();
  }, 200);
}
