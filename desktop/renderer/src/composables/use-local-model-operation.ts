import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import type { LocalModelOperation, LocalModelResult } from "../../../src/local-model-types";

/** Main owns the operation; a delayed IPC reply must never replace a newer event. */
export function useLocalModelOperation() {
  const operation = shallowRef<LocalModelOperation | null>(null);
  const pending = ref(false);
  const loading = ref(true);
  const error = ref("");
  let revision = 0;
  let request = 0;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;

  async function run(
    action: () => Promise<LocalModelResult<LocalModelOperation | null>>,
  ): Promise<void> {
    const currentRequest = ++request;
    const currentRevision = revision;
    pending.value = true;
    error.value = "";
    try {
      const result = await action();
      if (disposed || currentRequest !== request || currentRevision !== revision) return;
      if (result.ok) operation.value = result.value;
      else error.value = result.error;
    } catch (cause) {
      if (!disposed && currentRequest === request && currentRevision === revision) {
        error.value = cause instanceof Error ? cause.message : String(cause);
      }
    } finally {
      if (!disposed && currentRequest === request) pending.value = false;
    }
  }

  async function refresh(): Promise<void> {
    const api = window.openclaw?.model?.local;
    if (!api) {
      loading.value = false;
      return;
    }
    await run(() => api.getOperation());
    loading.value = false;
  }

  onMounted(() => {
    const api = window.openclaw?.model?.local;
    if (api) {
      unsubscribe = api.onEvent((snapshot) => {
        if (disposed) return;
        revision += 1;
        operation.value = snapshot;
        error.value = "";
        pending.value = false;
        loading.value = false;
      });
    }
    void refresh();
  });
  onUnmounted(() => {
    disposed = true;
    unsubscribe?.();
  });

  const busy = computed(() => loading.value || pending.value || Boolean(operation.value?.busy));
  const blocked = computed(() => busy.value || operation.value?.phase === "interrupted");
  return { operation, pending, loading, error, busy, blocked, run, refresh };
}
