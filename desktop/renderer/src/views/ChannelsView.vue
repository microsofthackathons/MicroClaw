<template>
  <div class="channels-view" :class="{ embedded }">
    <div class="view-header">
      <h2 :class="{ 'settings-group-title': embedded }">{{ t("channels.title") }}</h2>
    </div>

    <!-- WeChat Plugin Card -->
    <div class="plugin-card">
      <div class="plugin-header">
        <div class="plugin-icon">
          <img :src="weixinIcon" :alt="t('plugins.weixinName')" />
        </div>
        <div class="plugin-info">
          <div class="plugin-name">{{ t("plugins.weixinName") }}</div>
        </div>
        <div class="plugin-toggle">
          <el-switch v-model="weixinEnabled" :loading="toggling" @change="handleToggleEnabled" />
        </div>
      </div>

      <!-- Plugin body — only visible when enabled -->
      <div v-if="weixinEnabled" class="plugin-body">
        <div class="plugin-section">
          <div class="plugin-section-title">{{ t("plugins.channelLogin") }}</div>
          <div class="plugin-section-desc">
            {{ t("plugins.channelLoginDesc") }}
          </div>

          <!-- Login states -->
          <div v-if="!loginActive && !loginSuccess" class="login-actions">
            <el-button type="primary" @click="startLogin" :loading="loginStarting">
              {{ t("plugins.loginWeixin") }}
            </el-button>
          </div>

          <!-- QR code display area (fast path) -->
          <div v-if="loginActive && !useFallbackLogin" class="login-qr-area">
            <div class="qr-header">
              <span class="qr-status-text">{{ qrStatusText }}</span>
              <el-button size="small" text @click="cancelLogin">{{
                t("plugins.cancel")
              }}</el-button>
            </div>
            <div class="qr-body">
              <canvas ref="qrCanvasRef" class="qr-canvas"></canvas>
              <div v-if="qrScanned" class="qr-scanned-overlay">
                <span class="qr-scanned-icon">👀</span>
                <span>{{ t("plugins.scannedWaiting") }}</span>
              </div>
            </div>
            <div v-if="qrError" class="qr-error">{{ qrError }}</div>
          </div>

          <!-- Terminal output area (CLI fallback) -->
          <div v-if="loginActive && useFallbackLogin" class="login-terminal-area">
            <div class="terminal-header">
              <span class="terminal-title">{{ t("plugins.waitingScan") }}</span>
              <el-button size="small" text @click="cancelLogin">{{
                t("plugins.cancel")
              }}</el-button>
            </div>
            <pre class="terminal-output" ref="terminalRef">{{ loginOutput }}</pre>
          </div>

          <!-- Login success + disconnect -->
          <div v-if="loginSuccess" class="login-success">
            <span class="success-icon">✓</span>
            <span>{{ t("plugins.loginSuccess") }}</span>
            <el-button
              size="small"
              type="primary"
              text
              @click="goToWeixinChat"
              style="margin-left: auto"
            >
              {{ t("plugins.viewWeixinMessages") }}
            </el-button>
            <el-button
              size="small"
              type="danger"
              text
              @click="disconnectWeixin"
              :loading="disconnecting"
            >
              {{ t("plugins.disconnect") }}
            </el-button>
          </div>
        </div>
      </div>
    </div>
    <p class="view-desc">{{ t("plugins.weixinDesc") }}</p>

    <!-- Other channels -->
    <div v-if="channelStore.channels.length" class="channel-grid">
      <div v-for="ch in channelStore.channels" :key="ch.id" class="channel-card">
        <div class="channel-icon">{{ ch.icon }}</div>
        <div class="channel-info">
          <div class="channel-name">{{ ch.name }}</div>
          <div class="channel-type">{{ ch.type }}</div>
        </div>
        <div class="channel-status" :class="ch.connected ? 'online' : 'offline'">
          {{ ch.connected ? t("channels.connected") : t("channels.disconnected") }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { useChannelStore } from "@/stores/channels";
import { useChatStore } from "@/stores/chat";
import { useGatewayStore } from "@/stores/gateway";
import { t } from "@/i18n";
import weixinIcon from "@/assets/wechat.png";
import QRCode from "qrcode";

withDefaults(defineProps<{ embedded?: boolean }>(), {
  embedded: false,
});

const router = useRouter();
const channelStore = useChannelStore();
const chatStore = useChatStore();
const gatewayStore = useGatewayStore();

const weixinEnabled = ref(false);
const toggling = ref(false);
const loginActive = ref(false);
const loginStarting = ref(false);
const loginSuccess = ref(false);

const disconnecting = ref(false);
const qrCanvasRef = ref<HTMLCanvasElement | null>(null);
const qrScanned = ref(false);
const qrError = ref("");
const qrStatusText = ref("");
const useFallbackLogin = ref(false);
const loginOutput = ref("");
const terminalRef = ref<HTMLPreElement | null>(null);

let loginAborted = false;
let unsubLoginOutput: (() => void) | null = null;
let unsubLoginDone: (() => void) | null = null;
const QR_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
let qrRefreshTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  try {
    const status = await window.openclaw.plugin.weixin.getStatus();
    weixinEnabled.value = status.enabled;
    loginSuccess.value = status.loggedIn;
    gatewayStore.weixinLoggedIn = status.loggedIn;
    if (status.loginInProgress && !status.loggedIn) {
      loginActive.value = true;
      useFallbackLogin.value = true;
      loginOutput.value = t("plugins.loginInProgress");
    }
  } catch {}

  unsubLoginOutput = window.openclaw.plugin.weixin.onLoginOutput((text) => {
    loginOutput.value += text;
    nextTick(() => {
      if (terminalRef.value) {
        terminalRef.value.scrollTop = terminalRef.value.scrollHeight;
      }
    });
  });

  unsubLoginDone = window.openclaw.plugin.weixin.onLoginDone(async (result) => {
    if (!useFallbackLogin.value) return;
    loginActive.value = false;
    useFallbackLogin.value = false;
    if (result.code === 0) {
      try {
        const status = await window.openclaw.plugin.weixin.getStatus();
        loginSuccess.value = status.loggedIn;
        gatewayStore.weixinLoggedIn = status.loggedIn;
      } catch {
        loginSuccess.value = true;
        gatewayStore.weixinLoggedIn = true;
      }
      ElMessage.success(t("plugins.loginSuccess"));
    } else {
      try {
        const status = await window.openclaw.plugin.weixin.getStatus();
        loginSuccess.value = status.loggedIn;
        gatewayStore.weixinLoggedIn = status.loggedIn;
      } catch {}
      if (!loginSuccess.value) {
        ElMessage.warning(t("plugins.loginEnded"));
      }
    }
  });
});

