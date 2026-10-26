import type { ConfiguredModel } from "./configured-models";

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function sortModelsByFamily(models: readonly ConfiguredModel[]): ConfiguredModel[] {
  return models
    .map((model) => {
      const id = model.id.slice(model.id.lastIndexOf("/") + 1).replace(/^cmaas[-_]/i, "");
      const family = id.match(/^[a-z]+/i)?.[0] ?? id;
      return { model, id, family };
    })
    .sort(
      (left, right) =>
        collator.compare(left.family, right.family) ||
        collator.compare(left.id, right.id) ||
        collator.compare(left.model.id, right.model.id),
    )
    .map(({ model }) => model);
}
