<template>
  <div class="chat-view">
    <!-- Mode toggle bar -->
    <div class="mode-toggle-bar">
      <button
        class="mode-toggle-btn"
        :class="{ active: viewMode === 'chat' }"
        @click="viewMode = 'chat'"
      >
        {{ t("studio.switchToChat") }}
      </button>
      <button
        class="mode-toggle-btn"
        :class="{ active: viewMode === 'studio' }"
        @click="switchToStudio"
      >
        {{ t("studio.switchToStudio") }}
      </button>
    </div>

    <!-- Chat mode -->
    <template v-if="viewMode === 'chat'">
      <!-- Welcome (no messages yet) -->
      <div v-if="!hasMessages && !chatStore.loading" class="chat-welcome-area">
        <ChatWelcome mode="hero" :agent="currentAgent" @select="handleCardSelect" />
      </div>

      <!-- Chat thread (has messages) -->
      <template v-else>
        <div
          class="chat-thread"
          ref="threadRef"
          @scroll="handleScroll"
          @wheel="handleUserScrollGesture"
          @touchmove="handleUserScrollGesture"
          @click="handleThreadClick"
        >
          <ChatMessageList />
        </div>
      </template>

      <!-- New messages indicator — positioned above input -->
      <button
        v-if="hasMessages && showNewMessages"
        class="chat-new-messages"
        @click="scrollToBottom"
      >
        {{ t("chat.newMessages") }}
      </button>

      <!-- Input area -->
      <div class="home-input-area">
        <div class="home-input-box">
          <textarea
            ref="inputRef"
            v-model="inputText"
            :placeholder="composePlaceholder"
            :rows="isCompact ? 1 : 2"
            @keydown="handleKeydown"
            @input="autoResize"
            :disabled="!chatStore.wsConnected"
          ></textarea>
          <div class="home-input-bottom">
            <button class="home-input-plus" :title="t('chat.addAttachment')">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <div class="home-input-right">
              <button
                v-if="chatStore.streaming"
                class="home-input-send home-input-send--stop"
                @click="handleAbort"
                :title="t('chat.stopTask')"
              >
                <span class="stop-square"></span>
              </button>
              <button
                v-else
                class="home-input-send"
                :disabled="!inputText.trim() || !chatStore.wsConnected"
                @click="handleSend"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        <div class="home-disclaimer">
          {{ t("chat.disclaimer") }}
        </div>
      </div>
    </template>

    <!-- Studio mode -->
    <template v-if="viewMode === 'studio'">
      <div v-if="studioStore.backendStatus === 'starting'" class="studio-loading">
        <div class="studio-loading-text">{{ t("studio.backend.starting") }}</div>
      </div>
      <div v-else-if="studioStore.backendStatus === 'failed'" class="studio-loading">
        <div class="studio-loading-text studio-loading-error">{{ t("studio.backend.failed") }}</div>
        <button class="studio-retry-btn" @click="switchToStudio">
          {{ t("studio.backend.retry") }}
        </button>
      </div>
      <div v-else class="studio-canvas-area">
        <StudioGame />
        <StudioChatPanel />
        <div class="studio-status-bar">
          <StudioStatusPanel />
        </div>
      </div>

      <!-- Input area (same position as chat mode) -->
      <div class="home-input-area">
        <div class="home-input-box">
          <textarea
            ref="inputRef"
            v-model="inputText"
            :placeholder="composePlaceholder"
            :rows="isCompact ? 1 : 2"
            @keydown="handleKeydown"
            @input="autoResize"
            :disabled="!chatStore.wsConnected"
          ></textarea>
          <div class="home-input-bottom">
            <button class="home-input-plus" :title="t('chat.addAttachment')">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <div class="home-input-right">
              <button
                v-if="chatStore.streaming"
                class="home-input-send home-input-send--stop"
                @click="handleAbort"
                :title="t('chat.stopTask')"
              >
                <span class="stop-square"></span>
              </button>
              <button
                v-else
                class="home-input-send"
                :disabled="!inputText.trim() || !chatStore.wsConnected"
                @click="handleSend"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        <div class="home-disclaimer">
          {{ t("chat.disclaimer") }}
        </div>
      </div>
    </template>

    <ModelSetupDialog v-model="modelSetupVisible" @configured="handleModelConfigured" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import { useChatStore } from "@/stores/chat";