onUnmounted(() => {
  unsubLoginOutput?.();
  unsubLoginDone?.();
  clearQrRefreshTimer();
});

function clearQrRefreshTimer() {
  if (qrRefreshTimer) {
    clearInterval(qrRefreshTimer);
    qrRefreshTimer = null;
  }
}

function startQrRefreshTimer() {
  clearQrRefreshTimer();
  qrRefreshTimer = setInterval(async () => {
    if (!loginActive.value || loginAborted || qrScanned.value || useFallbackLogin.value) {
      clearQrRefreshTimer();
      return;
    }
    qrStatusText.value = t("plugins.qrAutoRefreshing");
    await fetchAndRenderQr(true);
  }, QR_REFRESH_INTERVAL_MS);
}

async function renderQrCode(dataUrl: string) {
  await new Promise((r) => setTimeout(r, 0));
  const canvas = qrCanvasRef.value;
  if (!canvas) return;
  try {
    await QRCode.toCanvas(canvas, dataUrl, {
      width: 240,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });
  } catch {
    qrError.value = t("plugins.qrRenderFailed");
  }
}

async function fetchAndRenderQr(force = false): Promise<boolean> {
  try {
    const result = await window.openclaw.plugin.weixin.loginQrStart({
      force,
      accountId: "default",
    });
    if (!result.ok) {
      qrError.value = result.error || result.message;
      return false;
    }
    if (result.qrDataUrl) {
      qrError.value = "";
      qrScanned.value = false;
      qrStatusText.value = t("plugins.waitingScan");
      await renderQrCode(result.qrDataUrl);
      return true;
    }
    qrError.value = result.message;
    return false;
  } catch (err: any) {
    qrError.value = err.message || String(err);
    return false;
  }
}

