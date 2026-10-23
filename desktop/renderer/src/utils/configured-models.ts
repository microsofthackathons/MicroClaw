import { getManagedModelProvider } from "./managed-model-providers";
import {
  normalizeModelInput,
  type ModelApiFormat,
  type ModelInputCapability,
  type ModelReasoningEffort,
} from "./model-provider";

export interface ConfiguredModel {
  providerKey: string;
  id: string;
  name: string;
  source: "managed" | "custom" | "auth-managed";
  baseUrl?: string;
  apiKey?: string;
  apiFormat?: ModelApiFormat;
  reasoningEffort?: ModelReasoningEffort;
  input?: ModelInputCapability[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function getModelRef(model: Pick<ConfiguredModel, "providerKey" | "id">): string {
  return `${model.providerKey}/${model.id}`;
}

export function providerName(key: string): string {
  if (key === "github-copilot") return "GitHub Copilot";
  if (key === "llama-cpp") return "llama.cpp";
  return getManagedModelProvider(key)?.label ?? key;
}

export function readConfiguredModels(config: unknown): {
  models: ConfiguredModel[];
  primary: string;
} {
  const root = record(config);
  const providers = record(record(root.models).providers);
  const defaults = record(record(root.agents).defaults);
  const modelDefaults = record(defaults.models);
  const selector = defaults.model;
  const primaryValue = typeof selector === "string" ? selector : record(selector).primary;
  const primary = typeof primaryValue === "string" ? primaryValue : "";
  const models: ConfiguredModel[] = [];
  for (const [key, raw] of Object.entries(providers)) {
    const provider = record(raw);
    const managed = getManagedModelProvider(key);
    for (const rawModel of Array.isArray(provider.models) ? provider.models : []) {
      const model = record(rawModel);
      if (typeof model.id !== "string" || !model.id.trim()) continue;
      const preset = managed?.models.find((item) => item.id === model.id);
      const apiFormat: ModelApiFormat =
        provider.api === "anthropic-messages"
          ? "anthropic"
          : provider.api === "openai-responses"
            ? "openai-responses"
            : "openai-chat";
      const thinking = record(record(modelDefaults[`${key}/${model.id}`]).params).thinking;
      const efforts: ModelReasoningEffort[] = [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "adaptive",
      ];
      const reasoningEffort =
        efforts.find((effort) => effort === thinking) ??
        (model.reasoning === true || apiFormat === "openai-responses" ? "low" : "off");
      models.push({
        providerKey: key,
        id: model.id,
        name: typeof model.name === "string" ? model.name : (preset?.name ?? model.id),
        source: managed ? "managed" : "custom",
        baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : "",
        apiKey: typeof provider.apiKey === "string" ? provider.apiKey : "",
        apiFormat,
        reasoningEffort,
        input: normalizeModelInput(model.input ?? preset?.input),
      });
    }
  }
  for (const ref of new Set([...Object.keys(modelDefaults), primary])) {
    if (!ref.startsWith("github-copilot/") || models.some((model) => getModelRef(model) === ref))
      continue;
    const id = ref.slice("github-copilot/".length);
    if (!id) continue;
    const alias = record(modelDefaults[ref]).alias;
    models.push({
      providerKey: "github-copilot",
      id,
      name: typeof alias === "string" ? alias : id,
      source: "auth-managed",
    });
  }
  return { models, primary };
}
