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
          <button class="sp-agent-flyout-search-btn" @click="focusAgentSearch">
            {{ t("sidebar.agents") }}
          </button>
          <button
            class="sp-agent-flyout-add-btn"
            :title="t('sidebar.newAgent')"
            :aria-label="t('sidebar.newAgent')"
            @click="handleCreateAgent"
          >
            <IconPlus :size="16" />
          </button>
        </div>

        <input
          ref="flyoutSearchInputRef"
          v-model="agentQuery"
          class="sp-agent-flyout-input"
          :placeholder="t('sidebar.searchAgents')"
          type="text"
        />

        <div class="sp-agent-avatar-list">
          <button
            v-for="agent in filteredAgents"
            :key="agent.id"
            class="sp-agent-avatar-item"
            :class="{ active: agentStore.currentAgentId === agent.id }"
            :title="agent.name"
            @click="handleAgentSelect(agent.id)"
          >
            <img class="sp-agent-avatar-img" :src="agent.avatar" :alt="agent.name" />
            <span class="sp-agent-avatar-name">{{ agent.name }}</span>
          </button>
        </div>

        <button class="sp-agent-flyout-footer" @click="handleExploreAgents">
          <span>{{ t("sidebar.explorePopularAgents") }}</span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
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
            v-for="s in allSessions"
            :key="s.key"
            class="sp-chat-item"
            :class="{ selected: chatStore.sessionKey === s.key }"
            @click="selectSession(s.key)"
          >
            <span class="sp-chat-item-title">{{ s.title }}</span>
            <span class="sp-chat-item-delete" @click.stop="deleteSession(s.key)"
              ><IconClose :size="12" :stroke-width="2.5"
            /></span>
          </button>
          <div v-if="allSessions.length === 0" class="sp-empty-hint">
            {{ t("sidebar.noChats") }}
          </div>
        </div>
      </div>

      <!-- Usage -->
      <button class="sp-menu-item" :class="{ active: route.path === '/usage' }" @click="openUsage">
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
          <rect x="3" y="12" width="3" height="8" rx="1" />
          <rect x="8.5" y="8" width="3" height="12" rx="1" />
          <rect x="14" y="4" width="3" height="16" rx="1" />
        </svg>
        <span>{{ t("sidebar.usage") }}</span>
      </button>

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
  </aside>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from "vue";
import { useRouter, useRoute } from "vue-router";
import { ElMessage } from "element-plus";
import { useGatewayStore } from "@/stores/gateway";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/sessions";
import { useAgentStore } from "@/stores/agents";
import { t } from "@/i18n";
import { useUsagePanel } from "@/composables/useUsagePanel";
import IconPlus from "@/components/icons/IconPlus.vue";
import IconChevronDown from "@/components/icons/IconChevronDown.vue";
import IconClose from "@/components/icons/IconClose.vue";

const router = useRouter();
const route = useRoute();
const gateway = useGatewayStore();
const chatStore = useChatStore();
const sessionStore = useSessionStore();
const agentStore = useAgentStore();

const { open: openUsage } = useUsagePanel();

const chatExpanded = ref(true);
const isAgentFlyoutOpen = ref(false);
const agentQuery = ref("");
const flyoutRef = ref<HTMLElement | null>(null);
const brandTriggerRef = ref<HTMLElement | null>(null);
const flyoutSearchInputRef = ref<HTMLInputElement | null>(null);
const flyoutTop = ref(0);
const flyoutLeft = ref(0);

const flyoutStyle = computed(() => ({
  top: `${flyoutTop.value}px`,
  left: `${flyoutLeft.value}px`,
}));

const filteredAgents = computed(() => {
  const q = agentQuery.value.trim().toLowerCase();
  if (!q) return agentStore.agents;
  return agentStore.agents.filter((agent) => {
    const name = agent.name.toLowerCase();
    const desc = (agent.description || "").toLowerCase();
    return name.includes(q) || desc.includes(q);
  });
});

const currentAgent = computed(() => {
  const session = sessionStore.sessions.find((s) => s.key === chatStore.sessionKey);
  const agentId = session?.agentId || agentStore.currentAgentId;
  return agentStore.agents.find((a) => a.id === agentId) || agentStore.agents[0];
});

onMounted(() => {
  gateway.refreshWeixinStatus();
  document.addEventListener("mousedown", handleDocumentPointerDown);
  document.addEventListener("keydown", handleDocumentKeyDown);
  window.addEventListener("resize", handleWindowResize);
  window.addEventListener("scroll", handleWindowScroll, true);
});

onUnmounted(() => {
  document.removeEventListener("mousedown", handleDocumentPointerDown);
  document.removeEventListener("keydown", handleDocumentKeyDown);
  window.removeEventListener("resize", handleWindowResize);
  window.removeEventListener("scroll", handleWindowScroll, true);
});

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
    nextTick(() => {
      updateFlyoutPosition();
      flyoutSearchInputRef.value?.focus();
    });
  }
}

function closeAgentFlyout() {
  isAgentFlyoutOpen.value = false;
}

function focusAgentSearch() {
  if (!isAgentFlyoutOpen.value) {
    isAgentFlyoutOpen.value = true;
  }
  nextTick(() => {
    updateFlyoutPosition();
    flyoutSearchInputRef.value?.focus();
  });
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

const allSessions = computed(() =>
  [...sessionStore.sessions].sort((a, b) => b.createdAt - a.createdAt),
);

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

function handleExploreAgents() {
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

.sp-agent-flyout-search-btn {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  padding: 4px 2px;
  font-family: inherit;
}

.sp-agent-flyout-search-btn:hover {
  color: var(--text-primary);
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

.sp-agent-flyout-input {
  width: 100%;
  border: 1px solid #e3ddd7;
  border-radius: 10px;
  background: #fff;
  color: var(--text-primary);
  font-size: 13px;
  padding: 8px 10px;
  outline: none;
}

.sp-agent-flyout-input:focus {
  border-color: #c9beb3;
}

html.dark .sp-agent-flyout-input {
  background: var(--bg-primary);
  border-color: var(--border);
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

.sp-agent-avatar-img {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
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

.sp-agent-flyout-footer {
  margin-top: 2px;
  border: none;
  border-top: 1px solid #ece7e2;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  padding: 10px 4px 2px;
  text-align: right;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.sp-agent-flyout-footer:hover {
  color: var(--text-primary);
}

html.dark .sp-agent-flyout-footer {
  border-top-color: var(--border);
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sp-chat-item-delete {
  display: none;
  padding: 0 4px;
  color: var(--text-muted);
  font-size: 15px;
  cursor: pointer;
  border-radius: 4px;
  line-height: 1;
  flex-shrink: 0;
}

.sp-chat-item-delete:hover {
  color: var(--danger);
}

.sp-chat-item:hover .sp-chat-item-delete {
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
