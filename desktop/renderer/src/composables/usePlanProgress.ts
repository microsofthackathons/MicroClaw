import { computed, type Ref } from "vue";

/**
 * A single step in a plan progress block.
 */
export interface PlanStep {
  step: number;
  label: string;
  status: "not-started" | "in-progress" | "done";
  /** Wall-clock seconds elapsed (only set for done steps). */
  elapsed?: number;
}

/**
 * Parsed plan progress extracted from model text.
 */
export interface PlanProgress {
  steps: PlanStep[];
  /** Total step count in the plan. */
  total: number;
  /** Number of completed steps. */
  completed: number;
  /** Index of the currently running step (0-based), or -1 if none running. */
  currentIndex: number;
}

// ── Regex patterns ──

/** Matches ```json:plan ... ``` fenced code blocks containing step definitions (global, finds all). */
const PLAN_BLOCK_RE = /```json:plan\s*\n([\s\S]*?)```/g;

/** Matches step start markers: <!-- step:N:start --> */
const STEP_START_RE = /<!--\s*step:(\d+):start\s*-->/g;

/** Matches step done markers: <!-- step:N:done --> */
const STEP_DONE_RE = /<!--\s*step:(\d+):done\s*-->/g;

/**
 * Parse plan steps and their current statuses from raw model text.
 * Uses the LAST json:plan block found (the model may echo the SKILL.md
 * example before outputting the actual plan).
 * When `finalized` is true, any started-but-not-done step is treated as done
 * (the response is complete so the step won't get a done marker).
 * Returns null if no plan block is found.
 */
export function parsePlanProgress(text: string, finalized = false): PlanProgress | null {
  // Find the LAST json:plan block — the model may reference the SKILL.md
  // example plan in earlier text before emitting its actual plan.
  PLAN_BLOCK_RE.lastIndex = 0;
  let lastPlanJson: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = PLAN_BLOCK_RE.exec(text)) !== null) {
    lastPlanJson = m[1];
  }
  if (!lastPlanJson) return null;

  let planDefs: { step: number; label: string }[];
  try {
    planDefs = JSON.parse(lastPlanJson);
    if (!Array.isArray(planDefs) || planDefs.length === 0) return null;
  } catch {
    return null;
  }

  // Collect which steps have been started/done
  const started = new Set<number>();
  const done = new Set<number>();

  // Track timestamps for elapsed calculation
  const startTimes = new Map<number, number>();
  const doneTimes = new Map<number, number>();

  let match: RegExpExecArray | null;
  // Reset lastIndex before each scan
  STEP_START_RE.lastIndex = 0;
  while ((match = STEP_START_RE.exec(text)) !== null) {
    const n = parseInt(match[1], 10);
    started.add(n);
    // Use match position as a rough proxy for ordering (not real timestamps)
    if (!startTimes.has(n)) startTimes.set(n, match.index);
  }

  STEP_DONE_RE.lastIndex = 0;
  while ((match = STEP_DONE_RE.exec(text)) !== null) {
    const n = parseInt(match[1], 10);
    done.add(n);
    if (!doneTimes.has(n)) doneTimes.set(n, match.index);
  }

  let currentIndex = -1;
  const steps: PlanStep[] = planDefs.map((def, i) => {
    const n = def.step;
    let status: PlanStep["status"] = "not-started";
    if (done.has(n)) {
      status = "done";
    } else if (started.has(n)) {
      status = finalized ? "done" : "in-progress";
      if (!finalized) currentIndex = i;
    }
    return { step: n, label: def.label, status };
  });

  const completed = steps.filter((s) => s.status === "done").length;

  return { steps, total: steps.length, completed, currentIndex };
}

/**
 * Strip plan blocks and step markers from text so they don't render as visible content.
 */
export function stripPlanMarkers(text: string): string {
  return text
    .replace(/```json:plan\s*\n[\s\S]*?```/g, "")
    .replace(/<!--\s*step:\d+:(start|done)\s*-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Composable: reactive plan progress derived from a text ref.
 * When `streaming` ref is provided and becomes false, auto-finalize
 * any in-progress steps (model stopped without emitting done marker).
 */
export function usePlanProgress(text: Ref<string>, streaming?: Ref<boolean>) {
  const plan = computed(() => {
    const finalized = streaming ? !streaming.value : false;
    return parsePlanProgress(text.value, finalized);
  });
  const hasPlan = computed(() => plan.value !== null);
  const cleanText = computed(() => (hasPlan.value ? stripPlanMarkers(text.value) : text.value));

  return { plan, hasPlan, cleanText };
}
