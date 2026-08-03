import { defineStore } from "pinia";
import { ref } from "vue";

export const useGatewayStore = defineStore("gateway", () => {
  const status = ref("stopped");
  const port = ref(0);
  const logs = ref<string[]>([]);
  /** Once true the loading gate in App.vue stays hidden. Reset on explicit gateway restart. */
  const ready = ref(false);
  /** True while the connected gateway pre-warms the agent behind the loading gate. */
  const warming = ref(false);
  /** WeChat plugin login status — shared across Sidebar & PluginsView. */
  const weixinLoggedIn = ref(false);
  /** Last error/hint log line — shown on the loading screen when gateway fails. */
  const lastError = ref("");

  function addLog(msg: string) {
    logs.value.push(msg);
    // Capture error/hint lines for display on the loading screen
    if (msg.startsWith("[error]") || msg.startsWith("[warn]") || msg.startsWith("[hint]")) {
      lastError.value = msg.replace(/^\[(error|warn|hint)\]\s*/, "");
    }
    // Trim with hysteresis to avoid re-slicing on every line
    if (logs.value.length > 600) {
      logs.value = logs.value.slice(-500);
    }
  }

  /** Called when the first WS connection succeeds (hides loading screen). */
  function markReady() {
    if (ready.value) return;
    warming.value = false;
    ready.value = true;
  }

  /** Begin one warm-up transition. Returns false when one is already active. */
  function beginWarming() {
    if (ready.value || warming.value) return false;
    warming.value = true;
    return true;
  }

  function finishWarming() {
    warming.value = false;
  }

  /** Reset the loading gate so the GatewayLoading overlay reappears. */
  function resetReady() {
    ready.value = false;
    warming.value = false;
    lastError.value = "";
  }

  /** Re-check WeChat login status from main process. */
  async function refreshWeixinStatus() {
    try {
      const s = await window.openclaw.plugin.weixin.getStatus();
      weixinLoggedIn.value = s.loggedIn;
    } catch {
      weixinLoggedIn.value = false;
    }
  }

  return {
    status,
    port,
    logs,
    addLog,
    ready,
    warming,
    markReady,
    beginWarming,
    finishWarming,
    resetReady,
    lastError,
    weixinLoggedIn,
    refreshWeixinStatus,
  };
});
