import { describe, expect, it } from "vitest";
import { assertChatModelSupported, getChatModelRestriction } from "./provider-model-capabilities";

describe("provider chat compatibility", () => {
  it.each([
    ["qwen/qwen3.8-omni-flash-realtime", "realtime"],
    ["qwen/qwen3-omni-flash-realtime-2025-09-15", "realtime"],
    ["qwen/qwen3.7-text-embedding-flash", "embedding"],
    ["qwen/qwen3.7-text-rerank", "rerank"],
    ["qwen/qwen-audio-3.0-asr-flash", "speech"],
    ["qwen/qwen3-tts-flash", "speech"],
    ["qwen/MiniMax/speech-2.8-hd", "speech"],
    ["minimax/speech-02-turbo", "speech"],
    ["qwen/qwen-image-3.0-pro", "image"],
    ["qwen/wan2.7-image-pro", "image"],
    ["qwen/wan2.7-t2v", "video"],
    ["minimax/MiniMax-Hailuo-02", "video"],
  ])("rejects %s before attempting a chat request", (ref, reason) => {
    expect(getChatModelRestriction(ref)).toBe(reason);
    expect(() => assertChatModelSupported(ref)).toThrow("UNSUPPORTED_CHAT_MODEL");
  });

  it.each([
    "qwen/qwen3.7-plus",
    "qwen/qwen3.8-max",
    "qwen/qwen3-vl-plus",
    "qwen/qwen3-omni-flash",
    "minimax/MiniMax-M3",
    "custom/realtime-chat-proxy",
    "llama-cpp/qwen3.5-4b-q4_k_m",
  ])("does not invent restrictions for %s", (ref) => {
    expect(getChatModelRestriction(ref)).toBeUndefined();
    expect(() => assertChatModelSupported(ref)).not.toThrow();
  });
});
