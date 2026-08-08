<template>
  <div class="agent-catalog">
    <div class="agent-catalog-header">
      <div>
        <h1 class="agent-catalog-title">{{ t("agentCatalog.pageTitle") }}</h1>
        <p class="agent-catalog-subtitle">{{ t("agentCatalog.subtitle") }}</p>
      </div>
      <div class="agent-catalog-tabs" role="tablist" :aria-label="t('agentCatalog.pageTitle')">
        <button
          class="agent-catalog-tab"
          :class="{ active: activeTab === 'marketplace' }"
          role="tab"
          :aria-selected="activeTab === 'marketplace'"
          @click="activeTab = 'marketplace'"
        >
          {{ t("agentCatalog.marketplace") }}
        </button>
        <button
          class="agent-catalog-tab"
          :class="{ active: activeTab === 'custom' }"
          role="tab"
          :aria-selected="activeTab === 'custom'"
          @click="activeTab = 'custom'"
        >
          {{ t("agentCatalog.customAgents") }}
        </button>
      </div>
    </div>

    <div v-if="activeTab === 'marketplace'" class="agent-catalog-grid">
      <AgentCard
        v-for="agent in filteredAgents"
        :key="agent.id"
        :agent="agent"
        :adding="addingAgentIds.has(agent.id)"
        @add="handleAdd"
        @remove="handleRemove"
      />
    </div>

    <div v-else class="custom-agent-empty">
      <strong>{{ t("agentCatalog.noCustomAgents") }}</strong>
      <span>{{ t("agentCatalog.noCustomAgentsHint") }}</span>
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
const activeTab = ref<"marketplace" | "custom">("marketplace");

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
  const agent = agentStore.agents.find((candidate) => candidate.id === agentId);
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
.agent-catalog {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 32px;
  overflow-y: auto;
  background: var(--bg-primary);
  align-items: center;
}

.agent-catalog-header {
  margin-bottom: 24px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  width: 100%;
  max-width: 1080px;
}

.agent-catalog-title {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
  letter-spacing: 0;
}

.agent-catalog-subtitle {
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: 13px;
}

.agent-catalog-tabs {
  display: flex;
  padding: 3px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--bg-chat-hover);
}

.agent-catalog-tab {
  min-height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.agent-catalog-tab.active {
  background: var(--bg-chat);
  color: var(--text-primary);
  box-shadow: 0 1px 3px rgb(0 0 0 / 10%);
}

.agent-catalog-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: clamp(16px, 2vw, 24px);
  width: 100%;
  max-width: 1080px;
}

.custom-agent-empty {
  display: grid;
  justify-items: center;
  gap: 6px;
  width: 100%;
  max-width: 1080px;
  padding: 72px 24px;
  color: var(--text-secondary);
  text-align: center;
}

.custom-agent-empty strong {
  color: var(--text-primary);
  font-size: 15px;
}

@media (max-width: 760px) {
  .agent-catalog-header {
    align-items: stretch;
    flex-direction: column;
    gap: 16px;
  }

  .agent-catalog-tabs {
    align-self: flex-start;
  }
}
</style>
