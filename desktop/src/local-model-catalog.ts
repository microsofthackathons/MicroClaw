import type { LocalModelFileStatus } from "./local-model-types";
import sources from "./local-model-sources.json";

export const LOCAL_MODEL_SELECTION_PROMPT = "MicroClaw: select the exact local model";
export const LOCAL_MODEL_DOWNLOAD_PROMPT = "MicroClaw: confirm the exact local model download";
export const LOCAL_MODEL_PRESETS = sources.models;

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
