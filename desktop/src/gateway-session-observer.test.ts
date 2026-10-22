import { describe, expect, it, vi } from "vitest";
import { GatewaySessionObserver } from "./gateway-session-observer";

function harness() {
  const request = vi.fn(
    async (method: string, params: Record<string, unknown>): Promise<unknown> =>
      method === "sessions.messages.subscribe"
        ? { subscribed: true, key: params.key, agentId: params.agentId }
        : { subscribed: true },
  );
  return { request, observer: new GatewaySessionObserver(request) };
}

describe("authoritative selected-session observer", () => {
  it("subscribes the exact agent/session without approval replay or narration", async () => {
    const { observer, request } = harness();
    await observer.select("agent:main:main");
    expect(request).not.toHaveBeenCalled();
    await observer.connect();
    expect(request.mock.calls).toEqual([
      ["sessions.subscribe", {}],
      [
        "sessions.messages.subscribe",
        {
          key: "agent:main:main",
          agentId: "main",
          subscriptionId: "microclaw-desktop-chat",
        },
      ],
    ]);
    await observer.select("agent:main:main");
    expect(request).toHaveBeenCalledTimes(2);
    expect(observer.accepts({ sessionKey: "agent:main:main", agentId: "main" })).toBe(true);
    expect(observer.accepts({ sessionKey: "agent:other:main", agentId: "other" })).toBe(false);
    expect(observer.accepts({ sessionKey: "agent:main:main", agentId: "other" })).toBe(false);
  });

  it("fences old events immediately while switching and unsubscribes exactly", async () => {
    const { observer, request } = harness();
    await observer.connect();
    await observer.select("agent:main:first");
    const switching = observer.select("agent:other:second");
    expect(observer.accepts({ sessionKey: "agent:main:first", agentId: "main" })).toBe(false);
    await switching;
    expect(request).toHaveBeenCalledWith("sessions.messages.unsubscribe", {
      key: "agent:main:first",
      agentId: "main",
      subscriptionId: "microclaw-desktop-chat",
    });
    expect(observer.accepts({ sessionKey: "agent:other:second", agentId: "other" })).toBe(true);
    await observer.select(null);
    expect(observer.accepts({ sessionKey: "agent:other:second" })).toBe(false);
  });

  it("does not revive a subscription acknowledged after disconnect; reconnects the selection", async () => {
    const { observer, request } = harness();
    let acknowledge!: (value: unknown) => void;
    request.mockImplementationOnce(async () => ({ subscribed: true }));
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    await observer.select("agent:main:main");
    const connecting = observer.connect();
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf("function"));
    observer.disconnect();
    acknowledge({ subscribed: true, key: "agent:main:main", agentId: "main" });
    await connecting;
    expect(observer.accepts({ sessionKey: "agent:main:main" })).toBe(false);
    await observer.connect();
    expect(observer.accepts({ sessionKey: "agent:main:main" })).toBe(true);
    expect(request.mock.calls.filter(([method]) => method === "sessions.subscribe")).toHaveLength(
      2,
    );
  });

  it("surfaces a rejected subscription and permits a later explicit retry", async () => {
    const { observer, request } = harness();
    await observer.connect();
    request.mockRejectedValueOnce(new Error("not authorized"));
    await expect(observer.select("agent:main:main")).rejects.toThrow("not authorized");
    expect(observer.accepts({ sessionKey: "agent:main:main" })).toBe(false);
    await observer.select("agent:main:main");
    expect(observer.accepts({ sessionKey: "agent:main:main" })).toBe(true);
  });

  it.each([
    "Method not found: sessions.messages.subscribe",
    "missing scope: operator.sessions.read",
  ])(
    "surfaces an unsupported method/scope instead of pretending to observe: %s",
    async (message) => {
      const { observer, request } = harness();
      await observer.connect();
      request.mockRejectedValueOnce(new Error(message));
      await expect(observer.select("agent:main:main")).rejects.toThrow(message);
      expect(observer.accepts({ sessionKey: "agent:main:main" })).toBe(false);
    },
  );

  it("rejects an RPC acknowledgement with no actual catalog subscription", async () => {
    const { observer, request } = harness();
    await observer.select("agent:main:main");
    request.mockResolvedValueOnce({ subscribed: false });
    await expect(observer.connect()).rejects.toThrow("lifecycle subscription");
    expect(observer.accepts({ sessionKey: "agent:main:main" })).toBe(false);
  });
});
