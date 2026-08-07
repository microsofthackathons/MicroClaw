<template>
  <aside class="side-panel">
    <!-- Drag region -->
    <div class="sp-drag-region"></div>

    <!-- Brand / avatar row -->
    <div class="sp-brand" ref="brandTriggerRef">
      <div class="sp-brand-inner" @click="toggleAgentFlyout">
        <img class="sp-brand-avatar" :src="currentAgent.avatar" :alt="currentAgent.name" />
        <div>
          <div class="sp-brand-name">{{ currentAgent.name }}</div>
          <div class="sp-brand-tagline">{{ t("sidebar.tagline") }}</div>
        </div>
        <span
          class="sp-conn-dot"
          :class="{ 'is-connected': chatStore.wsConnected }"
          :title="chatStore.wsConnected ? t('sidebar.connected') : t('sidebar.disconnected')"
          :aria-label="chatStore.wsConnected ? t('sidebar.connected') : t('sidebar.disconnected')"
        ></span>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="isAgentFlyoutOpen"
        ref="flyoutRef"
        class="sp-agent-flyout"
        :style="flyoutStyle"
        @click.stop
      >
        <div class="sp-agent-flyout-header">
          <span class="sp-agent-flyout-title">{{ t("sidebar.agents") }}</span>
          <button
            class="sp-agent-flyout-add-btn"
            :title="t('sidebar.newAgent')"
            :aria-label="t('sidebar.newAgent')"
            @click="handleCreateAgent"
          >
            <IconPlus :size="16" />
          </button>
        </div>

        <div class="sp-agent-avatar-list">
          <button
            v-for="agent in agentStore.agents"
            :key="agent.id"
            class="sp-agent-avatar-item"
            :class="{ active: agentStore.currentAgentId === agent.id }"
            :title="agent.name"
            @click="handleAgentSelect(agent.id)"
          >
            <span class="sp-agent-avatar-frame">
              <img
                class="sp-agent-avatar-img"
                :src="agent.avatar"
                :alt="agent.name"
                @load="normalizeAgentAvatar"
              />
            </span>
            <span class="sp-agent-avatar-name">{{ agent.name }}</span>
          </button>
        </div>
      </div>
    </Teleport>

    <!-- Navigation -->
    <nav class="sp-nav">
      <!-- Create new chat button -->
      <button class="sp-create-btn" @click="createNewChat">
        <IconPlus :size="18" />
        <span>{{ t("sidebar.createChat") }}</span>
      </button>

      <!-- Chat section - collapsible -->
      <div class="sp-section">
        <button class="sp-section-header" @click="chatExpanded = !chatExpanded">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span class="sp-section-label">{{ t("sidebar.chats") }}</span>
          <IconChevronDown
            class="sp-chevron"
            :class="{ expanded: chatExpanded }"
            :size="16"
            :stroke-width="2"
          />
        </button>

        <div v-show="chatExpanded" class="sp-section-body">
          <button
            v-for="s in visibleSessions"
            :key="s.key"
            class="sp-chat-item"
            :class="{ selected: route.name === 'chat' && chatStore.sessionKey === s.key }"
            @click="selectSession(s.key)"
          >
            <span class="sp-chat-item-title" :title="sessionTitle(s)">
              {{ sessionTitle(s) }}
            </span>
            <span
              class="sp-chat-item-action sp-chat-item-pin"
              :class="{ pinned: s.pinned }"
              :title="s.pinned ? t('sidebar.unpin') : t('sidebar.pin')"
              :aria-label="s.pinned ? t('sidebar.unpin') : t('sidebar.pin')"
              @click.stop="sessionStore.togglePinned(s.key)"
              ><IconPin :size="12"
            /></span>
            <span
              class="sp-chat-item-action sp-chat-item-delete"
              :title="t('sidebar.delete')"
              :aria-label="t('sidebar.delete')"
              @click.stop="deleteSession(s.key)"
              ><IconClose :size="12" :stroke-width="2.5"
            /></span>
          </button>
          <div v-if="visibleSessions.length === 0" class="sp-empty-hint">
            {{ t("sidebar.noChats") }}
          </div>
        </div>
      </div>

      <!-- Settings -->
      <button
        class="sp-menu-item"
        :class="{ active: route.path.startsWith('/settings') }"
        @click="router.push('/settings')"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
          />
        </svg>
        <span>{{ t("sidebar.settings") }}</span>
      </button>
    </nav>

    <section class="sp-usage-snapshot" aria-live="polite">
      <div class="sp-usage-head">
        <span class="sp-usage-title">{{ t("sidebar.usageSnapshotTitle") }}</span>
        <button
          class="sp-usage-toggle"
          :title="usageCollapsed ? t('sidebar.usageSnapshotExpand') : t('sidebar.usageSnapshotCollapse')"
          :aria-label="
            usageCollapsed ? t('sidebar.usageSnapshotExpand') : t('sidebar.usageSnapshotCollapse')
          "
          @click="toggleUsageCollapsed"
        >
          <svg
            class="sp-usage-toggle-icon"
            :class="{ collapsed: usageCollapsed }"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>

      <template v-if="!usageCollapsed">
        <div v-if="usageLoading" class="sp-usage-state">{{ t("settings.usageLoading") }}</div>
        <div v-else-if="usageSnapshot" class="sp-usage-grid">
          <div class="sp-usage-card">
            <span class="sp-usage-label">{{ t("sidebar.usageSnapshotSpend") }}</span>
            <span class="sp-usage-value">{{ formatCny(usageSnapshot.totalSpend) }}</span>
          </div>
          <div class="sp-usage-card">
            <span class="sp-usage-label">{{ t("sidebar.usageSnapshotTokens") }}</span>
            <span class="sp-usage-value">{{ formatCompact(usageSnapshot.totalTokens) }}</span>
          </div>
        </div>
        <div v-else-if="!gatewayOnline" class="sp-usage-state">{{ t("sidebar.usageSnapshotOffline") }}</div>
        <div v-else class="sp-usage-state">{{ t("sidebar.usageSnapshotNoData") }}</div>

        <div class="sp-usage-foot">
          <span>{{ t("sidebar.usageSnapshotPeriod") }}</span>
          <span v-if="lastUpdatedLabel">{{ t("sidebar.usageSnapshotUpdated", { time: lastUpdatedLabel }) }}</span>
        </div>
      </template>
    </section>

  </aside>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from "vue";
