import { LOCAL_MODEL_PRESETS, type LocalModelCatalogEntry } from "../../../src/local-model-catalog";
import { getModelRef, type ConfiguredModel } from "./configured-models";

export function mergeLocalModelCatalog(
  models: ConfiguredModel[],
  catalog: LocalModelCatalogEntry[],
): ConfiguredModel[] {
  const presets = LOCAL_MODEL_PRESETS.filter((preset) =>
    catalog.some((entry) => entry.modelRef === preset.modelRef),
  );
  const fixedRefs = new Set<string>(presets.map((preset) => preset.modelRef));
  return [
    ...models.filter((model) => model.providerKey !== "llama-cpp"),
    ...presets.map(
      (preset): ConfiguredModel => ({
        providerKey: "llama-cpp",
        id: preset.modelRef.slice("llama-cpp/".length),
        name: preset.name,
        source: "managed",
      }),
    ),
    ...models.filter(
      (model) => model.providerKey === "llama-cpp" && !fixedRefs.has(getModelRef(model)),
    ),
  ];
}