import { useAgentStore } from "@/stores/agents";
import { useStudioStore } from "@/stores/studio";
import { t } from "@/i18n";
import ChatMessageList from "@/components/chat/ChatMessageList.vue";
import ChatWelcome from "@/components/ChatWelcome.vue";
import StudioGame from "@/components/studio/StudioGame.vue";
import StudioChatPanel from "@/components/studio/StudioChatPanel.vue";
import StudioStatusPanel from "@/components/studio/StudioStatusPanel.vue";
import ModelSetupDialog from "@/components/ModelSetupDialog.vue";
import { useRoute } from "vue-router";

const route = useRoute();
const chatStore = useChatStore();
const agentStore = useAgentStore();
const studioStore = useStudioStore();

const viewMode = ref<"chat" | "studio">("chat");
const inputText = ref("");
const inputRef = ref<HTMLTextAreaElement>();
const threadRef = ref<HTMLDivElement>();
const showNewMessages = ref(false);
const isCompact = ref(window.innerHeight < 700);
const modelSetupVisible = ref(false);
const pendingModelSetupMessage = ref("");
let isUserScrolledUp = false;

function onWindowResize() {
  isCompact.value = window.innerHeight < 700;
}

const hasMessages = computed(() => chatStore.messages.length > 0 || chatStore.streaming);

function handleCardSelect(prompt: string) {
  inputText.value = prompt;
  nextTick(() => inputRef.value?.focus());
}

function clearComposeInput() {
  if (!inputText.value && !chatStore.pendingPrompt) return;
  inputText.value = "";
  chatStore.pendingPrompt = null;
  nextTick(() => autoResize());
}

const currentAgent = computed(() => {
  const agentId = route.params.agentId as string | undefined;
  if (!agentId) return undefined;
  return agentStore.agents.find((a) => a.id === agentId);
});

onMounted(() => {
  window.addEventListener("resize", onWindowResize);
  window.addEventListener("microclaw:clear-compose", clearComposeInput);
  if (chatStore.messages.length) {
    nextTick(scrollToBottom);
  }
  try {
    studioStore.initialize();
  } catch {
    // Studio APIs may be absent in lightweight preview mode.
  }
});

onUnmounted(() => {
  window.removeEventListener("resize", onWindowResize);
  window.removeEventListener("microclaw:clear-compose", clearComposeInput);
  studioStore.teardown();
});

async function switchToStudio() {
  viewMode.value = "studio";
  if (studioStore.backendStatus !== "running" && studioStore.backendStatus !== "starting") {
    await studioStore.startBackend();
  }
}

// Pre-fill input from pending prompt
watch(
  () => chatStore.pendingPrompt,
  (prompt) => {
    if (prompt) {
      inputText.value = prompt;
      chatStore.pendingPrompt = null;
      nextTick(() => autoResize());
    }
  },
  { immediate: true },
);

watch(
  () => [chatStore.sessionKey, route.params.agentId],
  () => {
    clearComposeInput();
  },
);

const composePlaceholder = computed(() =>
  chatStore.wsConnected ? t("chat.inputPlaceholder") : t("chat.waitingGateway"),
);

// Auto-scroll
watch(
  () => [
    chatStore.messages.length,
    chatStore.streamText,
    chatStore.streaming,
    chatStore.streamToolCalls.length,
  ],
  () => {
    if (!isUserScrolledUp) {
      nextTick(scrollToBottom);
    } else {
      const el = threadRef.value;
      if (el) {
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceFromBottom < 150) {
          nextTick(scrollToBottom);
        } else {
          showNewMessages.value = true;
        }
      }
    }
  },
);

// Extra scroll when streaming starts — the waiting GIF image loads async,
// so a single nextTick may fire before the image inflates the container.
watch(
  () => chatStore.streaming,
  (streaming) => {
    if (streaming && !isUserScrolledUp) {
      setTimeout(scrollToBottom, 100);
      setTimeout(scrollToBottom, 350);
    }
  },
);

// Reset scroll state on session switch — the "New Messages" indicator and
// any "user scrolled up" flag belong to the previous conversation; the newly
// loaded session should start at the bottom with a clean slate.
watch(
  () => chatStore.sessionKey,
  () => {
    showNewMessages.value = false;
    isUserScrolledUp = false;
    nextTick(scrollToBottom);
  },
);