import { useRouter, useRoute } from "vue-router";
import { ElMessage } from "element-plus";
import { useGatewayStore } from "@/stores/gateway";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/sessions";
import { useAgentStore } from "@/stores/agents";
import { t } from "@/i18n";
import IconPlus from "@/components/icons/IconPlus.vue";
import IconChevronDown from "@/components/icons/IconChevronDown.vue";
import IconClose from "@/components/icons/IconClose.vue";
import IconPin from "@/components/icons/IconPin.vue";

const router = useRouter();
const route = useRoute();
const gateway = useGatewayStore();
const chatStore = useChatStore();
const sessionStore = useSessionStore();
const agentStore = useAgentStore();

interface UsageSnapshot {
  totalSpend: number;
  totalTokens: number;
  exchangeRate: number | null;
}

// Fallback mirrors USD_TO_CNY_FALLBACK_RATE in SettingsView.vue / the main process.
const USD_TO_CNY_FALLBACK_RATE = 7.2;

const usageSnapshot = ref<UsageSnapshot | null>(null);
const usageLoading = ref(false);
const usageLastUpdated = ref<Date | null>(null);
const usageCollapsed = ref(false);
const openClawTitles = ref<Record<string, string>>({});
const avatarContentScales = new Map<string, number>();
let usageRefreshTimer: ReturnType<typeof setInterval> | null = null;
let titleRequestGeneration = 0;

const chatExpanded = ref(true);
const isAgentFlyoutOpen = ref(false);
const flyoutRef = ref<HTMLElement | null>(null);
const brandTriggerRef = ref<HTMLElement | null>(null);
const flyoutTop = ref(0);
const flyoutLeft = ref(0);

