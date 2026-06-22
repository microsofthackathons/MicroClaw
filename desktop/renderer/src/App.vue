<template>
  <!-- Setup wizard route is no longer auto-shown on launch. -->
  <router-view v-if="showSetup" />

  <!-- Gateway loading screen — blocks UI until WS is connected -->
  <GatewayLoading
    v-else-if="!gatewayReady"
    :status="gateway.status"
    :connected="chatStore.wsConnected"
    :errorMessage="gateway.lastError"
    @retry="handleRetry"
  />

  <!-- Main app (shown after first successful WS connection) -->
  <div v-else class="app-layout">
    <SidePanel />
    <main class="main-content">
      <div class="app-header">
        <h1 class="app-header-title">{{ headerTitle }}</h1>
        <div class="app-header-controls">
          <button class="win-ctrl" @click="minimizeWindow">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button class="win-ctrl" @click="maximizeWindow">
            <svg
              v-if="isMaximized"
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="2" y="8" width="14" height="14" rx="2.5" />
              <path
                d="M8 8V4.5A2.5 2.5 0 0 1 10.5 2H19.5A2.5 2.5 0 0 1 22 4.5V13.5A2.5 2.5 0 0 1 19.5 16H16"
              />
            </svg>
            <svg
              v-else
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
            </svg>
          </button>
          <button class="win-ctrl win-ctrl--close" @click="closeWindow">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
      <router-view />
    </main>
    <UsagePanel />
  </div>

  <!-- Integrity Alert Dialog (shown immediately on launch or mid-session) -->
  <el-dialog
    v-model="integrityDialogVisible"
    :title="t('integrity.title')"
    width="560"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="false"
  >
    <div
      v-if="integrityResult && !integrityResult.signatureValid"
      style="color: #ff3b30; margin-bottom: 16px; font-weight: bold"
    >
      {{ t("integrity.signatureFailed") }}
    </div>

    <div v-if="integrityResult?.signatureValid" class="integrity-hint">
      {{ t("integrity.changedSinceLastLaunch") }}
    </div>

    <div v-if="modifiedChanges.length" style="margin-bottom: 12px">
      <div style="font-weight: bold; color: #ff9500; margin-bottom: 4px">
        {{ t("integrity.modified") }} ({{ modifiedChanges.length }})
      </div>
      <div v-for="c in modifiedChanges" :key="c.skill + c.file" class="integrity-file">
        · {{ c.source }}/{{ c.skill }}/{{ c.file }}
      </div>
    </div>

    <div v-if="addedChanges.length" style="margin-bottom: 12px">
      <div style="font-weight: bold; color: #ff3b30; margin-bottom: 4px">
        {{ t("integrity.added") }} ({{ addedChanges.length }})
      </div>
      <div v-for="c in addedChanges" :key="c.skill + c.file" class="integrity-file">
        · {{ c.source }}/{{ c.skill }}/{{ c.file }}
      </div>
    </div>

    <div v-if="removedChanges.length" style="margin-bottom: 12px">
      <div style="font-weight: bold; color: #ff9500; margin-bottom: 4px">
        {{ t("integrity.removed") }} ({{ removedChanges.length }})
      </div>
      <div v-for="c in removedChanges" :key="c.skill + c.file" class="integrity-file">
        · {{ c.source }}/{{ c.skill }}/{{ c.file }}
      </div>
    </div>

    <template #footer>
      <el-button @click="exitApp">{{ t("integrity.exit") }}</el-button>
      <el-button type="primary" :loading="integrityLoading" @click="trustIntegrityChanges">
        {{ t("integrity.trustAndContinue") }}
      </el-button>
    </template>
  </el-dialog>

  <!-- In-app permission dialog (replaces native OS dialog) -->
  <PermissionDialog :request="currentPermission" @respond="handlePermissionResponse" />
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRouter, useRoute } from "vue-router";
import { ElMessage } from "element-plus";
import SidePanel from "@/components/SidePanel.vue";
import GatewayLoading from "@/components/GatewayLoading.vue";
import PermissionDialog from "@/components/PermissionDialog.vue";
import UsagePanel from "@/components/UsagePanel.vue";
import { useAgentStore } from "@/stores/agents";
import { useGatewayStore } from "@/stores/gateway";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/sessions";
import { useTaskStore } from "@/stores/tasks";
import { t, setLocale, locale } from "@/i18n";

