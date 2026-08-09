import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import router from "./router";
import App from "./App.vue";
import "./styles/global.css";
import { createBrowserOpenClawMock } from "./browser-openclaw";
import { loadWebFontsAfterPageLoad } from "./web-fonts";

// Browser dev mode: mock window.openclaw so the app bypasses gateway/IPC checks
const isBrowserDev = import.meta.env.DEV && !window.openclaw;
if (isBrowserDev) {
  window.openclaw = createBrowserOpenClawMock();
}

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(router);
app.use(ElementPlus);
app.mount("#app");
loadWebFontsAfterPageLoad();

// In browser dev mode, mark gateway ready after pinia stores are initialized
if (isBrowserDev) {
  setTimeout(async () => {
    const { useGatewayStore } = await import("@/stores/gateway");
    useGatewayStore().markReady();
  }, 200);
}