const flyoutStyle = computed(() => ({
  top: `${flyoutTop.value}px`,
  left: `${flyoutLeft.value}px`,
}));

const gatewayOnline = computed(() => gateway.ready && gateway.status === "running");
const lastUpdatedLabel = computed(() => {
  if (!usageLastUpdated.value) return "";
  return usageLastUpdated.value.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
});

const currentAgent = computed(() => {
  const session = sessionStore.sessions.find((s) => s.key === chatStore.sessionKey);
  const agentId = session?.agentId || agentStore.currentAgentId;
  return agentStore.agents.find((a) => a.id === agentId) || agentStore.agents[0];
});

onMounted(() => {
  gateway.refreshWeixinStatus();
  try {
    usageCollapsed.value = localStorage.getItem("microclaw:usageSnapshotCollapsed") === "1";
  } catch {}
  document.addEventListener("mousedown", handleDocumentPointerDown);
  document.addEventListener("keydown", handleDocumentKeyDown);
  window.addEventListener("resize", handleWindowResize);
  window.addEventListener("scroll", handleWindowScroll, true);
  void loadUsageSnapshot();
  usageRefreshTimer = setInterval(() => {
    void loadUsageSnapshot();
  }, 60_000);
});

onUnmounted(() => {
  document.removeEventListener("mousedown", handleDocumentPointerDown);
  document.removeEventListener("keydown", handleDocumentKeyDown);
  window.removeEventListener("resize", handleWindowResize);
  window.removeEventListener("scroll", handleWindowScroll, true);
  if (usageRefreshTimer) {
    clearInterval(usageRefreshTimer);
    usageRefreshTimer = null;
  }
});

async function loadUsageSnapshot() {
  if (usageLoading.value) return;
  usageLoading.value = true;
  try {
    const usageApi = window.openclaw?.usage?.getStats;
    if (!gatewayOnline.value || typeof usageApi !== "function") {
      if (import.meta.env.DEV) {
        applyMockSnapshot();
      } else {
        usageSnapshot.value = null;
      }
      return;
    }

    const stats = await usageApi();
    usageSnapshot.value = {
      totalSpend: Number(stats?.totalSpend || 0),
      totalTokens: Number(stats?.totalTokens || 0),
      exchangeRate: Number(stats?.exchangeRate) || null,
    };
    usageLastUpdated.value = new Date();
  } catch {
    if (import.meta.env.DEV) {
      applyMockSnapshot();
    } else {
      usageSnapshot.value = null;
    }
  } finally {
    usageLoading.value = false;
  }
}

function applyMockSnapshot() {
  usageSnapshot.value = {
    totalSpend: 42.35,
    totalTokens: 128400,
    exchangeRate: null,
  };
  usageLastUpdated.value = new Date();
}

function toggleUsageCollapsed() {
  usageCollapsed.value = !usageCollapsed.value;
  try {
    localStorage.setItem("microclaw:usageSnapshotCollapsed", usageCollapsed.value ? "1" : "0");
  } catch {}
}

function formatCompact(value: number) {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value || 0);
}

function formatCny(value: number) {
  const rate = usageSnapshot.value?.exchangeRate ?? USD_TO_CNY_FALLBACK_RATE;
  return `${t("settings.currencySymbol")}${((value || 0) * rate).toFixed(2)}`;
}

function normalizeAgentAvatar(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  const cachedScale = avatarContentScales.get(image.currentSrc);
  if (cachedScale !== undefined) {
    image.style.setProperty("--sp-agent-avatar-scale", String(cachedScale));
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || canvas.width === 0 || canvas.height === 0) return;

  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (pixels[(y * canvas.width + x) * 4 + 3] <= 8) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  const contentWidth = maxX - minX + 1;
  const contentHeight = maxY - minY + 1;
  const scale = contentWidth > 0 && contentHeight > 0
    ? Math.min(canvas.width / contentWidth, canvas.height / contentHeight, 2)
    : 1;
  avatarContentScales.set(image.currentSrc, scale);
  image.style.setProperty("--sp-agent-avatar-scale", String(scale));
}

