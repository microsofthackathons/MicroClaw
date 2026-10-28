<template>
  <section class="weixin-card">
    <header class="weixin-header">
      <img :src="weixinIcon" :alt="t('plugins.weixinName')" />
      <div class="weixin-info">
        <h3>{{ t("plugins.weixinName") }}</h3>
        <p :title="t('plugins.weixinDesc')">{{ t("plugins.weixinDesc") }}</p>
      </div>
      <span
        v-if="connectionLabel"
        class="connection-badge"
        :class="{ connected }"
        data-testid="weixin-account-status"
      >
        {{ connectionLabel }}
      </span>
      <div class="connection-actions">
        <el-button
          v-if="!connected"
          type="primary"
          :disabled="connectDisabled"
          :loading="starting"
          @click="openConnection"
        >
          {{ t("plugins.connectWeixin") }}
        </el-button>
        <el-button v-if="connected && showMessages" @click="viewMessages">
          {{ t("plugins.viewWeixinMessages") }}
        </el-button>
        <el-button
          v-if="hasStoredAccount"
          type="danger"
          :disabled="disconnectDisabled"
          :loading="disconnecting"
          @click="disconnectWeixin"
          >{{ t("plugins.disconnect") }}</el-button
        >
      </div>
    </header>
    <div
      v-if="
        mutationLocked ||
        status?.pausedByMxc ||
        status?.loginRequiresRestart ||
        invalidAccounts ||
        error ||
        (!status?.ready && !connected)
      "
      class="weixin-body"
    >
      <el-alert
        v-if="mutationLocked"
        type="info"
        :closable="false"
        :title="
          t(mutationLockKnown ? 'plugins.weixinMutationLocked' : 'plugins.weixinMutationUnknown')
        "
      />
      <el-alert
        v-if="status?.pausedByMxc"
        type="info"
        :closable="false"
        :title="t('plugins.weixinPausedByMxc')"
      />
      <el-alert
        v-if="status?.loginRequiresRestart"
        type="warning"
        :closable="false"
        :title="t('plugins.loginRecoveryRequired')"
      />
      <el-alert
        v-if="invalidAccounts"
        type="warning"
        :closable="false"
        :title="t('plugins.multipleAccountsInvalid')"
      />
      <p v-if="error" class="connection-error" role="alert">{{ error }}</p>
      <p v-if="!status?.ready && !connected" class="connection-hint">
        {{ t("plugins.weixinPreparing") }}
      </p>
    </div>
    <el-dialog
      v-model="dialogOpen"
      :title="t('plugins.connectWeixin')"
      width="380px"
      align-center
      destroy-on-close
      @opened="renderQr"
    >
      <div class="qr-content">
        <p v-if="qrMessage && !error && !qrExpired">{{ qrMessage }}</p>
        <div v-if="qrData" class="qr-frame" :class="{ expired: qrExpired }">
          <canvas ref="qrCanvas" :aria-label="t('plugins.connectWeixin')"></canvas>
          <button
            v-if="qrExpired"
            type="button"
            class="qr-expired"
            data-testid="weixin-qr-refresh"
            :disabled="starting || connectDisabled"
            @click="startQr"
          >
            <strong>{{ t("plugins.qrExpired") }}</strong>
            <span>{{ t("plugins.refreshQr") }}</span>
          </button>
        </div>
        <p v-else-if="starting">{{ t("plugins.weixinPreparingQr") }}</p>
        <p v-if="error" class="connection-error" role="alert">{{ error }}</p>
      </div>
      <template #footer>
        <el-button @click="dialogOpen = false">{{ t("plugins.closeQr") }}</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { t } from "@/i18n";
import { useChatStore } from "@/stores/chat";
import { useWeixinMutationLock } from "@/composables/useWeixinMutationLock";
import weixinIcon from "@/assets/wechat.png";

defineProps<{ showMessages?: boolean }>();
type WeixinStatus = Awaited<ReturnType<typeof window.openclaw.plugin.weixin.getStatus>>;
const router = useRouter();
const chatStore = useChatStore();
const {
  locked: mutationLocked,
  known: mutationLockKnown,
  applyStatus,
  canMutate,
} = useWeixinMutationLock();
const status = ref<WeixinStatus | null>(null);
const dialogOpen = ref(false);
const starting = ref(false);
const disconnecting = ref(false);
const error = ref("");
const qrData = ref("");
const qrMessage = ref("");
const qrExpired = ref(false);
const qrCanvas = ref<HTMLCanvasElement | null>(null);
let alive = true;
let ownsQr = false;
let loginRevision = 0;
let cancelling: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let refreshing: Promise<void> | null = null;
let renderRevision = 0;
let pollRevision = 0;

