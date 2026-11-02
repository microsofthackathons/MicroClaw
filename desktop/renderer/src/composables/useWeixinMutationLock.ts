import { onUnmounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { t } from "@/i18n";

export function useWeixinMutationLock() {
  const locked = ref(true);
  const loginLocked = ref(true);
  const known = ref(false);
  let revision = -1;
  const unsubscribe = window.openclaw.plugin.weixin.onMutationLock((status) => {
    apply(status.locked, status.revision, status.loginLocked);
  });
  onUnmounted(unsubscribe);

  function apply(value: boolean, nextRevision: number, qrLocked = value): void {
    if (typeof value !== "boolean" || !Number.isSafeInteger(nextRevision) || nextRevision < 0) {
      throw new Error("Invalid main-process WeChat mutation-lock status");
    }
    if (nextRevision < revision) return;
    revision = nextRevision;
    known.value = true;
    locked.value = value;
    loginLocked.value = typeof qrLocked === "boolean" ? qrLocked : true;
  }

  function applyStatus(status: {
    mutationLocked: boolean;
    loginLocked?: boolean;
    mutationLockRevision: number;
  }): void {
    apply(status.mutationLocked, status.mutationLockRevision, status.loginLocked);
  }

  function canMutate(): boolean {
    if (!locked.value) return true;
    ElMessage.warning(
      t(known.value ? "plugins.weixinMutationLocked" : "plugins.weixinMutationUnknown"),
    );
    return false;
  }

  function canLogin(): boolean {
    if (!loginLocked.value) return true;
    ElMessage.warning(
      t(known.value ? "plugins.weixinLoginLocked" : "plugins.weixinMutationUnknown"),
    );
    return false;
  }

  return { locked, loginLocked, known, applyStatus, canMutate, canLogin };
}
