<template>
  <div class="agent-market">
    <div class="agent-market-header">
      <h1 class="agent-market-title">{{ t("agentMarket.pageTitle") }}</h1>
    </div>

    <div class="agent-market-grid">
      <AgentCard
        v-for="agent in filteredAgents"
        :key="agent.id"
        :agent="agent"
        @toggle="handleToggle"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ElMessage } from "element-plus";
import { useAgentStore } from "@/stores/agents";
import { useAgentList } from "@/composables/useAgentList";
import AgentCard from "@/components/agent/AgentCard.vue";
import { t } from "@/i18n";

const agentStore = useAgentStore();
const { filteredAgents } = useAgentList(computed(() => agentStore.marketAgents));

async function handleToggle(agentId: string) {
  try {
    await agentStore.toggleAgent(agentId);
  } catch {
    ElMessage.error(t("agentMarket.persistenceFailed"));
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

.agent-market-header {
  margin-bottom: 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  max-width: 1080px;
}

.agent-market-title {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
  letter-spacing: -0.02em;
}

.agent-market-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: clamp(16px, 2vw, 24px);
  width: 100%;
  max-width: 1080px;
}
</style>
