import { computed, onMounted, onUnmounted, ref } from "vue";
import { t } from "@/i18n";

export type GitHubCopilotAuthState =
  | "idle"
  | "checking"
  | "signing-in"
  | "code"
  | "authenticated"
  | "error";

interface GitHubCopilotAuthOptions {
  isActive: () => boolean;
  clearError: () => void;
  setError: (message: string) => void;
}

export function useGitHubCopilotAuth(options: GitHubCopilotAuthOptions) {
  const state = ref<GitHubCopilotAuthState>("idle");
  const sessionId = ref<string | null>(null);
  const verificationUrl = ref("https://github.com/login/device");
  const userCode = ref("");
  const codeExpiresInMs = ref(0);
  const models = ref<Array<{ id: string; name: string }>>([]);
  const selectedModel = ref("");
  let requestGeneration = 0;
  let pendingEvent: GitHubCopilotLoginEvent | null = null;
  let removeListener: (() => void) | undefined;

  const loginInProgress = computed(
    () => state.value === "signing-in" || state.value === "code",
  );
  const codeExpiryMinutes = computed(() =>
    Math.max(1, Math.ceil(codeExpiresInMs.value / 60_000)),
  );

  function applyModels(
    generation: number,
    catalog: Array<{ id: string; name: string }>,
    preferredModel?: string,
  ): void {
    if (generation !== requestGeneration || !options.isActive()) return;
    models.value = catalog;
    if (catalog.length === 0) {
      state.value = "error";
      options.setError(t("modelSetup.copilotNoModels"));
      return;
    }
    selectedModel.value =
      catalog.find((model) => model.id === preferredModel)?.id ?? catalog[0].id;
    state.value = "authenticated";
  }

  async function loadModels(generation: number, preferredModel?: string): Promise<void> {
    const catalog = await window.openclaw.model.listGitHubCopilotModels();
    applyModels(generation, catalog, preferredModel);
  }

  async function loadStatus(startLoginWhenDisconnected = false): Promise<void> {
    const generation = ++requestGeneration;
    state.value = "checking";
    models.value = [];
    selectedModel.value = "";
    options.clearError();
    try {
      const status = await window.openclaw.model.getGitHubCopilotStatus();
      if (generation !== requestGeneration || !options.isActive()) return;
      if (!status.authenticated) {
        state.value = "idle";
        if (startLoginWhenDisconnected) await startLogin();
        return;
      }
      await loadModels(generation);
    } catch (error) {
      if (generation !== requestGeneration) return;
      state.value = "error";
      options.setError(
        t("modelSetup.copilotStatusFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  function applyLoginEvent(event: GitHubCopilotLoginEvent): void {
    if (event.status === "code") {
      state.value = "code";
      verificationUrl.value = event.verificationUrl;
      userCode.value = event.userCode;
      codeExpiresInMs.value = event.expiresInMs;
      return;
    }
    if (event.status === "success") {
      sessionId.value = null;
      const generation = ++requestGeneration;
      if (models.value.length > 0) {
        applyModels(generation, models.value, event.defaultModel);
        return;
      }
      state.value = "checking";
      void loadModels(generation, event.defaultModel).catch((error) => {
        if (generation !== requestGeneration) return;
        state.value = "error";
        options.setError(
          t("modelSetup.copilotModelsFailed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
      return;
    }
    sessionId.value = null;
    if (event.status === "cancelled") {
      state.value = models.value.length ? "authenticated" : "idle";
      return;
    }
    state.value = "error";
    options.setError(t("modelSetup.copilotLoginFailed", { error: event.message }));
  }

  function handleLoginEvent(event: GitHubCopilotLoginEvent): void {
    if (!sessionId.value) {
      if (state.value === "signing-in") pendingEvent = event;
      return;
    }
    if (event.sessionId === sessionId.value) applyLoginEvent(event);
  }

  function takePendingEvent(): GitHubCopilotLoginEvent | null {
    const event = pendingEvent;
    pendingEvent = null;
    return event;
  }

  async function startLogin(): Promise<void> {
    if (loginInProgress.value) return;
    const generation = ++requestGeneration;
    state.value = "signing-in";
    userCode.value = "";
    codeExpiresInMs.value = 0;
    pendingEvent = null;
    options.clearError();
    try {
      const result = await window.openclaw.model.startGitHubCopilotLogin();
      if (generation !== requestGeneration || !options.isActive()) {
        await window.openclaw.model.cancelGitHubCopilotLogin(result.sessionId);
        return;
      }
      sessionId.value = result.sessionId;
      const event = takePendingEvent();
      if (event?.sessionId === result.sessionId) applyLoginEvent(event);
    } catch (error) {
      if (generation !== requestGeneration) return;
      state.value = "error";
      options.setError(
        t("modelSetup.copilotLoginFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async function cancelLogin(): Promise<void> {
    requestGeneration += 1;
    const activeSessionId = sessionId.value;
    sessionId.value = null;
    pendingEvent = null;
    userCode.value = "";
    codeExpiresInMs.value = 0;
    state.value = models.value.length ? "authenticated" : "idle";
    try {
      await window.openclaw.model.cancelGitHubCopilotLogin(activeSessionId ?? undefined);
    } catch (error) {
      options.setError(
        t("modelSetup.copilotCancelFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async function reset(): Promise<void> {
    requestGeneration += 1;
    const activeSessionId = sessionId.value;
    sessionId.value = null;
    pendingEvent = null;
    state.value = "idle";
    userCode.value = "";
    codeExpiresInMs.value = 0;
    models.value = [];
    selectedModel.value = "";
    if (!activeSessionId) return;
    try {
      await window.openclaw.model.cancelGitHubCopilotLogin(activeSessionId);
    } catch (error) {
      console.warn("[github-copilot-auth] Failed to stop completed login worker:", error);
    }
  }

  function openVerificationPage(): void {
    if (verificationUrl.value !== "https://github.com/login/device") return;
    void window.openclaw.shell.openExternal(verificationUrl.value);
  }

  onMounted(() => {
    removeListener = window.openclaw.model.onGitHubCopilotLoginEvent(handleLoginEvent);
  });
  onUnmounted(() => {
    removeListener?.();
    void reset();
  });

  return {
    state,
    models,
    selectedModel,
    userCode,
    loginInProgress,
    codeExpiryMinutes,
    loadStatus,
    startLogin,
    cancelLogin,
    reset,
    openVerificationPage,
  };
}
