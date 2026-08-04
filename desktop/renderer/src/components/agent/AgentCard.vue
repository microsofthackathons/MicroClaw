<template>
  <div class="agent-card" :class="{ 'is-added': agent.isAdded }">
    <span v-if="agent.isAdded" class="agent-card-check">
      <IconCheck :size="20" />
    </span>
    <div class="agent-card-avatar">
      <img v-if="agent.image" :src="agent.image" :alt="agent.name" class="agent-card-avatar-img" />
      <span v-else class="agent-card-avatar-fallback">{{ agent.name.charAt(0) }}</span>
    </div>
    <div class="agent-card-body">
      <div class="agent-card-name">{{ agent.name }}</div>
      <div v-if="agent.description" class="agent-card-desc">{{ agent.description }}</div>
      <div v-if="agent.tags?.length" class="agent-card-tags">
        <span v-for="tag in agent.tags" :key="tag" class="agent-card-tag">{{ tag }}</span>
      </div>
      <button
        v-if="agent.isAdded"
        class="agent-card-action agent-card-action-danger"
        @click="$emit('remove', agent.id)"
      >
        <IconClose :size="14" />
        {{ t("agentMarket.remove") }}
      </button>
      <button
        v-else
        class="agent-card-action"
        :disabled="adding"
        :aria-busy="adding"
        @click="$emit('add', agent.id)"
      >
        <span v-if="adding" class="agent-card-spinner" aria-hidden="true"></span>
        <IconPlus v-else :size="14" />
        {{ t(adding ? "agentMarket.adding" : "agentMarket.add") }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Agent } from "@/stores/agents";
import { t } from "@/i18n";
import IconPlus from "@/components/icons/IconPlus.vue";
import IconCheck from "@/components/icons/IconCheck.vue";
import IconClose from "@/components/icons/IconClose.vue";

defineProps<{
  agent: Agent;
  adding?: boolean;
}>();

defineEmits<{
  add: [agentId: string];
  remove: [agentId: string];
}>();
</script>

<style scoped>
.agent-card {
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--bg-chat);
  border: 1px solid var(--border-strong);
  border-radius: 20px;
  overflow: hidden;
  transition:
    background 0.2s,
    box-shadow 0.2s,
    opacity 0.2s;
  cursor: pointer;
}

.agent-card:hover {
  background: var(--bg-chat-hover);
  box-shadow: var(--card-shadow-hover);
}

.agent-card.is-added {
  cursor: default;
}

.agent-card.is-added:hover {
  background: var(--bg-chat);
  box-shadow: none;
}

.agent-card-check {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 1;
  line-height: 0;
  color: var(--success);
}

.agent-card-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 20px;
}

.agent-card-avatar-img {
  width: 100%;
  height: auto;
  object-fit: contain;
}

.agent-card-avatar-fallback {
  width: 140px;
  height: 140px;
  display: grid;
  place-items: center;
  font-size: 48px;
  font-weight: 600;
  color: var(--text-muted);
}

.agent-card-body {
  padding: 12px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.agent-card-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.agent-card-desc {
  font-size: 12px;
  color: var(--text-primary);
  line-height: 1.5;
}

.agent-card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.agent-card-tag {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-secondary);
  background: var(--bg-chat-hover);
  border: 1px solid var(--border-strong);
  padding: 2px 10px;
  border-radius: 20px;
}

.agent-card-action {
  align-self: flex-start;
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 10px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 16px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s;
  font-family: inherit;
}

.agent-card-action:hover {
  background: var(--accent);
  color: var(--bg-primary);
}

.agent-card-action:disabled {
  cursor: wait;
  opacity: 0.65;
}

.agent-card-action:disabled:hover {
  background: transparent;
  color: var(--text-primary);
}

.agent-card-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: agent-card-spin 0.7s linear infinite;
}

@keyframes agent-card-spin {
  to {
    transform: rotate(360deg);
  }
}

.agent-card-action-danger {
  color: var(--danger, #c0392b);
}

.agent-card-action-danger:hover {
  background: var(--danger, #c0392b);
  color: #fff;
}
</style>