function handleScroll() {
  const el = threadRef.value;
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  if (atBottom) {
    isUserScrolledUp = false;
    showNewMessages.value = false;
  }
  // Note: we deliberately do NOT set isUserScrolledUp = true here, because
  // streaming content can grow scrollHeight asynchronously (e.g. waiting GIF
  // image load, message deltas), which fires scroll events without any user
  // gesture. We only flip the flag in response to real user scroll gestures
  // via handleUserScrollGesture().
}

function handleUserScrollGesture() {
  const el = threadRef.value;
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  isUserScrolledUp = !atBottom;
  if (atBottom) showNewMessages.value = false;
}

function scrollToBottom() {
  const el = threadRef.value;
  if (el) el.scrollTop = el.scrollHeight;
  showNewMessages.value = false;
  isUserScrolledUp = false;
}

function autoResize() {
  nextTick(() => {
    const el = inputRef.value;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 150) + "px";
    }
  });
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    handleSend();
  }
}

async function handleSend() {
  const text = inputText.value.trim();
  if (!text || !chatStore.wsConnected) return;
  if (await needsModelSetupBeforeSend()) {
    pendingModelSetupMessage.value = text;
    modelSetupVisible.value = true;
    return;
  }
  await sendText(text);
}

async function sendText(text: string) {
  inputText.value = "";
  autoResize();
  await chatStore.sendMessage(text);
}

async function needsModelSetupBeforeSend(): Promise<boolean> {
  try {
    return await window.openclaw.config.needsSetup();
  } catch {
    return false;
  }
}

async function handleModelConfigured() {
  const text = pendingModelSetupMessage.value || inputText.value.trim();
  pendingModelSetupMessage.value = "";
  if (!text || !chatStore.wsConnected) return;
  await sendText(text);
}

async function handleAbort() {
  await chatStore.abort();
}

function handleThreadClick(e: MouseEvent) {
  const target = (e.target as HTMLElement)?.closest?.("a");
  if (!target) return;
  const href = target.getAttribute("href");
  if (href && (href.startsWith("http://") || href.startsWith("https://"))) {
    e.preventDefault();
    e.stopPropagation();
    window.openclaw.shell.openExternal(href);
  }
}
</script>

