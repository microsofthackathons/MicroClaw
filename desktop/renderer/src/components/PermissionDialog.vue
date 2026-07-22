<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import { t } from "@/i18n";

/** Feature flag: show caller stack trace in permission dialog for debugging. */
const SHOW_CALLER_STACK = false;

/** Auto-deny countdown duration in seconds. */
const AUTO_DENY_SECONDS = 60;

interface PermissionRequest {
  requestId: string;
  type: "file" | "shell" | "shell-async" | "app-approval";
  targetPath?: string;
  dirPath?: string;
  command?: string;
  callerStack?: string;
  app?: string;
  accessNeeded?: string;
}

const props = defineProps<{
  request: PermissionRequest | null;
}>();

const emit = defineEmits<{
  respond: [decision: string];
}>();

// ── Countdown timer ──
const countdown = ref(AUTO_DENY_SECONDS);
let countdownTimer: ReturnType<typeof setInterval> | null = null;

function clearTimer() {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

watch(
  () => props.request,
  (req) => {
    clearTimer();
    if (req) {
      countdown.value = AUTO_DENY_SECONDS;
      countdownTimer = setInterval(() => {
        countdown.value--;
        if (countdown.value <= 0) {
          clearTimer();
          emit("respond", "deny");
        }
      }, 1000);
    }
  },
  { immediate: true },
);

onUnmounted(clearTimer);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const descriptionHtml = computed(() => {
  if (!props.request) return "";
  if (props.request.type === "app-approval") {
    const appName = `<strong>${escapeHtml(props.request.app || "")}</strong>`;
    return t("perm.appDesc", { app: appName });
  }
  const dir = `<strong>${escapeHtml(props.request.dirPath || "")}</strong>`;
  const access = props.request.accessNeeded;
  if (props.request.type === "file") {
    if (access === "ro") return t("perm.fileDescRO", { dir });
    return t("perm.fileDesc", { dir });
  }
  if (access === "ro") return t("perm.shellDescRO", { dir });
  return t("perm.shellDesc", { dir });
});

const commandHtml = computed(() => {
  if (!props.request?.command) return "";
  const raw = props.request.command;
  const truncated = raw.length > 300 ? raw.slice(0, 297) + "\u2026" : raw;
  return escapeHtml(truncated);
});

const isAppApproval = computed(() => props.request?.type === "app-approval");
const isShellRequest = computed(
  () => props.request?.type === "shell" || props.request?.type === "shell-async",
);
const isReadOnly = computed(() => props.request?.accessNeeded === "ro");
const riskLevel = computed<"low" | "medium" | "high">(() => {
  if (!props.request) return "low";
  if (props.request.type === "app-approval") return "high";
  if (isShellRequest.value) return isReadOnly.value ? "medium" : "high";
  return isReadOnly.value ? "low" : "medium";
});
const isModal = computed(() => riskLevel.value !== "low");
const dialogIcon = computed(() => {
  if (!props.request) return "📁";
  if (props.request.type === "app-approval") return "🚀";
  if (isShellRequest.value) return "⌨";
  return isReadOnly.value ? "📁" : "✎";
});
const dialogTitle = computed(() => {
  if (!props.request) return t("perm.title");
  if (props.request.type === "app-approval") return t("perm.titleApp");
  if (isShellRequest.value) return t("perm.titleCommand");
  return isReadOnly.value ? t("perm.titleRead") : t("perm.titleWrite");
});
const riskHint = computed(() => {
  if (!props.request) return "";
  if (props.request.type === "app-approval") return t("perm.riskApp");
  if (isShellRequest.value)
    return isReadOnly.value ? t("perm.riskCommandRO") : t("perm.riskCommandRW");
  return isReadOnly.value ? t("perm.riskRead") : t("perm.riskWrite");
});
const countdownPercent = computed(() =>
  Math.max(0, Math.min(100, (countdown.value / AUTO_DENY_SECONDS) * 100)),
);
/** The grant decision to send when user clicks "Allow". */
const grantDecision = computed(() =>
  props.request?.accessNeeded === "ro" ? "grant-ro" : "grant-rw",
);
const grantLabel = computed(() =>
  props.request?.accessNeeded === "ro" ? t("perm.grantRO") : t("perm.grantRW"),
);

function respond(decision: string) {
  emit("respond", decision);
}
</script>

<template>
  <Transition name="perm-slide">
    <div
      v-if="request"
      class="perm-overlay"
      :class="[`perm-overlay--${riskLevel}`, { 'perm-overlay--modal': isModal }]"
    >
      <div class="perm-card" :class="[`perm-card--${riskLevel}`, { 'perm-card--modal': isModal }]">
        <div class="perm-header">
          <div class="perm-heading">
            <span class="perm-icon">{{ dialogIcon }}</span>
            <div>
              <div class="perm-title">{{ dialogTitle }}</div>
              <div class="perm-subtitle">{{ riskHint }}</div>
            </div>
          </div>
          <button class="perm-close" @click="respond('deny')">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M4 4L12 12M12 4L4 12"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>
        <div class="perm-body" v-html="descriptionHtml"></div>
        <div v-if="commandHtml" class="perm-command">
          <div class="perm-command-label">{{ t("perm.commandLabel") }}</div>
          <code class="perm-command-code" v-html="commandHtml"></code>
        </div>
        <div v-if="SHOW_CALLER_STACK && request?.callerStack" class="perm-command">
          <div class="perm-command-label">{{ t("perm.callerLabel") }}</div>
          <code class="perm-command-code perm-stack">{{ request.callerStack }}</code>
        </div>
        <div class="perm-countdown-wrap">
          <div class="perm-countdown-row">
            <span>{{ t("perm.autoDeny", { seconds: countdown }) }}</span>
            <span class="perm-risk-label">{{ riskLevel.toUpperCase() }}</span>
          </div>
          <div class="perm-countdown-bar" aria-hidden="true">
            <span :style="{ width: countdownPercent + '%' }"></span>
          </div>
        </div>
        <div class="perm-actions">
          <button class="perm-btn perm-btn-outline" @click="respond('deny')">
            {{ t("perm.deny") }}
          </button>
          <template v-if="isAppApproval">
            <button class="perm-btn perm-btn-filled" @click="respond('allow-once')">
              {{ t("perm.allowOnce") }}
            </button>
            <button class="perm-btn perm-btn-filled" @click="respond('allow-always')">
              {{ t("perm.allowAlways") }}
            </button>
          </template>
          <template v-else>
            <button class="perm-btn perm-btn-filled" @click="respond(grantDecision)">
              {{ grantLabel }}
            </button>
          </template>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.perm-overlay {
  position: fixed;
  bottom: 0;
  left: var(--sidebar-width, 240px);
  right: 0;
  display: flex;
  justify-content: center;
  z-index: 200;
  pointer-events: none;
  padding: 12px 28px 18px;
  background: transparent;
}

.perm-overlay--modal {
  inset: 0;
  left: 0;
  bottom: 0;
  align-items: center;
  background: rgba(0, 0, 0, 0.34);
  padding: 28px;
  pointer-events: auto;
}

html.dark .perm-overlay--modal {
  background: rgba(0, 0, 0, 0.58);
}

.perm-card {
  pointer-events: auto;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--card-radius, 16px);
  box-shadow: var(--card-shadow-hover, var(--card-shadow));
  padding: 18px 20px;
  max-width: 680px;
  width: 100%;
  border-left: 4px solid var(--warning);
}

