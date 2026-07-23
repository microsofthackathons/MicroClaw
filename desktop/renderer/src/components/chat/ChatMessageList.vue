<template>
  <div class="chat-messages" :class="{ 'chat-messages--studio-mode': studioMode }">
    <!-- Loading (only shown on initial load, not background refresh) -->
    <div v-if="chatStore.loading && chatStore.messages.length === 0" class="chat-empty">
      <div class="chat-empty__hint">{{ t("chat.loading") }}</div>
    </div>

    <!-- Empty state -->
    <div v-else-if="chatStore.messages.length === 0 && !chatStore.streaming" class="chat-empty">
      <template v-if="!studioMode">
        <div class="chat-empty__logo">
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#fff"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
        </div>
        <div class="chat-empty__title">MicroClaw</div>
      </template>
      <div class="chat-empty__hint">{{ t("chat.emptyHint") }}</div>
    </div>

    <!-- All message groups -->
    <template v-for="(group, gi) in groupedMessages" :key="group.key">
      <div class="chat-group" :class="group.normalizedRole">
        <img
          v-if="group.normalizedRole === 'assistant'"
          class="chat-avatar"
          :src="avatarImg"
          alt=""
        />
        <div class="chat-group-messages">
          <!-- Plan progress panel (history) — shown when a completed message has plan markers -->
          <PlanProgressPanel
            v-if="group.normalizedRole === 'assistant' && getHistoryPlan(group)"
            :plan="getHistoryPlan(group)!"
            :isLive="false"
            :planKey="makePlanKey(getHistoryPlan(group))"
          />

          <!-- Merged tool calls panel (combines real-time tool events + history toolCall/toolResult) -->
          <div
            v-if="group.normalizedRole === 'assistant' && getMergedToolCalls(gi, group).length > 0"
            class="exec-panel exec-panel--history"
            style="margin-bottom: 8px"
          >
            <div class="exec-panel__header" @click="toggleHistoryPanel('tools-' + gi)">
              <span class="exec-panel__toggle">
                <svg
                  :class="{ rotated: isHistoryPanelOpen('tools-' + gi) }"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </span>
              <span class="exec-panel__title">{{ t("chat.executionSteps") }}</span>
              <span class="exec-panel__count">{{ getMergedToolCalls(gi, group).length }}</span>
            </div>
            <transition name="exec-slide">
              <div v-if="isHistoryPanelOpen('tools-' + gi)" class="exec-panel__body">
                <div
                  v-for="tool in getMergedToolCalls(gi, group)"
                  :key="tool.id"
                  class="exec-step done"
                  :class="{ 'exec-step--error': tool.isError }"
                >
                  <span class="exec-step__icon">
                    <svg
                      v-if="!tool.isError"
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                    <svg
                      v-else
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <line x1="15" y1="9" x2="9" y2="15" />
                      <line x1="9" y1="9" x2="15" y2="15" />
                    </svg>
                  </span>
                  <span class="exec-step__name">{{ tool.name }}</span>
                  <span v-if="tool.input" class="exec-step__meta">{{ tool.input }}</span>
                  <span
                    v-if="tool.actualCommand && tool.actualCommand !== tool.input"
                    class="exec-step__actual"
                    >&#x2BA1; {{ tool.actualCommand }}</span
                  >
                  <span
                    v-if="tool.result"
                    class="exec-step__result"
                    :class="{ 'exec-step__result--error': tool.isError }"
                    >{{ tool.result }}</span
                  >
                </div>
              </div>
            </transition>
          </div>

          <!-- Merged thinking panel for the entire group -->
          <div
            v-if="group.normalizedRole === 'assistant' && getGroupThinking(group)"
            class="context-panel"
            style="margin-bottom: 4px"
          >
            <div class="context-panel__header" @click="toggleHistoryPanel('thinking-' + group.key)">
              <span class="context-panel__toggle">
                <svg
                  :class="{ rotated: isHistoryPanelOpen('thinking-' + group.key) }"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </span>
              <span class="context-panel__icon">&#x1F4AD;</span>
              <span class="context-panel__title">{{ t("chat.thinking") }}</span>
            </div>
            <transition name="exec-slide">
              <div v-if="isHistoryPanelOpen('thinking-' + group.key)" class="context-panel__body">
                <div class="context-panel__text thinking-merged">
                  <div
                    v-for="(block, ti) in getGroupThinkingBlocks(group)"
                    :key="ti"
                    class="thinking-block"
                  >
                    <span class="thinking-block__dot"></span>
                    <div class="thinking-block__text" v-html="renderMarkdown(block)"></div>
                  </div>
                </div>
              </div>
            </transition>
          </div>

          <div
            v-for="(msg, idx) in group.messages"
            :key="group.key + '-' + idx"
            class="chat-bubble"
            :class="[
              group.normalizedRole,
              { editable: group.normalizedRole === 'user' && !isEditingMessage(group, idx) },
              { 'hidden-msg': group.normalizedRole === 'assistant' && isToolMessage(msg) },
            ]"
            @dblclick.prevent="
              group.normalizedRole === 'user' &&
              !isEditingMessage(group, idx) &&
              startEditMessage(group, idx)
            "
          >
            <!-- Assistant message rendering -->
            <template v-if="group.normalizedRole === 'assistant'">
              <!-- toolCall/toolResult messages: skip rendering (shown in exec panel) -->
              <template v-if="isToolMessage(msg)"><!-- in exec panel --></template>
              <template v-else>
                <!-- Thinking/reasoning content — skip per-message rendering; merged at group level below -->
                <!-- Normal text content -->
                <div class="chat-content-wrapper">
                  <button class="chat-copy-btn" @click="copyMessage(getMessageText(msg))">
                    {{ justCopied ? "&#x2713;" : ""
                    }}<svg
                      v-if="!justCopied"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                  <template
                    v-for="(seg, si) in getMessageSegments(msg, group.key + '-' + idx)"
                    :key="si"
                  >
                    <div
                      v-if="seg.type === 'intermediate'"
                      class="context-panel"
                      style="margin-bottom: 4px"
                    >
                      <div
                        class="context-panel__header"
                        @click="toggleHistoryPanel('ctx-' + group.key + '-' + idx + '-' + si)"
                      >
                        <span class="context-panel__toggle">
                          <svg
                            :class="{
                              rotated: isHistoryPanelOpen(
                                'ctx-' + group.key + '-' + idx + '-' + si,
                              ),
                            }"
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2.5"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          >
                            <polyline points="9 18 15 12 9 6" />
                          </svg>
                        </span>
                        <span class="context-panel__icon">&#x1F4CE;</span>
                        <span class="context-panel__title">{{ t("chat.intermediateOutput") }}</span>
                      </div>
                      <transition name="exec-slide">
                        <div
                          v-if="isHistoryPanelOpen('ctx-' + group.key + '-' + idx + '-' + si)"
                          class="context-panel__body"
                        >
                          <div
                            class="context-panel__text"
                            v-html="renderMarkdown(seg.content)"
                          ></div>
                        </div>
                      </transition>
                    </div>
                    <div v-else class="chat-text" v-html="renderMarkdown(seg.content)"></div>
                  </template>
                </div>
              </template>
            </template>
            <!-- User message: editable on double-click -->
            <template v-if="group.normalizedRole === 'user'">
              <div v-if="isEditingMessage(group, idx)" class="chat-edit-wrapper">
                <textarea
                  ref="editInputRef"
                  class="chat-edit-input"
                  v-model="editText"
                  @keydown="handleEditKeydown"
                  rows="1"
                ></textarea>
                <div class="chat-edit-actions">
                  <button
                    class="chat-edit-btn confirm"
                    @click="confirmEdit"
                    :title="t('chat.editConfirm')"
                  >
                    {{ t("chat.editConfirm") }}
                  </button>
                  <button
                    class="chat-edit-btn cancel"
                    @click="cancelEdit"
                    :title="t('chat.editCancel')"
                  >
                    {{ t("chat.editCancel") }}
                  </button>
                </div>
              </div>
              <div v-else class="chat-text chat-text--user">
                {{ getMessageText(msg) }}
              </div>
            </template>
          </div>
        </div>
      </div>
    </template>

    <!-- Streaming: single group with one avatar -->
    <div v-if="chatStore.streaming" class="chat-group assistant">
      <img class="chat-avatar" :src="avatarImg" alt="" />
      <div class="chat-group-messages">
        <!-- Waiting GIF (shrinks away smoothly when content arrives) -->
        <div
          class="chat-waiting-gif"
          :class="{
            'chat-waiting-gif--hidden':
              displayStreamText ||
              chatStore.streamToolCalls.length > 0 ||
              hasPartialPlanBlock ||
              streamHasPlan,
          }"
        >
          <img :src="currentWaitingGif" :key="waitingGifIndex" alt="" />
        </div>

        <!-- Plan progress panel (streaming) -->
        <PlanProgressPanel
          v-if="streamHasPlan"
          :plan="streamPlan"
          :isLive="true"
          :planKey="makePlanKey(streamPlan)"
        />

        <!-- Exec panel (tool calls) — auto-collapsed when plan progress is visible -->
        <div v-if="chatStore.streamToolCalls.length > 0" class="exec-panel exec-panel--live">
          <div class="exec-panel__header" @click="execPanelOpen = !execPanelOpen">
            <span class="exec-panel__toggle">
              <svg
                :class="{ rotated: execPanelOpen }"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </span>
            <span class="exec-panel__title">{{ t("chat.executionSteps") }}</span>
            <span class="exec-panel__count">{{ chatStore.streamToolCalls.length }}</span>
            <span v-if="hasRunningTools" class="exec-panel__spinner"></span>
          </div>
          <transition name="exec-slide">
            <div v-if="execPanelOpen" class="exec-panel__body">
              <div
                v-for="tool in chatStore.streamToolCalls"
                :key="tool.id"
                class="exec-step"
                :class="{ done: tool.done, 'exec-step--error': tool.isError }"
              >
                <span class="exec-step__icon">
                  <svg
                    v-if="tool.done && !tool.isError"
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  <svg
                    v-else-if="tool.isError"
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="15" y1="9" x2="9" y2="15" />
                    <line x1="9" y1="9" x2="15" y2="15" />
                  </svg>
                  <svg
                    v-else-if="tool.waitingPermission"
                    class="exec-step__lock"
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  <span v-else class="exec-step__dot"></span>
                </span>
                <span class="exec-step__name">{{ tool.name }}</span>
                <span v-if="tool.input" class="exec-step__meta">{{ tool.input }}</span>
                <span
                  v-if="tool.actualCommand && tool.actualCommand !== tool.input"
                  class="exec-step__actual"
                  >&#x2BA1; {{ tool.actualCommand }}</span
                >
                <span
                  v-if="tool.result"
                  class="exec-step__result"
                  :class="{ 'exec-step__result--error': tool.isError }"
                  >{{ tool.result }}</span
                >
              </div>
            </div>
          </transition>
        </div>

        <!-- Text output (hidden entirely when plan progress panel is visible during streaming) -->
        <div v-if="displayStreamText && !streamHasPlan" class="chat-bubble assistant streaming">
          <div class="chat-text" v-html="renderMarkdown(displayStreamText)"></div>
        </div>
      </div>
    </div>

    <!-- Error -->
    <div v-if="chatStore.lastError" class="chat-error" role="alert">
      <div class="chat-error__header">
        <svg
          class="chat-error__icon"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span class="chat-error__title">{{
          t("chat.error." + chatStore.lastError.code + ".title")
        }}</span>
      </div>
      <div class="chat-error__body">
        {{ t("chat.error." + chatStore.lastError.code + ".hint") }}
      </div>
      <details v-if="chatStore.lastError.raw" class="chat-error__details">
        <summary>{{ t("chat.error.showDetails") }}</summary>
        <pre class="chat-error__raw">{{ chatStore.lastError.raw }}</pre>
      </details>
      <div class="chat-error__actions">
        <button class="chat-error__btn chat-error__btn--primary" @click="openModelSettings">
          {{ t("chat.error.openSettings") }}
        </button>
        <button class="chat-error__btn" @click="chatStore.lastError = null">
          {{ t("chat.error.dismiss") }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch } from "vue";