const gateway = useGatewayStore();
const chatStore = useChatStore();
const sessionStore = useSessionStore();
const taskStore = useTaskStore();
const router = useRouter();
const route = useRoute();
const agentStore = useAgentStore();

// ── Setup wizard gate ──
const showSetup = ref(false);

// ── Gateway loading gate ──
// Once the first WS connection succeeds and the progress bar finishes,
// the loading screen hides.  It reappears on explicit gateway restart
// (e.g. from the Plugins page) via gateway.resetReady().
const gatewayReady = computed(() => gateway.ready);
const headerTitle = computed(() => {
  void locale.value;
  if (route.name === "agent-market") return t("agentMarket.title");
  let agentId = route.params.agentId as string | undefined;
  if (!agentId) {
    const session = sessionStore.sessions.find((s) => s.key === chatStore.sessionKey);
    agentId = session?.agentId;
  }
  if (agentId) {
    const agent = agentStore.agents.find((a) => a.id === agentId);
    if (agent) return agent.name;
  }
  return t("app.name");
});

// Delay hiding the loading screen so the progress bar can animate to 100%
function markConnected() {
  if (gateway.ready) return;
  window.openclaw.window.expandToFull();
  setTimeout(() => {
    gateway.markReady();
  }, 600);
}

function handleRetry() {
  window.openclaw.gateway.restart();
}

// ── Integrity check state ──
const integrityDialogVisible = ref(false);
const integrityResult = ref<IntegrityResult | null>(null);
const integrityLoading = ref(false);

// ── Permission dialog state (queue of pending requests) ──
interface PermissionRequestData {
  requestId: string;
  type: "file" | "shell" | "shell-async" | "app-approval";
  targetPath: string;
  dirPath: string;
  command?: string;
  accessNeeded?: string;
}
const permissionQueue = ref<PermissionRequestData[]>([]);
const currentPermission = computed(() =>
  permissionQueue.value.length > 0 ? permissionQueue.value[0] : null,
);

function handlePermissionResponse(decision: string) {
  const req = permissionQueue.value[0];
  if (!req) return;
  window.openclaw.sandbox.respondPermission(req.requestId, decision);
  // Show immediate permission decision in exec panel
  if (decision === "deny") {
    chatStore.completeToolCall(req.requestId, t("perm.denied"), true);
  } else if (decision.startsWith("grant")) {
    // Mark as "granting..." — will be updated when ACL result arrives
    const access = decision === "grant-ro" ? t("perm.grantingRo") : t("perm.grantingRw");
    chatStore.completeToolCall(req.requestId, access);
  } else if (decision === "allow-once") {
    chatStore.completeToolCall(req.requestId, t("perm.allowedOnce"));
  } else {
    chatStore.completeToolCall(req.requestId);
  }
  permissionQueue.value.shift();
}

const modifiedChanges = computed(
  () => integrityResult.value?.changes.filter((c) => c.type === "modified") ?? [],
);
const addedChanges = computed(
  () => integrityResult.value?.changes.filter((c) => c.type === "added") ?? [],
);
const removedChanges = computed(
  () => integrityResult.value?.changes.filter((c) => c.type === "removed") ?? [],
);

async function trustIntegrityChanges() {
  integrityLoading.value = true;
  try {
    await window.openclaw.skills.acceptIntegrityChanges();
    integrityDialogVisible.value = false;
    integrityResult.value = null;
    ElMessage.success(t("integrity.trusted"));
  } catch (err: any) {
    ElMessage.error(t("integrity.updateFailed", { error: err.message || err }));
  } finally {
    integrityLoading.value = false;
  }
}

function exitApp() {
  window.close();
}

