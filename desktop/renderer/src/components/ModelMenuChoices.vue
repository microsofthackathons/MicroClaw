<template>
  <button
    v-for="model in models"
    :key="getModelRef(model)"
    type="button"
    role="menuitemradio"
    class="model-menu-choice"
    :data-model-ref="getModelRef(model)"
    :aria-checked="getModelRef(model) === selectedModel"
    :disabled="disabled || Boolean(restrictionLabel(model))"
    :title="restrictionLabel(model) || model.name"
    @click="select(model)"
  >
    <span class="model-menu-name">{{ model.name }}</span>
    <span v-if="restrictionLabel(model) || modelStatus?.(model)" class="model-menu-state">
      {{ restrictionLabel(model) || modelStatus?.(model) }}
    </span>
    <IconCheckOutline
      v-if="getModelRef(model) === selectedModel"
      class="model-menu-check"
      :size="12"
      :stroke-width="2"
      aria-hidden="true"
    />
  </button>
</template>

<script setup lang="ts">
import { t } from "@/i18n";
import { getModelRef, type ConfiguredModel } from "@/utils/configured-models";
import { getChatModelRestriction } from "../../../src/provider-model-capabilities";
import IconCheckOutline from "./icons/IconCheckOutline.vue";

const props = defineProps<{
  models: ConfiguredModel[];
  selectedModel: string;
  disabled?: boolean;
  modelStatus?: (model: ConfiguredModel) => string;
}>();
const emit = defineEmits<{ select: [modelRef: string] }>();
function restrictionLabel(model: ConfiguredModel): string {
  const restriction = getChatModelRestriction(getModelRef(model));
  return restriction ? t(`modelSetup.incompatible.${restriction}`) : "";
}
function select(model: ConfiguredModel): void {
  if (!props.disabled && !restrictionLabel(model)) emit("select", getModelRef(model));
}
</script>

<style scoped>
.model-menu-choice {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--el-text-color-primary);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.model-menu-choice:not(:disabled):hover,
.model-menu-choice:not(:disabled):focus-visible {
  background: var(--accent-light);
}
.model-menu-choice:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: -2px;
}
.model-menu-choice:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.model-menu-name {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.model-menu-state {
  max-width: 45%;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.model-menu-check {
  flex-shrink: 0;
}
</style>
