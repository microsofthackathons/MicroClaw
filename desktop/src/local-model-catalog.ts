import type { LocalModelFileStatus } from "./local-model-types";

export const LOCAL_MODEL_SELECTION_PROMPT = "MicroClaw: select the exact local model";
export const LOCAL_MODEL_DOWNLOAD_PROMPT = "MicroClaw: confirm the exact local model download";
export const LOCAL_MODEL_PRESETS = [
  {
    modelRef: "llama-cpp/qwen3.5-4b-q4_k_m",
    name: "Qwen3.5 4B Q4_K_M",
    downloadBytes: 2740937888,
    cacheFile:
      "hf_unsloth_Qwen3.5-4B-GGUF_e87f176479d0855a907a41277aca2f8ee7a09523_Qwen3.5-4B-Q4_K_M.gguf",
    preferred: true,
  },
  {
    modelRef: "llama-cpp/qwen3.5-9b-q4_k_m",
    name: "Qwen3.5 9B Q4_K_M",
    downloadBytes: 5680522464,
    cacheFile:
      "hf_unsloth_Qwen3.5-9B-GGUF_3885219b6810b007914f3a7950a8d1b469d598a5_Qwen3.5-9B-Q4_K_M.gguf",
    preferred: false,
  },
] as const;

export interface LocalModelCatalogEntry {
  modelRef: string;
  name: string;
  downloadBytes: number;
  preferred: boolean;
  configured: boolean;
  fileStatus: LocalModelFileStatus | "not-downloaded";
}

export function isManagedLocalModel(modelRef: string): boolean {
  return LOCAL_MODEL_PRESETS.some((model) => model.modelRef === modelRef);
}
