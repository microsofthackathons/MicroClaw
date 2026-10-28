import type { ConfiguredModel } from "./configured-models";

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function getModelFamilyId(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1).replace(/^cmaas[-_]/i, "");
}

export function sortModelsByFamily<Model extends Pick<ConfiguredModel, "id">>(
  models: readonly Model[],
  order: "asc" | "desc" = "asc",
): Model[] {
  const direction = order === "desc" ? -1 : 1;
  return models
    .map((model) => {
      const id = getModelFamilyId(model.id);
      const family = id.match(/^[a-z]+/i)?.[0] ?? id;
      return { model, id, family };
    })
    .sort(
      (left, right) =>
        collator.compare(left.family, right.family) ||
        direction *
          (collator.compare(left.id, right.id) || collator.compare(left.model.id, right.model.id)),
    )
    .map(({ model }) => model);
}
