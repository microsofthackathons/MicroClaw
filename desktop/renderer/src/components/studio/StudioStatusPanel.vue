<template>
  <div
    ref="rootRef"
    class="studio-status-capsule"
    :class="{ expanded }"
    @pointerenter="setPointerBlock(true)"
    @pointerleave="setPointerBlock(false)"
    @pointerdown.stop.prevent="setPointerBlock(true)"
    @click.stop
  >
    <button class="capsule-trigger" type="button" @click="expanded = !expanded">
      <span class="status-dot" :class="mainAgent.state"></span>
      <span class="status-text">{{ t(`studio.status.${mainAgent.state}`) }}</span>
      <span v-if="manualActive" class="manual-badge">{{ t("studio.manual.active") }}</span>
      <span v-if="guestAgents.length > 0" class="guest-count">+{{ guestAgents.length }}</span>
      <svg
        class="trigger-arrow"
        :class="{ rotated: expanded }"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>

    <transition name="capsule-pop">
      <div v-if="expanded" class="capsule-panel">
        <div v-if="mainAgent.detail" class="status-detail">{{ mainAgent.detail }}</div>

        <div class="quick-states">
          <button
            v-for="state in states"
            :key="state"
            type="button"
            class="state-btn"
            :class="{ active: state === mainAgent.state }"
            @click="applyManualState(state)"
          >
            {{ t(`studio.status.${state}`) }}
          </button>
        </div>

        <div v-if="manualActive" class="manual-actions">
          <button class="state-btn clear-btn" type="button" @click="clearManualState">
            {{ t("studio.manual.clear") }}
          </button>
        </div>

        <div v-if="guestAgents.length > 0" class="agent-strip">
          <span class="agent-strip__title">{{ t("studio.agents.title") }}</span>
          <div class="agent-strip__list">
            <span v-for="agent in visibleGuestAgents" :key="agent.id" class="agent-chip">
              {{ agent.name }}
            </span>
            <span
              v-if="guestAgents.length > visibleGuestAgents.length"
              class="agent-chip agent-chip--count"
            >
              +{{ guestAgents.length - visibleGuestAgents.length }}
            </span>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useStudioStore, type StudioAgentState } from "@/stores/studio";
import { t } from "@/i18n";

const studioStore = useStudioStore();

const rootRef = ref<HTMLDivElement | null>(null);
const expanded = ref(false);
const states: StudioAgentState[] = [
  "idle",
  "writing",
  "researching",
  "executing",
  "syncing",
  "error",
];

const mainAgent = computed(() => studioStore.mainAgent);
const guestAgents = computed(() => studioStore.guestAgents);
const visibleGuestAgents = computed(() => guestAgents.value.slice(0, 2));
const manualActive = computed(() => studioStore.isManualOverrideActive());

function applyManualState(state: StudioAgentState) {
  void studioStore.setManualState(state);
}

function clearManualState() {
  studioStore.clearManualOverride();
}

function setPointerBlock(blocked: boolean) {
  studioStore.setUiOverlayPointerBlock(blocked);
}

function handleOutsideClick(event: Event) {
  if (!expanded.value) return;
  const target = event.target as Node | null;
  if (!target) return;
  if (!rootRef.value?.contains(target)) {
    expanded.value = false;
  }
}

onMounted(() => {
  window.addEventListener("pointerdown", handleOutsideClick);
});

onUnmounted(() => {
  window.removeEventListener("pointerdown", handleOutsideClick);
  setPointerBlock(false);
});
</script>

<style scoped>
.studio-status-capsule {
  position: relative;
  width: min(264px, calc(100vw - 96px));
  color: #f6f7fb;
  font-family: "Cascadia Code", "Consolas", monospace;
}

