export type LocalModelChoice = "llama-cpp" | "llama-cpp-existing-server";

export interface LocalModelCapabilities {
  gatewayVersion: string | null;
  supported: boolean;
  mutable: boolean;
  blockers: string[];
  plugin: {
    installed: boolean;
    enabled: boolean;
    version?: string;
    canInstall: boolean;
  };
}

export interface LocalModelCandidate {
  kind: string;
  modelRef: string;
  label: string;
  detail: string;
  recommended: boolean;
}

export interface LocalModelDetection {
  choices: Array<{ id: LocalModelChoice; label: string; hint?: string }>;
  candidates: LocalModelCandidate[];
  configuredModel?: string;
  agentId: string;
}

export type LocalModelFileStatus = "present" | "missing" | "unknown" | "external";

/** Saved configuration plus local file metadata; never an inference health check. */
export interface LocalModelSnapshot {
  models: Array<{ modelRef: string; name: string; fileStatus?: LocalModelFileStatus }>;
  configuredModel?: string;
  catalog?: import("./local-model-catalog").LocalModelCatalogEntry[];
}

export interface LocalModelStep {
  id: string;
  type: "note" | "select" | "text" | "confirm" | "multiselect" | "progress" | "action";
  title?: string;
  message?: string;
  options?: Array<{ value: unknown; label: string; hint?: string }>;
  initialValue?: unknown;
  placeholder?: string;
  sensitive?: boolean;
  executor?: "gateway" | "client";
}

export type LocalModelPhase =
  | "starting"
  | "step"
  | "prepared"
  | "activating"
  | "applying"
  | "ready"
  | "cancelled"
  | "error"
  | "interrupted";

export interface LocalModelOperation {
  id: string;
  kind: "prepare" | "activate";
  phase: LocalModelPhase;
  agentId: string;
  authChoice?: LocalModelChoice;
  modelRef?: string;
  preparedModelRef?: string;
  step?: LocalModelStep;
  error?: string;
  rejectedBeforePromotion?: boolean;
  download?: {
    modelRef: string;
    modelName: string;
    modelBytes: number;
    embeddingBytes: number;
    runtimeDiskBytes: number;
    backend: "cpu" | "cuda" | "metal";
    runtimeNote: string;
  };
  cancellationPending: boolean;
  busy: boolean;
}

/** No credentials, wizard answers, or provider messages are persisted here. */
export interface LocalModelReceipt {
  id: string;
  kind: "prepare" | "activate";
  agentId: string;
  gatewayIdentity: string;
  approvedEndpoint?: string;
  authChoice?: LocalModelChoice;
  modelRef?: string;
  /** This operation writes config through config.patch, not an inference setup wizard. */
  configSelection?: boolean;
  exactModelSelected?: boolean;
}

export interface LocalModelInstallReview {
  pluginId: "llama-cpp";
  version?: string;
  source?: string;
  capabilities: Record<string, string[]>;
  reviewToken?: string;
}

export type LocalModelResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface LocalModelAPI {
  getSnapshot(): Promise<LocalModelResult<LocalModelSnapshot>>;
  getCapabilities(): Promise<LocalModelResult<LocalModelCapabilities>>;
  detect(options?: { refresh?: boolean }): Promise<LocalModelResult<LocalModelDetection>>;
  inspectProvider(): Promise<LocalModelResult<LocalModelInstallReview>>;
  installProvider(params: {
    confirmed: true;
    reviewToken?: string;
  }): Promise<LocalModelResult<LocalModelCapabilities>>;
  prepare(params: {
    authChoice: LocalModelChoice;
    modelRef?: string;
    agentId?: string;
  }): Promise<LocalModelResult<LocalModelOperation>>;
  activate(params: {
    kind: string;
    modelRef: string;
  }): Promise<LocalModelResult<LocalModelOperation>>;
  answer(params: {
    operationId: string;
    stepId: string;
    value?: unknown;
  }): Promise<LocalModelResult<LocalModelOperation>>;
  cancel(operationId: string): Promise<LocalModelResult<LocalModelOperation>>;
  getOperation(): Promise<LocalModelResult<LocalModelOperation | null>>;
  resume(): Promise<LocalModelResult<LocalModelOperation | null>>;
  onEvent(callback: (operation: LocalModelOperation) => void): () => void;
}
