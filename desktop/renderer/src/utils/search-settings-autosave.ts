export type SearchProviderId = "parallel-free" | "brave" | "tavily";

export interface SearchSaveRequest {
  readonly provider: SearchProviderId;
  readonly key: string;
  readonly requiresKey: boolean;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Search configuration is unavailable");
  }
  return value as Record<string, unknown>;
}

// Copy only the search path; never replace an unavailable configuration with defaults.
export function patchSearchConfig(value: unknown, request: SearchSaveRequest) {
  const config = record(value);
  const tools = config.tools === undefined ? {} : record(config.tools);
  const web = tools.web === undefined ? {} : record(tools.web);
  const nextWeb = { ...web };
  delete nextWeb.searchProviders;
  nextWeb.search = request.requiresKey
    ? { provider: request.provider, apiKey: request.key }
    : { provider: request.provider };
  return { ...config, tools: { ...tools, web: nextWeb } };
}

interface SaveOptions {
  persist: (request: SearchSaveRequest, canWrite: () => boolean) => Promise<boolean>;
  saving: () => void;
  saved: (request: SearchSaveRequest, current: boolean) => void;
  failed: (error: unknown) => void;
}

export function createSearchAutosave(options: SaveOptions) {
  type Entry = { request: SearchSaveRequest; generation: number };
  let generation = 0;
  let disposed = false;
  let active: Entry | undefined;
  let pending: Entry | undefined;

  function same(entry: Entry | undefined, request: SearchSaveRequest) {
    return (
      entry?.generation === generation &&
      entry.request.provider === request.provider &&
      entry.request.key === request.key &&
      entry.request.requiresKey === request.requiresKey
    );
  }

  async function drain() {
    while (!disposed && pending) {
      const entry = pending;
      pending = undefined;
      active = entry;
      try {
        const written = await options.persist(entry.request, () => !disposed);
        if (!disposed && written) {
          options.saved(entry.request, entry.generation === generation);
        }
      } catch (error) {
        if (!disposed && entry.generation === generation) options.failed(error);
      } finally {
        active = undefined;
      }
    }
  }

  return {
    save(request: SearchSaveRequest) {
      if (disposed || same(active, request) || same(pending, request)) return;
      pending = { request: Object.freeze({ ...request }), generation };
      options.saving();
      if (!active) void drain();
    },
    invalidate() {
      generation += 1;
      pending = undefined;
    },
    dispose() {
      disposed = true;
      pending = undefined;
    },
    isDisposed: () => disposed,
  };
}
