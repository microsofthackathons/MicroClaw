import { afterEach, describe, expect, it, vi } from "vitest";
import { installPerformanceProbe } from "./performance-probe";
import type { PerformanceChatSample } from "./performance-sample";

const stores = vi.hoisted(() => ({ chat: vi.fn(), gateway: vi.fn() }));
vi.mock("./stores/chat", () => ({ useChatStore: stores.chat }));
vi.mock("./stores/gateway", () => ({ useGatewayStore: stores.gateway }));

afterEach(() => {
  Reflect.get(window, "__microclawPerf")?.dispose();
  Reflect.deleteProperty(window, "__microclawPerf");
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("performance probe default path", () => {
  it("does not subscribe, read stores, create observers or schedule frames when disabled", () => {
    window.openclaw = { features: { githubCopilot: false, performance: false } } as OpenClawAPI;
    const animation = vi.spyOn(window, "requestAnimationFrame");
    installPerformanceProbe();
    expect(stores.chat).not.toHaveBeenCalled();
    expect(stores.gateway).not.toHaveBeenCalled();
    expect(animation).not.toHaveBeenCalled();
    expect("__microclawPerf" in window).toBe(false);
  });
});

describe("performance probe enabled DOM boundaries", () => {
  async function fixture() {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    const chat = {
      sessionKey: "old",
      resolvedSessionKey: null,
      loading: false,
      wsConnected: true,
      streaming: false,
      sending: false,
      messages: [] as unknown[],
      lastError: null as unknown,
    };
    stores.chat.mockReturnValue(chat);
    stores.gateway.mockReturnValue({ ready: true });
    let receive = (_event: ChatEventPayload) => undefined;
    window.openclaw = {
      features: { performance: true },
      gateway: { isServiceReady: async () => true, onServiceReady: () => () => undefined },
      chat: {
        onEvent: (callback: typeof receive) => {
          receive = callback;
          return () => undefined;
        },
      },
    } as unknown as OpenClawAPI;
    document.body.innerHTML =
      '<button class="sp-create-btn"></button><div class="chat-view"><textarea></textarea></div>';
    installPerformanceProbe();
    await vi.advanceTimersByTimeAsync(100);
    const probe = window.__microclawPerf!;
    const body = (runId: string, text: string) => {
      const answer = document.createElement("div");
      answer.className = "chat-bubble assistant";
      answer.dataset.perfRunId = runId;
      const content = document.createElement("div");
      content.className = "chat-text";
      content.innerText = text;
      answer.append(content);
      document.querySelector(".chat-view")!.append(answer);
    };
    const send = () => {
      probe.armSend();
      document
        .querySelector("textarea")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    };
    return { chat, probe, body, send, receive: (event: ChatEventPayload) => receive(event) };
  }

  it.each([false, true])("rejects session reuse or a nonempty selection: %s", async (nonempty) => {
    const { chat, probe } = await fixture();
    probe.arm();
    document.querySelector(".sp-create-btn")!.addEventListener("click", () => {
      if (nonempty) {
        chat.sessionKey = "new";
        chat.messages = [{}];
      }
    });
    document.querySelector<HTMLButtonElement>(".sp-create-btn")!.click();
    await vi.advanceTimersByTimeAsync(100);
    expect(probe.snapshot()?.outcome).toBe(nonempty ? "session-not-empty" : "session-not-new");
  });

  it("ignores old DOM and unrelated fresh replies, even when their text matches", async () => {
    const { probe, body, send, receive } = await fixture();
    body("run", "MICROCLAW_PERF_OK");
    probe.beginExisting();
    await vi.advanceTimersByTimeAsync(100);
    send();
    receive({ sessionKey: "old", runId: "background", state: "final" });
    body("background", "MICROCLAW_PERF_OK");
    probe.submitted("old", { runId: "run" });
    receive({ sessionKey: "old", runId: "run", state: "final" });
    await vi.advanceTimersByTimeAsync(100);
    expect(probe.snapshot()?.outcome).toBe("empty-response");
    expect(probe.snapshot()?.metrics.sendToFirstTextMs).toBeNull();
  });

  it("does not report success when a matching error arrives before final paint", async () => {
    const { probe, body, send, receive } = await fixture();
    probe.beginExisting();
    await vi.advanceTimersByTimeAsync(100);
    send();
    probe.submitted("old", { runId: "run" });
    body("run", "answer");
    receive({ sessionKey: "old", runId: "run", state: "final" });
    receive({ sessionKey: "old", runId: "run", state: "error" });
    await vi.advanceTimersByTimeAsync(100);
    expect(probe.snapshot()?.outcome).toBe("model-error");
  });

  it("rejects a reported UI error before completion", async () => {
    const { chat, probe, body, send, receive } = await fixture();
    probe.beginExisting();
    await vi.advanceTimersByTimeAsync(100);
    send();
    probe.submitted("old", { runId: "run" });
    body("run", "answer");
    receive({ sessionKey: "old", runId: "run", state: "final" });
    chat.lastError = { code: "provider_access" };
    await vi.advanceTimersByTimeAsync(100);
    expect(probe.snapshot()?.outcome).toBe("chat-error");
  });

  it("retains a transient conversation error even if the UI clears it before paint", async () => {
    const { probe, body, send, receive } = await fixture();
    probe.beginExisting();
    await vi.advanceTimersByTimeAsync(100);
    send();
    probe.submitted("old", { runId: "run" });
    body("run", "answer");
    receive({ sessionKey: "old", runId: "run", state: "final" });
    probe.conversationError("unrelated-session");
    expect(probe.snapshot()?.outcome).toBeNull();
    probe.conversationError("old");
    await vi.advanceTimersByTimeAsync(100);
    expect(probe.snapshot()?.outcome).toBe("chat-error");
  });

  it("observes the actual action, ignores reasoning text, and waits for matching final rendering", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    const chat = {
      sessionKey: "session",
      resolvedSessionKey: null,
      loading: false,
      wsConnected: true,
      streaming: false,
      sending: false,
      messages: [],
      lastError: null,
    };
    stores.chat.mockReturnValue(chat);
    stores.gateway.mockReturnValue({ ready: true });
    let receiveChat: (event: ChatEventPayload) => void = () => undefined;
    const unsubscribe = vi.fn();
    window.openclaw = {
      features: { githubCopilot: false, performance: true },
      gateway: { isServiceReady: async () => true, onServiceReady: () => unsubscribe },
      chat: {
        onEvent: (callback: (event: ChatEventPayload) => void) => {
          receiveChat = callback;
          return unsubscribe;
        },
      },
    } as unknown as OpenClawAPI;
    document.body.innerHTML =
      '<button class="sp-create-btn"></button><div class="chat-view"><textarea></textarea><div class="thinking-block__text">reasoning only</div></div>';
    installPerformanceProbe();
    const probe = Reflect.get(window, "__microclawPerf") as {
      arm(): void;
      armSend(): void;
      submitted(sessionKey: string, acknowledgment: unknown): void;
      snapshot(): ReturnType<PerformanceChatSample["snapshot"]>;
      dispose(): void;
    };
    probe.arm();
    document.querySelector(".sp-create-btn")!.addEventListener("click", () => {
      chat.sessionKey = "new-session";
    });
    document.querySelector<HTMLButtonElement>(".sp-create-btn")!.click();
    await vi.advanceTimersByTimeAsync(100);
    expect(probe.snapshot().metrics.sessionReadyMs).not.toBeNull();
    probe.armSend();
    document
      .querySelector("textarea")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    chat.streaming = true;
    probe.submitted("new-session", { runId: "run" });
    receiveChat({ sessionKey: "new-session", runId: "run", state: "delta" });
    await vi.advanceTimersByTimeAsync(100);
    expect(probe.snapshot().metrics.sendToFirstTextMs).toBeNull();
    const answer = document.createElement("div");
    answer.className = "chat-bubble assistant";
    answer.dataset.perfRunId = "run";
    const body = document.createElement("div");
    body.className = "chat-text";
    body.innerText = "MICROCLAW_PERF_OK";
    answer.append(body);
    document.querySelector(".chat-view")!.append(answer);
    await vi.advanceTimersByTimeAsync(100);
    expect(probe.snapshot().metrics.sendToFirstTextMs).not.toBeNull();
    receiveChat({ sessionKey: "new-session", runId: "unrelated", state: "final" });
    chat.streaming = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(probe.snapshot().outcome).toBeNull();
    receiveChat({ sessionKey: "new-session", runId: "run", state: "final" });
    expect(probe.snapshot().outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(probe.snapshot().outcome).toBe("success");
    probe.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});