.capsule-trigger {
  width: 100%;
  height: 38px;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 2px solid rgba(25, 28, 38, 0.92);
  background: rgba(41, 47, 64, 0.86);
  color: #f6f7fb;
  padding: 0 10px;
  cursor: pointer;
  transition:
    transform 0.12s ease,
    background 0.12s ease;
  box-shadow:
    0 2px 0 rgba(10, 12, 18, 0.92),
    0 4px 10px rgba(0, 0, 0, 0.35);
}

.capsule-trigger:hover {
  transform: translateY(-1px);
  background: rgba(47, 53, 72, 0.92);
}

.status-dot {
  width: 10px;
  height: 10px;
  flex-shrink: 0;
  border: 1px solid rgba(0, 0, 0, 0.65);
  box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.25);
}

.status-dot.idle {
  background: #5dcf7c;
}
.status-dot.writing {
  background: #5da8ff;
}
.status-dot.researching {
  background: #4dd0e1;
}
.status-dot.executing {
  background: #f6b34f;
}
.status-dot.syncing {
  background: #7f9dff;
}
.status-dot.error {
  background: #ff6e6e;
}

.status-text {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.manual-badge {
  margin-left: auto;
  font-size: 10px;
  line-height: 1;
  padding: 3px 6px;
  border: 1px solid rgba(252, 211, 77, 0.6);
  background: rgba(120, 90, 24, 0.8);
  color: #fcd34d;
}

.guest-count {
  margin-left: auto;
  font-size: 10px;
  line-height: 1;
  padding: 3px 6px;
  border: 1px solid rgba(128, 138, 166, 0.7);
  background: rgba(48, 53, 70, 0.9);
  color: #b9c3de;
}

.trigger-arrow {
  flex-shrink: 0;
  opacity: 0.86;
  transition: transform 0.12s ease;
}

.trigger-arrow.rotated {
  transform: rotate(180deg);
}

.capsule-panel {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  width: min(320px, calc(100vw - 96px));
  padding: 10px;
  border: 2px solid rgba(21, 24, 34, 0.94);
  background: rgba(29, 33, 46, 0.94);
  box-shadow:
    0 2px 0 rgba(10, 12, 18, 0.92),
    0 8px 18px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(1.5px);
}

.status-detail {
  font-size: 11px;
  line-height: 1.35;
  color: #c4ccdf;
  margin-bottom: 9px;
  max-height: 34px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.quick-states {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.state-btn {
  height: 28px;
  border: 1px solid rgba(101, 112, 138, 0.75);
  background: rgba(48, 56, 75, 0.88);
  color: #e6ebfa;
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
  padding: 0 6px;
  transition:
    background 0.12s ease,
    border-color 0.12s ease;
}

.state-btn:hover {
  background: rgba(59, 69, 92, 0.95);
}

.state-btn.active {
  border-color: rgba(141, 232, 206, 0.88);
  background: rgba(45, 83, 84, 0.88);
  color: #c8fff3;
}

.agent-strip {
  margin-top: 9px;
}

.manual-actions {
  margin-top: 8px;
}

.clear-btn {
  min-width: 96px;
  border: 1px solid rgba(130, 154, 202, 0.85);
  background: rgba(39, 55, 88, 0.9);
  color: #dbe9ff;
}

.clear-btn:hover {
  background: rgba(49, 68, 107, 0.95);
}

.agent-strip__title {
  font-size: 10px;
  color: #97a5c7;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.agent-strip__list {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
}

.agent-chip {
  font-size: 10px;
  line-height: 1;
  padding: 4px 6px;
  border: 1px solid rgba(96, 106, 129, 0.72);
  background: rgba(43, 49, 66, 0.9);
  color: #d5ddf3;
}

.agent-chip--count {
  color: #9db2eb;
}

.capsule-pop-enter-active,
.capsule-pop-leave-active {
  transition:
    opacity 0.14s ease,
    transform 0.14s ease;
}

.capsule-pop-enter-from,
.capsule-pop-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

.capsule-pop-enter-to,
.capsule-pop-leave-from {
  opacity: 1;
  transform: translateY(0);
}
</style>