import { useRouter } from "vue-router";
import { useChatStore } from "@/stores/chat";
import { useAgentStore } from "@/stores/agents";
import {
  renderMarkdown,
  stripAnsi,
  segmentMessageContent,
  type MessageSegment,
} from "@/utils/markdown";
import { t } from "@/i18n";
import { useGroupedMessages, type MessageGroup } from "@/composables/useGroupedMessages";
import {
  usePlanProgress,
  parsePlanProgress,
  stripPlanMarkers,
} from "@/composables/usePlanProgress";
import PlanProgressPanel from "./PlanProgress.vue";
import searchGif from "@/assets/openclaw_search_preview_transparent.gif";
import bookGif from "@/assets/book.gif";
import binocularsGif from "@/assets/binoculars.gif";
import mapGif from "@/assets/map.gif";
import defaultAvatar from "@/assets/normal.png";

defineProps<{
  studioMode?: boolean;
}>();

const chatStore = useChatStore();
const agentStore = useAgentStore();
const router = useRouter();

/** Avatar of the agent bound to the current session (falls back to the default). */
const avatarImg = computed(() => {
  const agentId = chatStore.currentSessionAgentId;
  const agent = agentStore.agents.find((a) => a.id === agentId);
  return agent?.avatar || defaultAvatar;
});

