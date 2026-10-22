import { describe, expect, it, vi } from "vitest";
import {
  WeixinRemoteDeliveryCoordinator,
  type WeixinRemoteDeliveryState,
} from "./windows-node-mxc-weixin-remote-approval-delivery";

function local(reason: WeixinRemoteDeliveryState["reason"]): WeixinRemoteDeliveryState {
  return { state: "local-only", reason, replyMode: null, revision: 1 };
}
function harness() {
  const coordinator = new WeixinRemoteDeliveryCoordinator();
  const gate: {
    pending: boolean;
    challengeId: string | null;
    state: WeixinRemoteDeliveryState | null;
  } = { pending: true, challengeId: null, state: local("source-run-mismatch") };
  const read = () => gate;
  return { coordinator, gate, read };
}

describe("production WeChat delivery retry coordinator", () => {
  it("coalesces duplicate run registrations before the microtask and after confirmed delivery", async () => {
    const { coordinator, gate, read } = harness();
    const send = vi.fn(async () => {
      gate.challengeId = "only-challenge";
      gate.state = { ...local("source-run-mismatch"), state: "sent", reason: null };
      return null;
    });
    const first = coordinator.begin("source-bound", read, send);
    expect(coordinator.begin("source-bound", read, send)).toBe(first);
    expect(coordinator.begin("source-bound", read, send)).toBe(first);
    await first;
    await coordinator.begin("source-bound", read, send);
    expect(send).toHaveBeenCalledOnce();
  });

  it.each(["delivery-unconfirmed", "security-unavailable"] as const)(
    "never retries after send settles as %s, even without a challenge",
    async (reason) => {
      const { coordinator, gate, read } = harness();
      const send = vi.fn(async () => {
        gate.state =
          reason === "delivery-unconfirmed"
            ? { ...local(reason), state: "unconfirmed" }
            : local(reason);
        return null;
      });
      const first = coordinator.begin("source-bound", read, send);
      const duplicate = coordinator.begin("source-bound", read, send);
      await Promise.all([first, duplicate]);
      await coordinator.begin("source-bound", read, send);
      await coordinator.begin("promoted", read, send);
      expect(send).toHaveBeenCalledOnce();
    },
  );

  it("does not send when a challenge appears while awaiting an earlier attempt", async () => {
    const { coordinator, gate, read } = harness();
    let finish!: () => void;
    gate.state = null;
    const initial = coordinator.begin("initial", read, async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      gate.challengeId = "earlier-challenge";
      return null;
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const send = vi.fn(async () => null);
    const retry = coordinator.begin("source-bound", read, send);
    finish();
    await Promise.all([initial, retry]);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not restart after a rejected/unknown earlier attempt", async () => {
    const { coordinator, read } = harness();
    const send = vi.fn(async () => {
      throw new Error("unknown sender outcome");
    });
    await expect(coordinator.begin("source-bound", read, send)).rejects.toThrow(
      "unknown sender outcome",
    );
    await expect(coordinator.begin("source-bound", read, send)).rejects.toThrow(
      "unknown sender outcome",
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it("coalesces promotion while queued notification is in flight, then rechecks the post-await gate", async () => {
    const { coordinator, gate, read } = harness();
    gate.state = null;
    let finish!: () => void;
    const notice = vi.fn(async () => {
      gate.state = local("approval-queued");
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return null;
    });
    const initial = coordinator.begin("initial", read, notice);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const prompt = vi.fn(async () => {
      gate.challengeId = "promoted-challenge";
      return null;
    });
    const promotion = coordinator.begin("promoted", read, prompt);
    expect(coordinator.begin("promoted", read, prompt)).toBe(promotion);
    const binding = coordinator.begin("source-bound", read, prompt);
    finish();
    await Promise.all([initial, promotion, binding]);
    expect(notice).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledOnce();
  });
});
