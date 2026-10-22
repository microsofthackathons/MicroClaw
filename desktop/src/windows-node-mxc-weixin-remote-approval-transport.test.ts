import net from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { WindowsNodeMxcWeixinRemoteApprovalServer } from "./windows-node-mxc-weixin-remote-approval-transport";

const contract = "microclaw.windows-weixin-remote-approval.v1";

describe("WeChat remote approval transport", () => {
  const servers: WindowsNodeMxcWeixinRemoteApprovalServer[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  it("exposes only authenticated inbound interception and system delivery", async () => {
    const pipe = `\\\\.\\pipe\\microclaw-weixin-approval-test-${randomUUID()}`;
    const server = new WindowsNodeMxcWeixinRemoteApprovalServer(
      pipe,
      "secret-token",
      async (source) => ({
        consumed: source.text === "1 23456789",
        acknowledgement: "ack",
      }),
    );
    servers.push(server);
    await server.start();

    const socket = net.createConnection(pipe);
    socket.setEncoding("utf8");
    const frames: Array<Record<string, unknown>> = [];
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        frames.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
        buffer = buffer.slice(newline + 1);
      }
    });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      `${JSON.stringify({
        contract,
        type: "register",
        token: "secret-token",
        accountId: "bot@im.wechat",
      })}\n`,
    );
    await waitFor(() => frames.some((frame) => frame.type === "registered"));

    socket.write(
      `${JSON.stringify({
        contract,
        type: "inbound",
        requestId: "request-1",
        source: {
          accountId: "bot@im.wechat",
          senderId: "owner@im.wechat",
          conversationId: "owner@im.wechat",
          messageId: "2",
          cursor: 2,
          agentId: "main",
          sessionKey: "agent:main:weixin:owner",
          direct: true,
          forwarded: false,
          quoted: false,
          receivedAtUnixMs: 1,
          text: "1 23456789",
          ambiguous: false,
          sourcePhase: "candidate",
        },
      })}\n`,
    );
    await waitFor(() => frames.some((frame) => frame.type === "inbound-result"));
    expect(frames.find((frame) => frame.type === "inbound-result")).toMatchObject({
      requestId: "request-1",
      consumed: true,
      acknowledgement: "ack",
    });

    const delivery = server.deliver({
      accountId: "bot@im.wechat",
      to: "owner@im.wechat",
      text: "[MicroClaw Security Approval #23456789]",
    });
    await waitFor(() => frames.some((frame) => frame.type === "deliver"));
    const deliveryFrame = frames.find((frame) => frame.type === "deliver")!;
    socket.write(
      `${JSON.stringify({
        contract,
        type: "delivery-result",
        deliveryId: deliveryFrame.deliveryId,
        ok: true,
      })}\n`,
    );
    await delivery;
    socket.destroy();
  });

  it("leaves local approval usable when no plugin transport is registered", async () => {
    const pipe = `\\\\.\\pipe\\microclaw-weixin-approval-test-${randomUUID()}`;
    const server = new WindowsNodeMxcWeixinRemoteApprovalServer(pipe, "secret-token", async () => ({
      consumed: false,
    }));
    servers.push(server);
    await server.start();
    await expect(
      server.deliver({
        accountId: "bot@im.wechat",
        to: "owner@im.wechat",
        text: "approval",
      }),
    ).rejects.toThrow("transport is unavailable");
  });

  it("rejects pending deliveries immediately when a plugin client is replaced", async () => {
    const pipe = `\\\\.\\pipe\\microclaw-weixin-approval-test-${randomUUID()}`;
    const server = new WindowsNodeMxcWeixinRemoteApprovalServer(pipe, "secret-token", async () => ({
      consumed: false,
    }));
    servers.push(server);
    await server.start();

    const connect = async () => {
      const socket = net.createConnection(pipe);
      socket.setEncoding("utf8");
      const frames: Array<Record<string, unknown>> = [];
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        while (buffer.includes("\n")) {
          const newline = buffer.indexOf("\n");
          frames.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
          buffer = buffer.slice(newline + 1);
        }
      });
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      socket.write(
        `${JSON.stringify({
          contract,
          type: "register",
          token: "secret-token",
          accountId: "bot@im.wechat",
        })}\n`,
      );
      await waitFor(() => frames.some((frame) => frame.type === "registered"));
      return { socket, frames };
    };

    const first = await connect();
    const pendingDelivery = server.deliver({
      accountId: "bot@im.wechat",
      to: "owner@im.wechat",
      text: "approval",
    });
    const rejectedDelivery = expect(pendingDelivery).rejects.toMatchObject({
      name: "WeixinRemoteTransportError",
      diagnostic: { stage: "pipe", code: "transport-disconnected" },
    });
    await waitFor(() => first.frames.some((frame) => frame.type === "deliver"));

    const second = await connect();
    await rejectedDelivery;
    first.socket.destroy();
    second.socket.destroy();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for transport frame");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