function openModelSettings() {
  router.push({ name: "settings", params: { section: "models" } });
}

const execPanelOpen = ref(true);
const openHistoryPanels = ref(new Set<string>());
const justCopied = ref(false);

// ── Edit-message state ──
const editingGroupKey = ref<string | null>(null);
const editingMsgIdx = ref<number>(-1);
const editText = ref("");
const editInputRef = ref<HTMLTextAreaElement[]>();

const groupedMessages = useGroupedMessages(computed(() => chatStore.messages));

// ── Plan progress for streaming text ──
const streamFullText = computed(() => chatStore.streamText);
const isStreaming = computed(() => chatStore.streaming);
const { plan: streamPlan, hasPlan: streamHasPlan } = usePlanProgress(streamFullText, isStreaming);

/**
 * Stable identity for a plan instance, derived from session + plan signature.
 * Returns the same key for the streaming view and the eventual history view
 * of the same assistant turn so per-step elapsed timings persist across:
 *   - session switches (component unmount/remount)
 *   - the streaming → history transition (different component instance)
 */
function makePlanKey(plan: ReturnType<typeof parsePlanProgress> | null): string {
  if (!plan) return "";
  const sig = plan.steps.map((s) => `${s.step}|${s.label}`).join("||");
  return `${chatStore.sessionKey}::${sig}`;
}

// Auto-collapse exec panel when plan progress becomes available
watch(streamHasPlan, (hasPlan) => {
  if (hasPlan) execPanelOpen.value = false;
});

/** Detect an unclosed ```json:plan block that hasn't been fully received yet. */
const hasPartialPlanBlock = computed(() => {
  const full = chatStore.streamText;
  if (!full) return false;
  // Check if there's an opening ```json:plan without a matching closing ```
  const openIdx = full.lastIndexOf("```json:plan");
  if (openIdx === -1) return false;
  const afterOpen = full.indexOf("```", openIdx + 12);
  return afterOpen === -1; // no closing ``` found
});

const displayStreamText = computed(() => {
  const full = chatStore.streamText;
  if (!full) return "";
  // Hide text while a plan block is being received
  if (hasPartialPlanBlock.value) return "";
  const offset = chatStore.streamTextOffset;
  let modelPart = offset > 0 && offset < full.length ? full.slice(offset) : full;
  // Strip plan markers from display
  modelPart = stripPlanMarkers(modelPart);
  return stripAnsi(modelPart).trim();
});

// ── Rotating waiting GIFs ──
const waitingGifs = [searchGif, bookGif, binocularsGif, mapGif];
const waitingGifIndex = ref(0);
let waitingGifTimer: ReturnType<typeof setInterval> | null = null;

const currentWaitingGif = computed(() => waitingGifs[waitingGifIndex.value]);

