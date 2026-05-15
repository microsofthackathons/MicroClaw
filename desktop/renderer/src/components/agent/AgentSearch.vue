<template>
  <div class="agent-search">
    <IconSearch class="agent-search-icon" />
    <input
      ref="inputRef"
      class="agent-search-input"
      type="text"
      :placeholder="placeholder"
      :value="modelValue"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import IconSearch from "@/components/icons/IconSearch.vue";

defineProps<{
  modelValue: string;
  placeholder?: string;
}>();

defineEmits<{
  "update:modelValue": [value: string];
}>();

const inputRef = ref<HTMLInputElement>();

defineExpose({ focus: () => inputRef.value?.focus() });
</script>

<style scoped>
.agent-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  margin: 0;
  border-radius: var(--radius-pill);
  background: var(--bg-chat);
  border: 1px solid transparent;
  transition: border-color 0.15s;
}
.agent-search:focus-within {
  border-color: var(--accent);
}
.agent-search-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}
.agent-search-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 13px;
  color: var(--text-primary);
  line-height: 1.4;
}
.agent-search-input::placeholder {
  color: var(--text-muted);
}
</style>