async function startLogin() {
  loginStarting.value = true;
  loginSuccess.value = false;
  loginActive.value = true;
  qrError.value = "";
  qrScanned.value = false;
  loginAborted = false;
  useFallbackLogin.value = false;
  loginOutput.value = "";
  qrStatusText.value = t("plugins.waitingScan");

  try {
    const ok = await fetchAndRenderQr();
    if (ok) {
      loginStarting.value = false;
      startQrRefreshTimer();
      await pollForLogin();
      return;
    }
  } catch {}

  useFallbackLogin.value = true;
  loginStarting.value = false;

  try {
    const result = await window.openclaw.plugin.weixin.login();
    if (!result.ok && result.error) {
      ElMessage.error(t("plugins.loginFailed", { error: result.error }));
      loginActive.value = false;
      useFallbackLogin.value = false;
    }
  } catch (err: any) {
    loginActive.value = false;
    useFallbackLogin.value = false;
    ElMessage.error(t("plugins.loginFailed", { error: err.message || err }));
  }
}

async function pollForLogin() {
  while (loginActive.value && !loginAborted) {
    try {
      const result = await window.openclaw.plugin.weixin.loginQrWait({
        accountId: "default",
        timeoutMs: 35_000,
      });

      if (loginAborted) return;

      if (result.connected) {
        clearQrRefreshTimer();
        loginActive.value = false;
        loginSuccess.value = true;
        gatewayStore.weixinLoggedIn = true;
        ElMessage.success(t("plugins.loginSuccess"));
        restartGatewayAfterLogin();
        return;
      }

      if (result.message.includes("已扫码") || result.message.includes("scanned")) {
        qrScanned.value = true;
        qrStatusText.value = t("plugins.scannedWaiting");
      } else if (result.message.includes("过期") || result.message.includes("expired")) {
        qrScanned.value = false;
        qrStatusText.value = t("plugins.qrExpiredRefreshing");
        await fetchAndRenderQr(true);
        startQrRefreshTimer();
      } else if (result.message.includes("没有进行中") || result.message.includes("no active")) {
        clearQrRefreshTimer();
        qrError.value = result.message;
        loginActive.value = false;
        return;
      }
    } catch {
      if (loginAborted) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function restartGatewayAfterLogin() {
  try {
    await window.openclaw.gateway.restart();
  } catch {}
}

async function cancelLogin() {
  loginAborted = true;
  clearQrRefreshTimer();
  if (useFallbackLogin.value) {
    await window.openclaw.plugin.weixin.cancelLogin();
    useFallbackLogin.value = false;
  }
  loginActive.value = false;
  qrError.value = "";
  qrScanned.value = false;
  loginOutput.value = "";
}

async function disconnectWeixin() {
  try {
    await ElMessageBox.confirm(t("plugins.disconnectConfirm"), t("plugins.disconnect"), {
      confirmButtonText: t("plugins.confirm"),
      cancelButtonText: t("plugins.cancel"),
      type: "warning",
    });
  } catch {
    return;
  }

  disconnecting.value = true;
  try {
    const result = await window.openclaw.plugin.weixin.disconnect();
    if (result.ok) {
      loginSuccess.value = false;
      gatewayStore.weixinLoggedIn = false;
      ElMessage.success(t("plugins.disconnected"));
    } else {
      ElMessage.error(t("plugins.operationFailed", { error: result.error || "Unknown error" }));
    }
  } catch (err: any) {
    ElMessage.error(t("plugins.operationFailed", { error: err.message || err }));
  } finally {
    disconnecting.value = false;
  }
}

async function handleToggleEnabled(val: boolean) {
  toggling.value = true;
  try {
    await window.openclaw.plugin.weixin.setEnabled(val);
    weixinEnabled.value = val;
    if (val) {
      ElMessage.success(t("plugins.weixinEnabled"));
    } else {
      ElMessage.info(t("plugins.weixinDisabled"));
      loginSuccess.value = false;
    }
  } catch (err: any) {
    ElMessage.error(t("plugins.operationFailed", { error: err.message || err }));
    weixinEnabled.value = !val;
  } finally {
    toggling.value = false;
  }
}

function goToWeixinChat() {
  chatStore.switchToMainSession();
  router.push("/chat");
}
</script>

<style scoped>
.channels-view {
  height: 100%;
  overflow-y: auto;
  padding: 24px 32px;
  max-width: 720px;
  font-family: inherit;
}

.channels-view.embedded {
  height: auto;
  overflow: visible;
  padding: 0;
  max-width: none;
}

.view-header {
  margin-bottom: 24px;
}

.channels-view.embedded .view-header {
  margin-bottom: 8px;
}

.view-header h2 {
  font-size: 20px;
  font-weight: 600;
}

.view-header h2.settings-group-title {
  margin: 0;
  padding-left: 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.07em;
}

.view-desc {
  color: var(--text-muted);
  font-size: 12px;
  margin: -14px 0 20px;
  padding: 6px 4px 0;
}

/* Plugin card */
.plugin-card {
  background: var(--bg-grouped);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 20px;
}

.plugin-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px 24px;
}

.plugin-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  background: rgba(7, 193, 96, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.plugin-icon img {
  width: 28px;
  height: 28px;
  object-fit: contain;
  display: block;
}

.plugin-info {
  flex: 1;
  min-width: 0;
}

.plugin-name {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-primary);
}

.plugin-toggle {
  flex-shrink: 0;
}

.plugin-body {
  border-top: 1px solid var(--border);
  padding: 0 24px 24px;
}

.plugin-section {
  padding-top: 20px;
}

.plugin-section + .plugin-section {
  border-top: 1px solid var(--border-light);
  margin-top: 20px;
}

.plugin-section-title {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.plugin-section-desc {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-muted);
  margin-bottom: 14px;
}

/* Login QR code */
.login-qr-area {
  background: var(--bg-tertiary, #1a1a2e);
  border-radius: 8px;
  overflow: hidden;
  margin-top: 8px;
}

.qr-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.05);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.qr-status-text {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
}

.qr-body {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  position: relative;
}

.qr-canvas {
  border-radius: 4px;
}

.qr-scanned-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  font-size: 14px;
  gap: 8px;
}

.qr-scanned-icon {
  font-size: 32px;
}

.qr-error {
  padding: 8px 12px;
  color: #ff6b6b;
  font-size: 12px;
}

/* Login terminal (CLI fallback) */
.login-terminal-area {
  background: #1a1a2e;
  border-radius: 8px;
  overflow: hidden;
  margin-top: 8px;
}

.terminal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.05);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.terminal-title {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
}