const hasStoredAccount = computed(
  () => status.value?.invariantState === "single" && status.value.loggedIn,
);
const invalidAccounts = computed(() =>
  ["multiple", "invalid"].includes(status.value?.invariantState ?? ""),
);
const connected = computed(
  () =>
    hasStoredAccount.value &&
    status.value?.runtimeKnown === true &&
    status.value.connected === true,
);
const pendingQr = computed(() =>
  ["starting", "waiting"].includes(status.value?.qrSession?.state ?? ""),
);
const connectDisabled = computed(
  () =>
    mutationLocked.value ||
    !status.value?.ready ||
    status.value.loginRequiresRestart ||
    disconnecting.value ||
    (status.value.loginInProgress && !pendingQr.value),
);
const disconnectDisabled = computed(
  () =>
    mutationLocked.value ||
    !status.value?.runtimeKnown ||
    status.value.loginRequiresRestart ||
    starting.value ||
    pendingQr.value ||
    disconnecting.value,
);
const connectionLabel = computed(() => {
  if (connected.value) return t("channels.connected");
  if (!status.value?.runtimeKnown) return t("plugins.checkingWeixinConnection");
  if (hasStoredAccount.value && status.value.connecting) return t("plugins.connectingWeixin");
  return "";
});

function refreshStatus(force = false): Promise<void> {
  if (refreshing) return force ? refreshing.then(() => refreshStatus()) : refreshing;
  refreshing = (async () => {
    const revision = loginRevision;
    try {
      const next = await window.openclaw.plugin.weixin.getStatus();
      if (!alive) return;
      applyStatus(next);
      status.value = next;
      if (revision === loginRevision && dialogOpen.value && ownsQr && !starting.value) {
        if (next.qrSession?.qrDataUrl) qrData.value = next.qrSession.qrDataUrl;
        if (next.qrSession?.message) qrMessage.value = next.qrSession.message;
        qrExpired.value = next.qrSession?.state === "expired";
        if (next.qrSession?.state === "connected") {
          ownsQr = false;
          dialogOpen.value = false;
        }
        if (next.qrSession?.state === "error") {
          qrData.value = "";
          error.value = next.qrSession.message;
        }
      }
    } catch (reason) {
      if (alive) {
        status.value = null;
        error.value = reason instanceof Error ? reason.message : String(reason);
      }
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function pollStatus(): Promise<void> {
  const revision = ++pollRevision;
  clearTimeout(timer);
  await refreshStatus();
  if (alive && revision === pollRevision) {
    timer = setTimeout(pollStatus, dialogOpen.value ? 800 : 5_000);
  }
}

async function renderQr(): Promise<void> {
  const revision = ++renderRevision;
  await nextTick();
  if (!dialogOpen.value || !qrData.value || !qrCanvas.value) return;
  try {
    const QRCode = await import("qrcode");
    if (revision !== renderRevision || !dialogOpen.value || !qrCanvas.value) return;
    await QRCode.default.toCanvas(qrCanvas.value, qrData.value, { width: 256, margin: 2 });
  } catch {
    if (alive && revision === renderRevision) error.value = t("plugins.qrRenderFailed");
  }
}

watch([dialogOpen, qrData], renderQr, { flush: "post" });
watch(dialogOpen, (open) => {
  if (!open) stopConnection();
  void pollStatus();
});

async function openConnection(): Promise<void> {
  if (dialogOpen.value || !canMutate() || connectDisabled.value) return;
  if (hasStoredAccount.value || invalidAccounts.value) {
    try {
      await ElMessageBox.confirm(t("plugins.replaceWeixinConfirm"), t("plugins.confirm"), {
        type: "warning",
      });
    } catch {
      return;
    }
  }
  if (!alive || !canMutate() || connectDisabled.value) return;
  dialogOpen.value = true;
  await startQr();
}

async function startQr(): Promise<void> {
  if (!dialogOpen.value || starting.value || !canMutate() || connectDisabled.value) return;
  const revision = ++loginRevision;
  starting.value = true;
  error.value = "";
  qrData.value = "";
  qrMessage.value = "";
  qrExpired.value = false;
  try {
    if (cancelling) await cancelling;
    if (!alive || revision !== loginRevision || !dialogOpen.value || !canMutate()) return;
    ownsQr = true;
    const result = await window.openclaw.plugin.weixin.loginQrStart({
      force: hasStoredAccount.value || invalidAccounts.value,
    });
    if (!alive || revision !== loginRevision || !dialogOpen.value) return;
    if (!result.ok) error.value = result.message;
    else {
      qrData.value = result.qrDataUrl ?? "";
      qrMessage.value = result.message;
    }
    await refreshStatus(true);
  } catch (reason) {
    if (alive && revision === loginRevision) {
      error.value = reason instanceof Error ? reason.message : String(reason);
    }
  } finally {
    if (alive && revision === loginRevision) starting.value = false;
  }
}

function stopConnection(): void {
  loginRevision++;
  starting.value = false;
  qrData.value = "";
  qrMessage.value = "";
  qrExpired.value = false;
  error.value = "";
  if (!ownsQr) return;
  ownsQr = false;
  const cancellation = window.openclaw.plugin.weixin.cancelLogin();
  cancelling = cancellation;
  void cancellation
    .catch((reason) => {
      if (alive && !dialogOpen.value) {
        error.value = reason instanceof Error ? reason.message : String(reason);
      }
    })
    .finally(() => {
      if (cancelling === cancellation) cancelling = null;
      if (alive) void refreshStatus(true);
    });
}

async function disconnectWeixin(): Promise<void> {
  if (!canMutate() || disconnectDisabled.value) return;
  try {
    await ElMessageBox.confirm(t("plugins.disconnectConfirm"), t("plugins.confirm"), {
      type: "warning",
    });
  } catch {
    return;
  }
  if (!alive || !canMutate() || disconnectDisabled.value) return;
  const accountId = status.value?.currentAccount?.accountId;
  if (!accountId) return;
  disconnecting.value = true;
  error.value = "";
  try {
    const result = await window.openclaw.plugin.weixin.disconnect({ accountId });
    if (!alive) return;
    if (!result.ok) error.value = result.error ?? t("plugins.disconnectFailed");
    else ElMessage.success(t("plugins.disconnected"));
    await refreshStatus(true);
  } catch (reason) {
    if (alive) error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    if (alive) disconnecting.value = false;
  }
}

function viewMessages(): void {
  chatStore.switchToMainSession();
  void router.push("/chat");
}

onMounted(() => {
  void pollStatus();
});
onUnmounted(() => {
  stopConnection();
  alive = false;
  clearTimeout(timer);
  renderRevision++;
});
</script>

<style scoped>
.weixin-card {
  background: var(--bg-grouped);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}
.weixin-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
}
.weixin-header img {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
}
.weixin-info {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}
.weixin-header h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
  white-space: nowrap;
}
.weixin-header p,
.connection-hint {
  color: var(--text-muted);
  font-size: 12px;
}
.weixin-header p {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.connection-badge {
  flex-shrink: 0;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: 12px;
}
.connection-badge.connected {
  color: var(--success-color, #18a874);
}
.weixin-body {
  display: grid;
  gap: 12px;
  padding: 0 20px 14px;
}
.weixin-body p {
  margin: 0;
}
.connection-actions {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
}
.connection-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
.connection-error {
  color: var(--danger-color, #f56c6c);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.qr-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  min-height: 160px;
}
.qr-content canvas {
  max-width: 100%;
  display: block;
}
.qr-frame {
  position: relative;
  width: 256px;
  max-width: 100%;
}
.qr-frame.expired canvas {
  filter: blur(3px);
  opacity: 0.3;
}
.qr-expired {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  border: 0;
  border-radius: 8px;
  background: var(--el-mask-color, rgba(255, 255, 255, 0.75));
  color: var(--text-primary);
  font: inherit;
  cursor: pointer;
}
.qr-expired span {
  color: var(--el-color-primary);
  font-size: 13px;
}
.qr-expired:disabled {
  cursor: not-allowed;
}
</style>
