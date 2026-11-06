import { getChatModelRestriction } from "../../../src/provider-model-capabilities";
import { getModelFamilyId, sortModelsByFamily } from "./model-family-sort";

const recommendedQwenModel = "qwen3.7-plus";
const featuredQwenModels = ["qwen3.8-max", "qwen3.8-flash", recommendedQwenModel, "qwen3.5-plus"];

export function isProviderModelVisible(providerKey: string, id: string): boolean {
  if (providerKey !== "qwen") return true;
  const familyId = getModelFamilyId(id);
  return (
    /^qwen(?:\d|[-_]|$)/i.test(familyId) && !getChatModelRestriction(`${providerKey}/${familyId}`)
  );
}

export function getProviderCatalogOptions(providerKey: string, ids: readonly string[]): string[] {
  if (providerKey !== "qwen") return [...ids];
  return sortModelsByFamily(
    ids.filter((id) => isProviderModelVisible(providerKey, id)).map((id) => ({ id })),
    "desc",
  ).map(({ id }) => id);
}

export function getProviderModelSections<Model extends { id: string }>(
  providerKey: string,
  models: readonly Model[],
  selectedId?: string,
): { primary: Model[]; more: Model[] } {
  if (providerKey !== "qwen") return { primary: [...models], more: [] };
  const primary: Model[] = [];
  for (const id of featuredQwenModels) {
    const candidates = models.filter((model) => getModelFamilyId(model.id).toLowerCase() === id);
    const model =
      candidates.find((candidate) => candidate.id === selectedId) ??
      candidates.find((candidate) => candidate.id.toLowerCase() === id) ??
      candidates[0];
    if (model) primary.push(model);
  }
  const selected = models.find((model) => model.id === selectedId);
  if (selected && !primary.includes(selected)) primary.unshift(selected);
  const primaryIds = new Set(primary.map((model) => model.id));
  return { primary, more: models.filter((model) => !primaryIds.has(model.id)) };
}

export function isRecommendedProviderModel(providerKey: string, id: string): boolean {
  return providerKey === "qwen" && getModelFamilyId(id).toLowerCase() === recommendedQwenModel;
}
