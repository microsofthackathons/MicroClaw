<template>
  <div class="qr-content">
    <p v-if="message && !error && !expired">{{ message }}</p>
    <div v-if="data" class="qr-frame" :class="{ expired }">
      <canvas ref="canvas" :aria-label="t('plugins.connectWeixin')"></canvas>
      <button
        v-if="expired"
        type="button"
        class="qr-expired"
        data-testid="weixin-qr-refresh"
        :disabled="disabled"
        @click="$emit('refresh')"
      >
        <strong>{{ t("plugins.qrExpired") }}</strong>
        <span>{{ t("plugins.refreshQr") }}</span>
      </button>
    </div>
    <p v-else-if="loading">{{ t("plugins.weixinPreparingQr") }}</p>
    <p v-if="error" class="connection-error" role="alert">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { t } from "@/i18n";

const props = defineProps<{
  data: string;
  message: string;
  expired: boolean;
  disabled: boolean;
  loading: boolean;
  error: string;
}>();
const emit = defineEmits<{ refresh: []; renderError: [] }>();
const canvas = ref<HTMLCanvasElement | null>(null);
let renderRevision = 0;

watch(
  [() => props.data, canvas],
  async () => {
    const revision = ++renderRevision;
    if (!props.data || !canvas.value) return;
    try {
      const QRCode = await import("qrcode");
      if (revision !== renderRevision || !canvas.value) return;
      await QRCode.default.toCanvas(canvas.value, props.data, { width: 256, margin: 2 });
    } catch {
      if (revision === renderRevision) emit("renderError");
    }
  },
  { flush: "post" },
);

onBeforeUnmount(() => renderRevision++);
</script>

<style scoped>
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
.connection-error {
  color: var(--danger-color, #f56c6c);
  font-size: 13px;
  overflow-wrap: anywhere;
}
</style>
