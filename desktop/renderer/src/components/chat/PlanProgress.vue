<template>
  <div v-if="plan" class="plan-progress" :class="{ 'plan-progress--collapsed': collapsed }">
    <!-- Collapsed view: avatar + current step in one row -->
    <template v-if="collapsed">
      <div class="plan-progress__compact">
        <img
          class="plan-progress__compact-img"
          :src="isLive && !allDone ? cleaningGif : cleaningStill"
          alt=""
        />
        <div class="plan-progress__compact-info">
          <span v-if="currentStep" class="plan-progress__compact-label">{{
            currentStep.label
          }}</span>
          <span v-else-if="allDone" class="plan-progress__compact-label">{{
            t("chat.plan.allDone")
          }}</span>
          <span class="plan-progress__compact-meta">
            {{ t("chat.plan.stepN", { n: plan.completed, total: plan.total }) }}
            <template v-if="currentStep && liveElapsed">
              · {{ t("chat.plan.elapsed", { t: liveElapsed }) }}</template
            >
            <template v-if="currentStep && !liveElapsed && stepElapsed[currentStep.step]">
              · {{ t("chat.plan.elapsed", { t: stepElapsed[currentStep.step] }) }}</template
            >
          </span>
        </div>
        <button class="plan-progress__toggle" @click="collapsed = false">
          {{ t("chat.plan.expand") }}
          <svg
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
      </div>
    </template>
    <!-- Expanded view: full step list -->
    <template v-else>
      <div class="plan-progress__hero">
        <img
          class="plan-progress__gif"
          :src="isLive && !allDone ? cleaningGif : cleaningStill"
          alt=""
        />
      </div>
      <div class="plan-progress__count">
        {{ plan.completed }}/{{ plan.total }}{{ t("chat.plan.stepsUnit") }}
      </div>
      <div class="plan-progress__steps">
        <div
          v-for="(step, i) in plan.steps"
          :key="step.step"
          class="plan-step"
          :class="[step.status, { 'plan-step--last': i === plan.steps.length - 1 }]"
        >
          <span class="plan-step__icon">
            <svg
              v-if="step.status === 'done'"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle cx="12" cy="12" r="10" fill="var(--success)" opacity="0.15" />
              <path
                d="M8 12.5l2.5 2.5 5-5"
                stroke="var(--success)"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
                fill="none"
              />
            </svg>
            <svg
              v-else-if="step.status === 'in-progress'"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              class="plan-step__spinner"
            >
              <circle
                cx="12"
                cy="12"
                r="10"
                stroke="var(--accent)"
                stroke-width="2"
                opacity="0.2"
                fill="none"
              />
              <path
                d="M12 2a10 10 0 0 1 10 10"
                stroke="var(--accent)"
                stroke-width="2.2"
                stroke-linecap="round"
                fill="none"
              />
            </svg>
            <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle
                cx="12"
                cy="12"
                r="9"
                stroke="var(--text-muted)"
                stroke-width="1.5"
                fill="none"
                opacity="0.5"
              />
            </svg>
          </span>
          <span
            class="plan-step__label"
            :class="{ 'plan-step__label--active': step.status === 'in-progress' }"
            >{{ step.label }}</span
          >
          <span class="plan-step__meta">
            <template v-if="step.status === 'done'">
              {{ t("chat.plan.stepN", { n: step.step, total: plan.total }) }}
              <template v-if="stepElapsed[step.step]">
                · {{ t("chat.plan.elapsed", { t: stepElapsed[step.step] }) }}</template
              >
            </template>
            <template v-else-if="step.status === 'in-progress'">
              {{ t("chat.plan.stepN", { n: step.step, total: plan.total }) }}
              <template v-if="liveElapsed !== null">
                · {{ t("chat.plan.elapsed", { t: liveElapsed }) }}</template
              >
            </template>
            <template v-else>
              {{ t("chat.plan.stepN", { n: step.step, total: plan.total }) }}
            </template>
          </span>
        </div>
      </div>
      <!-- Progress bar (during execution) -->
      <div v-if="!allDone" class="plan-progress__bar">
        <div class="plan-progress__bar-fill" :style="{ width: progressPercent + '%' }"></div>
      </div>
      <!-- Completion state -->
      <div v-else class="plan-progress__done">
        <div class="plan-progress__done-label">{{ t("chat.plan.allDone") }}</div>
      </div>
      <!-- Collapse button -->
      <div class="plan-progress__footer">
        <span></span>
        <button class="plan-progress__toggle" @click="collapsed = true">
          {{ t("chat.plan.collapse") }}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onUnmounted, watch } from "vue";
