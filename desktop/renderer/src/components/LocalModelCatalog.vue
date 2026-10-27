<template>
  <section class="local-catalog" :aria-label="t('localCatalog.title')">
    <div
      class="machine-summary"
      role="status"
      :title="hardwareDetails || undefined"
      :aria-label="hardwareDetails || undefined"
    >
      <svg class="machine-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 21h8m-4-4v4m-5-11 3 3 7-6" />
      </svg>
      <template v-if="hardware">
        <span class="machine-memory">{{
          t("localCatalog.totalMemory", {
            total: Math.round(hardware.totalMemoryBytes / 1024 ** 3),
          })
        }}</span>
        <span class="machine-separator" aria-hidden="true">·</span>
        <span class="machine-mode">{{
          gpu?.name ||
          t(hardware.accelerator === "metal" ? "localCatalog.metal" : "localCatalog.cpuMode")
        }}</span>
      </template>
      <span v-else>{{
        t(loading ? "localCatalog.checking" : "localCatalog.hardwareUnknown")
      }}</span>
    </div>

    <p
      v-if="recommendation.reason === 'limited'"
      class="resource-notice"
      role="status"
      data-testid="local-resources-limited"
    >
      {{ t("localCatalog.reason.limited") }}
    </p>

    <div class="model-list">
      <article v-if="featured" class="featured-model" data-testid="recommended-local-model">
        <div class="model-copy">
          <div class="model-name">
            <h3>{{ displayName(featured) }}</h3>
            <span class="recommendation-label">{{
              t(recommendation.modelRef ? "localCatalog.recommended" : "localCatalog.lightweight")
            }}</span>
            <span v-if="featured.modelRef === currentModelRef" class="current-model">{{
              t("localModel.currentDefault")
            }}</span>
          </div>
          <p class="model-meta">
            {{ downloadSize(featured) }} GB
            <span v-if="minimumMemory(featured)">
              · {{ t("localCatalog.minimumMemory", { size: minimumMemory(featured) }) }}</span
            >
            <span v-if="featured.fileStatus === 'present'">
              · {{ t("modelManager.downloaded") }}</span
            >
            <span v-else-if="featured.fileStatus === 'unknown'">
              · {{ t("localModel.filesUnknown") }}</span
            >
          </p>
          <p class="recommendation-reason">
            {{ t(`localCatalog.reason.${loading ? "checking" : recommendation.reason}`) }}
          </p>
        </div>
        <button
          class="primary-action"
          :data-model-ref="featured.modelRef"
          :disabled="isDisabled(featured)"
          :aria-busy="selectingModelRef === featured.modelRef"
          @click="emit('select', featured.modelRef)"
        >
          {{ actionLabel(featured) }}
        </button>
      </article>
      <div v-for="model in otherModels" :key="model.modelRef" class="model-row">
        <div class="model-copy">
          <div class="model-name">
            <strong>{{ displayName(model) }}</strong>
            <span v-if="model.modelRef === currentModelRef" class="current-model">{{
              t("localModel.currentDefault")
            }}</span>
          </div>
          <p class="model-meta">
            {{ downloadSize(model) }} GB
            <span v-if="minimumMemory(model)">
              · {{ t("localCatalog.minimumMemory", { size: minimumMemory(model) }) }}</span
            >
            <span v-if="model.fileStatus === 'present'"> · {{ t("modelManager.downloaded") }}</span>
            <span v-else-if="model.fileStatus === 'unknown'">
              · {{ t("localModel.filesUnknown") }}</span
            >
          </p>
          <p v-if="warning(model)" class="model-warning">{{ warning(model) }}</p>
        </div>
        <button
          :data-model-ref="model.modelRef"
          :disabled="isDisabled(model)"
          :aria-busy="selectingModelRef === model.modelRef"
          @click="emit('select', model.modelRef)"
        >
          {{ actionLabel(model) }}
        </button>
      </div>
    </div>
    <p class="estimate-note">{{ t("localCatalog.estimateNote") }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { t } from "@/i18n";
import { LOCAL_MODEL_PRESETS, type LocalModelCatalogEntry } from "../../../src/local-model-catalog";
import { recommendLocalModel } from "../../../src/local-model-recommendation";
import type { LocalModelHardware } from "../../../src/local-model-types";

const props = defineProps<{
  catalog: LocalModelCatalogEntry[];
  hardware: LocalModelHardware | null;
  loading?: boolean;
  disabled?: boolean;
  busyModelRef?: string;
  selectingModelRef?: string;
  currentModelRef?: string;
}>();
const emit = defineEmits<{ select: [modelRef: string] }>();
const recommendation = computed(() => recommendLocalModel(props.catalog, props.hardware));
const featured = computed(() =>
  recommendation.value.modelRef
    ? props.catalog.find((model) => model.modelRef === recommendation.value.modelRef)
    : recommendation.value.reason === "unknown"
      ? props.catalog.find((model) => model.preferred)
      : undefined,
);
const otherModels = computed(() => props.catalog.filter((model) => model !== featured.value));
const memorySummary = computed(() =>
  props.hardware
    ? t("localCatalog.memorySummary", {
        total: Math.round(props.hardware.totalMemoryBytes / 1024 ** 3),
        available: (props.hardware.availableMemoryBytes / 1024 ** 3).toFixed(1),
      })
    : "",
);
const gpu = computed(() =>
  props.hardware?.accelerator === "cuda"
    ? [...props.hardware.gpus].sort(
        (first, second) => second.availableMemoryBytes - first.availableMemoryBytes,
      )[0]
    : undefined,
);
const gpuMemory = computed(() => ((gpu.value?.totalMemoryBytes ?? 0) / 1024 ** 3).toFixed(0));
const hardwareDetails = computed(() =>
  props.hardware
    ? [
        props.hardware.cpu,
        memorySummary.value,
        gpu.value
          ? `${gpu.value.name} · ${gpuMemory.value} GB ${t("localCatalog.vram")}`
          : t(props.hardware.accelerator === "metal" ? "localCatalog.metal" : "localCatalog.cpu"),
      ].join("\n")
    : "",
);
function displayName(model: LocalModelCatalogEntry): string {
  return model.name.replace(/\s+(?:UD-)?Q4_K_M$/u, "");
}
function downloadSize(model: LocalModelCatalogEntry): string {
  return (model.downloadBytes / 1e9).toFixed(1);
}
function minimumMemory(model: LocalModelCatalogEntry): number {
  return (
    LOCAL_MODEL_PRESETS.find((preset) => preset.modelRef === model.modelRef)?.minimumSystemGiB ?? 0
  );
}
function warning(model: LocalModelCatalogEntry): string {
  const fit = recommendation.value.fit[model.modelRef];
  return fit && fit !== "fits" && fit !== "unknown" ? t(`localCatalog.fit.${fit}`) : "";
}
function isDisabled(model: LocalModelCatalogEntry): boolean {
  return Boolean(props.disabled || (props.busyModelRef && props.busyModelRef !== model.modelRef));
}
function actionLabel(model: LocalModelCatalogEntry): string {
  return t(
    props.selectingModelRef === model.modelRef
      ? "modelManager.switching"
      : props.busyModelRef === model.modelRef
        ? "localModel.viewSetup"
        : model.fileStatus === "present"
          ? "localModel.useModel"
          : "localCatalog.downloadModel",
  );
}
</script>

<style scoped>
.local-catalog {
  --catalog-muted: var(--smtc-foreground-ctrl-neutral-secondary-rest, #60646c);
  --catalog-border: var(--smtc-stroke-divider-subtle, #e5e7eb);
  --catalog-subtle: var(--smtc-background-ctrl-subtle-hover, #f8f9fa);
  font-size: 13px;
}
.machine-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin: 0 0 18px;
  color: var(--catalog-muted);
  font-size: 12px;
  line-height: 1.6;
}
.machine-icon {
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  stroke: currentColor;
  stroke-width: 1.5;
}
.machine-memory,
.machine-separator {
  flex-shrink: 0;
}
.machine-mode {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-copy {
  flex: 1;
  min-width: 0;
}
.model-list {
  border: 1px solid var(--catalog-border);
  border-radius: 12px;
  overflow: hidden;
}
.featured-model {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px;
  background: var(--catalog-subtle);
}
.recommendation-label {
  padding: 2px 6px;
  border: 1px solid var(--catalog-border);
  border-radius: 5px;
  color: var(--catalog-muted);
  font-size: 10px;
  font-weight: 500;
  line-height: 1.4;
}
.featured-model h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.recommendation-reason {
  margin: 6px 0 0;
  color: var(--catalog-muted);
  font-size: 12px;
  line-height: 1.6;
}
button {
  flex-shrink: 0;
  padding: 7px 12px;
  min-height: 34px;
  border: 1px solid var(--catalog-border);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  cursor: pointer;
}
button:hover:not(:disabled) {
  background: var(--catalog-subtle);
}
button:focus-visible {
  outline: 2px solid var(--smtc-foreground-ctrl-neutral-primary-rest, #242424);
  outline-offset: 3px;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.primary-action {
  background: var(--smtc-background-ctrl-neutral-primary-rest, #18181b);
  color: var(--smtc-foreground-ctrl-on-accent-rest, #fff);
  border-color: transparent;
}
.primary-action:hover:not(:disabled) {
  opacity: 0.9;
  background: var(--smtc-background-ctrl-neutral-primary-rest, #18181b);
}
.model-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 16px 18px;
}
.featured-model + .model-row,
.model-row + .model-row {
  border-top: 1px solid var(--catalog-border);
}
.model-name {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.model-name strong {
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.current-model {
  color: var(--catalog-muted);
  font-size: 11px;
  font-weight: 400;
}
.model-meta,
.model-warning {
  margin: 5px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--catalog-muted);
}
.model-warning,
.resource-notice {
  color: var(--smtc-status-warning-foreground, #90621d);
}
.resource-notice {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.6;
}
.estimate-note {
  margin: 12px 0 0;
  color: var(--catalog-muted);
  font-size: 11px;
  line-height: 1.6;
}
@media (max-width: 420px) {
  .featured-model,
  .model-row {
    align-items: flex-start;
    gap: 10px;
    padding: 14px;
  }
  .featured-model button,
  .model-row button {
    max-width: 92px;
    padding: 6px 10px;
  }
}
</style>