/**
 * Ensure the active chat is a fresh session bound to the currently-selected agent.
 * Starts a new session when the current chat already has messages, OR when it
 * belongs to a different agent than the one now selected — otherwise switching
 * agents on an empty chat would keep routing to (and displaying) the old agent.
 */
function ensureEmptySession() {
  const targetAgentId = agentStore.currentAgentId;
  if (chatStore.messages.length > 0 || chatStore.currentSessionAgentId !== targetAgentId) {
    chatStore.newSession(targetAgentId);
  }
  // Tag the (new or existing) session with the current agent.
  const key = chatStore.sessionKey;
  const s = sessionStore.sessions.find((s) => s.key === key);
  if (s) {
    s.agentId = targetAgentId;
  }
}

function toggleAgentFlyout() {
  isAgentFlyoutOpen.value = !isAgentFlyoutOpen.value;
  if (isAgentFlyoutOpen.value) {
    nextTick(updateFlyoutPosition);
  }
}

function closeAgentFlyout() {
  isAgentFlyoutOpen.value = false;
}

function updateFlyoutPosition() {
  const trigger = brandTriggerRef.value;
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  const gap = 12;
  const flyoutWidth = flyoutRef.value?.offsetWidth || 260;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const maxTop = viewportHeight - 120;

  flyoutLeft.value = Math.min(rect.right + gap, viewportWidth - flyoutWidth - 12);
  flyoutTop.value = Math.max(8, Math.min(rect.top, maxTop));
}

function handleWindowResize() {
  if (isAgentFlyoutOpen.value) {
    updateFlyoutPosition();
  }
}

function handleWindowScroll() {
  if (isAgentFlyoutOpen.value) {
    updateFlyoutPosition();
  }
}

function handleDocumentPointerDown(event: MouseEvent) {
  if (!isAgentFlyoutOpen.value) return;
  const target = event.target as Node;
  if (flyoutRef.value?.contains(target)) return;
  if (brandTriggerRef.value?.contains(target)) return;
  closeAgentFlyout();
}

function handleDocumentKeyDown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    closeAgentFlyout();
  }
}

const visibleSessions = computed(() =>
  sessionStore.sessions
    .filter((session) => (session.agentId || "main") === agentStore.currentAgentId)
    .sort(
      (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.createdAt - a.createdAt,
    ),
);

watch(
  [
    gatewayOnline,
    () => visibleSessions.value.map((session) => `${session.key}\0${session.title}`).join("\n"),
    () => chatStore.sessionTitleRefreshRevision,
  ],
  () => void loadSessionTitles(),
  { immediate: true },
);

async function loadSessionTitles() {
  const generation = ++titleRequestGeneration;
  const keys = visibleSessions.value.map((session) => session.key).slice(0, 64);
  if (!gatewayOnline.value || keys.length === 0) {
    openClawTitles.value = {};
    return;
  }
  openClawTitles.value = {};
  try {
    const response = await window.openclaw.chat.listSessionTitles(keys);
    if (generation !== titleRequestGeneration) return;
    openClawTitles.value = response.titles ?? {};
  } catch {
    if (generation === titleRequestGeneration) openClawTitles.value = {};
  }
}

function sessionTitle(session: { key: string; title: string }) {
  return openClawTitles.value[session.key] || session.title;
}

function selectSession(key: string) {
  chatStore.switchSession(key);
  const session = sessionStore.sessions.find((s) => s.key === key);
  const agentId = session?.agentId || "main";
  agentStore.selectAgent(agentId);
  router.push(`/chat/${agentId}`);
}

function createNewChat() {
  ensureEmptySession();
  router.push(`/chat/${agentStore.currentAgentId}`);
}

async function deleteSession(key: string) {
  try {
    await chatStore.deleteSession(key);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ElMessage.error(t("sidebar.chatDeleteFailed", { error: message }));
  }
}

function clearComposeDraft() {
  chatStore.pendingPrompt = null;
  window.dispatchEvent(new Event("microclaw:clear-compose"));
}

// ── Agent list ──
function handleAgentSelect(agentId: string) {
  clearComposeDraft();
  agentStore.selectAgent(agentId);
  if (route.path.startsWith("/chat")) {
    ensureEmptySession();
    router.push(`/chat/${agentId}`);
  }
  closeAgentFlyout();
}

function handleCreateAgent() {
  closeAgentFlyout();
  router.push("/chat/market");
}

</script>

<style scoped>
.side-panel {
  width: clamp(200px, 22vw, 280px);
  min-width: 200px;
  height: 100vh;
  background: #fbfbf9;
  border-right: 1px solid #eeebe8;
  display: flex;
  flex-direction: column;
  user-select: none;
  overflow: hidden;
  flex-shrink: 0;
}

html.dark .side-panel {
  background: var(--bg-secondary);
  border-right-color: var(--border);
}

.sp-drag-region {
  height: 12px;
  -webkit-app-region: drag;
  flex-shrink: 0;
}

/* ── Brand row ── */
.sp-brand {
  padding: 0 clamp(12px, 2vw, 24px) clamp(12px, 2vw, 24px);
}

.sp-brand-inner {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  margin: 0 -12px;
  border-radius: 12px;
  cursor: pointer;
  transition: background 0.15s;
  background: #f9f5f2;
}

.sp-brand-inner:hover {
  background: #f0ece7;
}

html.dark .sp-brand-inner {
  background: var(--bg-tertiary);
}

html.dark .sp-brand-inner:hover {
  background: var(--border);
}

.sp-brand-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.sp-conn-dot {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text-muted);
  border: 2px solid #f9f5f2;
  transition: background 0.2s;
}

