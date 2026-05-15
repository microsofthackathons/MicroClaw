import { ref, computed, type Ref } from "vue";
import type { Agent } from "@/stores/agents";

export function useAgentList(agents: Ref<Agent[]>) {
  const searchQuery = ref("");

  const filteredAgents = computed(() => {
    const q = searchQuery.value.trim().toLowerCase();
    if (!q) return agents.value;
    return agents.value.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description?.toLowerCase().includes(q) ||
        a.tags?.some((t) => t.toLowerCase().includes(q)),
    );
  });

  return { searchQuery, filteredAgents };
}
