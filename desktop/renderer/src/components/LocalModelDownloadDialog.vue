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
          <h2 id="download-title">{{ preset?.name }}</h2>
          <button
            :aria-label="t('common.close')"
            :disabled="closing || selecting || pending || loading"
            @click="close"
          >
            &times;
          </button>
        </header>
        <p class="hint">
          {{ t(sessionKey ? "modelManager.sessionHint" : "localModel.defaultNotice") }}
        </p>
        <p v-if="error || failure" class="error" role="alert">{{ error || failure }}</p>
        <template v-if="awaitingConsent && download">
          <p>{{ t("fixedLocal.downloadConsent") }}</p>
          <dl>
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
          <p role="status" aria-live="polite">
            {{
              t(
                selecting
                  ? "fixedLocal.selecting"
                  : confirming
                    ? "fixedLocal.confirming"
                    : "fixedLocal.preparing",
              )
            }}
          </p>
          <p
            v-if="progressMessage"
            class="hint"
            role="status"
            data-testid="local-download-progress"
          >
            {{ progressMessage }}
          </p>
          <progress :aria-label="t('fixedLocal.preparing')" />
        </template>
        <p v-if="terminalError" class="error" role="alert">{{ operation?.error }}</p>
        <p v-if="streaming" class="hint">{{ t("localModel.streaming") }}</p>
        <p v-if="operation?.cancellationPending" role="status">
          {{ t("localModel.cancelProtected") }}
        </p>
        <div v-if="operation?.phase === 'interrupted' && operation.id === ownedId" class="actions">
          <button :disabled="pending" @click="run(() => api.resume())">
            {{ t("localModel.resume") }}
          </button>
        </div>
        <button
          v-if="!awaitingConsent"
          :disabled="closing || selecting || pending || loading"
          @click="close"
        >
          {{ t(operation?.busy ? "localModel.cancelSetup" : "common.close") }}
        </button>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { t } from "@/i18n";
import { useLocalModelOperation } from "@/composables/use-local-model-operation";
import { LOCAL_MODEL_PRESETS } from "../../../src/local-model-catalog";

const props = defineProps<{ modelRef: string; sessionKey?: string; streaming?: boolean }>();
const emit = defineEmits<{ close: []; selected: []; busy: [value: boolean] }>();
const api = window.openclaw.model.local;
const { operation, pending, loading, error, run, refresh } = useLocalModelOperation();
const preset = computed(() => LOCAL_MODEL_PRESETS.find((item) => item.modelRef === props.modelRef));
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
onMounted(() => void start());
onUnmounted(() => {
  disposed = true;
  emit("busy", false);
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
  box-sizing: border-box;
  width: min(460px, calc(100vw - 32px));
  max-height: calc(100vh - 40px);
  overflow-y: auto;
  border-radius: 14px;
  padding: 24px;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
}
header,
.actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
h2 {
  font-size: 18px;
  margin: 0;
}
header button {
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 22px;
}
.hint {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.error {
  color: var(--el-color-danger);
  font-size: 13px;
  overflow-wrap: anywhere;
}
dl {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 12px;
  font-size: 14px;
}
dd {
  margin: 0;
}
button {
  padding: 7px 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 7px;
  cursor: pointer;
  background: var(--el-bg-color);
  color: inherit;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.primary {
  background: var(--el-color-primary);
  border-color: var(--el-color-primary);
  color: white;
}
progress {
  width: 100%;
  margin-bottom: 14px;
}
</style>
