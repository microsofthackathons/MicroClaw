<template>
  <div v-if="recovery || error" class="session-model-recovery" data-testid="session-model-recovery">
    <p v-if="recovery" role="status">{{ t("modelManager.recoveryRequired") }}</p>
    <p v-if="recovery?.blockedReason && !recovery.recovering" class="detail">
      {{ recovery.blockedReason }}
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <button
      v-if="recovery"
      type="button"
      data-testid="recover-session-model"
      :disabled="disabled || busy || !recovery.canRecover"
      :aria-busy="busy"
      @click="recover"
    >
      {{
        t(
          busy
            ? "modelManager.recovering"
            : recovery.requiresRestart
              ? "modelManager.recoverWithRestart"
              : "modelManager.recoverCurrent",
        )
      }}
    </button>
    <button v-else type="button" @click="refresh">{{ t("modelManager.refresh") }}</button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { t } from "@/i18n";
import type { SessionModelRecovery } from "../../../src/session-model-types";

const props = defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{
  state: [value: SessionModelRecovery | null];
  busy: [value: boolean];
  recovered: [];
}>();
const api = window.openclaw.model.session;
const recovery = ref<SessionModelRecovery | null>(null);
const pending = ref(false);
const error = ref("");
const busy = computed(() => pending.value || Boolean(recovery.value?.recovering));
let disposed = false;
let revision = 0;
let unsubscribe: (() => void) | undefined;

async function refresh() {
  const version = ++revision;
  try {
    const next = await api.getRecovery();
    if (disposed || version !== revision) return;
    const previous = recovery.value;
    recovery.value = next;
    if (!next) error.value = "";
    emit("state", next);
    if (previous && !next) emit("recovered");
  } catch (cause) {
    if (!disposed && version === revision)
      error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function recover() {
  const active = recovery.value;
  if (!active || !active.canRecover || busy.value || props.disabled) return;
  pending.value = true;
  error.value = "";
  try {
    if (active.requiresRestart) {
      try {
        await ElMessageBox.confirm(
          t("modelManager.recoveryConfirm"),
          t("modelManager.recoverWithRestart"),
          {
            type: "warning",
            confirmButtonText: t("modelManager.recoverWithRestart"),
            cancelButtonText: t("settings.cancel"),
          },
        );
      } catch (cause) {
        if (cause === "cancel" || cause === "close") return;
        throw cause;
      }
    }
    if (disposed) return;
    if (recovery.value?.id !== active.id) throw new Error(t("modelManager.recoveryChanged"));
    await api.recover({
      recoveryId: active.id,
      confirmed: true,
      restart: active.requiresRestart,
    });
    await refresh();
  } catch (cause) {
    if (!disposed) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    pending.value = false;
  }
}

watch(busy, (value) => emit("busy", value), { flush: "sync" });
onMounted(() => {
  unsubscribe = api.onRecoveryChanged(() => void refresh());
  void refresh();
});
onUnmounted(() => {
  disposed = true;
  revision++;
  unsubscribe?.();
  emit("busy", false);
});
</script>

<style scoped>
.session-model-recovery {
  margin: 10px 0;
  padding: 10px 12px;
  border: 1px solid var(--el-color-warning-light-5);
  border-radius: 8px;
  background: var(--el-color-warning-light-9);
  color: var(--el-text-color-primary);
  font-size: 13px;
}
p {
  margin: 0 0 8px;
}
.detail {
  color: var(--el-text-color-secondary);
  overflow-wrap: anywhere;
}
[role="alert"] {
  color: var(--el-color-danger);
}
button {
  padding: 6px 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--el-bg-color);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
</style>
