import { ref } from "vue";

export interface MvpTask {
  id: string;
  title: string;
  agentId: string;
}

const tasks = ref<MvpTask[]>([]);
const scrollRequestId = ref<string | null>(null);
const selectedTaskId = ref<string | null>(null);

export function useMvpTasks() {
  function addTask(agentId: string, text: string): string {
    const id = `mvptask-${Date.now()}`;
    const title = text.length > 24 ? text.slice(0, 24) + "…" : text;
    tasks.value.push({ id, title, agentId });
    return id;
  }

  function selectTask(id: string | null) {
    selectedTaskId.value = id;
  }

  function clearTasksForAgent(agentId: string) {
    tasks.value = tasks.value.filter((t) => t.agentId !== agentId);
    if (selectedTaskId.value && !tasks.value.find((t) => t.id === selectedTaskId.value)) {
      selectedTaskId.value = null;
    }
  }

  function tasksForAgent(agentId: string) {
    return tasks.value.filter((t) => t.agentId === agentId);
  }

  function requestScrollTo(taskId: string) {
    scrollRequestId.value = taskId;
  }

  return {
    tasks,
    scrollRequestId,
    selectedTaskId,
    addTask,
    selectTask,
    clearTasksForAgent,
    tasksForAgent,
    requestScrollTo,
  };
}
