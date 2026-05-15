<template>
  <!-- Trigger button (top-right of canvas) -->
  <button
    v-show="!panelOpen"
    class="chat-panel-trigger"
    type="button"
    :aria-label="t('studio.switchToChat')"
    @click="togglePanel"
    @pointerdown.stop
  >
    <span class="trigger-icon" aria-hidden="true">💬</span>
    <span v-if="hasNotification" class="trigger-dot" aria-hidden="true"></span>
  </button>

  <!-- Overlay panel -->
  <transition name="panel-slide">
    <div
      v-if="panelOpen"
      class="chat-panel"
      :class="{ wide: panelWide }"
      @pointerenter="studioStore.setUiOverlayPointerBlock(true)"
      @pointerleave="studioStore.setUiOverlayPointerBlock(false)"
      @pointerdown.stop
      @click.stop
    >
      <!-- Header -->
      <div class="chat-panel__header">
        <span class="chat-panel__title">{{ t("studio.switchToChat") }}</span>
        <button
          class="chat-panel__expand-btn"
          type="button"
          @click="panelWide = !panelWide"
          :title="panelWide ? t('studio.chatPanel.narrow') : t('studio.chatPanel.wide')"
          :aria-label="panelWide ? t('studio.chatPanel.narrow') : t('studio.chatPanel.wide')"
          :aria-pressed="panelWide"
        >
          <svg
            v-if="!panelWide"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
          <svg
            v-else
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="4 14 10 14 10 20" />
            <polyline points="20 10 14 10 14 4" />
            <line x1="14" y1="10" x2="21" y2="3" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
        <button
          class="chat-panel__close-btn"
          type="button"
          @click="closePanel"
          :title="t('studio.chatPanel.close')"
          :aria-label="t('studio.chatPanel.close')"
        >
          ✕
        </button>
      </div>

      <!-- Messages -->
      <div ref="scrollRef" class="chat-panel__messages" @scroll="onScroll">
        <ChatMessageList :studioMode="true" />
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import { useChatStore } from "@/stores/chat";
import { useStudioStore } from "@/stores/studio";
import { t } from "@/i18n";
import ChatMessageList from "@/components/chat/ChatMessageList.vue";

const chatStore = useChatStore();
const studioStore = useStudioStore();

const panelOpen = ref(true);
const panelWide = ref(false);
const hasNotification = ref(false);
const scrollRef = ref<HTMLDivElement>();
let userScrolledUp = false;

function togglePanel() {
  panelOpen.value = !panelOpen.value;
  if (panelOpen.value) {
    hasNotification.value = false;
    nextTick(scrollToBottom);
  } else {
    studioStore.setUiOverlayPointerBlock(false);
  }
}

function closePanel() {
  panelOpen.value = false;
  studioStore.setUiOverlayPointerBlock(false);
}

function scrollToBottom() {
  if (scrollRef.value) {
    scrollRef.value.scrollTop = scrollRef.value.scrollHeight;
  }
}

function onScroll() {
  if (!scrollRef.value) return;
  const { scrollTop, scrollHeight, clientHeight } = scrollRef.value;
  userScrolledUp = scrollHeight - scrollTop - clientHeight > 40;
}

// Auto-scroll on new messages / stream updates
watch(
  () => [chatStore.messages.length, chatStore.streamText],
  () => {
    if (panelOpen.value && !userScrolledUp) {
      nextTick(scrollToBottom);
    }
  },
);

// Notification dot: show when a streaming response finishes and panel is closed
watch(
  () => chatStore.streaming,
  (streaming, wasStreaming) => {
    if (wasStreaming && !streaming && !panelOpen.value) {
      hasNotification.value = true;
    }
  },
);
</script>

<style scoped>
.chat-panel-trigger {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 100;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid rgba(25, 28, 38, 0.92);
  background: rgba(41, 47, 64, 0.86);
  color: #f6f7fb;
  cursor: pointer;
  box-shadow:
    0 2px 0 rgba(10, 12, 18, 0.92),
    0 4px 10px rgba(0, 0, 0, 0.35);
  transition:
    transform 0.12s ease,
    background 0.12s ease;
}

.chat-panel-trigger:hover {
  transform: translateY(-1px);
  background: rgba(47, 53, 72, 0.92);
}

.trigger-icon {
  font-size: 16px;
  line-height: 1;
}

.trigger-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 8px;
  height: 8px;
  background: #ff4444;
  border: 1px solid rgba(25, 28, 38, 0.92);
  border-radius: 50%;
  animation: dot-pulse 1.5s ease-in-out infinite;
}

@keyframes dot-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

/* ── Panel ── */

.chat-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 320px;
  z-index: 90;
  display: flex;
  flex-direction: column;
  border-left: 2px solid rgba(25, 28, 38, 0.92);
  background: rgba(22, 25, 35, 0.92);
  backdrop-filter: blur(4px);
  color: #f6f7fb;
  font-family: "Cascadia Code", "Consolas", monospace;
}

.chat-panel.wide {
  width: 480px;
}

.chat-panel__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 2px solid rgba(25, 28, 38, 0.92);
  background: rgba(29, 33, 46, 0.95);
  flex-shrink: 0;
}

.chat-panel__title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
  flex: 1;
}

.chat-panel__expand-btn,
.chat-panel__close-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(101, 112, 138, 0.5);
  background: transparent;
  color: #c4ccdf;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.12s ease;
}

.chat-panel__expand-btn:hover,
.chat-panel__close-btn:hover {
  background: rgba(59, 69, 92, 0.8);
}

.chat-panel__messages {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ── Slide transition ── */

.panel-slide-enter-active,
.panel-slide-leave-active {
  transition:
    transform 0.2s ease,
    opacity 0.2s ease;
}

.panel-slide-enter-from,
.panel-slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

.panel-slide-enter-to,
.panel-slide-leave-from {
  transform: translateX(0);
  opacity: 1;
}

/* ── Scrollbar ── */

.chat-panel__messages::-webkit-scrollbar {
  width: 6px;
}

.chat-panel__messages::-webkit-scrollbar-track {
  background: transparent;
}

.chat-panel__messages::-webkit-scrollbar-thumb {
  background: rgba(101, 112, 138, 0.4);
  border-radius: 3px;
}
</style>
