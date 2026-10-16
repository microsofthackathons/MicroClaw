import { shallowReactive, shallowRef } from "vue";
import type {
  ProviderCatalogInput,
  ProviderCatalogResult,
} from "../../../src/provider-model-catalog";
import { t } from "@/i18n";
import { type ConfiguredModel, providerName } from "@/utils/configured-models";
import { getManagedModelProvider } from "@/utils/managed-model-providers";
import { normalizeModelInput } from "@/utils/model-provider";

export type ConfiguredCatalogs = Record<string, ProviderCatalogInput>;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readConfiguredCatalogs(config: unknown): ConfiguredCatalogs {
  const providers = object(object(object(config).models).providers);
  return Object.fromEntries(
    Object.entries(providers)
      .filter(([id]) => getManagedModelProvider(id))
      .map(([id, raw]) => {
        const provider = object(raw);
        return [
          id,
          {
            baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : "",
            apiKey: typeof provider.apiKey === "string" ? provider.apiKey : "",
          },
        ];
      }),
  );
}

function createCatalog(api: Window["openclaw"]["model"]) {
  const entries = shallowReactive(
    new Map<
      string,
      {
        result: ReturnType<typeof shallowRef<ProviderCatalogResult | undefined>>;
        pending?: Promise<ProviderCatalogResult>;
      }
    >(),
  );
  const key = (input: ProviderCatalogInput) =>
    JSON.stringify([input.baseUrl.trim().replace(/\/+$/, ""), input.apiKey.trim()]);

  function load(input: ProviderCatalogInput): Promise<ProviderCatalogResult> {
    const id = key(input);
    let entry = entries.get(id);
    if (!entry) {
      entry = { result: shallowRef() };
      entries.set(id, entry);
    }
    if (entry.pending) return entry.pending;
    const current = entry;
    current.pending = api
      .discoverModels(input)
      .catch((): ProviderCatalogResult => ({ ok: false, error: "network" }))
      .then((result) => {
        current.result.value = result;
        return result;
      })
      .finally(() => {
        current.pending = undefined;
      });
    return current.pending;
  }

  function merge(models: ConfiguredModel[], inputs: ConfiguredCatalogs): ConfiguredModel[] {
    let result = models;
    for (const [providerKey, input] of Object.entries(inputs)) {
      const catalog = entries.get(key(input))?.result.value;
      if (!catalog?.ok) continue;
      const saved = new Map(
        models
          .filter((model) => model.providerKey === providerKey)
          .map((model) => [model.id, model]),
      );
      result = [
        ...result.filter((model) => model.providerKey !== providerKey),
        ...catalog.models.map((id): ConfiguredModel => {
          const existing = saved.get(id);
          return (
            existing ?? {
              providerKey,
              id,
              name: id,
              source: "managed",
              ...input,
              apiFormat: "openai-chat",
              input: normalizeModelInput(
                getManagedModelProvider(providerKey)?.models.find((model) => model.id === id)
                  ?.input,
              ),
            }
          );
        }),
      ];
    }
    return result;
  }

  function errors(inputs: ConfiguredCatalogs): string {
    return Object.entries(inputs)
      .flatMap(([provider, input]) => {
        const result = entries.get(key(input))?.result.value;
        return result && !result.ok
          ? [`${providerName(provider)}: ${t(`modelSetup.catalogError.${result.error}`)}`]
          : [];
      })
      .join("; ");
  }

  return {
    load,
    merge,
    errors,
    loadConfigured: (inputs: ConfiguredCatalogs) => Promise.all(Object.values(inputs).map(load)),
  };
}

const catalogs = new WeakMap<Window["openclaw"]["model"], ReturnType<typeof createCatalog>>();

/** Shared by all three pickers; unsaved credentials have a separate in-memory entry. */
export function useProviderModelCatalog() {
  const api = window.openclaw.model;
  let catalog = catalogs.get(api);
  if (!catalog) {
    catalog = createCatalog(api);
    catalogs.set(api, catalog);
  }
  return catalog;
}
