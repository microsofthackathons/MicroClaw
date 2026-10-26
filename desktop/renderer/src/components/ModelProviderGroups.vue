<template>
  <div class="model-groups">
    <section v-for="group in groups" :key="group.key" class="model-group">
      <h4>
        <button
          type="button"
          class="model-group-toggle"
          :data-provider-group="group.key"
          :aria-expanded="isExpanded(group.key)"
          :aria-controls="`${groupId}-${group.key}`"
          @click="toggle(group.key)"
        >
          <svg
            class="model-group-chevron"
            :class="{ expanded: isExpanded(group.key) }"
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            aria-hidden="true"
          >
            <path d="m5 3 4 4-4 4" />
          </svg>
          <span class="model-group-name">{{ providerName(group.key) }}</span>
          <span class="model-group-count" aria-hidden="true">{{ group.models.length }}</span>
        </button>
      </h4>
      <div
        v-show="isExpanded(group.key)"
        :id="`${groupId}-${group.key}`"
        class="model-group-models"
      >
        <div v-for="model in group.models" :key="getModelRef(model)" class="model-choice">
          <button
            type="button"
            class="model-choice-button"
            :class="{ selected: getModelRef(model) === selectedModel }"
            :data-model-ref="getModelRef(model)"
            :aria-pressed="getModelRef(model) === selectedModel"
            :disabled="disabled || isModelDisabled?.(model) || Boolean(restrictionLabel(model))"
            :title="restrictionLabel(model) || undefined"
            @click="select(model)"
          >
            <span class="model-choice-name">{{ model.name }}</span>
            <span v-if="restrictionLabel(model) || modelStatus" class="model-choice-state">
              {{ restrictionLabel(model) || modelStatus?.(model) }}
            </span>
            <span v-if="getModelRef(model) === selectedModel" aria-hidden="true">&#10003;</span>
          </button>
          <slot name="model-action" :model="model" />
        </div>
      </div>
    </section>
    <p v-if="!groups.length" class="empty-models" role="status">
      {{ t(search ? "modelManager.noMatches" : "settings.noProviderConfigured") }}
      <button v-if="search" type="button" class="clear-search" @click="emit('clear-search')">
        {{ t("modelManager.clearSearch") }}
      </button>
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { t } from "@/i18n";
import { getModelRef, providerName, type ConfiguredModel } from "@/utils/configured-models";
import { sortModelsByFamily } from "@/utils/model-family-sort";
import { getChatModelRestriction } from "../../../src/provider-model-capabilities";

const props = defineProps<{
  models: ConfiguredModel[];
  selectedModel?: string | null;
  query: string;
  disabled?: boolean;
  contextKey?: string;
  isModelDisabled?: (model: ConfiguredModel) => boolean;
  modelStatus?: (model: ConfiguredModel) => string;
}>();
const emit = defineEmits<{ select: [modelRef: string]; "clear-search": [] }>();
const groupId = useId();
const expandedGroups = ref(new Map<string, boolean>());
const searchExpandedGroups = ref(new Map<string, boolean>());
const search = computed(() => props.query.trim().toLocaleLowerCase());
const currentProvider = computed(() => props.selectedModel?.split("/", 1)[0]);
const groups = computed(() => {
  const result = new Map<string, ConfiguredModel[]>();
  for (const model of props.models) {
    if (
      search.value &&
      !`${model.name} ${getModelRef(model)} ${providerName(model.providerKey)}`
        .toLocaleLowerCase()
        .includes(search.value)
    )
      continue;
    const group = result.get(model.providerKey) ?? [];
    group.push(model);
    result.set(model.providerKey, group);
  }
  return [...result].map(([key, models]) => ({ key, models: sortModelsByFamily(models) }));
});

function isExpanded(provider: string): boolean {
  if (search.value) return searchExpandedGroups.value.get(provider) ?? true;
  return expandedGroups.value.get(provider) ?? provider === currentProvider.value;
}
function toggle(provider: string): void {
  const expansion = search.value ? searchExpandedGroups.value : expandedGroups.value;
  expansion.set(provider, !isExpanded(provider));
}
function select(model: ConfiguredModel): void {
  if (!props.disabled && !props.isModelDisabled?.(model) && !restrictionLabel(model))
    emit("select", getModelRef(model));
}
function restrictionLabel(model: ConfiguredModel): string {
  const restriction = getChatModelRestriction(getModelRef(model));
  return restriction ? t(`modelSetup.incompatible.${restriction}`) : "";
}
watch(search, () => searchExpandedGroups.value.clear(), { flush: "sync" });
watch(
  () => props.contextKey,
  () => {
    expandedGroups.value.clear();
    searchExpandedGroups.value.clear();
  },
);
</script>

<style scoped>
/* The popover title names its dialog; each picker renders its own visible header. */
:global(.model-picker-dialog .el-popover__title) {
  display: none;
}

.model-groups {
  max-height: 320px;
  overflow-y: auto;
}
.model-group h4 {
  margin: 8px 0 0;
}
.model-group-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--el-text-color-primary);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.model-group-toggle:hover,
.model-choice-button:hover,
.model-choice-button.selected {
  background: var(--el-fill-color-light);
}
.model-group-toggle:focus-visible,
.model-choice-button:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: -2px;
}
.model-group-chevron {
  flex-shrink: 0;
}
.model-group-chevron.expanded {
  transform: rotate(90deg);
}
.model-group-name {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.model-group-count {
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
.model-group-models {
  padding-left: 20px;
}
.model-choice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.model-choice-button {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  padding: 10px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--el-text-color-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.model-choice-button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.model-choice-name {
  flex: 1;
  overflow-wrap: anywhere;
}
.model-choice-state {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.empty-models {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.clear-search {
  border: 0;
  padding: 4px 0;
  background: transparent;
  color: var(--el-color-primary);
  cursor: pointer;
  font-size: 12px;
}
</style>
