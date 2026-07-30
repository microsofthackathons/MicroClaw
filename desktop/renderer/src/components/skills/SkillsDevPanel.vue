<template>
  <div class="skills-dev-panel">
    <div class="skills-dev-scroll">
      <div class="skills-dev-header">
        <h2 class="skills-dev-title">{{ t("skills.dev.title") }}</h2>
        <p class="skills-dev-subtitle">{{ t("skills.dev.subtitle") }}</p>
      </div>

      <div class="skills-dev-row">
        <label class="skills-dev-label" for="skills-dev-agent">
          {{ t("skills.dev.agent") }}
        </label>
        <select
          id="skills-dev-agent"
          class="skills-dev-select"
          :value="selectedAgentId"
          @change="onAgentChange"
        >
          <option v-for="agent in agents" :key="agent.id" :value="agent.id">
            {{ agent.name }} ({{ agent.id }})
          </option>
        </select>
      </div>

      <div class="skills-dev-actions-top">
        <button class="skills-dev-linkbtn" type="button" @click="selectAll">
          {{ t("skills.dev.selectAll") }}
        </button>
        <button class="skills-dev-linkbtn" type="button" @click="clearAll">
          {{ t("skills.dev.clearAll") }}
        </button>
        <button
          class="skills-dev-linkbtn"
          type="button"
          :disabled="statusLoading"
          @click="refreshStatus"
        >
          {{ statusLoading ? t("skills.dev.refreshing") : t("skills.dev.refresh") }}
        </button>
        <span class="skills-dev-count">
          {{ t("skills.dev.enabledCount", { count: enabledCount, total: allSkillIds.length }) }}
        </span>
      </div>

      <div class="skills-dev-summary">
        <span v-if="status">
          {{ t("skills.dev.modelVisibleSummary", {
            visible: status.summary.modelVisible,
            total: status.summary.total,
          }) }}
        </span>
        <span v-if="statusError" class="skills-dev-status-error">
          {{ t("skills.dev.statusFailed", { error: statusError }) }}
        </span>
      </div>

      <div v-if="loading" class="skills-dev-status">{{ t("skills.dev.loading") }}</div>
      <ul v-else class="skills-dev-list">
        <li v-for="id in allSkillIds" :key="id" class="skills-dev-item">
          <div class="skills-dev-item-main">
            <label class="skills-dev-toggle">
              <input type="checkbox" :checked="pending.has(id)" @change="toggleSkill(id)" />
              <span class="skills-dev-skill-id">{{ id }}</span>
              <span class="skills-dev-toggle-hint">{{ t("skills.dev.thisAgent") }}</span>
            </label>
            <label class="skills-dev-global">
              <input
                type="checkbox"
                :checked="globalOn(id)"
                :disabled="!statusFor(id) || globalBusy.has(id)"
                @change="toggleGlobal(id)"
              />
              <span class="skills-dev-global-label">{{ t("skills.dev.global") }}</span>
            </label>
          </div>
          <div v-if="statusFor(id)" class="skills-dev-item-status">
            <span class="skills-dev-badge" :class="badgeClass(id)">{{ badgeText(id) }}</span>
            <span v-if="reasonText(id)" class="skills-dev-reason">{{ reasonText(id) }}</span>
            <span v-if="missingText(id)" class="skills-dev-missing">{{ missingText(id) }}</span>
          </div>
        </li>
      </ul>
    </div>

    <div class="skills-dev-footer">
      <span v-if="feedback" class="skills-dev-feedback" :class="`is-${feedbackKind}`">
        {{ feedback }}
      </span>
      <button
        class="skills-dev-apply"
        type="button"
        :disabled="applying || loading || !dirty"
        @click="apply"
      >
        {{ applying ? t("skills.dev.applying") : t("skills.dev.apply") }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { t } from "@/i18n";
import { useAgentStore } from "@/stores/agents";
import { AGENT_CATALOG, ALL_SKILL_IDS, matchesSkill } from "../../../../src/agent-catalog";

const agentStore = useAgentStore();

const agents = AGENT_CATALOG.map((agent) => ({ id: agent.id, name: agent.name }));
const allSkillIds = ALL_SKILL_IDS;

const selectedAgentId = ref(resolveDefaultAgentId());
const pending = ref<Set<string>>(new Set());
const persisted = ref<Set<string>>(new Set());
const loading = ref(false);
const applying = ref(false);
const feedback = ref("");
const feedbackKind = ref<"info" | "success" | "error">("info");

const status = ref<SkillsStatus | null>(null);
const statusLoading = ref(false);
const statusError = ref("");
const globalBusy = ref<Set<string>>(new Set());

function resolveDefaultAgentId(): string {
  const current = agentStore.currentAgentId;
  return agents.some((a) => a.id === current) ? current : "main";
}

const enabledCount = computed(() => pending.value.size);
const dirty = computed(() => !setsEqual(pending.value, persisted.value));

// Match a status record (keyed by the CLI's frontmatter name or slug) back to a
// catalog slug, tolerating both the slug- and display-name forms.
function statusFor(slug: string): SkillStatusRecord | undefined {
  const records = status.value?.skills;
  if (!records) return undefined;
  return records.find(
    (record) => matchesSkill(record.skillKey, slug) || matchesSkill(record.name, slug),
  );
}

function globalOn(slug: string): boolean {
  const record = statusFor(slug);
  // Unknown skills default to "on" so the switch isn't misleadingly off.
  if (!record) return true;
  return !record.disabled && !record.blockedByAllowlist;
}

function badgeClass(slug: string): string {
  const record = statusFor(slug);
  if (!record) return "is-unknown";
  if (record.modelVisible) return "is-visible";
  return "is-hidden";
}

function badgeText(slug: string): string {
  const record = statusFor(slug);
  if (!record) return t("skills.dev.badge.unknown");
  return record.modelVisible ? t("skills.dev.badge.visible") : t("skills.dev.badge.hidden");
}

function reasonText(slug: string): string {
  const record = statusFor(slug);
  if (!record || record.modelVisible) return "";
  if (record.blockedByAllowlist) return t("skills.dev.reason.allowlist");
  if (record.blockedByAgentFilter) return t("skills.dev.reason.agentFilter");
  if (record.disabled) return t("skills.dev.reason.disabled");
  if (!record.eligible) return t("skills.dev.reason.missing");
  return "";
}

function missingText(slug: string): string {
  const record = statusFor(slug);
  if (!record || record.modelVisible || record.eligible) return "";
  const parts: string[] = [];
  const bins = [...record.missing.bins, ...record.missing.anyBins];
  if (bins.length) parts.push(t("skills.dev.missing.bins", { list: bins.join(", ") }));
  if (record.missing.env.length)
    parts.push(t("skills.dev.missing.env", { list: record.missing.env.join(", ") }));
  if (record.missing.config.length)
    parts.push(t("skills.dev.missing.config", { list: record.missing.config.join(", ") }));
  if (record.missing.os.length)
    parts.push(t("skills.dev.missing.os", { list: record.missing.os.join(", ") }));
  return parts.join(" · ");
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

async function loadAgentSkills(agentId: string): Promise<void> {
  loading.value = true;
  feedback.value = "";
  try {
    const config = await window.openclaw.config.read();
    const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
    const entry = list.find(
      (candidate: unknown) =>
        typeof candidate === "object" &&
        candidate !== null &&
        (candidate as { id?: unknown }).id === agentId,
    ) as { skills?: unknown } | undefined;
    const stored = Array.isArray(entry?.skills)
      ? entry.skills.filter((id: unknown): id is string => typeof id === "string")
      : [];
    // A stored value counts as ON if it matches EITHER the slug or the mapped
    // OpenClaw match-name, so both older slug-form and current name-form register.
    const skills = allSkillIds.filter((slug) =>
      stored.some((value) => matchesSkill(value, slug)),
    );
    persisted.value = new Set(skills);
    pending.value = new Set(skills);
  } catch (error) {
    feedbackKind.value = "error";
    feedback.value = t("skills.dev.loadFailed", {
      error: error instanceof Error ? error.message : String(error),
    });
    persisted.value = new Set();
    pending.value = new Set();
  } finally {
    loading.value = false;
  }
}

function onAgentChange(event: Event): void {
  selectedAgentId.value = (event.target as HTMLSelectElement).value;
}

function toggleSkill(id: string): void {
  const next = new Set(pending.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  pending.value = next;
}

function selectAll(): void {
  pending.value = new Set(allSkillIds);
}

function clearAll(): void {
  pending.value = new Set();
}

async function loadStatus(agentId: string): Promise<void> {
  statusLoading.value = true;
  statusError.value = "";
  try {
    const result = await window.openclaw.skills.getStatus(agentId);
    if (result.ok) {
      status.value = result;
    } else {
      status.value = null;
      statusError.value = result.error ?? "unknown error";
    }
  } catch (error) {
    status.value = null;
    statusError.value = error instanceof Error ? error.message : String(error);
  } finally {
    statusLoading.value = false;
  }
}

function refreshStatus(): void {
  void loadStatus(selectedAgentId.value);
}

async function toggleGlobal(slug: string): Promise<void> {
  const next = !globalOn(slug);
  const busy = new Set(globalBusy.value);
  busy.add(slug);
  globalBusy.value = busy;
  feedbackKind.value = "info";
  feedback.value = t("skills.dev.globalUpdating", { skill: slug });
  try {
    await window.openclaw.skills.setGlobalEnabled(slug, next);
    feedbackKind.value = "success";
    feedback.value = t("skills.dev.globalUpdated", { skill: slug });
    await loadStatus(selectedAgentId.value);
  } catch (error) {
    feedbackKind.value = "error";
    feedback.value = t("skills.dev.globalFailed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    const done = new Set(globalBusy.value);
    done.delete(slug);
    globalBusy.value = done;
  }
}

async function apply(): Promise<void> {
  applying.value = true;
  feedbackKind.value = "info";
  feedback.value = t("skills.dev.applying");
  const agentId = selectedAgentId.value;
  const skillIds = allSkillIds.filter((id) => pending.value.has(id));
  try {
    await window.openclaw.skills.setAgentSkills(agentId, skillIds);
    persisted.value = new Set(skillIds);
    feedbackKind.value = "success";
    feedback.value = t("skills.dev.applied");
    await loadStatus(agentId);
  } catch (error) {
    feedbackKind.value = "error";
    feedback.value = t("skills.dev.applyFailed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    applying.value = false;
  }
}

watch(selectedAgentId, (agentId) => {
  void loadAgentSkills(agentId);
  void loadStatus(agentId);
});

onMounted(() => {
  void loadAgentSkills(selectedAgentId.value);
  void loadStatus(selectedAgentId.value);
});
</script>

<style scoped>
.skills-dev-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.skills-dev-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: clamp(8px, 2vw, 20px);
}

.skills-dev-header {
  margin-bottom: 16px;
}

.skills-dev-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--ux-text-primary);
  margin: 0 0 4px;
}

.skills-dev-subtitle {
  font-size: 13px;
  color: var(--ux-text-muted);
  margin: 0;
}

.skills-dev-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.skills-dev-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--ux-text-primary);
}