watch(
  () => chatStore.streaming && !displayStreamText.value && chatStore.streamToolCalls.length === 0,
  (show) => {
    if (show) {
      waitingGifIndex.value = 0;
      waitingGifTimer = setInterval(() => {
        waitingGifIndex.value = (waitingGifIndex.value + 1) % waitingGifs.length;
      }, 2000);
    } else if (waitingGifTimer) {
      clearInterval(waitingGifTimer);
      waitingGifTimer = null;
    }
  },
);

const hasRunningTools = computed(() => chatStore.streamToolCalls.some((t) => !t.done));

// ── Plan progress for history messages ──
const _historyPlanCache = new Map<string, ReturnType<typeof parsePlanProgress>>();

// Clear cache when session changes (group keys like "group-0" repeat across sessions)
watch(
  () => chatStore.sessionKey,
  () => {
    _historyPlanCache.clear();
  },
);

function getHistoryPlan(group: MessageGroup) {
  // Check cache first to avoid re-parsing on every render
  if (_historyPlanCache.has(group.key)) return _historyPlanCache.get(group.key)!;
  // Concatenate text-only content from ALL messages in the group, then parse
  // once. This ensures:
  //   1) The json:plan block (in an early message) is found together with
  //      step markers (which may be in later messages).
  //   2) parsePlanProgress uses the LAST plan block, avoiding accidental
  //      matches against SKILL.md examples the model may echo.
  const parts: string[] = [];
  for (const msg of group.messages) {
    const text = chatStore.extractTextOnly(msg);
    if (text) parts.push(text);
  }
  const combined = parts.join("\n");
  const plan = combined ? parsePlanProgress(combined, true) : null;
  _historyPlanCache.set(group.key, plan);
  return plan;
}

// ── Extract text from a message ──
function getMessageText(msg: unknown): string {
  const text = chatStore.extractText(msg) || "";
  return stripAnsi(collapseInlineJson(stripPlanMarkers(text)));
}

/** Wrap top-level inline JSON objects/arrays in a collapsible <details> block. */
function collapseInlineJson(text: string): string {
  const result: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("```", i)) {
      const end = text.indexOf("```", i + 3);
      const fenceEnd = end === -1 ? text.length : end + 3;
      result.push(text.slice(i, fenceEnd));
      i = fenceEnd;
      continue;
    }
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      let depth = 1;
      let inStr = false;
      let escaped = false;
      let j = i + 1;
      while (j < text.length && depth > 0) {
        const c = text[j];
        if (escaped) {
          escaped = false;
          j++;
          continue;
        }
        if (c === "\\") {
          escaped = true;
          j++;
          continue;
        }
        if (c === '"') {
          inStr = !inStr;
          j++;
          continue;
        }
        if (!inStr) {
          if (c === "{" || c === "[") depth++;
          else if (c === "}" || c === "]") depth--;
        }
        j++;
      }
      if (depth === 0) {
        const candidate = text.slice(i, j);
        try {
          const parsed = JSON.parse(candidate);
          if (typeof parsed === "object" && parsed !== null) {
            const pretty = JSON.stringify(parsed, null, 2);
            result.push(
              `\n<details class="json-collapse"><summary>\u{1F4CB} JSON</summary>\n\n\`\`\`json\n${pretty}\n\`\`\`\n</details>\n`,
            );
            i = j;
            continue;
          }
        } catch {
          /* not valid JSON */
        }
      }
    }
    result.push(text[i]);
    i++;
  }
  return result.join("").replace(/\n{3,}/g, "\n\n");
}

function isToolMessage(msg: unknown): boolean {
  const m = msg as Record<string, unknown>;
  if (typeof m.role === "string" && m.role.toLowerCase() === "toolresult") return true;
  if (
    typeof m.role === "string" &&
    m.role.toLowerCase() === "assistant" &&
    Array.isArray(m.content)
  ) {
    const blocks = m.content as any[];
    const hasToolCall = blocks.some((b: any) => b.type === "toolCall");
    const hasText = blocks.some((b: any) => b.type === "text" && b.text?.trim());
    if (hasToolCall && !hasText) return true;
  }
  return false;
}

function getGroupToolCalls(
  group: MessageGroup,
): { id: string; name: string; input?: string; result?: string; isError?: boolean }[] {
  const tools: { id: string; name: string; input?: string; result?: string; isError?: boolean }[] =
    [];
  const resultMap = new Map<string, string>();

  for (const msg of group.messages) {
    const role = msg.role.toLowerCase();
    if (role === "toolresult" && Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block.type === "text" && typeof block.text === "string") {
          resultMap.set(`result-${resultMap.size}`, stripAnsi(block.text).slice(0, 1000));
        }
      }
    }
  }

  let resultIdx = 0;
  for (const msg of group.messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as any[]) {
      if (block.type === "toolCall") {
        const name = typeof block.name === "string" ? block.name : "tool";
        const id = typeof block.id === "string" ? block.id : `tc-${tools.length}`;
        const input = block.input as Record<string, unknown> | undefined;
        let argsLabel: string | undefined;
        if (input) {
          if (name === "exec" && typeof input.command === "string") {
            argsLabel = input.command;
          } else if (
            (name === "read" || name === "edit" || name === "write") &&
            typeof input.path === "string"
          ) {
            argsLabel = input.path as string;
          }
        }
        const result = resultMap.get(`result-${resultIdx}`);
        const isError = result ? /error|ENOENT|EPERM/i.test(result) : false;
        tools.push({ id, name, input: argsLabel, result, isError });
        resultIdx++;
      }
    }
  }
  return tools;
}

