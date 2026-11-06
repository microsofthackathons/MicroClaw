import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import * as deviceIdentity from "./device-identity";
import { GatewayClient } from "./gateway-client";

function sendFragmentedFrame(socket: WebSocket, frame: unknown) {
  const data = Buffer.from(JSON.stringify(frame));
  const midpoint = Math.floor(data.length / 2);
  socket.send(data.subarray(0, midpoint), { binary: false, fin: false });
  socket.send(data.subarray(midpoint), { binary: false, fin: true });
}

describe("GatewayClient WebSocket transport", () => {
  let server: WebSocketServer;
  let client: GatewayClient;
  let peer: WebSocket;
  const onConnected = vi.fn();
  const onDisconnected = vi.fn();
  const onEvent = vi.fn();
  const onRequest = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(deviceIdentity, "loadOrCreateDeviceIdentity").mockReturnValue({
      deviceId: "test-device",
      publicKey: Buffer.alloc(32, 2).toString("base64url"),
      privateKey: Buffer.alloc(32, 1).toString("base64url"),
    });
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket) => {
      peer = socket;
      socket.on("message", (data) => {
        const request = JSON.parse(String(data));
        onRequest(request);
        if (request.method === "never.reply") return;
        sendFragmentedFrame(socket, {
          type: "res",
          id: request.id,
          ok: true,
          payload:
            request.method === "connect"
              ? { server: { version: "test" }, features: { methods: ["echo"] } }
              : request.params,
        });
      });
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "test-nonce" },
        }),
      );
    });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    client = new GatewayClient({
      port: address.port,
      token: "test-token",
      onConnected,
      onDisconnected,
      onEvent,
    });
    client.start();
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
  });

  afterEach(async () => {
    client?.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    vi.restoreAllMocks();
  });

  it("negotiates the gateway handshake and exchanges fragmented JSON messages", async () => {
    expect(client.connected).toBe(true);
    expect(client.serverVersion).toBe("test");
    expect(client.methods).toEqual(["echo"]);
    expect(onRequest).toHaveBeenCalledWith(
      expect.objectContaining({ type: "req", method: "connect" }),
    );
    await expect(client.request("echo", { text: "你好 👋" })).resolves.toEqual({
      text: "你好 👋",
    });
    const event = { type: "event", event: "tick", payload: { text: "你好 👋" } };
    sendFragmentedFrame(peer, event);
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledExactlyOnceWith(event));
  });

  it("rejects pending requests on disconnect and exchanges messages after reconnecting", async () => {
    const pending = client.request("never.reply", {}, 3_000);
    const rejected = expect(pending).rejects.toThrow("disconnected");
    await vi.waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({ method: "never.reply" })),
    );
    peer.terminate();
    await rejected;
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    expect(onDisconnected).toHaveBeenCalledOnce();
    expect(client.connectionGeneration).toBe(2);
    await expect(client.request("echo", { reconnected: true })).resolves.toEqual({
      reconnected: true,
    });
  });

  it.each([Buffer.from("x"), Buffer.alloc(0)])(
    "closes an excessive stream of %j fragments and recovers without delivering it",
    async (fragment) => {
      const onClose = vi.fn();
      peer.on("close", onClose);
      for (let fragmentIndex = 0; fragmentIndex <= 16 * 1024; fragmentIndex++) {
        peer.send(fragment, { binary: false, fin: false });
      }
      await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(1008, expect.any(Buffer)), {
        timeout: 3_000,
      });
      expect(onEvent).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(onConnected).toHaveBeenCalledTimes(2), { timeout: 3_000 });
      expect(onDisconnected).toHaveBeenCalledOnce();
      await expect(client.request("echo", { recovered: true })).resolves.toEqual({
        recovered: true,
      });
    },
  );
});