.skills-dev-select {
  flex: 1;
  max-width: 320px;
  padding: 6px 10px;
  font-size: 13px;
  font-family: inherit;
  border: 1px solid var(--ux-border);
  border-radius: 8px;
  background: var(--ux-surface);
  color: var(--ux-text-primary);
}

.skills-dev-actions-top {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}

.skills-dev-linkbtn {
  padding: 2px 4px;
  font-size: 12px;
  font-family: inherit;
  background: transparent;
  border: none;
  color: var(--ux-ctrl-brand-rest);
  cursor: pointer;
}

.skills-dev-linkbtn:hover {
  text-decoration: underline;
}

.skills-dev-count {
  font-size: 12px;
  color: var(--ux-text-muted);
  margin-left: auto;
}

.skills-dev-status {
  font-size: 13px;
  color: var(--ux-text-muted);
  padding: 8px 0;
}

.skills-dev-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 6px 16px;
}

.skills-dev-item {
  min-width: 0;
}

.skills-dev-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
}

.skills-dev-toggle:hover {
  background: var(--ux-surface-hover);
}

.skills-dev-skill-id {
  font-size: 13px;
  color: var(--ux-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skills-dev-summary {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--ux-text-muted);
  margin-bottom: 8px;
  min-height: 16px;
}

.skills-dev-status-error {
  color: var(--ux-status-error, #c62828);
}

.skills-dev-item-main {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
}

.skills-dev-toggle-hint {
  font-size: 11px;
  color: var(--ux-text-muted);
}

.skills-dev-global {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  flex-shrink: 0;
}

.skills-dev-global-label {
  font-size: 11px;
  color: var(--ux-text-muted);
}

.skills-dev-item-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 2px 8px 4px 8px;
}

.skills-dev-badge {
  font-size: 11px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 999px;
  white-space: nowrap;
}

.skills-dev-badge.is-visible {
  background: var(--ux-status-success-bg, rgba(46, 125, 50, 0.14));
  color: var(--ux-status-success, #2e7d32);
}

.skills-dev-badge.is-hidden {
  background: var(--ux-status-warning-bg, rgba(198, 40, 40, 0.12));
  color: var(--ux-status-error, #c62828);
}

.skills-dev-badge.is-unknown {
  background: var(--ux-surface-hover);
  color: var(--ux-text-muted);
}

.skills-dev-reason {
  font-size: 11px;
  color: var(--ux-text-primary);
}

.skills-dev-missing {
  font-size: 11px;
  color: var(--ux-text-muted);
}

.skills-dev-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 10px clamp(8px, 2vw, 20px);
  border-top: 1px solid var(--ux-border);
  flex-shrink: 0;
}

.skills-dev-feedback {
  font-size: 12px;
}

.skills-dev-feedback.is-success {
  color: var(--ux-status-success, #2e7d32);
}

.skills-dev-feedback.is-error {
  color: var(--ux-status-error, #c62828);
}

.skills-dev-feedback.is-info {
  color: var(--ux-text-muted);
}

.skills-dev-apply {
  padding: 6px 18px;
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  border: 1px solid var(--ux-ctrl-brand-rest);
  border-radius: 999px;
  background: var(--ux-ctrl-brand-rest);
  color: var(--ux-ctrl-on-brand);
  cursor: pointer;
}

.skills-dev-apply:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
