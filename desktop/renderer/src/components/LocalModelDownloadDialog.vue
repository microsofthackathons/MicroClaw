<template>
  <Teleport to="body">
    <div v-if="showDialog" class="download-overlay">
      <section
        class="download-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="download-title"
        @keydown.esc.stop.prevent="close"
      >
        <header>
          <div class="model-heading">
            <p class="eyebrow">{{ t("localModel.title") }}</p>
            <h2 id="download-title" :title="preset?.name">{{ modelName }}</h2>
          </div>
          <button
            class="close-button"
            :aria-label="t('common.close')"
            :disabled="closing || selecting || pending || loading"
            @click="close"
          >
            &times;
          </button>
        </header>
        <p v-if="sessionKey" class="hint">{{ t("modelManager.sessionHint") }}</p>
        <p v-if="error || failure" class="error" role="alert">{{ error || failure }}</p>
        <template v-if="awaitingConsent && download">
          <p class="consent-copy">{{ t("fixedLocal.downloadConsent") }}</p>
          <dl class="download-facts">
            <dt>{{ t("fixedLocal.modelDownload") }}</dt>
            <dd>{{ formatBytes(download.modelBytes) }}</dd>
            <dt>{{ t("fixedLocal.embeddingDownload") }}</dt>
            <dd>{{ formatBytes(download.embeddingBytes) }}</dd>
            <dt>{{ t("fixedLocal.runtimeSpace") }}</dt>
            <dd>{{ formatBytes(download.runtimeDiskBytes) }}</dd>
            <dt>{{ t("fixedLocal.execution") }}</dt>
            <dd>{{ download.backend === "cpu" ? "CPU" : download.backend.toUpperCase() }}</dd>
          </dl>
          <p v-if="download.backend === 'cpu'" class="hint">{{ t("fixedLocal.cpuWarning") }}</p>
          <p v-if="download.runtimeNote" class="hint">{{ download.runtimeNote }}</p>
          <div class="actions">
            <button :disabled="pending || closing" @click="close">
              {{ t("settings.cancel") }}
            </button>
            <button
              class="primary"
              data-testid="confirm-local-download"
              :disabled="
                pending || confirming || closing || streaming || operation?.cancellationPending
              "
              @click="confirmDownload"
            >
              {{ t("fixedLocal.downloadAndUse") }}
            </button>
          </div>
        </template>
        <template v-else-if="!failure && !error && !terminalError">
          <div class="progress-state">
            <p class="progress-label" role="status" aria-live="polite">{{ progressLabel }}</p>
            <div
              v-if="downloadProgress"
              class="download-metrics"
              data-testid="local-download-progress"
            >
              <div class="download-amount">
                <span>{{
                  t("fixedLocal.downloadedAmount", {
                    current: downloadProgress.downloadedGB,
                    total: downloadProgress.totalGB,
                  })
                }}</span>
                <strong>{{ downloadProgress.percent }}%</strong>
              </div>
              <p class="download-speed">{{ displayedSpeed }} MB/s</p>
            </div>
            <p
              v-else-if="progressMessage"
              class="hint"
              role="status"
              data-testid="local-download-progress"
            >
              {{ progressMessage }}
            </p>
            <p v-else-if="selecting" class="hint">{{ t("fixedLocal.filesReady") }}</p>
            <p v-else-if="!selecting && !confirming" class="hint">
              {{ t("fixedLocal.preparingHint") }}
            </p>
            <div
              class="progress-track"
              :class="{ determinate: downloadProgress }"
              aria-hidden="true"
            >
              <span
                :style="downloadProgress ? { width: `${downloadProgress.percent}%` } : undefined"
              />
            </div>
            <progress
              class="accessible-progress"
              :aria-label="progressLabel"
              :value="downloadProgress?.percent"
              :max="100"
            />
          </div>
        </template>
        <p v-if="terminalError" class="error" role="alert">{{ operation?.error }}</p>
        <p v-if="streaming" class="hint">{{ t("localModel.streaming") }}</p>
        <p v-if="operation?.cancellationPending" role="status">
          {{ t("localModel.cancelProtected") }}
        </p>
        <div v-if="!awaitingConsent" class="actions">
          <button
            v-if="operation?.phase === 'interrupted' && operation.id === ownedId"
            class="primary"
            :disabled="pending"
            @click="run(() => api.resume())"
          >
            {{ t("localModel.resume") }}
          </button>
          <button :disabled="closing || selecting || pending || loading" @click="close">
            {{ t(operation?.busy ? "localModel.cancelSetup" : "common.close") }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { t } from "@/i18n";
import { useLocalModelOperation } from "@/composables/use-local-model-operation";
import { parseManagedDownloadProgress } from "@/utils/local-model-presentation";
import { LOCAL_MODEL_PRESETS } from "../../../src/local-model-catalog";

const props = defineProps<{ modelRef: string; sessionKey?: string; streaming?: boolean }>();
const emit = defineEmits<{
  close: [];
  selected: [];
  busy: [value: boolean];
  visible: [value: boolean];
}>();
const api = window.openclaw.model.local;
const { operation, pending, loading, error, run, refresh } = useLocalModelOperation();
const preset = computed(() => LOCAL_MODEL_PRESETS.find((item) => item.modelRef === props.modelRef));
const modelName = computed(() => preset.value?.name.replace(/\s+(?:UD-)?Q4_K_M$/u, ""));
const ownedId = ref("");
const failure = ref("");
const checking = ref(true);
const needsPreparation = ref(false);
const selecting = ref(false);
const closing = ref(false);
const confirming = ref(false);
const download = computed(() =>
  operation.value?.id === ownedId.value ? operation.value.download : undefined,
);
const terminalError = computed(
  () => operation.value?.id === ownedId.value && operation.value.phase === "error",
);
const showDialog = computed(
  () =>
    needsPreparation.value ||
    Boolean(error.value || failure.value) ||
    terminalError.value ||
    (operation.value?.id === ownedId.value && operation.value.phase === "interrupted"),
);
const awaitingConsent = computed(() =>
  Boolean(
    download.value &&
    operation.value?.busy &&
    operation.value.phase === "step" &&
    operation.value.step?.type === "confirm" &&
    operation.value.step.executor !== "gateway" &&
    !confirming.value,
  ),
);
const progressMessage = computed(() =>
  operation.value?.id === ownedId.value && operation.value.step?.type === "progress"
    ? operation.value.step.message
    : undefined,
);
const downloadProgress = computed(() =>
  parseManagedDownloadProgress(progressMessage.value, preset.value?.name),
);
const displayedSpeed = ref(0);
let speedStage: string | undefined;
let smoothedSpeed = 0;
let lastSpeedSampleAt = 0;
let lastSpeedDisplayAt = 0;
watch(downloadProgress, (progress) => {
  if (!progress) {
    speedStage = undefined;
    return;
  }
  const now = performance.now();
  if (speedStage !== progress.stage) {
    speedStage = progress.stage;
    smoothedSpeed = progress.speedMBps;
    lastSpeedSampleAt = now;
    lastSpeedDisplayAt = now;
    displayedSpeed.value = Math.round(smoothedSpeed);
    return;
  }
  const weight = 1 - Math.exp(-(now - lastSpeedSampleAt) / 3000);
  smoothedSpeed += weight * (progress.speedMBps - smoothedSpeed);
  lastSpeedSampleAt = now;
  if (now - lastSpeedDisplayAt >= 1000) {
    displayedSpeed.value = Math.round(smoothedSpeed);
    lastSpeedDisplayAt = now;
  }
});
const progressLabel = computed(() =>
  t(
    selecting.value
      ? "fixedLocal.selecting"
      : confirming.value
        ? "fixedLocal.confirming"
        : downloadProgress.value
          ? `fixedLocal.downloadStage.${downloadProgress.value.stage}`
          : "fixedLocal.preparing",
  ),
);
let disposed = false;
let selectionStarted = false;

function formatBytes(bytes: number) {
  return bytes === 0 ? t("fixedLocal.cached") : `${(bytes / 1e9).toFixed(1)} GB`;
}

async function selectPrepared() {
  if (disposed || props.streaming || selectionStarted || closing.value) return;
  selectionStarted = true;
  selecting.value = true;
  try {
    if (props.sessionKey) {
      await window.openclaw.model.session.select({
        sessionKey: props.sessionKey,
        modelRef: props.modelRef,
      });
      if (!disposed) {
        emit("selected");
        emit("close");
      }
    } else {
      await run(async () => {
        const result = await api.activate({ kind: "existing-model", modelRef: props.modelRef });
        if (result.ok) ownedId.value = result.value.id;
        return result;
      });
      if (error.value) selecting.value = false;
    }
  } catch (cause) {
    if (!disposed) failure.value = cause instanceof Error ? cause.message : String(cause);
    selecting.value = false;
  } finally {
    if (props.sessionKey || error.value || failure.value) {
      selecting.value = false;
    }
  }
}

async function start() {
  try {
    if (!preset.value) throw new Error(t("fixedLocal.unsupportedModel"));
    const [capabilities, snapshot, current] = await Promise.all([
      api.getCapabilities(),
      api.getSnapshot(),
      api.getOperation(),
    ]);
    if (disposed) return;
    if (!capabilities.ok) throw new Error(capabilities.error);
    if (!snapshot.ok) throw new Error(snapshot.error);
    if (!current.ok) throw new Error(current.error);
    if (
      !capabilities.value.supported ||
      !capabilities.value.mutable ||
      !capabilities.value.plugin.installed ||
      !capabilities.value.plugin.enabled
    )
      throw new Error(t("fixedLocal.providerRequired"));
    if (current.value?.busy) {
      if (current.value.kind !== "prepare" || current.value.modelRef !== props.modelRef)
        throw new Error(t("localModel.operationBusy"));
      needsPreparation.value = true;
      ownedId.value = current.value.id;
      await refresh();
      return;
    }
    const saved = snapshot.value.models.find((model) => model.modelRef === props.modelRef);
    if (saved?.fileStatus === "present" || saved?.fileStatus === "external") {
      if (props.streaming) throw new Error(t("localModel.streaming"));
      await selectPrepared();
      return;
    }
    needsPreparation.value = true;
    await run(async () => {
      const agentId = props.sessionKey ? /^agent:([^:]+):/.exec(props.sessionKey)?.[1] : undefined;
      if (props.sessionKey && !agentId) throw new Error(t("fixedLocal.agentRequired"));
      const result = await api.prepare({
        authChoice: "llama-cpp",
        modelRef: props.modelRef,
        ...(agentId ? { agentId } : {}),
      });
      if (result.ok) ownedId.value = result.value.id;
      return result;
    });
  } catch (cause) {
    if (!disposed) failure.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    checking.value = false;
  }
}

async function confirmDownload() {
  const active = operation.value;
  if (
    pending.value ||
    confirming.value ||
    closing.value ||
    props.streaming ||
    active?.cancellationPending
  )
    return;
  if (!awaitingConsent.value || !active?.step) {
    failure.value = t("fixedLocal.confirmationExpired");
    return;
  }
  const stepId = active.step.id;
  confirming.value = true;
  failure.value = "";
  try {
    await run(() => api.answer({ operationId: active.id, stepId, value: true }));
  } finally {
    confirming.value = false;
  }
}

async function close() {
  if (closing.value || selecting.value || pending.value || loading.value) return;
  closing.value = true;
  try {
    if (operation.value?.id === ownedId.value && operation.value.busy) {
      await run(() => api.cancel(ownedId.value));
      if (operation.value?.busy || error.value) return;
    }
    emit("close");
  } finally {
    closing.value = false;
  }
}

watch(
  () => [operation.value?.id, operation.value?.phase, props.streaming, ownedId.value],
  () => {
    const active = operation.value;
    if (disposed || active?.id !== ownedId.value) return;
    if (active.phase === "prepared" && active.preparedModelRef === props.modelRef)
      void selectPrepared();
    if (active.phase === "ready" && active.modelRef === props.modelRef && selectionStarted) {
      selecting.value = false;
      emit("selected");
      emit("close");
    }
    if (
      active.phase === "error" ||
      active.phase === "cancelled" ||
      active.phase === "interrupted"
    ) {
      selecting.value = false;
    }
  },
);
watch(
  () => checking.value || selecting.value,
  (busy) => emit("busy", busy),
  { immediate: true, flush: "sync" },
);
watch(showDialog, (visible) => emit("visible", visible), { immediate: true, flush: "sync" });
onMounted(() => void start());
onUnmounted(() => {
  disposed = true;
  emit("busy", false);
  emit("visible", false);
});
</script>

<style scoped>
.download-overlay {
  position: fixed;
  inset: 0;
  z-index: 2200;
  background: #0006;
  display: grid;
  place-items: center;
}
.download-panel {
  --download-muted: var(--smtc-foreground-ctrl-neutral-secondary-rest, #60646c);
  --download-border: var(--smtc-stroke-divider-subtle, #e5e7eb);
  --download-subtle: var(--smtc-background-ctrl-subtle-hover, #f8f9fa);
  box-sizing: border-box;
  width: min(460px, calc(100vw - 32px));
  max-height: calc(100vh - 40px);
  overflow-y: auto;
  border-radius: 16px;
  padding: 24px;
  background: var(--smtc-background-card-on-primary-default-rest, #fff);
  color: var(--smtc-foreground-ctrl-neutral-primary-rest, #242424);
  box-shadow: 0 16px 64px rgba(0, 0, 0, 0.12);
  font-size: 13px;
  line-height: 1.6;
}
header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.model-heading {
  min-width: 0;
}
.eyebrow {
  margin: 0 0 4px;
  color: var(--download-muted);
  font-size: 12px;
}
h2 {
  font-size: 18px;
  margin: 0;
  font-weight: 600;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.close-button {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  min-height: 0;
  padding: 0;
  border: 0;
  background: transparent;
  font-size: 22px;
  line-height: 1;
}
.hint {
  margin: 10px 0 0;
  color: var(--download-muted);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.error {
  margin: 20px 0 0;
  padding: 12px;
  border: 1px solid var(--smtc-status-danger-foreground, #b42318);
  border-radius: 10px;
  color: var(--smtc-status-danger-foreground, #b42318);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.consent-copy {
  margin: 18px 0 14px;
  color: var(--download-muted);
}
.download-facts {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px 16px;
  margin: 0;
  padding: 16px;
  border: 1px solid var(--download-border);
  border-radius: 10px;
  background: var(--download-subtle);
  font-size: 12px;
}
dt {
  color: var(--download-muted);
}
dd {
  margin: 0;
  font-weight: 500;
  text-align: right;
}
.actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 20px;
}
button {
  min-height: 34px;
  padding: 7px 12px;
  border: 1px solid var(--download-border);
  border-radius: 8px;
  cursor: pointer;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
}
button:hover:not(:disabled) {
  background: var(--download-subtle);
}
button:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 3px;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.primary {
  background: var(--smtc-background-ctrl-neutral-primary-rest, #18181b);
  border-color: transparent;
  color: var(--smtc-foreground-ctrl-on-accent-rest, #fff);
}
.primary:hover:not(:disabled) {
  background: var(--smtc-background-ctrl-neutral-primary-rest, #18181b);
  opacity: 0.9;
}
.progress-state {
  position: relative;
  margin-top: 20px;
  padding: 16px;
  border: 1px solid var(--download-border);
  border-radius: 10px;
  background: var(--download-subtle);
}
.progress-label {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
}
.progress-state .hint {
  margin-top: 6px;
}
.download-metrics {
  margin-top: 8px;
  color: var(--download-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.download-amount {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 12px;
}
.download-amount strong {
  color: var(--smtc-foreground-ctrl-neutral-primary-rest, #242424);
  font-weight: 500;
}
.download-speed {
  margin: 4px 0 0;
}
.progress-track {
  height: 4px;
  margin-top: 16px;
  border-radius: 4px;
  background: var(--download-border);
  overflow: hidden;
}
.progress-track span {
  display: block;
  width: 35%;
  height: 100%;
  border-radius: inherit;
  background: var(--smtc-foreground-ctrl-neutral-primary-rest, #242424);
  animation: local-download-progress 1.8s ease-in-out infinite;
}
.progress-track.determinate span {
  margin: 0;
  animation: none;
  transition: width 0.3s linear;
}
.accessible-progress {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
@keyframes local-download-progress {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(290%);
  }
}
@keyframes local-download-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
@media (prefers-reduced-motion: reduce) {
  .progress-track span {
    animation: local-download-pulse 2.4s ease-in-out infinite;
    margin: 0 auto;
  }
  .progress-track.determinate span {
    transition: none;
  }
}
@media (max-width: 420px) {
  .download-panel {
    padding: 20px;
  }
}
</style>
