export const CHAT_SESSION_UPDATE_CHANNEL = "chat:session-update";
export interface ChatSessionUpdate {
  sessionKey: string;
}
type Listener = (event: unknown, payload: ChatSessionUpdate) => void;

export function forwardGatewaySessionUpdate(
  event: { event: string; payload?: unknown },
  send: (channel: string, payload: ChatSessionUpdate) => void,
): boolean {
  if (event.event !== "session.message" && event.event !== "sessions.changed") return false;
  const payload = event.payload;
  if (
    payload &&
    typeof payload === "object" &&
    "sessionKey" in payload &&
    typeof payload.sessionKey === "string" &&
    payload.sessionKey
  ) {
    send(CHAT_SESSION_UPDATE_CHANNEL, { sessionKey: payload.sessionKey });
  }
  return true;
}

export function subscribeChatSessionUpdates(
  ipc: {
    on(channel: string, listener: Listener): unknown;
    removeListener(channel: string, listener: Listener): unknown;
  },
  callback: (payload: ChatSessionUpdate) => void,
): () => void {
  const handler: Listener = (_event, payload) => callback(payload);
  ipc.on(CHAT_SESSION_UPDATE_CHANNEL, handler);
  return () => {
    ipc.removeListener(CHAT_SESSION_UPDATE_CHANNEL, handler);
  };
}
