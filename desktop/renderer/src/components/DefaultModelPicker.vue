<template>
  <div class="default-model-picker">
    <el-popover
      v-model:visible="open"
      trigger="click"
      role="dialog"
      :title="t('modelManager.defaultModel')"
      popper-class="model-picker-dialog"
      placement="bottom-end"
      :offset="6"
      :width="triggerWidth"
      :popper-style="{ minWidth: '0', boxSizing: 'border-box', padding: '4px' }"
      :disabled="disabled || switching"
    >
      <template #reference>
        <button
          ref="trigger"
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
          <IconChevronDown
            class="model-trigger-chevron"
            :size="12"
            :stroke-width="2"
            aria-hidden="true"
          />
        </button>
      </template>
      <section class="default-model-menu" :aria-label="t('modelManager.defaultModel')">
        <header class="default-model-header">
          <strong>{{ t("modelManager.defaultModel") }}</strong>
          <p class="scope-hint">{{ t("localModel.defaultNotice") }}</p>
        </header>
        <p v-if="loading && !models.length" role="status">{{ t("localModel.readingConfig") }}</p>
        <CascadingModelMenu
          v-if="open"
          :models="models"
          :selected-model="modelValue"
          :disabled="disabled || switching"
          :model-status="modelStatus"
          @select="choose"
        />
      </section>
    </el-popover>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { t } from "@/i18n";
import { getModelRef, providerName, type ConfiguredModel } from "@/utils/configured-models";
import CascadingModelMenu from "./CascadingModelMenu.vue";
import IconChevronDown from "./icons/IconChevronDown.vue";

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
const trigger = ref<HTMLButtonElement>();
const triggerWidth = ref(0);
let resizeObserver: ResizeObserver | undefined;

function updateTriggerWidth(): void {
  if (trigger.value) triggerWidth.value = trigger.value.getBoundingClientRect().width;
}

onMounted(() => {
  updateTriggerWidth();
  if (typeof ResizeObserver !== "undefined" && trigger.value) {
    resizeObserver = new ResizeObserver(updateTriggerWidth);
    resizeObserver.observe(trigger.value);
  }
});
onBeforeUnmount(() => resizeObserver?.disconnect());
watch(open, (visible) => {
  if (visible) updateTriggerWidth();
});

const selectedLabel = computed(() => {
  const model = props.models.find((item) => getModelRef(item) === props.modelValue);
  return model
    ? `${providerName(model.providerKey)} · ${model.name}`
    : props.modelValue || t("localModel.selectModel");
});
function choose(modelRef: string): void {
  if (props.disabled || props.switching) return;
  open.value = false;
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
.default-model-header {
  padding: 8px 8px 0;
}
:global(.model-picker-dialog .el-popover__title) {
  display: none;
}
.scope-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin: 8px 0;
}
.model-trigger-chevron {
  flex-shrink: 0;
}
</style>
