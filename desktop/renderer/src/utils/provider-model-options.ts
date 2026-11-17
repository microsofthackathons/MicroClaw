import { getChatModelRestriction } from "../../../src/provider-model-capabilities";
import { getModelFamilyId, sortModelsByFamily } from "./model-family-sort";

const recommendedQwenModel = "qwen3.7-plus";

export function isProviderModelVisible(providerKey: string, id: string): boolean {
  if (providerKey !== "qwen") return true;
  const familyId = getModelFamilyId(id);
  return (
    /^qwen(?:\d|[-_]|$)/i.test(familyId) && !getChatModelRestriction(`${providerKey}/${familyId}`)
  );
}

export function getProviderCatalogOptions(providerKey: string, ids: readonly string[]): string[] {
  if (providerKey !== "qwen" && providerKey !== "minimax") return [...ids];
  return sortProviderModels(
    providerKey,
    ids.filter((id) => isProviderModelVisible(providerKey, id)).map((id) => ({ id })),
  ).map(({ id }) => id);
}

export function sortProviderModels<Model extends { id: string }>(
  providerKey: string,
  models: readonly Model[],
): Model[] {
  return sortModelsByFamily(
    models,
    providerKey === "qwen" || providerKey === "minimax" ? "desc" : "asc",
  );
}

export function getProviderModelSections<Model extends { id: string }>(
  providerKey: string,
  models: readonly Model[],
): { primary: Model[]; more: Model[] } {
  if (providerKey !== "qwen") return { primary: [...models], more: [] };
  const sorted = sortProviderModels(providerKey, models);
  return { primary: sorted.slice(0, 5), more: sorted.slice(5) };
}

export function isRecommendedProviderModel(providerKey: string, id: string): boolean {
  return providerKey === "qwen" && getModelFamilyId(id).toLowerCase() === recommendedQwenModel;
}