.sp-conn-dot.is-connected {
  background: var(--success);
}

html.dark .sp-conn-dot {
  border-color: var(--bg-tertiary);
}

.sp-brand-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.sp-brand-tagline {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.sp-agent-flyout {
  position: fixed;
  width: min(260px, calc(100vw - 24px));
  max-height: min(62vh, 520px);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: #fff;
  border: 1px solid #e9e5e1;
  border-radius: 14px;
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.12);
  z-index: 30;
}

html.dark .sp-agent-flyout {
  background: var(--bg-secondary);
  border-color: var(--border);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.35);
}

.sp-agent-flyout-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sp-agent-flyout-title {
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  padding: 4px 2px;
}

.sp-agent-flyout-add-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: #f4efea;
  color: var(--text-primary);
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: background 0.15s;
}

.sp-agent-flyout-add-btn:hover {
  background: #e9e2dc;
}

html.dark .sp-agent-flyout-add-btn {
  background: var(--bg-tertiary);
}

html.dark .sp-agent-flyout-add-btn:hover {
  background: var(--border);
}

.sp-agent-avatar-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  padding-right: 2px;
}

.sp-agent-avatar-item {
  width: 100%;
  border: none;
  border-radius: 10px;
  background: transparent;
  padding: 8px 10px;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  transition: background 0.15s;
}

.sp-agent-avatar-item:hover {
  background: #f7f2ee;
}

html.dark .sp-agent-avatar-item:hover {
  background: var(--bg-tertiary);
}

.sp-agent-avatar-item.active {
  background: #efe8e1;
}

html.dark .sp-agent-avatar-item.active {
  background: var(--bg-tertiary);
}

.sp-agent-avatar-frame {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  flex-shrink: 0;
  overflow: hidden;
}

.sp-agent-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scale(var(--sp-agent-avatar-scale, 1));
}

.sp-agent-avatar-name {
  flex: 1;
  text-align: left;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.25;
}

/* ── Create chat button ── */
.sp-create-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 20px 10px 16px;
  margin-bottom: 16px;
  background: #1d1d1f;
  border: none;
  color: #fff;
  border-radius: var(--radius-pill);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}

.sp-create-btn:hover {
  background: #2b2b2d;
}

html.dark .sp-create-btn {
  background: #1d1d1f;
}

