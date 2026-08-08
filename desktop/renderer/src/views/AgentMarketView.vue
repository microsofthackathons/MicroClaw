<template>
  <div class="agent-catalog">
    <div class="agent-catalog-toolbar">
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
  --ux-ctrl-brand-rest: var(--smtc-background-ctrl-brand-rest, #211d1a);
  --ux-ctrl-on-brand: var(--smtc-foreground-ctrl-on-brand-rest, #fff);
  --ux-text-muted: var(--smtc-foreground-ctrl-hint-default, var(--text-muted));

  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 32px;
  overflow-y: auto;
  background: var(--bg-primary);
  align-items: center;
}

.agent-catalog-toolbar {
  margin-bottom: 24px;
  width: 100%;
  max-width: 1080px;
}

.agent-catalog-tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.agent-catalog-tab {
  padding: 4px 14px;
  border: 1px solid var(--ux-border);
  border-radius: 999px;
  background: transparent;
  color: var(--ux-text-muted);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}

.agent-catalog-tab.active {
  background: var(--ux-ctrl-brand-rest);
  color: var(--ux-ctrl-on-brand);
  border-color: var(--ux-ctrl-brand-rest);
}

.agent-catalog-tab:not(.active):hover {
  background: var(--ux-surface-hover);
  color: var(--ux-text-primary);
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
</style>