import type { PlanProgress } from "@/composables/usePlanProgress";
import { t } from "@/i18n";
import cleaningGif from "@/assets/cleaning_nobg.gif";
import cleaningStill from "@/assets/cleaning_still.png";

// ── Module-level timing store ──
// Keeping these outside the component lets per-step timings survive both
// (a) session switches that unmount this component, and
// (b) the streaming → history transition (which mounts a fresh instance for
//     the same assistant turn).
// We also mirror the data into sessionStorage so the timings survive Vite
// HMR (which re-executes this module) and full renderer reloads.
// The store is keyed by `planKey` (derived from session + plan signature in
// the parent), then by step number.
interface StepTiming {
  startedAt: number;
  /** Cached formatted duration once the step is done. */
  elapsed?: string;
}
const SS_KEY = "openclaw.planTimings.v1";
const planTimings = new Map<string, Map<number, StepTiming>>();

// Hydrate from sessionStorage on module load (safe in browser-only env).
try {
  const raw = sessionStorage.getItem(SS_KEY);
  if (raw) {
    const obj = JSON.parse(raw) as Record<string, Record<string, StepTiming>>;
    for (const [k, stepMap] of Object.entries(obj)) {
      const inner = new Map<number, StepTiming>();
      for (const [stepNum, t] of Object.entries(stepMap)) {
        inner.set(Number(stepNum), t);
      }
      planTimings.set(k, inner);
    }
  }
} catch {
  // ignore — sessionStorage may be unavailable or corrupt
}

function persistPlanTimings(): void {
  try {
    const obj: Record<string, Record<string, StepTiming>> = {};
    for (const [k, inner] of planTimings) {
      const stepMap: Record<string, StepTiming> = {};
      for (const [stepNum, t] of inner) stepMap[String(stepNum)] = t;
      obj[k] = stepMap;
    }
    sessionStorage.setItem(SS_KEY, JSON.stringify(obj));
  } catch {
    // ignore quota / unavailability
  }
}

function getPlanTimingMap(key: string): Map<number, StepTiming> {
  let m = planTimings.get(key);
  if (!m) {
    m = new Map();
    planTimings.set(key, m);
  }
  return m;
}

const props = withDefaults(
  defineProps<{
    plan: PlanProgress | null;
    isLive?: boolean;
    /**
     * Stable key identifying this plan instance across re-mounts. Must be the
     * same value when the component remounts for the same logical plan
     * (session switch, streaming → history). Empty string disables persistence.
     */
    planKey?: string;
  }>(),
  {
    isLive: false,
    planKey: "",
  },
);

const progressPercent = computed(() => {
  if (!props.plan || props.plan.total === 0) return 0;
  return Math.round((props.plan.completed / props.plan.total) * 100);
});

const allDone = computed(() => {
  return props.plan && props.plan.total > 0 && props.plan.completed === props.plan.total;
});

const collapsed = ref(false);

/** The currently in-progress step (or the last done step if all done). */
const currentStep = computed(() => {
  if (!props.plan) return null;
  const inProgress = props.plan.steps.find((s) => s.status === "in-progress");
  if (inProgress) return inProgress;
  // If all done, show last step
  const doneSteps = props.plan.steps.filter((s) => s.status === "done");
  return doneSteps.length > 0 ? doneSteps[doneSteps.length - 1] : null;
});

// ── Per-step elapsed tracking ──
/** Map of step number → elapsed seconds string (only for done steps). */
const stepElapsed = ref<Record<number, string>>({});

// Live elapsed for current in-progress step
const liveElapsed = ref<string | null>(null);
let liveTimer: ReturnType<typeof setInterval> | null = null;
// Step number the live timer is currently tracking. We update it when the
// in-progress step changes so the interval doesn't read a stale step from
// a previous closure (which causes the elapsed counter to flicker between
// two values).
let liveStepNum: number | null = null;
let liveStepKey: string | null = null;

