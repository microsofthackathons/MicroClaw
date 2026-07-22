<template>
  <aside class="side-panel">
    <!-- Drag region -->
    <div class="sp-drag-region"></div>

    <!-- Brand / avatar row -->
    <div class="sp-brand">
      <div class="sp-brand-inner" @click="toggleMode">
        <img class="sp-brand-avatar" :src="currentAgent.avatar" :alt="currentAgent.name" />
        <div>
          <div class="sp-brand-name">{{ currentAgent.name }}</div>
          <div class="sp-brand-tagline">{{ t("sidebar.tagline") }}</div>
        </div>
      </div>
    </div>

    <!-- Navigation (default) -->
    <nav v-if="panelMode === 'chats'" class="sp-nav">
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

      <!-- Phone -->
      <button
        class="sp-menu-item"
        :class="{ active: route.path === '/phone' }"
        @click="router.push('/phone')"
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
          <rect x="5" y="2" width="14" height="20" rx="2" />
          <line x1="12" y1="18" x2="12.01" y2="18" />
        </svg>
        <span>{{ t("sidebar.phone") }}</span>
      </button>

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

    <!-- Agent list (after clicking brand) -->
    <div v-else class="sp-nav sp-agent-section">
      <AgentSearch v-model="searchQuery" :placeholder="t('sidebar.searchAgents')" />
      <button class="sp-create-btn" @click="handleCreateAgent">
        <IconPlus :size="18" />
        <span>{{ t("sidebar.newAgent") }}</span>
      </button>
      <div class="sp-agent-list">
        <AgentListItem
          v-for="agent in filteredAgents"
          :key="agent.id"
          :agent="agent"
          :is-active="agentStore.currentAgentId === agent.id"
          @select="handleAgentSelect"
          @quick-task="handleQuickTask"
        />
      </div>
    </div>

    <!-- Bottom connection status -->
    <div class="sp-footer">
      <div class="sp-status" :class="{ 'is-connected': chatStore.wsConnected }">
        <span class="sp-status-dot"></span>
        {{ chatStore.wsConnected ? t("sidebar.connected") : t("sidebar.disconnected") }}
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useGatewayStore } from "@/stores/gateway";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/sessions";
import { useAgentStore } from "@/stores/agents";
import { useAgentList } from "@/composables/useAgentList";
import { t } from "@/i18n";
import { useUsagePanel } from "@/composables/useUsagePanel";
import AgentSearch from "@/components/agent/AgentSearch.vue";
import AgentListItem from "@/components/agent/AgentListItem.vue";
import IconPlus from "@/components/icons/IconPlus.vue";
import IconChevronDown from "@/components/icons/IconChevronDown.vue";
import IconClose from "@/components/icons/IconClose.vue";

const router = useRouter();
const route = useRoute();
const gateway = useGatewayStore();
const chatStore = useChatStore();
const sessionStore = useSessionStore();
const agentStore = useAgentStore();
const { searchQuery, filteredAgents } = useAgentList(computed(() => agentStore.addedAgents));

const { open: openUsage } = useUsagePanel();

const chatExpanded = ref(true);
const panelMode = ref<"chats" | "agents">("chats");

const currentAgent = computed(() => {
  const session = sessionStore.sessions.find((s) => s.key === chatStore.sessionKey);
  const agentId = session?.agentId || agentStore.currentAgentId;
  return agentStore.agents.find((a) => a.id === agentId) || agentStore.agents[0];
});

onMounted(() => {
  gateway.refreshWeixinStatus();
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

function toggleMode() {
  if (panelMode.value === "chats") {
    panelMode.value = "agents";
    ensureEmptySession();
    router.push(`/chat/${agentStore.currentAgentId}`);
  } else {
    panelMode.value = "chats";
    const currentSession = sessionStore.sessions.find((s) => s.key === chatStore.sessionKey);
    const agentId = currentSession?.agentId || "main";
    router.push(`/chat/${agentId}`);
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

function deleteSession(key: string) {
  chatStore.deleteSession(key);
}

function clearComposeDraft() {
  chatStore.pendingPrompt = null;
  window.dispatchEvent(new Event("microclaw:clear-compose"));
}

// ── Agent list ──
function handleAgentSelect(agentId: string) {
  clearComposeDraft();
  agentStore.selectAgent(agentId);
  ensureEmptySession();
  router.push(`/chat/${agentId}`);
}

async function handleQuickTask(task: string) {
  const agentId = agentStore.currentAgentId;
  await router.push(`/chat/${agentId}`);
  chatStore.pendingPrompt = task;
}

function handleCreateAgent() {
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
  height: 36px;
  -webkit-app-region: drag;
  flex-shrink: 0;
}

/* ── Brand row ── */
.sp-brand {
  padding: 0 clamp(12px, 2vw, 24px) clamp(12px, 2vw, 24px);
}

.sp-brand-inner {
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

/* ── Create chat button ── */
.sp-create-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
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

/* ── Footer ── */
.sp-footer {
  padding: 12px clamp(12px, 2vw, 24px) clamp(12px, 2vw, 24px);
}

.sp-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
}

.sp-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
  transition: background 0.2s;
}

.sp-status.is-connected {
  color: var(--text-secondary);
}

.sp-status.is-connected .sp-status-dot {
  background: var(--success);
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
