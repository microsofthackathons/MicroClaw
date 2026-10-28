import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopGatewayChildProcess } from "./gateway-process-stop";

function createChild() {
  const input = { destroyed: false, writableEnded: false, end: vi.fn() };
  const emitter = Object.assign(new EventEmitter(), {
    pid: 4321,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: input,
  });
  return {
    child: emitter as unknown as ChildProcess,
    input,
    exit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
      emitter.exitCode = code;
      emitter.signalCode = signal;
      emitter.emit("exit", code, signal);
    },
  };
}

describe("stopGatewayChildProcess", () => {
  afterEach(() => vi.useRealTimers());

  it("closes the native host lifeline and waits for process exit rather than a free port", async () => {
    vi.useFakeTimers();
    const managed = createChild();
    const forceStop = vi.fn();
    let completed = false;
    const result = stopGatewayChildProcess({
      child: managed.child,
      timeoutMs: 10_000,
      forceTimeoutMs: 3_000,
      forceStop,
      onForceStop: vi.fn(),
    }).then((mode) => {
      completed = true;
      return mode;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(managed.input.end).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
    expect(forceStop).not.toHaveBeenCalled();
    managed.exit();
    expect(await result).toBe("graceful");
    expect(managed.child.listenerCount("exit")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("only uses force termination after the graceful shutdown deadline", async () => {
    vi.useFakeTimers();
    const managed = createChild();
    const forceStop = vi.fn(() => managed.exit(null, "SIGKILL"));
    const onForceStop = vi.fn();
    const result = stopGatewayChildProcess({
      child: managed.child,
      timeoutMs: 10_000,
      forceTimeoutMs: 3_000,
      forceStop,
      onForceStop,
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(forceStop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe("forced");
    expect(forceStop).toHaveBeenCalledOnce();
    expect(onForceStop).toHaveBeenCalledWith("timeout", undefined);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back when the lifeline cannot be closed", async () => {
    const managed = createChild();
    managed.input.destroyed = true;
    const onForceStop = vi.fn();
    expect(
      await stopGatewayChildProcess({
        child: managed.child,
        timeoutMs: 10_000,
        forceTimeoutMs: 3_000,
        forceStop: () => managed.exit(1),
        onForceStop,
      }),
    ).toBe("forced");
    expect(onForceStop).toHaveBeenCalledWith("request-failed", expect.any(Error));
    expect(managed.input.end).not.toHaveBeenCalled();
  });

  it("does not stop an already exited process", async () => {
    const managed = createChild();
    managed.exit();
    const forceStop = vi.fn();
    expect(
      await stopGatewayChildProcess({
        child: managed.child,
        timeoutMs: 10_000,
        forceTimeoutMs: 3_000,
        forceStop,
        onForceStop: vi.fn(),
      }),
    ).toBe("already-exited");
    expect(managed.input.end).not.toHaveBeenCalled();
    expect(forceStop).not.toHaveBeenCalled();
  });

  it("refuses to report success if force termination does not produce an exit", async () => {
    vi.useFakeTimers();
    const managed = createChild();
    const result = stopGatewayChildProcess({
      child: managed.child,
      timeoutMs: 10_000,
      forceTimeoutMs: 3_000,
      forceStop: vi.fn(),
      onForceStop: vi.fn(),
    });
    const assertion = expect(result).rejects.toThrow(
      "Could not confirm Gateway process 4321 exited",
    );
    await vi.advanceTimersByTimeAsync(13_000);
    await assertion;
    expect(managed.child.listenerCount("exit")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