function minimizeWindow() {
  window.openclaw?.window?.minimize?.();
}

const isMaximized = ref(false);

function maximizeWindow() {
  window.openclaw?.window?.maximize?.();
}

function closeWindow() {
  window.openclaw?.window?.close?.();
}

function applyTheme(mode: string) {
  const html = document.documentElement;
  html.classList.remove("light", "dark");
  if (mode === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    html.classList.add(prefersDark ? "dark" : "light");
  } else {
    html.classList.add(mode);
  }
}

const DEFAULT_LIGHT_ACCENT = "#1e1f25";

function resetAccentOverrides() {
  const rootStyle = document.documentElement.style;
  rootStyle.removeProperty("--accent");
  rootStyle.removeProperty("--accent-hover");
  rootStyle.removeProperty("--accent-subtle");
  rootStyle.removeProperty("--accent-light");
}

let unsubStatus: (() => void) | null = null;
let unsubLog: (() => void) | null = null;
let unsubWsConnected: (() => void) | null = null;
let unsubWsDisconnected: (() => void) | null = null;
let unsubChatEvent: (() => void) | null = null;
let unsubToolEvent: (() => void) | null = null;
let unsubIntegrityAlert: (() => void) | null = null;
let unsubPermission: (() => void) | null = null;
let unsubAclTimeout: (() => void) | null = null;
let unsubAclIneffective: (() => void) | null = null;
let unsubPermCompleted: (() => void) | null = null;
let unsubMaximizeChange: (() => void) | null = null;
let historyPollTimer: number | null = null;

