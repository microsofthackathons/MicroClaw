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
  let startRequest: Promise<{ sessionId: string }> | null = null;

  const loginInProgress = computed(() => state.value === "signing-in" || state.value === "code");
  const codeExpiryMinutes = computed(() => Math.max(1, Math.ceil(codeExpiresInMs.value / 60_000)));

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
    selectedModel.value = catalog.find((model) => model.id === preferredModel)?.id ?? catalog[0].id;
    state.value = "authenticated";
  }

  async function loadModels(generation: number, preferredModel?: string): Promise<void> {
    if (generation !== requestGeneration || !options.isActive()) return;
    const preparation = await window.openclaw.model.prepareGitHubCopilot();
    if (generation !== requestGeneration || !options.isActive()) return;
    if (preparation.restartRequired)
      await window.openclaw.gateway.restart({ reason: "copilot-plugin-activation" });
    if (generation !== requestGeneration || !options.isActive()) return;
    const catalog = await window.openclaw.model.listGitHubCopilotModels();
    applyModels(generation, catalog, preferredModel);
  }

  async function loadStatus(startLoginWhenDisconnected = false): Promise<void> {
    if (loginInProgress.value && sessionId.value) return;
    const generation = ++requestGeneration;
    state.value = "checking";
    models.value = [];
    selectedModel.value = "";
    pendingEvent = null;
    options.clearError();
    try {
      const login = await window.openclaw.model.getGitHubCopilotLoginSession?.();
      if (generation !== requestGeneration || !options.isActive()) return;
      if (login) {
        sessionId.value = login.sessionId;
        state.value = login.cancelling ? "checking" : "signing-in";
        if (login.code && !login.cancelling) applyLoginEvent(login.code);
        const event = takePendingEvent();
        if (event?.sessionId === login.sessionId) applyLoginEvent(event);
        return;
      }
      const status = await window.openclaw.model.getGitHubCopilotStatus();
      if (generation !== requestGeneration || !options.isActive()) return;
      if (!status.authenticated) {
        state.value = "idle";
        if (startLoginWhenDisconnected) await startLogin();
        return;
      }
      await loadModels(generation);
    } catch (error) {
      if (generation !== requestGeneration || !options.isActive()) return;
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
    if (!options.isActive()) return;
    if (!sessionId.value) {
      if (state.value === "signing-in" || state.value === "checking") pendingEvent = event;
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
    let request: Promise<{ sessionId: string }> | null = null;
    try {
      request = window.openclaw.model.startGitHubCopilotLogin();
      startRequest = request;
      const result = await request;
      // The main process owns the login. Closing or switching a panel only
      // detaches this view; the next view restores the active session.
      if (generation !== requestGeneration || !options.isActive()) return;
      sessionId.value = result.sessionId;
      const event = takePendingEvent();
      if (event?.sessionId === result.sessionId) applyLoginEvent(event);
      if (generation !== requestGeneration || !options.isActive()) return;
      const login = await window.openclaw.model.getGitHubCopilotLoginSession?.();
      if (generation !== requestGeneration || !options.isActive()) return;
      if (login?.sessionId === result.sessionId && login.code) applyLoginEvent(login.code);
    } catch (error) {
      if (generation !== requestGeneration || !options.isActive()) return;
      state.value = "error";
      options.setError(
        t("modelSetup.copilotLoginFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      if (startRequest === request) startRequest = null;
    }
  }

  async function cancelLogin(): Promise<void> {
    const generation = ++requestGeneration;
    const activeSessionId = sessionId.value;
    const pendingStart = startRequest;
    sessionId.value = null;
    pendingEvent = null;
    userCode.value = "";
    codeExpiresInMs.value = 0;
    state.value = "checking";
    try {
      const target = activeSessionId ?? (pendingStart ? (await pendingStart).sessionId : null);
      if (target) await window.openclaw.model.cancelGitHubCopilotLogin(target);
      if (generation !== requestGeneration || !options.isActive()) return;
      // Credentials may already have committed before explicit cancellation.
      // Ask the backend for the final state instead of assuming sign-out.
      await loadStatus();
    } catch (error) {
      if (generation !== requestGeneration || !options.isActive()) return;
      state.value = "error";
      options.setError(
        t("modelSetup.copilotCancelFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async function reset(): Promise<void> {
    requestGeneration += 1;
    sessionId.value = null;
    pendingEvent = null;
    state.value = "idle";
    userCode.value = "";
    codeExpiresInMs.value = 0;
    models.value = [];
    selectedModel.value = "";
    // Reset only view state. The login continues while another provider card
    // or settings page is open; only the Cancel action cancels authentication.
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
