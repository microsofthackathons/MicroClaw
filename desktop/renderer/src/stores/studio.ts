import { defineStore } from "pinia";
import { ref, watch, type WatchStopHandle } from "vue";
import { useChatStore } from "./chat";

export type StudioAgentState =
  | "idle"
  | "writing"
  | "researching"
  | "executing"
  | "syncing"
  | "error";

export type StudioBackendLifecycleStatus =
  | "stopped"
  | "starting"
  | "running"
  | "failed"
  | "restarting"
  | "stopping";

export interface AgentInfo {
  id: string;
  name: string;
  state: StudioAgentState;
  detail?: string;
  joinedAt: number;
}

export interface MainAgentInfo {
  state: StudioAgentState;
  detail: string;
  progress: number;
  name: string;
  updatedAt: number;
}

export const useStudioStore = defineStore("studio", () => {
  const backendStatus = ref<StudioBackendLifecycleStatus>("stopped");
  const backendPort = ref(0);
  const mainAgent = ref<MainAgentInfo>({
    state: "idle",
    detail: "",
    progress: 0,
    name: "Star",
    updatedAt: Date.now(),
  });
  const guestAgents = ref<AgentInfo[]>([]);
  const uiOverlayPointerBlock = ref(false);
  const manualOverrideActive = ref(false);

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let offStatusListener: (() => void) | null = null;
  let autoMappingStopHandle: WatchStopHandle | null = null;

  async function startBackend() {
    if (backendStatus.value === "running" || backendStatus.value === "starting") return;
    backendStatus.value = "starting";
    try {
      const port = await window.openclaw.studio.start();
      backendPort.value = port;
    } catch (err: any) {
      backendStatus.value = "failed";
      console.warn("[studio] Failed to start backend:", err?.message || err);
    }
  }

  async function stopBackend() {
    stopPolling();
    try {
      await window.openclaw.studio.stop();
    } catch {
      // Ignore stop errors; UI should still reset.
    }
    backendStatus.value = "stopped";
    backendPort.value = 0;
  }

  async function syncBackendState() {
    try {
      const [status, port] = await Promise.all([
        window.openclaw.studio.getStatus(),
        window.openclaw.studio.getPort(),
      ]);
      backendStatus.value = status as StudioBackendLifecycleStatus;
      backendPort.value = port;

      if (status === "running" && port > 0) {
        startPolling();
      } else if (status === "failed" || status === "stopped") {
        stopPolling();
      }
    } catch {
      // Best-effort sync only.
    }
  }

  function initListeners() {
    if (!offStatusListener) {
      offStatusListener = window.openclaw.studio.onStatus((status: string) => {
        backendStatus.value = status as StudioBackendLifecycleStatus;
        if (status === "running") {
          startPolling();
        } else if (status === "failed" || status === "stopped") {
          stopPolling();
        }
      });
    }

    void syncBackendState();
  }

  function disposeListeners() {
    offStatusListener?.();
    offStatusListener = null;
  }

  function initialize() {
    initListeners();
    setupAutoMapping();
  }

  function teardown() {
    disposeListeners();
    autoMappingStopHandle?.();
    autoMappingStopHandle = null;
    stopPolling();
  }

  function startPolling() {
    stopPolling();
    void pollStatus();
    pollTimer = setInterval(() => {
      void pollStatus();
    }, 3000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function pollStatus() {
    if (backendPort.value === 0) return;
    const base = `http://127.0.0.1:${backendPort.value}`;
    try {
      const [statusRes, agentsRes] = await Promise.all([
        fetch(`${base}/status`),
        fetch(`${base}/agents`),
      ]);
      if (statusRes.ok) {
        const data = await statusRes.json();
        mainAgent.value = {
          state: data.state || "idle",
          detail: data.detail || "",
          progress: data.progress || 0,
          name: data.name || "Star",
          updatedAt: data.updatedAt || Date.now(),
        };
      }
      if (agentsRes.ok) {
        const data = await agentsRes.json();
        guestAgents.value = Array.isArray(data) ? data : [];
      }
    } catch {
      // Backend might not be ready yet — silently ignore.
    }
  }

  async function setState(state: StudioAgentState, detail: string = "", progress: number = 0) {
    if (backendPort.value === 0) return;
    if (
      mainAgent.value.state === state &&
      mainAgent.value.detail === detail &&
      mainAgent.value.progress === progress
    ) {
      return;
    }
    try {
      await fetch(`http://127.0.0.1:${backendPort.value}/set_state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, detail, progress }),
      });
      mainAgent.value = { ...mainAgent.value, state, detail, progress, updatedAt: Date.now() };
    } catch {
      // Ignore transient backend failures.
    }
  }

  async function setManualState(state: StudioAgentState, detail: string = "") {
    manualOverrideActive.value = true;
    await setState(state, detail);
  }

  async function applyAutoStateFromChat() {
    if (backendStatus.value !== "running") return;

    const chatStore = useChatStore();
    const { streaming, streamToolCalls, sending, streamText } = chatStore;

    if (streaming) {
      const activeTools = streamToolCalls.filter((tool) => !tool.done);
      if (activeTools.length > 0) {
        const toolName = activeTools[0].name.toLowerCase();
        if (toolName.includes("search") || toolName.includes("browse")) {
          await setState("researching", activeTools[0].name);
        } else if (toolName.includes("git") || toolName.includes("sync")) {
          await setState("syncing", activeTools[0].name);
        } else {
          await setState("executing", activeTools[0].name);
        }
      } else {
        const detail = streamText?.slice(-50) || "";
        await setState("writing", detail);
      }
    } else if (!sending) {
      await setState("idle");
    }
  }

  function clearManualOverride() {
    manualOverrideActive.value = false;
    void applyAutoStateFromChat();
  }

  function isManualOverrideActive(): boolean {
    return manualOverrideActive.value;
  }

  function setUiOverlayPointerBlock(blocked: boolean) {
    uiOverlayPointerBlock.value = blocked;
  }

  function setupAutoMapping() {
    if (autoMappingStopHandle) return;

    const chatStore = useChatStore();

    autoMappingStopHandle = watch(
      () => ({
        streaming: chatStore.streaming,
        toolCalls: chatStore.streamToolCalls,
        sending: chatStore.sending,
      }),
      () => {
        if (isManualOverrideActive()) return;
        void applyAutoStateFromChat();
      },
      { deep: true },
    );
  }

  return {
    backendStatus,
    backendPort,
    mainAgent,
    guestAgents,
    startBackend,
    stopBackend,
    initialize,
    teardown,
    setManualState,
    clearManualOverride,
    uiOverlayPointerBlock,
    setUiOverlayPointerBlock,
    isManualOverrideActive,
  };
});
