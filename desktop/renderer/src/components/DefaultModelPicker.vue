<template>
  <div class="default-model-picker">
    <el-popover
      v-model:visible="open"
      trigger="click"
      role="dialog"
      :title="t('modelManager.defaultModel')"
      popper-class="model-picker-dialog"
      placement="bottom-end"
      :width="380"
      :popper-style="{ maxWidth: 'calc(100vw - 32px)' }"
      :disabled="disabled || switching"
    >
      <template #reference>
        <button
          type="button"
          class="default-model-trigger"
          data-testid="default-model-picker"
          :disabled="disabled || switching"
          :aria-label="t('modelManager.defaultModel')"
          :aria-expanded="open"
          :aria-busy="loading || switching"
          :title="selectedLabel"
        >
          <span v-if="switching" role="status">{{ t("modelManager.switching") }}</span>
          <span v-else>{{ selectedLabel }}</span>
          <span aria-hidden="true">&#9662;</span>
        </button>
      </template>
      <section class="default-model-menu" :aria-label="t('modelManager.defaultModel')">
        <strong>{{ t("modelManager.defaultModel") }}</strong>
        <p class="scope-hint">{{ t("localModel.defaultNotice") }}</p>
        <input
          v-model="query"
          type="search"
          class="model-search"
          :aria-label="t('modelManager.search')"
          :placeholder="t('modelManager.search')"
        />
        <p v-if="loading && !models.length" role="status">{{ t("localModel.readingConfig") }}</p>
        <ModelProviderGroups
          :models="models"
          :selected-model="modelValue"
          :query="query"
          :disabled="disabled || switching"
          :model-status="modelStatus"
          @select="choose"
          @clear-search="query = ''"
        />
      </section>
    </el-popover>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { t } from "@/i18n";
import { getModelRef, providerName, type ConfiguredModel } from "@/utils/configured-models";
import ModelProviderGroups from "./ModelProviderGroups.vue";

const props = defineProps<{
  modelValue: string;
  models: ConfiguredModel[];
  disabled?: boolean;
  loading?: boolean;
  switching?: boolean;
  modelStatus?: (model: ConfiguredModel) => string;
}>();
const emit = defineEmits<{ change: [modelRef: string] }>();
const open = ref(false);
const query = ref("");
const selectedLabel = computed(() => {
  const model = props.models.find((item) => getModelRef(item) === props.modelValue);
  return model
    ? `${providerName(model.providerKey)} · ${model.name}`
    : props.modelValue || t("localModel.selectModel");
});
function choose(modelRef: string): void {
  if (props.disabled || props.switching) return;
  open.value = false;
  query.value = "";
  emit("change", modelRef);
}
watch(
  () => props.disabled || props.switching,
  (disabled) => {
    if (disabled) open.value = false;
  },
);
</script>

<style scoped>
.default-model-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-height: 32px;
  padding: 6px 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 7px;
  background: var(--el-fill-color-blank);
  color: var(--el-text-color-regular);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}
.default-model-trigger > span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.default-model-trigger:hover {
  border-color: var(--el-border-color-hover);
}
.default-model-trigger:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
.default-model-trigger:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.default-model-menu {
  color: var(--el-text-color-primary);
}
.scope-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin: 8px 0;
}
.model-search {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  background: var(--el-fill-color-blank);
  color: inherit;
}
</style>