.terminal-output {
  padding: 8px 12px;
  margin: 0;
  font-family: "Cascadia Code", "Consolas", "Courier New", monospace;
  font-size: 9px;
  line-height: 1.2;
  color: #e0e0e0;
  white-space: pre;
  overflow: auto;
  max-height: 480px;
  min-height: 120px;
}

/* Login success */
.login-success {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: rgba(52, 199, 89, 0.08);
  border-radius: 8px;
  color: #1a8a3e;
  font-size: 14px;
  font-weight: 500;
}

.success-icon {
  font-size: 18px;
  font-weight: bold;
}

/* Channel grid */
.channel-grid {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.channel-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background: var(--bg-grouped);
  border: 1px solid var(--border);
  border-radius: 8px;
  transition: border-color 0.15s;
}

.channel-card:hover {
  border-color: var(--border-light);
}

.channel-icon {
  font-size: 28px;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.channel-info {
  flex: 1;
}

.channel-name {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-primary);
}

.channel-type {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-secondary);
  margin-top: 2px;
}

.channels-view :deep(.el-button),
.channels-view :deep(.el-switch) {
  font-family: inherit;
}

.channel-status {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 12px;
}

.channel-status.online {
  background: rgba(52, 199, 89, 0.12);
  color: #1a8a3e;
}

.channel-status.offline {
  background: rgba(0, 0, 0, 0.04);
  color: var(--text-muted);
}

/* ── Dark mode overrides ── */
html.dark .login-success {
  background: rgba(52, 199, 89, 0.15);
  color: #4ade80;
}
html.dark .channel-status.online {
  background: rgba(52, 199, 89, 0.18);
  color: #4ade80;
}
html.dark .channel-status.offline {
  background: rgba(255, 255, 255, 0.06);
}
</style>