<style scoped>
.chat-view,
.mode-toggle-btn,
.chat-new-messages,
.studio-canvas-area,
.studio-retry-btn,
.home-input-box,
.home-input-plus,
.home-input-send,
.home-disclaimer {
  --ux-surface-primary: var(--smtc-background-web-page-primary, var(--bg-primary));
  --ux-surface-secondary: var(--smtc-background-window-primary-solid, var(--bg-secondary));
  --ux-surface-tertiary: var(--smtc-background-card-on-primary-default-rest, var(--bg-tertiary));
  --ux-surface-hover: var(--smtc-background-ctrl-subtle-hover, #f5f5f5);
  --ux-ctrl-brand-rest: var(--smtc-background-ctrl-brand-rest, #211d1a);
  --ux-ctrl-brand-hover: var(--smtc-background-ctrl-brand-hover, #302b27);
  --ux-ctrl-on-brand: var(--smtc-foreground-ctrl-on-brand-rest, #fff);
  --ux-text-primary: var(--smtc-foreground-ctrl-neutral-primary-rest, var(--text-primary));
  --ux-text-secondary: var(--smtc-foreground-ctrl-neutral-secondary-rest, var(--text-secondary));
  --ux-text-muted: var(--smtc-foreground-ctrl-hint-default, var(--text-muted));
  --ux-border: var(--smtc-stroke-divider-subtle, var(--border));
  --ux-focus: var(--smtc-background-ctrl-subtle-selected-rest, var(--text-muted));
  --ux-shadow-card: var(--smtc-shadow-card-rest-key, 0 2px 12px rgba(0, 0, 0, 0.15));
}

.chat-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--ux-surface-primary);
  overflow: hidden;
  position: relative;
}

/* ── Mode toggle bar ── */
.mode-toggle-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: clamp(8px, 2vw, 20px) clamp(8px, 2vw, 20px) 4px;
  flex-shrink: 0;
}

.mode-toggle-btn {
  padding: 4px 14px;
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  border: 1px solid var(--ux-border);
  border-radius: 999px;
  background: transparent;
  color: var(--ux-text-muted);
  cursor: pointer;
  transition: all 0.15s;
}

.mode-toggle-btn.active {
  background: var(--ux-ctrl-brand-rest);
  color: var(--ux-ctrl-on-brand);
  border-color: var(--ux-ctrl-brand-rest);
}

.mode-toggle-btn:not(.active):hover {
  background: var(--ux-surface-hover);
  color: var(--ux-text-primary);
}

/* ── Welcome ── */
.chat-welcome-area {
  flex: 1;
  overflow: visible;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 0;
}

/* ── Thread ── */
.chat-thread {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 28px clamp(12px, 3vw, 32px) 48px;
  min-height: 0;
}

.chat-thread > :deep(*) {
  max-width: 768px;
  margin-left: auto;
  margin-right: auto;
}

/* ── New messages indicator ── */
.chat-new-messages {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  color: var(--ux-ctrl-on-brand);
  background: var(--ux-ctrl-brand-rest);
  border: none;
  border-radius: 999px;
  cursor: pointer;
  position: absolute;
  bottom: 100px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  box-shadow: var(--ux-shadow-card);
  transition:
    background 0.15s,
    box-shadow 0.15s;
}

.chat-new-messages:hover {
  background: var(--ux-ctrl-brand-hover);
  box-shadow: var(--smtc-shadow-flyout-key, 0 4px 16px rgba(0, 0, 0, 0.2));
}

/* ── Studio mode ── */
.studio-canvas-area {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  background: var(--smtc-background-window-tab-band-solid, #2d2d3d);
  border-radius: 14px;
  margin: 8px 32px 12px;
}

.studio-loading {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--ux-text-muted);
}

.studio-loading-text {
  font-size: 14px;
  font-weight: 500;
}

.studio-loading-error {
  color: var(--danger);
}

.studio-retry-btn {
  padding: 6px 20px;
  border: 1px solid var(--ux-border);
  border-radius: 8px;
  background: var(--ux-surface-secondary);
  color: var(--ux-text-primary);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
  font-family: inherit;
}

.studio-retry-btn:hover {
  background: var(--ux-surface-hover);
}

.studio-status-bar {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 50;
}

/* ── Input area (matches HomeView) ── */
.home-input-area {
  flex-shrink: 0;
  padding: 0 clamp(12px, 3vw, 32px) 20px;
  max-width: calc(768px + 64px);
  margin-left: auto;
  margin-right: auto;
  width: 100%;
  position: relative;
  z-index: 1;
}

.home-input-box {
  border: 1px solid var(--ux-border);
  border-radius: 20px;
  transition:
    box-shadow 0.15s,
    border-color 0.15s;
}

.home-input-box:focus-within {
  border-color: transparent;
  box-shadow: 0 0 0 2px var(--ux-focus);
}

.home-input-box textarea {
  width: 100%;
  padding: 16px 20px 6px;
  border: none;
  outline: none;
  background: transparent;
  font-size: 14px;
  color: var(--ux-text-primary);
  font-family: inherit;
  resize: none;
  line-height: 1.5;
}

.home-input-box textarea::placeholder {
  color: var(--ux-text-muted);
}

.home-input-box textarea:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.home-input-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px 12px;
}

.home-input-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.home-input-plus {
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

.home-input-plus:hover {
  background: var(--ux-surface-hover);
}

.home-input-send {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: none;
  background: var(--smtc-background-ctrl-neutral-rest, #e1e1e1);
  color: var(--ux-text-secondary);
  border-radius: 50%;
  cursor: pointer;
  transition:
    background 0.15s,
    opacity 0.15s;
  box-shadow: var(--ux-shadow-card);
}

.home-input-send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.home-input-send:not(:disabled):hover {
  background: var(--smtc-background-ctrl-neutral-hover, #d5d5d5);
}

.home-input-send--stop {
  background: var(--ux-ctrl-brand-rest);
  color: var(--ux-ctrl-on-brand);
  opacity: 1;
  cursor: pointer;
}

.home-input-send--stop:hover {
  background: var(--ux-ctrl-brand-hover);
}

.stop-square {
  display: block;
  width: 12px;
  height: 12px;
  background: var(--ux-ctrl-on-brand);
  border-radius: 2px;
}

.home-disclaimer {
  text-align: center;
  font-size: 11px;
  color: var(--ux-text-muted);
  margin-top: 16px;
  margin-bottom: 4px;
  line-height: 1.4;
}

@media (max-height: 700px) {
  .home-input-box textarea {
    padding: 10px 16px 4px;
  }

  .home-disclaimer {
    display: none;
  }

  .home-input-area {
    padding-bottom: 8px;
  }

  .home-input-bottom {
    padding: 0 8px 6px;
  }
}
</style>
