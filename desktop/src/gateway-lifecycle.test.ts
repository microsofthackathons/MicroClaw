import { describe, expect, it, vi } from "vitest";
import { hardRestartGateway } from "./gateway-lifecycle";

describe("hardRestartGateway", () => {
  it("stops the client and process, waits for the port, then starts", async () => {
    const order: string[] = [];
    const occupied = [true, true, false];

    await hardRestartGateway({
      stopClient: () => order.push("client"),
      stopProcess: () => order.push("process"),
      isPortOccupied: async () => occupied.shift() ?? false,
      startGateway: async () => {
        order.push("start");
      },
      sleep: async () => {
        order.push("sleep");
      },
      timeoutMs: 1_500,
      pollMs: 500,
    });

    expect(order).toEqual(["client", "process", "sleep", "sleep", "start"]);
  });

  it("does not start while the old port remains occupied", async () => {
    const startGateway = vi.fn();

    await expect(
      hardRestartGateway({
        stopClient: vi.fn(),
        stopProcess: vi.fn(),
        isPortOccupied: async () => true,
        startGateway,
        sleep: async () => {},
        timeoutMs: 1_000,
        pollMs: 500,
      }),
    ).rejects.toThrow(/port remained occupied/);
    expect(startGateway).not.toHaveBeenCalled();
  });

  it("checks at least once when the timeout is shorter than the poll interval", async () => {
    const isPortOccupied = vi.fn().mockResolvedValue(false);
    const startGateway = vi.fn().mockResolvedValue(undefined);

    await hardRestartGateway({
      stopClient: vi.fn(),
      stopProcess: vi.fn(),
      isPortOccupied,
      startGateway,
      sleep: vi.fn(),
      timeoutMs: 1,
      pollMs: 500,
    });

    expect(isPortOccupied).toHaveBeenCalledOnce();
    expect(startGateway).toHaveBeenCalledOnce();
  });
});
