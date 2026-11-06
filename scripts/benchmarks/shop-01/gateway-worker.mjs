import { appendFileSync } from "node:fs";
import { GatewayClient } from "../../../desktop/src/gateway-client.ts";

const tracePath = process.env.SHOP_GATEWAY_TRACE;
const trace = (value) => appendFileSync(tracePath, `${JSON.stringify(value)}\n`);
let active = null;
const client = new GatewayClient({
  port: Number(process.env.SHOP_GATEWAY_PORT),
  token: process.env.SHOP_GATEWAY_TOKEN,
  onConnected(hello) {
    process.send?.({ type: "ready", version: hello.server?.version ?? null });
  },
  onAuthError(message) {
    process.send?.({ type: "fatal", message });
    client.stop();
  },
  onEvent(event) {
    trace({ at: new Date().toISOString(), type: "event", event });
    const payload = event.payload;
    if (event.event !== "chat" || !active || payload?.sessionKey !== active.sessionKey) return;
    if (!active.runId) active.events.push(payload);
    else consume(payload);
  },
});

function consume(payload) {
  if (!active || payload.runId !== active.runId) return;
  if (!["final", "error", "aborted"].includes(payload.state)) return;
  const requestId = active.id;
  active = null;
  process.send?.({ type: "reply", id: requestId, payload });
}

process.on("message", async (command) => {
  if (command.type === "stop") {
    client.stop();
    process.disconnect();
    return;
  }
  if (command.type !== "send" || active) return;
  active = { id: command.id, sessionKey: command.sessionKey, runId: null, events: [] };
  trace({ at: new Date().toISOString(), type: "send", ...command });
  try {
    await client.observeChatSession(command.sessionKey);
    const response = await client.sendChat(command.sessionKey, command.message);
    if (typeof response?.runId !== "string") throw new Error("chat.send did not return runId");
    trace({ at: new Date().toISOString(), type: "accepted", id: command.id, response });
    const queued = active.events;
    active.runId = response.runId;
    for (const payload of queued) consume(payload);
  } catch (error) {
    active = null;
    process.send?.({ type: "failure", id: command.id, message: error.message });
  }
});
process.on("disconnect", () => {
  client.stop();
  process.exit(0);
});
client.start();
