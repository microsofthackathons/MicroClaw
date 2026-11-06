export type ChatModelRestriction =
  | "realtime"
  | "embedding"
  | "rerank"
  | "speech"
  | "image"
  | "video";

/** The provider directory also advertises families served by non-chat APIs. */
export function getChatModelRestriction(modelRef: string): ChatModelRestriction | undefined {
  const slash = modelRef.indexOf("/");
  if (!["qwen", "minimax"].includes(modelRef.slice(0, slash))) return undefined;
  const id = modelRef.slice(slash + 1).toLowerCase();
  if (/(?:^|[-/])realtime(?:-|$)/.test(id)) return "realtime";
  if (/(?:^|[-/])rerank(?:-|$)/.test(id)) return "rerank";
  if (/(?:^|[-/])embedding(?:-|$)/.test(id) || /^gte-/.test(id)) return "embedding";
  if (
    /(?:^|[-/])(?:asr|tts|speech|s2s)(?:-|$)/.test(id) ||
    /^(?:paraformer|cosyvoice|sambert|sensevoice)(?:-|$)/.test(id)
  )
    return "speech";
  if (
    /^(?:qwen-image|z-image)(?:-|$)/.test(id) ||
    /^wan[\d.]*-image(?:-|$)/.test(id) ||
    /^(?:minimax\/)?image-\d/.test(id)
  )
    return "image";
  if (/^(?:wan(?:x|[\d.])|(?:minimax[-/])?hailuo|video-\d)/.test(id)) return "video";
  return undefined;
}

export function assertChatModelSupported(modelRef: string): void {
  const restriction = getChatModelRestriction(modelRef);
  if (restriction)
    throw new Error(
      `UNSUPPORTED_CHAT_MODEL: ${modelRef} requires a ${restriction} API, not the chat-completions interface used by this conversation.`,
    );
}