.perm-card--low {
  border-left-color: var(--success);
}

.perm-card--medium {
  border-left-color: var(--warning);
}

.perm-card--high {
  border-left-color: var(--danger);
}

.perm-card--modal {
  max-width: 560px;
  border-radius: 20px;
  padding: 22px 24px;
}

.perm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.perm-heading {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}

.perm-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 12px;
  background: var(--accent-subtle);
  font-size: 18px;
  flex: 0 0 auto;
}

.perm-title {
  font-size: 16px;
  font-weight: 800;
  color: var(--text-primary);
}

.perm-subtitle {
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.4;
  margin-top: 3px;
}

.perm-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 6px;
  transition:
    background 0.15s,
    color 0.15s;
}

.perm-close:hover {
  background: var(--accent-subtle);
  color: var(--text-primary);
}

.perm-body {
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-bottom: 12px;
}

.perm-body :deep(strong) {
  color: var(--text-primary);
  font-weight: 600;
}

.perm-command {
  margin-bottom: 16px;
}

.perm-command-label {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 4px;
  font-weight: 500;
}

.perm-command-code {
  display: block;
  font-family: "Cascadia Code", "Fira Code", "Consolas", monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-primary);
  background: var(--bg-tertiary, rgba(0, 0, 0, 0.06));
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  word-break: break-all;
  white-space: pre-wrap;
  max-height: 80px;
  overflow-y: auto;
}

.perm-stack {
  font-size: 10px;
  opacity: 0.6;
  max-height: 60px;
}

.perm-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
}

.perm-countdown-wrap {
  margin: 4px 0 14px;
}

.perm-countdown-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 7px;
}

.perm-risk-label {
  font-weight: 800;
  letter-spacing: 0.08em;
}

.perm-countdown-bar {
  width: 100%;
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--border-light);
}

.perm-countdown-bar span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--success), var(--warning));
  transition: width 1s linear;
}

.perm-card--high .perm-countdown-bar span {
  background: linear-gradient(90deg, var(--warning), var(--danger));
}

.perm-btn {
  padding: 8px 16px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition:
    opacity 0.15s,
    transform 0.1s;
  white-space: nowrap;
}

.perm-btn:active {
  transform: scale(0.97);
}

.perm-btn-outline {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  margin-right: auto;
}

.perm-btn-outline:hover {
  background: var(--bg-tertiary);
}

.perm-btn-filled {
  background: var(--msg-user-bg);
  border: 1px solid transparent;
  color: var(--msg-user-text, #fff);
}

.perm-card--medium .perm-btn-filled {
  background: var(--warning);
  color: #1e1f25;
}

.perm-card--high .perm-btn-filled {
  background: var(--danger);
  color: #fff;
}

.perm-btn-filled:hover {
  opacity: 0.85;
}

/* Slide-up transition */
.perm-slide-enter-active,
.perm-slide-leave-active {
  transition:
    transform 0.25s ease,
    opacity 0.25s ease;
}

.perm-slide-enter-from,
.perm-slide-leave-to {
  transform: translateY(20px);
  opacity: 0;
}

.perm-overlay--modal.perm-slide-enter-from,
.perm-overlay--modal.perm-slide-leave-to {
  transform: none;
}

@media (max-width: 720px) {
  .perm-overlay {
    left: 0;
    padding: 12px;
  }

  .perm-card--modal {
    max-width: 100%;
  }

  .perm-actions {
    flex-direction: column;
  }

  .perm-btn,
  .perm-btn-outline {
    width: 100%;
    margin-right: 0;
  }
}
</style>
