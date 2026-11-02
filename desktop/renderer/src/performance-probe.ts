import { nextTick } from "vue";
import { useChatStore } from "./stores/chat";
import { useGatewayStore } from "./stores/gateway";
import { PerformanceChatSample } from "./performance-sample";

export function installPerformanceProbe(): void {
  if (!window.openclaw.features.performance) return;
  const chat = useChatStore();
  const gateway = useGatewayStore();
  let sample: PerformanceChatSample | null = null;
  let previousBodies = new WeakSet<Element>();
  let disposed = false;
  const milestones: Record<string, number> = { probeInstalledAt: performance.now() };
  let serviceReady = false;
  const markServiceReady = () => {
    serviceReady = true;
    milestones.serviceReadyAt ??= performance.now();
  };
  const unsubscribeReady = window.openclaw.gateway.onServiceReady(markServiceReady);
  void window.openclaw.gateway
    .isServiceReady()
    .then((ready) => {
      if (ready) markServiceReady();
    })
    .catch(() => undefined);
  const ready = () => {
    const composer = document.querySelector<HTMLTextAreaElement>(".chat-view textarea");
    const usable = Boolean(composer && !composer.disabled && composer.getClientRects().length);
    if (!chat.loading && chat.wsConnected) milestones.initialSessionReadyAt ??= performance.now();
    if (usable) milestones.composerReadyAt ??= performance.now();
    const complete = serviceReady && gateway.ready && chat.wsConnected && !chat.loading && usable;
    if (complete) milestones.chatReadyAt ??= performance.now();
    return complete;
  };
  const sessionState = () => ({
    sessionKey: chat.resolvedSessionKey || chat.sessionKey,
    messageCount: chat.messages.length,
    ready: ready(),
  });
  const unsubscribe = window.openclaw.chat.onEvent((event) => sample?.event(event));
  const afterPaintOpportunity = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  const observe = async (active: PerformanceChatSample) => {
    await nextTick();
    await afterPaintOpportunity();
    if (disposed || sample !== active) return;
    if (sample.sessionReadyAt === null && ready()) {
      sample.sessionReady(
        chat.resolvedSessionKey || chat.sessionKey,
        performance.now(),
        chat.messages.length,
      );
    }
    const activeKey = chat.resolvedSessionKey || chat.sessionKey;
    if (sample.sessionKey === activeKey) {
      if (sample.sentAt !== null && chat.lastError) sample.fail("chat-error");
      const settled = !chat.streaming && !chat.sending;
      const bodies = document.querySelectorAll<HTMLElement>(
        settled
          ? ".chat-bubble.assistant:not(.streaming) .chat-text"
          : ".chat-bubble.assistant .chat-text",
      );
      const texts = new Map<string, string[]>();
      for (const body of bodies) {
        const runId = body.closest<HTMLElement>("[data-perf-run-id]")?.dataset.perfRunId;
        if (!runId || previousBodies.has(body) || !body.getClientRects().length) continue;
        const text = body.innerText.trim();
        if (text) texts.set(runId, [...(texts.get(runId) ?? []), text]);
      }
      for (const [runId, parts] of texts)
        sample.rendered(runId, parts.join("\n"), settled, performance.now());
      if (sample.runId && !texts.has(sample.runId))
        sample.rendered(sample.runId, "", settled, performance.now());
    }
    if (!sample.outcome) requestAnimationFrame(() => void observe(active));
  };
  const probe: PerformanceProbe = {
    version: 2,
    ready: () => ({ ready: ready(), milestones: { ...milestones } }),
    state: sessionState,
    snapshot: () => sample?.snapshot() ?? null,
    reset: () => {
      sample = null;
    },
    beginExisting: () => {
      previousBodies = new WeakSet(document.querySelectorAll(".chat-bubble.assistant .chat-text"));
      sample = new PerformanceChatSample(performance.now());
      void observe(sample);
    },
    arm: () => {
      sample = null;
      const button = document.querySelector<HTMLButtonElement>(".sp-create-btn");
      if (!button) throw new Error("New-conversation action is not available");
      button.addEventListener(
        "click",
        () => {
          previousBodies = new WeakSet(
            document.querySelectorAll(".chat-bubble.assistant .chat-text"),
          );
          sample = new PerformanceChatSample(performance.now(), sessionState().sessionKey);
          void observe(sample);
        },
        { once: true, capture: true },
      );
    },
    armSend: () => {
      const composer = document.querySelector<HTMLTextAreaElement>(".chat-view textarea");
      if (!composer || !sample) throw new Error("No active performance conversation");
      composer.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "Enter" && !event.shiftKey) sample?.sent(performance.now());
        },
        { once: true, capture: true },
      );
    },
    submitted: (sessionKey: string, acknowledgment: unknown) =>
      sample?.submitted(sessionKey, acknowledgment),
    submissionFailed: () => sample?.fail("submission-error"),
    conversationError: (sessionKey: string) => {
      if (sample && sample.sentAt !== null && sample.sessionKey === sessionKey)
        sample.fail("chat-error");
    },
    dispose: () => {
      disposed = true;
      sample = null;
      unsubscribe();
      unsubscribeReady();
    },
  };
  Object.defineProperty(window, "__microclawPerf", { value: probe, configurable: true });
}

export type PerformanceProbe = {
  version: number;
  ready(): { ready: boolean; milestones: Record<string, number> };
  state(): { sessionKey: string; messageCount: number; ready: boolean };
  snapshot(): ReturnType<PerformanceChatSample["snapshot"]> | null;
  reset(): void;
  beginExisting(): void;
  arm(): void;
  armSend(): void;
  submitted(sessionKey: string, acknowledgment: unknown): void;
  submissionFailed(): void;
  conversationError(sessionKey: string): void;
  dispose(): void;
};
