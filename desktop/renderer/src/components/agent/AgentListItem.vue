<template>
  <div class="agent-list-item" :class="{ active: isActive }" @click="handleClick">
    <AgentAvatar :src="agent.avatar" :name="agent.name" :size="38" />
    <div class="agent-list-item-info">
      <span class="agent-list-item-name">{{ agent.name }}</span>
      <span v-if="agent.description" class="agent-list-item-desc">{{ agent.description }}</span>
    </div>
    <button
      v-if="agent.quickTasks?.length"
      class="agent-list-item-expand"
      :class="{ expanded }"
      @click.stop="expanded = !expanded"
      :title="t('agent.quickTasks')"
    >
      <IconChevronDown :size="12" />
    </button>
  </div>
  <QuickTaskList
    v-if="expanded && agent.quickTasks?.length"
    :tasks="agent.quickTasks"
    @select="(task) => $emit('quickTask', task)"
  />
</template>

<script setup lang="ts">
import { ref } from "vue";
import type { Agent } from "@/stores/agents";
import { t } from "@/i18n";
import AgentAvatar from "./AgentAvatar.vue";
import QuickTaskList from "./QuickTaskList.vue";
import IconChevronDown from "@/components/icons/IconChevronDown.vue";

const props = defineProps<{
  agent: Agent;
  isActive?: boolean;
}>();

const emit = defineEmits<{
  select: [agentId: string];
  quickTask: [task: string];
}>();

const expanded = ref(false);

function handleClick() {
  emit("select", props.agent.id);
  if (props.agent.quickTasks?.length) {
    expanded.value = !expanded.value;
  }
}
</script>

<style scoped>
.agent-list-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.15s;
}
.agent-list-item:hover {
  background: var(--bg-chat);
}
.agent-list-item.active {
  background: var(--bg-chat);
}
.agent-list-item-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.agent-list-item-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-list-item-desc {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-list-item-expand {
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  border-radius: 4px;
  cursor: pointer;
  display: grid;
  place-items: center;
  color: var(--text-muted);
  transition:
    transform 0.2s,
    color 0.15s,
    opacity 0.15s;
  flex-shrink: 0;
  opacity: 0;
}
.agent-list-item:hover .agent-list-item-expand,
.agent-list-item-expand.expanded {
  opacity: 1;
}
.agent-list-item-expand:hover {
  color: var(--text-secondary);
}
.agent-list-item-expand.expanded {
  transform: rotate(180deg);
}
</style>
