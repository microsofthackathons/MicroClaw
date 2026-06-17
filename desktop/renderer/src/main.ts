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
      get: () => Promise.resolve(null),
      set: noopAsync,
    },
    chat: {
      send: noopAsync,
      abort: noopAsync,
      onStreamEvent: noopSub,
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