function getCompletedToolCalls(groupIndex: number):
  | {
      id: string;
      name: string;
      input?: string;
      actualCommand?: string;
      result?: string;
      isError?: boolean;
    }[]
  | null {
  const groups = groupedMessages.value;
  let assistantIdx = 0;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].normalizedRole === "assistant") {
      if (i === groupIndex) {
        return chatStore.completedToolCallsMap[assistantIdx] || null;
      }
      assistantIdx++;
    }
  }
  return null;
}

function getMergedToolCalls(
  groupIndex: number,
  group: MessageGroup,
): {
  id: string;
  name: string;
  input?: string;
  actualCommand?: string;
  result?: string;
  isError?: boolean;
}[] {
  const realtime = getCompletedToolCalls(groupIndex);
  const history = getGroupToolCalls(group);

  if (!realtime || realtime.length === 0) {
    return history.map((h) => ({ ...h, actualCommand: undefined }));
  }
  if (history.length === 0) return realtime;

  const historyById = new Map(history.map((h) => [h.id, h]));

  const merged: {
    id: string;
    name: string;
    input?: string;
    actualCommand?: string;
    result?: string;
    isError?: boolean;
  }[] = realtime.map((rt) => {
    const hist = historyById.get(rt.id);
    if (hist) historyById.delete(rt.id);
    return {
      id: rt.id,
      name: rt.name,
      input: rt.input || hist?.input,
      actualCommand: rt.actualCommand,
      result: hist?.result || rt.result,
      isError: hist?.isError || rt.isError,
    };
  });

  for (const [, hist] of historyById) {
    merged.push({ ...hist, actualCommand: undefined });
  }

  return merged;
}

function toggleHistoryPanel(key: string) {
  const next = new Set(openHistoryPanels.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  openHistoryPanels.value = next;
}

function isHistoryPanelOpen(key: string): boolean {
  return openHistoryPanels.value.has(key);
}

function getMessageSegments(msg: unknown, _key: string): MessageSegment[] {
  const m = msg as Record<string, unknown>;

  if (Array.isArray(m.content)) {
    const hasTools = (m.content as any[]).some((b: any) => b.type === "tool_use");
    if (hasTools) {
      const textOnly = chatStore.extractTextOnly(msg);
      if (textOnly && textOnly.trim()) {
        return [{ type: "text", content: stripPlanMarkers(stripAnsi(textOnly).trim()) }];
      }
      return [];
    }
  }

  const rawText = chatStore.extractText(msg) ?? "";
  if (!rawText.trim()) return [];
  return segmentMessageContent(stripPlanMarkers(rawText));
}

/** Merge thinking/reasoning blocks from all messages in a group into one string. */
function getGroupThinking(group: MessageGroup): string | null {
  const blocks = getGroupThinkingBlocks(group);
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

/** Get individual thinking blocks for structured rendering. */
function getGroupThinkingBlocks(group: MessageGroup): string[] {
  const parts: string[] = [];
  for (const msg of group.messages) {
    const t = chatStore.extractThinking(msg);
    if (t) parts.push(t.trim());
  }
  return parts;
}

async function copyMessage(content: string) {
  try {
    await navigator.clipboard.writeText(content);
    justCopied.value = true;
    setTimeout(() => (justCopied.value = false), 1500);
  } catch {
    /* Clipboard not available */
  }
}

// ── Edit user message ──
function isEditingMessage(group: MessageGroup, msgIdx: number): boolean {
  return editingGroupKey.value === group.key && editingMsgIdx.value === msgIdx;
}

function startEditMessage(group: MessageGroup, msgIdx: number) {
  if (chatStore.streaming || chatStore.sending) return;
  window.getSelection()?.removeAllRanges();
  const msg = group.messages[msgIdx];
  editingGroupKey.value = group.key;
  editingMsgIdx.value = msgIdx;
  editText.value = getMessageText(msg);
  nextTick(() => {
    const els = editInputRef.value;
    if (els && els.length > 0) {
      const el = els[0];
      el.focus();
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }
  });
}

function cancelEdit() {
  editingGroupKey.value = null;
  editingMsgIdx.value = -1;
  editText.value = "";
}

async function confirmEdit() {
  const text = editText.value.trim();
  if (!text || !chatStore.wsConnected) return;
  if (await chatStore.sendMessage(text)) cancelEdit();
}

function handleEditKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    cancelEdit();
  } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    confirmEdit();
  }
}
</script>

<style scoped>
/* ── Chat Group ── */
.chat-group {
  display: flex;
  align-items: flex-start;
  margin-bottom: 20px;
  gap: 10px;
}

.chat-group.user {
  justify-content: flex-end;
}

/* ── Avatar ── */
.chat-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 2px;
  object-fit: cover;
}

.chat-group-messages {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: min(720px, 85%);
}

.chat-group.user .chat-group-messages {
  align-items: flex-end;
}

/* ── Bubble ── */
.chat-bubble {
  position: relative;
  display: inline-block;
  max-width: 100%;
  word-wrap: break-word;
  transition: border-color 0.15s;
}

/* User bubble: dark rounded pill */
.chat-bubble.user {
  background: var(--msg-user-bg);
  color: var(--msg-user-text);
  border-radius: 18px;
  padding: 12px 18px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}

.chat-bubble.user .chat-text--user {
  cursor: default;
}

.chat-bubble.user.editable {
  cursor: pointer;
}

.chat-bubble.user.editable:hover {
  filter: brightness(1.15);
  box-shadow: 0 1px 8px rgba(0, 0, 0, 0.15);
}