onMounted(async () => {
  // Track window maximize state
  window.openclaw?.window
    ?.isMaximized?.()
    .then((v: boolean) => {
      isMaximized.value = v;
    })
    .catch(() => {});
  unsubMaximizeChange =
    window.openclaw?.window?.onMaximizeChange?.((v: boolean) => {
      isMaximized.value = v;
    }) ?? null;

  // Apply persisted theme and locale early, but keep the app on its default accent palette.
  try {
    const s = await window.openclaw.settings.get();
    applyTheme(s.themeMode || "light");
    resetAccentOverrides();
    if (s.accentColor && s.accentColor !== DEFAULT_LIGHT_ACCENT) {
      await window.openclaw.settings.set("accentColor", DEFAULT_LIGHT_ACCENT);
    }
    if (s.language) {
      setLocale(s.language as any);
    }
  } catch {}

  // Redirect away from /setup if still on it (e.g. after reload)
  if (router.currentRoute.value.path === "/setup") {
    router.replace("/chat");
  }

  // ── Integrity check (runs before anything else) ──
  try {
    const pending = await window.openclaw.skills.pendingIntegrityResult();
    if (pending && !pending.valid) {
      integrityResult.value = pending;
      integrityDialogVisible.value = true;
    }
  } catch {}

  // Listen for mid-session integrity alerts (file watcher)
  // Some preview environments do not expose this API yet.
  try {
    if (typeof window.openclaw.skills.onIntegrityAlert === "function") {
      unsubIntegrityAlert = window.openclaw.skills.onIntegrityAlert((result) => {
        if (!result.valid) {
          integrityResult.value = result;
          integrityDialogVisible.value = true;
        }
      });
    }
  } catch {}

  // Listen for sandbox permission requests
  unsubPermission = window.openclaw.sandbox.onPermissionRequest((data: PermissionRequestData) => {
    permissionQueue.value.push(data);
    // Add a pending entry to the exec panel so user sees what's waiting for permission
    if (chatStore.streaming) {
      const path = data.targetPath || data.dirPath;
      const access = data.accessNeeded === "ro" ? "Read" : "Write";
      const label = `${access} permission: ${path}`;
      chatStore.addPendingToolCall(data.requestId, label);
    }
  });

  // Listen for ACL verification timeout after user approved permission
  unsubAclTimeout =
    window.openclaw.sandbox.onAclTimeout?.((data: { dir: string; access: string }) => {
      // Mark the corresponding permission tool call as failed
      const pending = permissionQueue.value.find(
        (p) => p.dirPath === data.dir || p.targetPath === data.dir,
      );
      if (pending) {
        chatStore.completeToolCall(
          pending.requestId,
          t("perm.aclTimeout", { dir: data.dir }),
          true,
        );
      }
      // Also check streamToolCalls for already-completed entries
      for (const tc of chatStore.streamToolCalls) {
        if (tc.name.includes(data.dir) && !tc.isError) {
          chatStore.completeToolCall(tc.id, t("perm.aclTimeout", { dir: data.dir }), true);
        }
      }
      ElMessage.warning({
        message: t("perm.aclTimeout", { dir: data.dir }),
        duration: 8000,
        showClose: true,
      });
    }) ?? null;

  // Listen for ACL-ineffective reports (ACL set but AppContainer still Access Denied)
  unsubAclIneffective =
    window.openclaw.sandbox.onAclIneffective?.(
      (data: { dir: string; deniedPath: string; access: string; command?: string }) => {
        const detail = data.command
          ? `\n${t("perm.commandLabel")}: ${data.command.substring(0, 120)}`
          : "";
        ElMessage.error({
          message: t("perm.aclIneffective", { dir: data.dir, path: data.deniedPath }) + detail,
          duration: 12000,
          showClose: true,
        });
      },
    ) ?? null;

  // Listen for ACL grant results to update exec panel with final status
  unsubPermCompleted =
    window.openclaw.sandbox.onPermissionCompleted?.((data) => {
      if (data.result === "verified") {
        const access = data.access === "rw" ? t("perm.grantedRw") : t("perm.grantedRo");
        chatStore.completeToolCall(data.requestId, access);
      } else if (data.result === "verify-timeout") {
        const access = data.access === "rw" ? t("perm.grantedRw") : t("perm.grantedRo");
        chatStore.completeToolCall(data.requestId, `${access} (${t("perm.verifyPending")})`);
      } else if (data.result === "failed") {
        chatStore.completeToolCall(data.requestId, t("perm.aclFailed"), true);
      }
    }) ?? null;

  // Gateway process status
  unsubStatus = window.openclaw.gateway.onStatus((status) => {
    gateway.status = status;
    if (status === "running") {
      window.openclaw.gateway.getPort().then((p) => (gateway.port = p));
    }
  });
  unsubLog = window.openclaw.gateway.onLog((msg) => {
    gateway.addLog(msg);
  });

  // WebSocket connection status
  unsubWsConnected = window.openclaw.gateway.onWsConnected((mainSessionKey) => {
    const wasStreaming = chatStore.streaming;
    chatStore.wsConnected = true;
    markConnected();
    // Apply the canonical session key from gateway hello, but only if
    // the user is still on the default/initial session.  If the user
    // switched to a custom session before the reconnect, preserve it
    // to avoid duplicating or orphaning that session.
    if (mainSessionKey) {
      const current = chatStore.sessionKey;
      const isDefaultSession = !current || current === "main" || current === mainSessionKey;
      if (isDefaultSession) {
        chatStore.sessionKey = mainSessionKey;
        chatStore.resolvedSessionKey = mainSessionKey;
      }
    }
    // Register in session store
    sessionStore.ensureSession(chatStore.sessionKey);
    chatStore.loadHistory();
    // If we were streaming when the WS dropped, the "final" event may have
    // been lost.  Probe the server to check whether the task actually
    // completed — this is authoritative and works regardless of active tools.
    if (wasStreaming) {
      setTimeout(() => chatStore.recoverAfterReconnect(), 5_000);
    }
    // Fetch scheduled tasks now that gateway is connected
    taskStore.fetchTasks();
    // Refresh WeChat login status (important after gateway restart)
    gateway.refreshWeixinStatus();
  });
  unsubWsDisconnected = window.openclaw.gateway.onWsDisconnected(() => {
    chatStore.wsConnected = false;
  });

  // Chat events (delta, final, aborted, error)
  unsubChatEvent = window.openclaw.chat.onEvent((payload) => {
    chatStore.handleChatEvent(payload);
  });

  // Agent tool events (start, result)
  unsubToolEvent = window.openclaw.chat.onToolEvent((payload) => {
    chatStore.handleToolEvent(payload);
  });

  // Actual shell command notifications from sandbox-preload
  if (window.openclaw.chat.onExecCommand) {
    window.openclaw.chat.onExecCommand((data) => {
      chatStore.updateLatestExecCommand(data.command);
    });
  }

  // Get initial status
  window.openclaw.gateway.getStatus().then((s) => (gateway.status = s));
  window.openclaw.gateway.getPort().then((p) => (gateway.port = p));
  window.openclaw.chat.isConnected().then((c) => {
    if (c && !chatStore.wsConnected) {
      chatStore.wsConnected = c;
      markConnected();
      chatStore.loadHistory();
    }
  });

  // (Theme, accent, locale already applied above before setup check)

  // React to OS theme changes when in "system" mode
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    window.openclaw.settings.get().then((s) => {
      if (s.themeMode === "system") applyTheme("system");
    });
  });

  // Poll for new messages (catches WeChat-originated messages
  // that don't trigger a desktop chat event).
  // loadHistory() internally skips Vue reactivity update when messages
  // haven't changed, so the UI won't flicker on no-op polls.
  historyPollTimer = window.setInterval(() => {
    if (chatStore.wsConnected && !chatStore.streaming && !chatStore.sending) {
      chatStore.loadHistory({ showLoading: false });
    }
    chatStore.checkStaleStream();
  }, 5000);
});