html.dark .sp-create-btn:hover {
  background: #2b2b2d;
}

/* ── Navigation ── */
.sp-nav {
  flex: 1;
  padding: 0 clamp(8px, 1.5vw, 16px) 8px;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
}

.sp-usage-snapshot {
  padding: 10px clamp(8px, 1.5vw, 16px) 12px;
  background: #fbfbf9;
}

html.dark .sp-usage-snapshot {
  background: var(--bg-secondary);
}

.sp-usage-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.sp-usage-title {
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 600;
}

.sp-usage-toggle {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  width: 18px;
  height: 18px;
  padding: 0;
  line-height: 1;
  display: grid;
  place-items: center;
  border-radius: 4px;
  font-size: 11px;
}

.sp-usage-toggle-icon {
  transition: transform 0.2s ease;
}

.sp-usage-toggle-icon.collapsed {
  transform: rotate(-90deg);
}

.sp-usage-toggle:hover {
  background: #f0ece7;
  color: var(--text-primary);
}

html.dark .sp-usage-toggle:hover {
  background: var(--bg-tertiary);
}

.sp-usage-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.sp-usage-card {
  border: 1px solid #ece7e2;
  border-radius: 8px;
  padding: 6px;
  background: #fff;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

html.dark .sp-usage-card {
  border-color: var(--border);
  background: var(--bg-primary);
}

.sp-usage-label {
  font-size: 10px;
  color: var(--text-muted);
}

.sp-usage-value {
  font-size: 12px;
  color: var(--text-primary);
  font-weight: 600;
  line-height: 1.2;
}

.sp-usage-state {
  font-size: 12px;
  color: var(--text-muted);
  padding: 4px 0;
}

.sp-usage-foot {
  margin-top: 8px;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 10px;
  color: var(--text-muted);
}

/* ── Chat section ── */
.sp-section {
  margin-bottom: 8px;
}

.sp-section-header {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}

.sp-section-header:hover {
  background: #f9f5f2;
}

html.dark .sp-section-header:hover {
  background: var(--bg-tertiary);
}

.sp-section-label {
  flex: 1;
  text-align: left;
}

.sp-chevron {
  color: var(--text-muted);
  transition: transform 0.2s;
  transform: rotate(-90deg);
  flex-shrink: 0;
}

.sp-chevron.expanded {
  transform: rotate(0deg);
}

.sp-section-body {
  margin-top: 4px;
  margin-left: 24px;
}

/* ── Chat items ── */
.sp-chat-item {
  width: 100%;
  display: flex;
  align-items: center;
  text-align: left;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}

.sp-chat-item:hover {
  background: #f9f5f2;
  color: var(--text-primary);
}

html.dark .sp-chat-item:hover {
  background: var(--bg-tertiary);
}

.sp-chat-item.selected {
  background: #f0ece7;
  color: var(--text-primary);
  font-weight: 600;
}

html.dark .sp-chat-item.selected {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.sp-chat-item-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sp-chat-item-action {
  display: none;
  padding: 0 4px;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 4px;
  line-height: 1;
  flex-shrink: 0;
}

.sp-chat-item-pin.pinned {
  display: block;
  color: var(--text-secondary);
}

.sp-chat-item-pin:hover,
.sp-chat-item-pin.pinned:hover {
  color: var(--text-primary);
}

.sp-chat-item-delete:hover {
  color: var(--danger);
}

.sp-chat-item:hover .sp-chat-item-action {
  display: block;
}

.sp-empty-hint {
  padding: 12px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}

/* ── Menu items ── */
.sp-menu-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
  margin-bottom: 2px;
}

.sp-menu-item:hover {
  background: #f9f5f2;
  color: var(--text-primary);
}

.sp-menu-item.active {
  background: #f0ece7;
  color: var(--text-primary);
  font-weight: 600;
}

html.dark .sp-menu-item:hover {
  background: var(--bg-tertiary);
}

html.dark .sp-menu-item.active {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

/* ── Agent section ── */
.sp-agent-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sp-agent-list {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
  padding: 0 2px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

</style>