/* ── Edit mode ── */
.chat-edit-wrapper {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  min-width: 200px;
}

.chat-edit-input {
  width: 100%;
  min-height: 36px;
  max-height: 200px;
  padding: 8px 12px;
  font-size: 14px;
  line-height: 1.5;
  font-family: inherit;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--accent);
  border-radius: 10px;
  resize: none;
  outline: none;
  box-sizing: border-box;
}

.chat-edit-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-light);
}

.chat-edit-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}

.chat-edit-btn {
  padding: 4px 14px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 12px;
  border: none;
  cursor: pointer;
  font-family: inherit;
  transition:
    background 0.15s,
    color 0.15s;
}

.chat-edit-btn.confirm {
  background: var(--accent);
  color: #fff;
}

.chat-edit-btn.confirm:hover {
  filter: brightness(1.1);
}

.chat-edit-btn.cancel {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.chat-edit-btn.cancel:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

/* AI bubble: transparent container (panels + text live inside) */
.chat-bubble.assistant {
  background: transparent;
  border: none;
  padding: 0;
  border-radius: 0;
}

/* Text content card inside assistant bubble */
.chat-bubble.assistant .chat-text {
  background: var(--bg-assistant-card);
  padding: 12px 16px;
  border-radius: 14px;
}

.chat-bubble.assistant.streaming {
  border-left: none;
  padding-left: 0;
}

/* Hide tool-related messages (rendered in group-level exec panel) */
.chat-bubble.hidden-msg {
  display: none;
}

/* ── Copy button ── */
.chat-content-wrapper {
  position: relative;
}

.chat-copy-btn {
  position: absolute;
  top: auto;
  bottom: 0;
  right: 0;
  border: none;
  background: transparent;
  color: var(--text-muted);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s;
}

.chat-content-wrapper:hover .chat-copy-btn {
  opacity: 1;
  pointer-events: auto;
}

.chat-copy-btn:hover {
  color: var(--text-primary);
}

/* ── Chat text / Markdown ── */
.chat-text {
  font-size: 14px;
  line-height: 1.65;
  word-wrap: break-word;
  overflow-wrap: break-word;
  color: var(--text-primary);
  font-weight: 400;
}

.chat-text--user {
  white-space: pre-wrap;
}

.chat-group.user .chat-text {
  color: var(--msg-user-text);
}

.chat-text :deep(p) {
  margin: 0;
}

.chat-text :deep(p + p) {
  margin-top: 0.6em;
}

.chat-text :deep(ul),
.chat-text :deep(ol) {
  padding-left: 1.5em;
  margin: 4px 0 8px;
}

.chat-text :deep(li + li) {
  margin-top: 0.25em;
}

.chat-text :deep(a) {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.chat-text :deep(code) {
  font-family: "Cascadia Code", "Fira Code", Consolas, monospace;
  font-size: 0.9em;
}

.chat-text :deep(:not(pre) > code) {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  padding: 1px 5px;
  border-radius: 3px;
}

.chat-text :deep(pre) {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px;
  margin: 8px 0;
  overflow-x: auto;
}

.chat-text :deep(pre code) {
  padding: 0;
  background: transparent;
  border: none;
}

.chat-text :deep(details.json-collapse) {
  margin: 8px 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.chat-text :deep(details.json-collapse summary) {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
  background: var(--bg-tertiary);
}

.chat-text :deep(details.json-collapse summary:hover) {
  color: var(--text-primary);
}

.chat-text :deep(details.json-collapse pre) {
  margin: 0;
  border: none;
  border-top: 1px solid var(--border);
  border-radius: 0;
}

.chat-text :deep(blockquote) {
  border-left: 3px solid var(--accent);
  padding-left: 12px;
  margin: 8px 0;
  color: var(--text-secondary);
}

.chat-text :deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 13px;
}

.chat-text :deep(th),
.chat-text :deep(td) {
  border: 1px solid var(--border);
  padding: 5px 10px;
}

.chat-text :deep(th) {
  background: var(--bg-tertiary);
  font-weight: 600;
}

.chat-text :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 1em 0;
}

/* ── Reading indicator (typing dots) ── */
.chat-reading-indicator {
  padding: 10px 0 !important;
}

.chat-reading-dots {
  display: inline-flex;
  gap: 5px;
  align-items: center;
}

.chat-reading-dots span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
  animation: chat-dot-wave 1.4s ease-in-out infinite;
}

.chat-reading-dots span:nth-child(2) {
  animation-delay: 0.18s;
}

.chat-reading-dots span:nth-child(3) {
  animation-delay: 0.36s;
}

@keyframes chat-dot-wave {
  0%,
  60%,
  100% {
    opacity: 0.25;
    transform: translateY(0);
  }
  30% {
    opacity: 1;
    transform: translateY(-4px);
  }
}

/* ── Error ── */
.chat-error {
  margin: 8px 16px;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(255, 59, 48, 0.08);
  color: var(--text-primary);
  font-size: 13px;
  border: 1px solid rgba(255, 59, 48, 0.25);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.chat-error__header {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--danger);
  font-weight: 600;
}
.chat-error__icon {
  flex-shrink: 0;
}
.chat-error__title {
  line-height: 1.3;
}
.chat-error__body {
  color: var(--text-secondary);
  line-height: 1.5;
}
.chat-error__details {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-secondary);
}
.chat-error__details summary {
  cursor: pointer;
  user-select: none;
  outline: none;
}
.chat-error__raw {
  margin: 6px 0 0;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.04);
  border-radius: 6px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow: auto;
}
.chat-error__actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.chat-error__btn {
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s;
}
.chat-error__btn:hover {
  background: var(--bg-secondary);
}
.chat-error__btn--primary {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}
.chat-error__btn--primary:hover {
  background: var(--danger);
  filter: brightness(0.92);
}