onUnmounted(() => {
  unsubStatus?.();
  unsubLog?.();
  unsubWsConnected?.();
  unsubWsDisconnected?.();
  unsubChatEvent?.();
  unsubToolEvent?.();
  unsubIntegrityAlert?.();
  unsubPermission?.();
  unsubAclTimeout?.();
  unsubAclIneffective?.();
  unsubPermCompleted?.();
  unsubMaximizeChange?.();
  if (historyPollTimer) window.clearInterval(historyPollTimer);
});
</script>

<style scoped>
.app-layout,
.main-content,
.app-header,
.win-ctrl,
.integrity-hint,
.integrity-file {
  --ux-surface-primary: var(--smtc-background-web-page-primary, var(--bg-primary));
  --ux-surface-secondary: var(--smtc-background-window-primary-solid, var(--bg-secondary));
  --ux-surface-hover: var(--smtc-background-ctrl-subtle-hover, #f0f0f0);
  --ux-danger-surface: var(--smtc-status-danger-background);
  --ux-danger-text: var(--smtc-status-danger-foreground);
  --ux-text-primary: var(--smtc-foreground-ctrl-neutral-primary-rest, var(--text-primary));
  --ux-text-secondary: var(--smtc-foreground-ctrl-neutral-secondary-rest, var(--text-secondary));
  --ux-border: var(--smtc-stroke-divider-subtle, #e0e0e0);
}

.app-layout {
  display: flex;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid var(--ux-border);
  background: var(--ux-surface-primary);
  position: relative;
  will-change: contents;
}

.main-content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--ux-surface-secondary);
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  height: 56px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--ux-border);
  -webkit-app-region: drag;
}

.app-header-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--ux-text-primary);
}

.app-header-controls {
  display: flex;
  align-items: center;
  gap: 4px;
  -webkit-app-region: no-drag;
}

.win-ctrl {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  color: var(--ux-text-secondary);
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}

.win-ctrl:hover {
  background: var(--ux-surface-hover);
}

.win-ctrl--close:hover {
  background: var(--ux-danger-surface);
}

.win-ctrl--close:hover svg {
  stroke: var(--ux-danger-text);
}

.main-drag-region {
  display: none;
}

.integrity-hint {
  margin-bottom: 12px;
  color: var(--ux-text-secondary);
}

.integrity-file {
  font-size: 13px;
  color: var(--ux-text-secondary);
  padding-left: 12px;
}
</style>
