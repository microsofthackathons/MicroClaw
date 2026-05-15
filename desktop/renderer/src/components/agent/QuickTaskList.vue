<template>
  <ul class="quick-task-list">
    <li
      v-for="(task, i) in tasks"
      :key="i"
      class="quick-task-item"
      @click="$emit('select', task.title)"
    >
      {{ task.title }}
    </li>
  </ul>
</template>

<script setup lang="ts">
import type { QuickTask } from "@/stores/agents";

defineProps<{
  tasks: QuickTask[];
}>();

defineEmits<{
  select: [task: string];
}>();
</script>

<style scoped>
.quick-task-list {
  list-style: none;
  margin: 0;
  padding: 8px 0 8px 50px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.quick-task-item {
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-primary);
  font-size: 12px;
  transition: background 0.15s;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.quick-task-item:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}
</style>
