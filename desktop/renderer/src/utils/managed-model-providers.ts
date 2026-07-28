import qwenLogo from "@/assets/modelprovider/Qwen.png";
import minimaxLogo from "@/assets/modelprovider/minimax.png";
import type { ModelApiFormat, ModelInputCapability } from "./model-provider";

export type ManagedModelProviderId = "qwen" | "minimax";

export interface ManagedModelPreset {
  id: string;
  name: string;
  input: ModelInputCapability[];
}

export interface ManagedModelProvider {
  id: ManagedModelProviderId;
  label: string;
  logo: string;
  baseUrl: string;
  apiFormat: ModelApiFormat;
  models: ManagedModelPreset[];
  defaultModel: string;
  apiKeyPlaceholder: string;
  signupUrl: string;
}

export const MANAGED_MODEL_PROVIDERS: ManagedModelProvider[] = [
  {
    id: "qwen",
    label: "千问",
    logo: qwenLogo,
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiFormat: "openai-chat",
    models: [
      { id: "qwen", name: "qwen", input: ["text", "image"] },
      { id: "qwen3.7-plus", name: "qwen3.7-plus", input: ["text", "image"] },
      { id: "qwen3.6-plus", name: "qwen3.6-plus", input: ["text", "image"] },
      { id: "qwen3-32b", name: "qwen3-32b", input: ["text", "image"] },
      { id: "qwen3.6-flash", name: "qwen3.6-flash", input: ["text", "image"] },
      { id: "qwen3.5-plus", name: "qwen3.5-plus", input: ["text", "image"] },
    ],
    defaultModel: "qwen3.7-plus",
    apiKeyPlaceholder: "sk-...",
    signupUrl: "https://click.qianwenai.com/m/20000000741/",
  },
  {
    id: "minimax",
    label: "MiniMax",
    logo: minimaxLogo,
    baseUrl: "https://api.minimaxi.com/v1",
    apiFormat: "openai-chat",
    models: [
      { id: "MiniMax-M3", name: "MiniMax-M3", input: ["text", "image"] },
      { id: "MiniMax-M1", name: "MiniMax-M1", input: ["text", "image"] },
    ],
    defaultModel: "MiniMax-M3",
    apiKeyPlaceholder: "sk-...",
    signupUrl: "https://platform.minimaxi.com/byok-trial?source=microclaw",
  },
];

export function getManagedModelProvider(value: string): ManagedModelProvider | undefined {
  return MANAGED_MODEL_PROVIDERS.find((provider) => provider.id === value);
}

export function isManagedModelProviderId(value: string): value is ManagedModelProviderId {
  return getManagedModelProvider(value) !== undefined;
}