function formatElapsed(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m${remainSecs}s`;
}

// Watch for step status changes to track timing
watch(
  () => [props.plan, props.planKey] as const,
  ([plan, planKey]) => {
    if (!plan) return;
    const timings = getPlanTimingMap(planKey || "__anon__");
    let mutated = false;

    // Hydrate stepElapsed from the persistent store (covers remount: history
    // view replacing streaming view, or returning to a session after a switch).
    const hydrated: Record<number, string> = {};
    for (const [stepNum, t] of timings) {
      if (t.elapsed) hydrated[stepNum] = t.elapsed;
    }
    if (Object.keys(hydrated).length > 0) {
      stepElapsed.value = { ...stepElapsed.value, ...hydrated };
    }

    for (const step of plan.steps) {
      const existing = timings.get(step.step);
      if (step.status === "in-progress" && !existing) {
        timings.set(step.step, { startedAt: Date.now() });
        mutated = true;
      }
      if (step.status === "done") {
        const t = timings.get(step.step);
        if (t && !t.elapsed) {
          t.elapsed = formatElapsed(Date.now() - t.startedAt);
          mutated = true;
        }
        if (t?.elapsed && !stepElapsed.value[step.step]) {
          stepElapsed.value = {
            ...stepElapsed.value,
            [step.step]: t.elapsed,
          };
        }
      }
    }

    if (mutated) persistPlanTimings();

    // Update live timer for in-progress step
    const inProgressStep = plan.steps.find((s) => s.status === "in-progress");
    if (inProgressStep && props.isLive) {
      const stepNum = inProgressStep.step;
      const key = planKey || "__anon__";
      // If we're already tracking this exact step, just refresh the value.
      // Otherwise, (re)start the interval and update the tracked step.
      if (liveStepNum !== stepNum || liveStepKey !== key) {
        if (liveTimer) {
          clearInterval(liveTimer);
          liveTimer = null;
        }
        liveStepNum = stepNum;
        liveStepKey = key;
      }
      // Compute initial value immediately so the UI doesn't flash "0s" after
      // a session switch back into a still-running step.
      const t0 = timings.get(stepNum);
      if (t0) liveElapsed.value = formatElapsed(Date.now() - t0.startedAt);
      if (!liveTimer) {
        liveTimer = setInterval(() => {
          if (liveStepNum === null || liveStepKey === null) return;
          const map = planTimings.get(liveStepKey);
          const t = map?.get(liveStepNum);
          if (t) {
            liveElapsed.value = formatElapsed(Date.now() - t.startedAt);
          }
        }, 250);
      }
    } else {
      if (liveTimer) {
        clearInterval(liveTimer);
        liveTimer = null;
      }
      liveStepNum = null;
      liveStepKey = null;
      liveElapsed.value = null;
    }
  },
  { deep: true, immediate: true },
);

onUnmounted(() => {
  if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
});
</script>

<style scoped>
.plan-progress {
  background: #ffffff;
  border-radius: 14px;
  padding: 16px;
  margin-bottom: 8px;
  overflow: hidden;
  width: 320px;
  box-shadow:
    0 2px 12px rgba(0, 0, 0, 0.08),
    0 1px 4px rgba(0, 0, 0, 0.04);
}

.plan-progress__hero {
  display: flex;
  justify-content: center;
  padding: 8px 0 12px;
}

.plan-progress__gif {
  width: 120px;
  height: auto;
  object-fit: contain;
}

.plan-progress__count {
  font-size: 13px;
  color: var(--text-secondary);
  font-weight: 500;
  margin-bottom: 10px;
}

.plan-progress__steps {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.plan-step {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 4px;
  border-bottom: 1px solid #f0f0f0;
  transition: background 0.15s;
}

.plan-step--last {
  border-bottom: none;
}

.plan-step.in-progress {
  background: rgba(var(--accent-rgb, 59, 130, 246), 0.06);
  border-radius: 8px;
}

.plan-step__icon {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
}

.plan-step__spinner {
  animation: plan-spin 1s linear infinite;
}

@keyframes plan-spin {
  to {
    transform: rotate(360deg);
  }
}

.plan-step__label {
  flex: 1;
  font-size: 13px;
  color: var(--text-secondary);
  font-weight: 400;
  line-height: 1.4;
}

.plan-step.done .plan-step__label {
  color: var(--text-muted);
}

.plan-step__label--active {
  color: var(--text-primary) !important;
  font-weight: 500;
}

.plan-step.not-started .plan-step__label {
  color: var(--text-muted);
  opacity: 0.7;
}

.plan-step__meta {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  flex-shrink: 0;
}

/* Progress bar */
.plan-progress__bar {
  margin-top: 12px;
  height: 3px;
  background: #e8e8e8;
  border-radius: 2px;
  overflow: hidden;
}

.plan-progress__bar-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 0.4s ease;
}

/* Completion state */
.plan-progress__done {
  margin-top: 14px;
}

.plan-progress__done-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

/* Footer */
.plan-progress__footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}

.plan-progress__toggle {
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: color 0.15s;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.plan-progress__toggle:hover {
  color: var(--text-primary);
}

/* Collapsed compact view */
.plan-progress--collapsed {
  padding: 10px 14px;
}

.plan-progress__compact {
  display: flex;
  align-items: center;
  gap: 10px;
}

.plan-progress__compact-img {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  object-fit: contain;
  flex-shrink: 0;
}

.plan-progress__compact-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.plan-progress__compact-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.plan-progress__compact-meta {
  font-size: 11px;
  color: var(--text-muted);
}
</style>