/* ── Empty state ── */
.chat-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding-bottom: 60px;
}

.chat-empty__logo {
  width: 60px;
  height: 60px;
  border-radius: 18px;
  background: linear-gradient(135deg, var(--accent), var(--accent-hover));
  display: grid;
  place-items: center;
  font-size: 30px;
  margin-bottom: 8px;
  box-shadow: 0 4px 16px var(--accent-light);
}

.chat-empty__title {
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.04em;
}

.chat-empty__hint {
  font-size: 14px;
  color: var(--text-muted);
  font-weight: 400;
}

/* ── Waiting GIF ── */
.chat-waiting-gif {
  display: flex;
  justify-content: center;
  padding: 16px 0;
  max-height: 220px;
  overflow: hidden;
  opacity: 1;
  transition:
    max-height 0.4s ease,
    opacity 0.3s ease,
    padding 0.4s ease;
}

.chat-waiting-gif--hidden {
  max-height: 0;
  opacity: 0;
  padding: 0;
}

.chat-waiting-gif img {
  width: 160px;
  height: auto;
  border-radius: 12px;
}

/* ── Execution Steps Panel ── */
.exec-panel {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 10px;
  margin-bottom: 8px;
  overflow: hidden;
}

/* Live (streaming) exec panel: borderless, blends with background */
.exec-panel--live {
  border: none;
  background: transparent;
}

.exec-panel--live .exec-panel__body {
  border-top: none;
}

.exec-panel--live .exec-panel__header:hover {
  background: transparent;
}

.exec-panel__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  cursor: pointer;
  user-select: none;
  transition: background 0.12s;
}

.exec-panel__header:hover {
  background: var(--bg-tertiary);
}

.exec-panel__toggle svg {
  transition: transform 0.2s ease;
  color: var(--text-muted);
}

.exec-panel__toggle svg.rotated {
  transform: rotate(90deg);
}

.exec-panel__title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: 0.02em;
}

.exec-panel__count {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  padding: 1px 7px;
  border-radius: 10px;
  min-width: 18px;
  text-align: center;
}

.exec-panel__spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: exec-spin 0.8s linear infinite;
  margin-left: auto;
}

@keyframes exec-spin {
  to {
    transform: rotate(360deg);
  }
}

.exec-panel__body {
  padding: 2px 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px solid var(--border);
}

.exec-step {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  padding: 4px 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.exec-step.done {
  color: var(--text-muted);
}

.exec-step__icon {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
}

.exec-step.done .exec-step__icon {
  color: var(--success);
}

.exec-step__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  animation: exec-dot-pulse 1.2s ease-in-out infinite;
}

.exec-step__lock {
  color: #e6a817;
}

@keyframes exec-dot-pulse {
  0%,
  100% {
    opacity: 0.4;
    transform: scale(0.85);
  }
  50% {
    opacity: 1;
    transform: scale(1.1);
  }
}

.exec-step__name {
  font-family: "Cascadia Code", "Fira Code", Consolas, monospace;
  font-size: 12px;
  font-weight: 450;
}

.exec-step__meta {
  flex-basis: 100%;
  padding-left: 26px;
  font-size: 11px;
  color: var(--text-muted);
  word-break: break-word;
  line-height: 1.5;
}

.exec-step__actual {
  flex-basis: 100%;
  padding-left: 26px;
  font-size: 10px;
  color: var(--text-muted);
  opacity: 0.6;
  word-break: break-all;
  line-height: 1.4;
  font-family: "Cascadia Code", "Fira Code", Consolas, monospace;
}

.exec-step__result {
  flex-basis: 100%;
  padding-left: 26px;
  font-size: 10px;
  color: var(--text-muted);
  opacity: 0.5;
  word-break: break-word;
  line-height: 1.4;
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  font-family: "Cascadia Code", "Fira Code", Consolas, monospace;
}

.exec-step__result--error {
  color: #e74c3c;
  opacity: 0.85;
}

.exec-step--error .exec-step__icon svg {
  stroke: #e74c3c;
}

/* Slide transition */
.exec-slide-enter-active,
.exec-slide-leave-active {
  transition:
    max-height 0.2s ease,
    opacity 0.2s ease;
  overflow: hidden;
}

.exec-slide-enter-from,
.exec-slide-leave-to {
  max-height: 0;
  opacity: 0;
}

.exec-slide-enter-to,
.exec-slide-leave-from {
  max-height: 400px;
  opacity: 1;
}

/* ── Context Panel (thinking, intermediate output) ── */
.context-panel {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}

.context-panel__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  cursor: pointer;
  user-select: none;
  transition: background 0.12s;
}

.context-panel__header:hover {
  background: var(--bg-tertiary);
}

.context-panel__toggle svg {
  transition: transform 0.2s ease;
  color: var(--text-muted);
}

.context-panel__toggle svg.rotated {
  transform: rotate(90deg);
}

.context-panel__icon {
  font-size: 14px;
  line-height: 1;
}

.context-panel__title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: 0.02em;
}

.context-panel__body {
  padding: 8px 14px 12px;
  border-top: 1px solid var(--border);
}

.context-panel__text {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
  word-wrap: break-word;
  overflow-wrap: break-word;
  max-height: 300px;
  overflow-y: auto;
}

