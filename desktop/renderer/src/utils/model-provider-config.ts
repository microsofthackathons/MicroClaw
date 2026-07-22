type ConfigRecord = Record<string, unknown>;

export interface ProviderModelSetup {
  api: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
}

export interface ManagedProviderModelSetup {
  api: string;
  apiKey: string;
  baseUrl: string;
  id: string;
  input?: string[];
  name: string;
  providerKey: string;
  reasoning: boolean;
}

function isConfigRecord(value: unknown): value is ConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeProviderModelConfig(
  existingProvider: unknown,
  setup: ProviderModelSetup,
): ConfigRecord {
  const provider = isConfigRecord(existingProvider) ? existingProvider : {};
  const existingModels = Array.isArray(provider.models) ? provider.models : [];
  const modelIndex = existingModels.findIndex(
    (model) => isConfigRecord(model) && model.id === setup.modelName,
  );
  const existingModel = modelIndex >= 0 ? existingModels[modelIndex] : undefined;
  const selectedModel = {
    id: setup.modelName,
    name: setup.modelName,
    input: ["text", "image"],
    ...(isConfigRecord(existingModel) ? existingModel : {}),
  };
  const models =
    modelIndex >= 0
      ? existingModels.map((model, index) => (index === modelIndex ? selectedModel : model))
      : [...existingModels, selectedModel];

  return {
    ...provider,
    ...(setup.baseUrl ? { baseUrl: setup.baseUrl } : {}),
    apiKey: setup.apiKey,
    api: setup.api,
    models,
  };
}

export function buildManagedProviderConfigs(
  existingProviders: unknown,
  setups: ManagedProviderModelSetup[],
): Record<string, ConfigRecord> {
  const providers = isConfigRecord(existingProviders) ? existingProviders : {};
  const groupedSetups = new Map<string, ManagedProviderModelSetup[]>();

  for (const setup of setups) {
    const group = groupedSetups.get(setup.providerKey);
    if (group) {
      group.push(setup);
    } else {
      groupedSetups.set(setup.providerKey, [setup]);
    }
  }

  const result: Record<string, ConfigRecord> = {};
  for (const [providerKey, providerSetups] of groupedSetups) {
    const existingProvider = isConfigRecord(providers[providerKey]) ? providers[providerKey] : {};
    const existingModels = Array.isArray(existingProvider.models) ? existingProvider.models : [];
    const models = providerSetups.map((setup) => {
      const existingModel = existingModels.find(
        (model) => isConfigRecord(model) && model.id === setup.id,
      );
      const nextModel: ConfigRecord = {
        ...(isConfigRecord(existingModel) ? existingModel : {}),
        id: setup.id,
        name: setup.name,
      };

      if (setup.reasoning) {
        nextModel.reasoning = true;
      } else {
        delete nextModel.reasoning;
      }
      if (setup.input) {
        nextModel.input = setup.input;
      } else {
        delete nextModel.input;
      }
      return nextModel;
    });
    const connection = providerSetups[providerSetups.length - 1];
    const nextProvider: ConfigRecord = {
      ...existingProvider,
      apiKey: connection.apiKey,
      api: connection.api,
      models,
    };
    if (connection.baseUrl) {
      nextProvider.baseUrl = connection.baseUrl;
    } else {
      delete nextProvider.baseUrl;
    }
    result[providerKey] = nextProvider;
  }

  return result;
}
