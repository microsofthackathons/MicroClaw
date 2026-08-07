<template>
  <div class="agent-market">
    <div class="agent-market-grid">
      <AgentCard
        v-for="agent in filteredAgents"
        :key="agent.id"
        :agent="agent"
        :adding="addingAgentIds.has(agent.id)"
        @add="handleAdd"
        @remove="handleRemove"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAgentStore } from "@/stores/agents";
import { useAgentList } from "@/composables/useAgentList";
import AgentCard from "@/components/agent/AgentCard.vue";
import { t } from "@/i18n";

const agentStore = useAgentStore();
const { filteredAgents } = useAgentList(computed(() => agentStore.marketAgents));
const addingAgentIds = ref(new Set<string>());

async function handleAdd(agentId: string) {
  const agent = agentStore.marketAgents.find((candidate) => candidate.id === agentId);
  if (!agent || agent.isAdded || addingAgentIds.value.has(agentId)) return;

  addingAgentIds.value.add(agentId);
  try {
    await agentStore.addAgent(agentId);
    ElMessage.success(t("agentMarket.addSuccess", { name: agent.name }));
  } catch {
    ElMessage.error(t("agentMarket.addFailed"));
  } finally {
    addingAgentIds.value.delete(agentId);
  }
}

async function handleRemove(agentId: string) {
  const agent = agentStore.marketAgents.find((candidate) => candidate.id === agentId);
  if (!agent) return;
  try {
    await ElMessageBox.confirm(
      t("agentMarket.removeConfirm", { name: agent.name }),
      t("agentMarket.removeTitle"),
      {
        confirmButtonText: t("agentMarket.remove"),
        cancelButtonText: t("agentMarket.cancel"),
        type: "warning",
      },
    );
  } catch {
    return;
  }

  try {
    await agentStore.removeAgent(agentId);
    ElMessage.success(t("agentMarket.removeSuccess", { name: agent.name }));
  } catch {
    ElMessage.error(t("agentMarket.removeFailed"));
  }
}
</script>

<style scoped>
.agent-market {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 32px;
  overflow-y: auto;
  background: var(--bg-primary);
  border-radius: 12px;
  align-items: center;
}

.agent-market-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: clamp(16px, 2vw, 24px);
  width: 100%;
  max-width: 1080px;
}
</style>