.context-panel__text :deep(p) {
  margin: 0;
}

.context-panel__text :deep(p + p) {
  margin-top: 0.5em;
}

.context-panel__text :deep(code) {
  font-family: "Cascadia Code", "Fira Code", Consolas, monospace;
  font-size: 0.9em;
}

.context-panel__text :deep(:not(pre) > code) {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  padding: 1px 5px;
  border-radius: 3px;
}

.context-panel__text :deep(pre) {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  margin: 6px 0;
  overflow-x: auto;
}

.context-panel__text :deep(pre code) {
  padding: 0;
  background: transparent;
  border: none;
}

/* ── Merged thinking blocks ── */
.thinking-merged {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.thinking-block {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.thinking-block__dot {
  width: 5px;
  height: 5px;
  min-width: 5px;
  border-radius: 50%;
  background: var(--text-muted);
  margin-top: 7px;
  opacity: 0.5;
}

.thinking-block__text {
  flex: 1;
  min-width: 0;
}

.thinking-block__text :deep(p) {
  margin: 0;
}

.thinking-block__text :deep(p + p) {
  margin-top: 0.4em;
}

.thinking-block__text :deep(ol),
.thinking-block__text :deep(ul) {
  margin: 2px 0;
  padding-left: 1.2em;
}

/* ══════════════════════════════════════════
   Compact mode overrides (Studio overlay)
   ══════════════════════════════════════════ */

.chat-messages--studio-mode {
  font-family: "Cascadia Code", "Consolas", monospace;
}

.chat-messages--studio-mode .chat-group {
  margin-bottom: 8px;
}

.chat-messages--studio-mode .chat-group-messages {
  max-width: 95%;
}

.chat-messages--studio-mode .chat-bubble.user {
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
  background: rgba(59, 93, 138, 0.6);
  border: 1px solid rgba(90, 130, 180, 0.4);
  color: #e0eaff;
  box-shadow: none;
}

.chat-messages--studio-mode .chat-bubble.assistant {
  padding: 4px 0;
  font-size: 12px;
}

.chat-messages--studio-mode .chat-bubble.assistant .chat-text {
  background: rgba(20, 24, 38, 0.85);
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgba(80, 90, 120, 0.4);
}

.chat-messages--studio-mode .chat-bubble.assistant.streaming {
  border-left-width: 2px;
  padding-left: 8px;
}

.chat-messages--studio-mode .chat-text {
  font-size: 12px;
  line-height: 1.5;
  color: #d5ddf3;
}

.chat-messages--studio-mode .chat-group.user .chat-text {
  color: #e0eaff;
}

.chat-messages--studio-mode .chat-text :deep(pre) {
  background: rgba(0, 0, 0, 0.3);
  padding: 6px 8px;
  font-size: 11px;
  border: 1px solid rgba(80, 90, 110, 0.3);
}

.chat-messages--studio-mode .chat-text :deep(code) {
  font-size: 11px;
  font-family: "Cascadia Code", "Consolas", monospace;
}

.chat-messages--studio-mode .chat-text :deep(p) {
  margin: 4px 0;
}

.chat-messages--studio-mode .chat-text :deep(p:first-child) {
  margin-top: 0;
}

.chat-messages--studio-mode .chat-text :deep(p:last-child) {
  margin-bottom: 0;
}

.chat-messages--studio-mode .chat-text :deep(ul),
.chat-messages--studio-mode .chat-text :deep(ol) {
  padding-left: 1.5em;
  margin: 4px 0 8px;
}

.chat-messages--studio-mode .chat-copy-btn {
  display: none;
}

.chat-messages--studio-mode .chat-empty {
  padding-bottom: 20px;
}

.chat-messages--studio-mode .chat-empty__hint {
  font-size: 12px;
  color: #6b7a99;
}

.chat-messages--studio-mode .exec-panel {
  border-radius: 6px;
}

.chat-messages--studio-mode .exec-panel__header {
  padding: 6px 10px;
}

.chat-messages--studio-mode .exec-panel__title {
  font-size: 11px;
}

.chat-messages--studio-mode .exec-panel__count {
  font-size: 10px;
}

.chat-messages--studio-mode .exec-panel__body {
  padding: 2px 10px 8px;
}

.chat-messages--studio-mode .exec-step {
  font-size: 11px;
}

.chat-messages--studio-mode .exec-step__name {
  font-size: 11px;
}

.chat-messages--studio-mode .exec-step__meta {
  font-size: 10px;
  padding-left: 22px;
}

.chat-messages--studio-mode .exec-step__result {
  font-size: 9px;
  padding-left: 22px;
  max-height: 120px;
}

.chat-messages--studio-mode .context-panel {
  border-radius: 6px;
}

.chat-messages--studio-mode .context-panel__header {
  padding: 6px 10px;
}

.chat-messages--studio-mode .context-panel__title {
  font-size: 11px;
}

.chat-messages--studio-mode .context-panel__body {
  padding: 6px 10px 8px;
}

.chat-messages--studio-mode .context-panel__text {
  font-size: 11px;
  max-height: 200px;
}

/* Compact reading dots */
.chat-messages--studio-mode .chat-reading-dots span {
  width: 5px;
  height: 5px;
  background: #8899bb;
}

/* Compact edit */
.chat-messages--studio-mode .chat-edit-input {
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 6px;
}

.chat-messages--studio-mode .chat-edit-btn {
  font-size: 11px;
  padding: 3px 10px;
}
</style>
