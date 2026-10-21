import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GatewayRequestError } from "./gateway-client";
import {
  LocalModelService,
  hasLocalModelPrimary,
  supportsLocalModelGatewayVersion,
  supportsLocalModelVersion,
  validateLocalModelUrl,
  LOCAL_MODEL_DETECTION_TTL_MS,
  LOCAL_MODEL_APPLY_SETTLE_TIMEOUT_MS,
  buildLocalModelSelectionPatch,
  type LocalModelGateway,
} from "./local-model-service";
import type { LocalModelOperation, LocalModelReceipt } from "./local-model-types";
import {
  LOCAL_MODEL_PRESETS,
  LOCAL_MODEL_SELECTION_PROMPT,
  LOCAL_MODEL_DOWNLOAD_PROMPT,
} from "./local-model-catalog";

const MODEL = "llama-cpp/test-model";
const PRESET = LOCAL_MODEL_PRESETS[0].modelRef;
const METHODS = [
  "plugins.list",
  "plugins.inspect",
  "plugins.install",
  "plugins.setEnabled",
  "agents.list",
  "models.list",
  "openclaw.setup.detect",
  "openclaw.setup.prepare.start",
  "config.get",
  "config.patch",
  "wizard.next",
  "wizard.cancel",
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(initialReceipt?: LocalModelReceipt) {
  let receipt = initialReceipt;
  let revision = 1;
  let authChoice: string | undefined =
    initialReceipt?.kind === "activate" ? undefined : (initialReceipt?.authChoice ?? "llama-cpp");
  let selectedPreset = "";
  let config: unknown = {
    agents: { defaults: { model: { primary: "cloud/previous" } } },
    models: {
      providers: {
        "llama-cpp": {
          baseUrl: "http://127.0.0.1:8080/v1",
          localService: { command: "C:\\llama-server.exe" },
          models: [{ id: "test-model" }],
        },
      },
    },
  };
  let plugin = {
    id: "llama-cpp",
    installed: true,
    enabled: true,
    version: "2026.9.3",
    install: { source: "official", pluginId: "llama-cpp" },
  };
  let next: (params: unknown) => unknown | Promise<unknown> = () => ({
    done: false,
    status: "running",
    step: {
      id: "consent",
      type: "confirm",
      message: `${LOCAL_MODEL_DOWNLOAD_PROMPT}\n${JSON.stringify({
        modelRef: selectedPreset,
        modelName: "Qwen3.5 4B (Q4_K_M)",
        modelBytes: 2740937888,
        embeddingBytes: 328577056,
        runtimeDiskBytes: 2 * 1024 ** 3,
        backend: "cpu",
        runtimeNote: "",
      })}`,
      initialValue: false,
    },
  });
  const detection = {
    candidates: [
      {
        kind: "provider-auto:llama-cpp",
        modelRef: MODEL,
        label: "Local",
        detail: "Prepared",
        recommended: true,
      },
    ],
    prepareOptions: [
      { id: "llama-cpp", label: "Managed local model" },
      { id: "llama-cpp-existing-server", label: "Existing server" },
    ],
    configuredModel: "cloud/previous",
  };
  const request = vi.fn(
    async (method: string, params?: unknown, _timeout?: number | null): Promise<unknown> => {
      switch (method) {
        case "plugins.list":
          return { plugins: [plugin], mutationAllowed: true };
        case "plugins.inspect":
          return {
            plugin,
            source: { kind: "bundled" },
            declared: { providers: ["llama-cpp"], tools: [] },
            reviewToken: "review-1",
          };
        case "agents.list":
          return { defaultId: "main", agents: [{ id: "main" }] };
        case "openclaw.setup.detect":
          return detection;
        case "models.list":
          return { models: [{ id: "test-model", provider: "llama-cpp", name: "Local" }] };
        case "openclaw.setup.prepare.start":
          authChoice = (params as { authChoice: string }).authChoice;
          selectedPreset = "";
          return { sessionId: "ignored", done: false, status: "running" };
        case "config.get":
          return {
            valid: true,
            hash: `source-${revision}`,
            config,
            configRevisionHash: `revision-${revision}`,
            appliedConfigHash: `revision-${revision}`,
          };
        case "config.patch": {
          const input = params as { raw: string; baseHash: string };
          if (input.baseHash !== `source-${revision}`) {
            throw new GatewayRequestError("Configuration changed", "INVALID_REQUEST");
          }
          const patch = JSON.parse(input.raw);
          const current = config as Record<string, unknown>;
          const agents = (current.agents ?? {}) as Record<string, unknown>;
          const defaults = (agents.defaults ?? {}) as Record<string, unknown>;
          const selector = typeof defaults.model === "object" ? defaults.model : {};
          config = {
            ...current,
            agents: {
              ...agents,
              defaults: {
                ...defaults,
                model: { ...selector, ...patch.agents.defaults.model },
                ...(patch.agents.defaults.models
                  ? {
                      models: { ...(defaults.models as object), ...patch.agents.defaults.models },
                    }
                  : {}),
              },
            },
          };
          revision++;
          return { ok: true, config, sentinel: { payload: { stats: { requiresRestart: false } } } };
        }
        case "wizard.next": {
          const answer = (params as { answer?: { stepId: string; value: string } }).answer;
          if (authChoice === "llama-cpp" && !selectedPreset) {
            if (answer?.stepId === "exact-model") selectedPreset = answer.value;
            else
              return {
                done: false,
                status: "running",
                step: {
                  id: "exact-model",
                  type: "select",
                  message: LOCAL_MODEL_SELECTION_PROMPT,
                  options: LOCAL_MODEL_PRESETS.map((preset) => ({
                    value: preset.modelRef,
                    label: preset.name,
                  })),
                },
              };
          }
          return next(params);
        }
        case "wizard.cancel":
          return { status: "cancelled" };
        case "plugins.install":
        case "plugins.setEnabled":
          plugin = { ...plugin, installed: true, enabled: true };
          return { ok: true, restartRequired: true };
        default:
          throw new Error(`Unexpected method: ${method}`);
      }
    },
  );
  const gateway: LocalModelGateway = {
    connected: true,
    serverVersion: "2026.10.3",
    methods: METHODS,
    connectionGeneration: 1,
    request: async <T>(method: string, params?: unknown, timeout?: number | null) =>
      (await request(method, params, timeout)) as T,
  };
  const events: LocalModelOperation[] = [];
  const assertMutable = vi.fn();
  const restartGateway = vi.fn().mockResolvedValue(undefined);
  const service = new LocalModelService({
    gateway: () => gateway,
    identity: () => "test-gateway",
    assertMutable,
    readConfig: () => config,
    readReceipt: () => receipt,
    saveReceipt: (value) => {
      receipt = value ?? undefined;
    },
    restartGateway,
    onChange: (operation) => events.push(operation),
  });
  return {
    service,
    gateway,
    request,
    events,
    assertMutable,
    restartGateway,
    detection,
    receipt: () => receipt,
    next: (handler: typeof next) => {
      next = handler;
    },
    config: (value: unknown) => {
      config = value;
      revision++;
    },
    readConfig: () => config,
    plugin: (patch: Partial<typeof plugin>) => {
      plugin = { ...plugin, ...patch };
    },
  };
}

async function waitPhase(f: ReturnType<typeof fixture>, phase: LocalModelOperation["phase"]) {
  await vi.waitFor(() => expect(f.service.getOperation()?.phase).toBe(phase));
  await Promise.resolve();
}

describe("local model protocol guards", () => {
  it("requires a valid explicit owner for an ambiguous multi-agent preparation", async () => {
    const f = fixture();
    f.config({ agents: { entries: { first: {}, second: {} } } });
    await expect(f.service.prepare({ authChoice: "llama-cpp", modelRef: PRESET })).rejects.toThrow(
      "no unambiguous owner",
    );
    await expect(
      f.service.prepare({ authChoice: "llama-cpp", modelRef: PRESET, agentId: "missing" }),
    ).rejects.toThrow("configured agent");
    expect(f.request.mock.calls.some(([method]) => method === "openclaw.setup.prepare.start")).toBe(
      false,
    );
    const operation = await f.service.prepare({
      authChoice: "llama-cpp",
      modelRef: PRESET,
      agentId: "second",
    });
    await waitPhase(f, "step");
    expect(
      f.request.mock.calls.find(([method]) => method === "openclaw.setup.prepare.start")?.[1],
    ).toEqual({ sessionId: operation.id, authChoice: "llama-cpp", agentId: "second" });
    await f.service.cancel(operation.id);
  });
  it("uses an explicitly configured system owner without rewriting agent configuration", async () => {
    const f = fixture();
    const config = {
      agents: {
        entries: { first: {}, selected: {} },
        defaults: { systemAgent: { agentId: "selected" }, model: "cloud/keep" },
      },
    };
    f.config(config);
    const operation = await f.service.prepare({ authChoice: "llama-cpp", modelRef: PRESET });
    await waitPhase(f, "step");
    expect(
      f.request.mock.calls.find(([method]) => method === "openclaw.setup.prepare.start")?.[1],
    ).toMatchObject({ agentId: "selected" });
    expect(f.readConfig()).toEqual(config);
    await f.service.cancel(operation.id);
  });
  it("lists fixed presets and reads capability status without online search or hardware discovery", async () => {
    const f = fixture();
    f.plugin({ installed: false, enabled: false });
    f.gateway.methods = [...METHODS, "plugins.search"];
    expect(f.service.getSnapshot().catalog?.map((model) => model.modelRef)).toEqual(
      LOCAL_MODEL_PRESETS.map((model) => model.modelRef),
    );
    await f.service.getCapabilities();
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(["plugins.list"]);
  });

  it("offers setup for a fresh install without searching for or installing the provider", async () => {
    const f = fixture();
    f.gateway.methods = [...METHODS, "plugins.search"];
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params, timeout) =>
      method === "plugins.list"
        ? { plugins: [], mutationAllowed: true }
        : original(method, params, timeout),
    );

    expect(await f.service.getCapabilities()).toMatchObject({
      supported: true,
      mutable: true,
      blockers: [],
      plugin: { installed: false, enabled: false, canInstall: true },
    });
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(["plugins.list"]);
  });

  it("refuses to confirm a download unless the provider first acknowledged the exact model", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params, timeout) =>
      method === "wizard.next"
        ? {
            done: false,
            step: {
              id: "wrong",
              type: "confirm",
              message: "Download an automatically recommended model?",
            },
          }
        : original(method, params, timeout),
    );
    await f.service.prepare({ authChoice: "llama-cpp", modelRef: PRESET });
    await waitPhase(f, "error");
    expect(f.request.mock.calls.some(([method]) => method === "wizard.cancel")).toBe(true);
    expect(
      f.request.mock.calls.some(
        ([method, params]) => method === "wizard.next" && (params as { answer?: unknown }).answer,
      ),
    ).toBe(false);
  });

  it("rejects any prepared model that differs from the selected preset", async () => {
    const f = fixture();
    const operation = await f.service.prepare({ authChoice: "llama-cpp", modelRef: PRESET });
    await waitPhase(f, "step");
    f.next(() => ({
      done: true,
      status: "done",
      preparedModelRef: LOCAL_MODEL_PRESETS[1].modelRef,
    }));
    await f.service.answer({ operationId: operation.id, stepId: "consent", value: true });
    await waitPhase(f, "error");
    expect(f.service.getOperation()?.error).toContain("exact selected model");
    expect(f.request.mock.calls.some(([method]) => method === "config.patch")).toBe(false);
  });

  it("builds a narrow selection patch that keeps provider, sandbox, auth and per-agent settings untouched", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "cloud/previous", fallbacks: ["cloud/fallback"] },
          models: { "cloud/previous": { alias: "Cloud" } },
        },
        entries: { other: { model: "cloud/override" } },
      },
      models: {
        providers: {
          "llama-cpp": {
            baseUrl: "http://127.0.0.1:8080/v1",
            models: [{ id: "test-model", compat: { supportsTools: true } }],
            localService: { command: "C:\\server.exe" },
          },
        },
      },
      tools: { sandbox: { tools: { deny: ["write"] } } },
      auth: { profiles: { cloud: { provider: "cloud" } } },
    };
    const original = structuredClone(config);
    expect(buildLocalModelSelectionPatch(config, MODEL)).toEqual({
      agents: { defaults: { model: { primary: MODEL }, models: { [MODEL]: {} } } },
    });
    expect(config).toEqual(original);
    expect(() => buildLocalModelSelectionPatch(config, "llama-cpp/unknown")).toThrow(
      "not configured",
    );
    expect(() => buildLocalModelSelectionPatch(config, "cloud/previous")).toThrow("not configured");
  });

  it("does not create a model allowlist or overwrite an existing model entry", () => {
    const base = {
      models: {
        providers: {
          "llama-cpp": {
            baseUrl: "http://localhost:8080/v1",
            models: [{ id: "test-model" }],
          },
        },
      },
      agents: {
        defaults: { models: { [MODEL]: { alias: "Local", params: { thinking: "off" } } } },
      },
    };
    expect(buildLocalModelSelectionPatch(base, MODEL)).toEqual({
      agents: { defaults: { model: { primary: MODEL } } },
    });
    expect(buildLocalModelSelectionPatch({ models: base.models }, MODEL)).toEqual({
      agents: { defaults: { model: { primary: MODEL } } },
    });
  });
  it("skips eager warmup for the effective local default, not an unused local provider", () => {
    expect(hasLocalModelPrimary({ agents: { defaults: { model: MODEL } } })).toBe(true);
    expect(
      hasLocalModelPrimary({
        agents: {
          defaults: { model: "cloud/previous" },
          entries: { assistant: { default: true, model: { primary: MODEL } } },
        },
      }),
    ).toBe(true);
    expect(
      hasLocalModelPrimary({
        agents: { defaults: { model: "cloud/previous" } },
        models: { providers: { "llama-cpp": {} } },
      }),
    ).toBe(false);
  });
  it.each(["2026.9.3", "2026.9.4"])("accepts the supported host %s", (version) => {
    expect(supportsLocalModelVersion(version)).toBe(true);
  });
  it.each([
    "2026.9.3",
    "2026.9.4",
    "2026.10.2",
    "2026.10.2+build.1",
    "2026.10.3",
    "2026.10.3+build.1",
  ])("accepts the verified Gateway release %s", (version) =>
    expect(supportsLocalModelGatewayVersion(version)).toBe(true),
  );
  it.each(["2026.10.1", "2026.10.4", "2026.10.2-beta.1", "2026.10.3-beta.1", null])(
    "does not broaden Gateway compatibility to %s",
    (version) => expect(supportsLocalModelGatewayVersion(version)).toBe(false),
  );
  it("does not treat Gateway support as permission to replace the pinned provider", () => {
    expect(supportsLocalModelVersion("2026.10.2")).toBe(false);
  });
  it.each([null, "2026.9.2", "2026.10.1", "2026.9.3-beta.1", "unknown"])(
    "does not assume compatibility for %s",
    (version) => {
      expect(supportsLocalModelVersion(version)).toBe(false);
    },
  );
  it.each(["http://127.0.0.1:8080", "http://localhost:8080/v1", "http://[::1]:8080"])(
    "accepts explicit loopback %s",
    (url) => expect(validateLocalModelUrl(url)).toContain("http"),
  );
  it.each([
    "http://192.168.0.1",
    "http://server.local",
    "https://example.com",
    "file:///C:/model",
    "http://user:secret@localhost",
  ])("rejects non-loopback or credential-bearing endpoints %s", (url) => {
    expect(() => validateLocalModelUrl(url)).toThrow();
  });
});

describe("local model lifecycle", () => {
  it("projects saved models without RPCs, credentials, weight reads or a connected Gateway", () => {
    const f = fixture();
    f.gateway.connected = false;
    f.config({
      models: {
        providers: {
          "llama-cpp": {
            apiKey: "private-key",
            baseUrl: "http://localhost:8080",
            localService: { env: { SECRET: "private-value" } },
            models: [{ id: "test-model", name: "My saved model" }],
          },
        },
      },
      agents: {
        defaults: { model: "cloud/previous" },
        entries: { main: { model: { primary: MODEL } } },
      },
    });
    expect(f.service.getSnapshot()).toEqual({
      catalog: expect.any(Array),
      models: [{ modelRef: MODEL, name: "My saved model", fileStatus: "unknown" }],
      configuredModel: MODEL,
    });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("coalesces concurrent discovery and reuses its recent result without exposing mutable cached objects", async () => {
    const f = fixture();
    const pending = deferred<unknown>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, params, timeout) =>
      method === "openclaw.setup.detect" ? pending.promise : original(method, params, timeout),
    );
    const first = f.service.detect();
    const second = f.service.detect();
    pending.resolve(f.detection);
    const [one, two] = await Promise.all([first, second]);
    one.candidates.length = 0;
    expect(two.candidates).toHaveLength(1);
    expect((await f.service.detect()).candidates).toHaveLength(1);
    expect(
      f.request.mock.calls.filter(([method]) => method === "openclaw.setup.detect"),
    ).toHaveLength(1);
    expect(f.request.mock.calls.filter(([method]) => method === "agents.list")).toHaveLength(1);
  });

  it("expires and explicitly refreshes discovery without caching failures", async () => {
    const f = fixture();
    vi.useFakeTimers();
    try {
      await f.service.detect();
      await vi.advanceTimersByTimeAsync(LOCAL_MODEL_DETECTION_TTL_MS + 1);
      await f.service.detect();
      const original = f.request.getMockImplementation()!;
      let fail = true;
      f.request.mockImplementation(async (method, params, timeout) => {
        if (method === "openclaw.setup.detect" && fail) {
          fail = false;
          throw new Error("Provider discovery unavailable");
        }
        return original(method, params, timeout);
      });
      await expect(f.service.detect({ refresh: true })).rejects.toThrow("unavailable");
      await f.service.detect();
      expect(
        f.request.mock.calls.filter(([method]) => method === "openclaw.setup.detect"),
      ).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates discovery when configuration, connection generation or host version changes", async () => {
    const f = fixture();
    await f.service.detect();
    f.config({ agents: { defaults: { model: MODEL } } });
    await f.service.detect();
    f.gateway.connectionGeneration = 2;
    await f.service.detect();
    f.gateway.serverVersion = "2026.9.4";
    await f.service.detect();
    expect(
      f.request.mock.calls.filter(([method]) => method === "openclaw.setup.detect"),
    ).toHaveLength(4);
  });

  it("rejects discovery that completed against an outdated configuration", async () => {
    const f = fixture();
    const pending = deferred<unknown>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, params, timeout) =>
      method === "openclaw.setup.detect" ? pending.promise : original(method, params, timeout),
    );
    const detection = f.service.detect();
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([method]) => method === "openclaw.setup.detect")).toBe(
        true,
      ),
    );
    f.config({ agents: { defaults: { model: "cloud/changed" } } });
    pending.resolve(f.detection);
    await expect(detection).rejects.toThrow("changed during discovery");
    await f.service.detect();
    expect(
      f.request.mock.calls.filter(([method]) => method === "openclaw.setup.detect"),
    ).toHaveLength(2);
  });

  it("reuses explicit discovery during prepare, but refreshes after a wizard finishes", async () => {
    const f = fixture();
    await f.service.detect();
    const operation = await f.service.prepare({ authChoice: "llama-cpp" });
    await waitPhase(f, "step");
    expect(
      f.request.mock.calls.filter(([method]) => method === "openclaw.setup.detect"),
    ).toHaveLength(1);
    await f.service.cancel(operation.id);
    await f.service.detect();
    expect(
      f.request.mock.calls.filter(([method]) => method === "openclaw.setup.detect"),
    ).toHaveLength(2);
  });

  it("selects an exact saved model through a revision-guarded patch without any inference or discovery", async () => {
    const f = fixture();
    await f.service.activate({ kind: "existing-model", modelRef: MODEL });
    await waitPhase(f, "ready");
    expect(f.request).toHaveBeenCalledWith(
      "config.patch",
      {
        baseHash: "source-1",
        raw: JSON.stringify({ agents: { defaults: { model: { primary: MODEL } } } }),
      },
      180_000,
    );
    expect(
      f.request.mock.calls.every(([method]) =>
        ["plugins.list", "agents.list", "config.get", "config.patch"].includes(method),
      ),
    ).toBe(true);
    expect(f.service.getOperation()).toMatchObject({
      phase: "ready",
      busy: false,
      modelRef: MODEL,
    });
  });

  it("rejects a managed model deleted after the dialog read its saved configuration", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "microclaw-deleted-selection-"));
    try {
      const file = path.join(root, "model.gguf");
      writeFileSync(file, "GGUF");
      const f = fixture();
      f.config({
        models: {
          providers: {
            "llama-cpp": {
              baseUrl: "http://localhost:8080/v1",
              localService: { command: "llama-server.exe" },
              models: [{ id: "test-model", params: { modelPath: file } }],
            },
          },
        },
      });
      expect(f.service.getSnapshot().models[0].fileStatus).toBe("present");
      unlinkSync(file);
      expect(f.service.getSnapshot().models[0].fileStatus).toBe("missing");
      await expect(f.service.activate({ kind: "existing-model", modelRef: MODEL })).rejects.toThrow(
        "files are missing",
      );
      expect(f.request.mock.calls.some(([method]) => method === "config.patch")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not use cached discovery or a saved model to bypass fresh mutation policy", async () => {
    const f = fixture();
    await f.service.detect();
    f.assertMutable.mockImplementation(() => {
      throw new Error("Configuration is locked");
    });
    await expect(f.service.prepare({ authChoice: "llama-cpp" })).rejects.toThrow("locked");
    await expect(f.service.activate({ kind: "existing-model", modelRef: MODEL })).rejects.toThrow(
      "locked",
    );
    expect(f.request.mock.calls.some(([method]) => method.endsWith(".start"))).toBe(false);
  });

  it("never activates an unknown saved model without validating its exact configuration", async () => {
    const f = fixture();
    await expect(
      f.service.activate({ kind: "existing-model", modelRef: "llama-cpp/missing" }),
    ).rejects.toThrow("not configured");
    expect(f.request.mock.calls.some(([method]) => method.endsWith(".start"))).toBe(false);
  });

  it("does not block existing chats while preparing a model, but still protects config writes", async () => {
    const f = fixture();
    const operation = await f.service.prepare({ authChoice: "llama-cpp" });
    await waitPhase(f, "step");
    expect(() => f.service.assertChatAllowed()).not.toThrow();
    expect(() => f.service.assertIdle()).toThrow("active");
    await f.service.cancel(operation.id);
  });

  it("blocks new chats during model activation", async () => {
    const f = fixture();
    const commit = deferred<void>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params, timeout) => {
      if (method === "config.patch") await commit.promise;
      return original(method, params, timeout);
    });
    await f.service.activate({
      kind: "provider-auto:llama-cpp",
      modelRef: MODEL,
    });
    await waitPhase(f, "applying");
    expect(() => f.service.assertChatAllowed()).toThrow("being applied");
    commit.resolve();
    await waitPhase(f, "ready");
  });

  it("releases an expired setup lock without claiming rollback or changing the saved model", async () => {
    const f = fixture({
      id: "expired",
      kind: "prepare",
      agentId: "main",
      gatewayIdentity: "test-gateway",
    });
    f.request.mockRejectedValueOnce(
      new GatewayRequestError("wizard not found", "INVALID_REQUEST", { code: "WIZARD_NOT_FOUND" }),
    );
    const result = await f.service.cancel("expired");
    expect(result.busy).toBe(false);
    expect(result.phase).toBe("error");
    expect(result.error).toContain("not rolled back");
    expect(f.receipt()).toBeUndefined();
    expect(() => f.service.assertIdle()).not.toThrow();
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      "wizard.cancel",
      { sessionId: "expired" },
      undefined,
    );
  });

  it("permits recovery and cancellation of an owned receipt after configuration becomes locked", async () => {
    const f = fixture({
      id: "owned",
      kind: "prepare",
      authChoice: "llama-cpp",
      agentId: "main",
      gatewayIdentity: "test-gateway",
    });
    f.assertMutable.mockImplementation(() => {
      throw new Error("Configuration is locked");
    });
    await f.service.resume();
    await waitPhase(f, "step");
    await expect(
      f.service.answer({ operationId: "owned", stepId: "consent", value: true }),
    ).rejects.toThrow("locked");
    await f.service.cancel("owned");
    expect(f.service.getOperation()?.phase).toBe("cancelled");
  });

  it("reads capabilities without discovery, downloads or selection", async () => {
    const f = fixture();
    await f.service.getCapabilities();
    expect(f.request.mock.calls.some(([method]) => method === "models.list")).toBe(false);
    expect(f.request.mock.calls.some(([method]) => method.endsWith(".start"))).toBe(false);
  });

  it("blocks unsupported methods, versions and MXC without mutation", async () => {
    const f = fixture();
    f.gateway.methods = METHODS.filter((method) => method !== "wizard.cancel");
    expect((await f.service.getCapabilities()).supported).toBe(false);
    await expect(f.service.prepare({ authChoice: "llama-cpp" })).rejects.toThrow("missing");
    f.gateway.methods = METHODS;
    f.assertMutable.mockImplementation(() => {
      throw new Error("MXC is locked");
    });
    expect((await f.service.getCapabilities()).mutable).toBe(false);
    await expect(f.service.prepare({ authChoice: "llama-cpp" })).rejects.toThrow("MXC");
    expect(f.request.mock.calls.some(([method]) => method.endsWith(".start"))).toBe(false);
  });

  it("requires explicit installation and exact capability-review consent", async () => {
    const f = fixture();
    f.plugin({ installed: false, enabled: false });
    await expect(f.service.installProvider({ confirmed: false })).rejects.toThrow("consent");
    const review = await f.service.inspectProvider();
    await expect(
      f.service.installProvider({ confirmed: true, reviewToken: "stale" }),
    ).rejects.toThrow("review");
    await f.service.installProvider({ confirmed: true, reviewToken: review.reviewToken });
    expect(f.request).toHaveBeenCalledWith(
      "plugins.install",
      {
        source: "official",
        pluginId: "llama-cpp",
        acknowledgeCapabilities: { reviewToken: "review-1" },
      },
      300_000,
    );
    expect(f.restartGateway).toHaveBeenCalledOnce();
  });

  it("uses a fixed release only after verifying the official ClawHub identity", async () => {
    const f = fixture();
    f.gateway.methods = [...METHODS, "plugins.search"];
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params, timeout) => {
      if (method === "plugins.list") return { plugins: [], mutationAllowed: true };
      if (method === "plugins.search")
        return {
          results: [
            {
              package: {
                name: "@openclaw/llama-cpp-provider",
                runtimeId: "llama-cpp",
                isOfficial: true,
                channel: "official",
                family: "code-plugin",
              },
            },
          ],
        };
      return original(method, params, timeout);
    });
    const review = await f.service.inspectProvider();
    expect(review.version).toBe("2026.9.3");
    expect(review.capabilities).toEqual({});
    await f.service.installProvider({ confirmed: true });
    expect(f.request).toHaveBeenCalledWith(
      "plugins.install",
      {
        source: "clawhub",
        packageName: "@openclaw/llama-cpp-provider",
        version: "2026.9.3",
      },
      300_000,
    );
  });

  it("requires a fresh review rather than silently acknowledging new capabilities", async () => {
    const f = fixture();
    f.plugin({ installed: false, enabled: false });
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params, timeout) => {
      if (method === "plugins.install")
        throw new GatewayRequestError("Review needed", "UNAVAILABLE", {
          capabilityConsentCode: "PLUGIN_CAPABILITY_CONSENT_REQUIRED",
          pluginId: "llama-cpp",
          reviewToken: "staged-token",
          widened: { providers: ["llama-cpp"] },
        });
      return original(method, params, timeout);
    });
    await expect(f.service.installProvider({ confirmed: true })).rejects.toThrow("review");
    expect(f.request.mock.calls.filter(([method]) => method === "plugins.install")).toHaveLength(1);
    expect((await f.service.inspectProvider()).reviewToken).toBe("staged-token");
    expect(f.restartGateway).not.toHaveBeenCalled();
  });

  it("rejects a community package pretending to provide the official runtime", async () => {
    const f = fixture();
    f.gateway.methods = [...METHODS, "plugins.search"];
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params, timeout) => {
      if (method === "plugins.list") return { plugins: [], mutationAllowed: true };
      if (method === "plugins.search")
        return {
          results: [
            {
              package: {
                name: "@openclaw/llama-cpp-provider",
                runtimeId: "llama-cpp",
                isOfficial: false,
                channel: "community",
                family: "code-plugin",
              },
            },
          ],
        };
      return original(method, params, timeout);
    });
    expect((await f.service.getCapabilities(true)).plugin.canInstall).toBe(false);
    await expect(f.service.installProvider({ confirmed: true })).rejects.toThrow("official");
    expect(f.restartGateway).not.toHaveBeenCalled();
  });

  it("keeps prepare separate from activation and never auto-confirms download", async () => {
    const f = fixture();
    const operation = await f.service.prepare({ authChoice: "llama-cpp" });
    await waitPhase(f, "step");
    expect(f.service.getOperation()?.step?.initialValue).toBe(false);
    expect(f.request.mock.calls.some(([method]) => method.includes("activate"))).toBe(false);
    const start = f.request.mock.calls.find(
      ([method]) => method === "openclaw.setup.prepare.start",
    );
    expect(start?.[1]).toEqual({
      sessionId: operation.id,
      authChoice: "llama-cpp",
      agentId: "main",
    });
    await expect(
      f.service.answer({ operationId: operation.id, stepId: "consent", value: "true" }),
    ).rejects.toThrow("confirmation");
    f.next(() => ({ done: true, status: "done", preparedModelRef: PRESET }));
    await f.service.answer({ operationId: operation.id, stepId: "consent", value: true });
    await waitPhase(f, "prepared");
    expect(f.service.getOperation()?.preparedModelRef).toBe(PRESET);
    expect(f.receipt()).toBeUndefined();
    expect(f.restartGateway).not.toHaveBeenCalled();
  });

  it("does not start duplicate operations or accept stale answers", async () => {
    const f = fixture();
    const first = f.service.prepare({ authChoice: "llama-cpp" });
    await expect(f.service.prepare({ authChoice: "llama-cpp" })).rejects.toThrow("active");
    const operation = await first;
    await waitPhase(f, "step");
    await expect(
      f.service.answer({ operationId: operation.id, stepId: "old", value: true }),
    ).rejects.toThrow("no longer");
    await f.service.cancel(operation.id);
  });

  it("drives gateway progress without an answer", async () => {
    const f = fixture();
    let count = 0;
    f.next(() =>
      ++count === 1
        ? {
            done: false,
            step: { id: "download", type: "progress", executor: "gateway", message: "Preparing" },
          }
        : { done: true, status: "done", preparedModelRef: PRESET },
    );
    await f.service.prepare({ authChoice: "llama-cpp" });
    await waitPhase(f, "prepared");
    expect(f.events.some((event) => event.step?.id === "download")).toBe(true);
    expect(
      f.request.mock.calls
        .filter(
          ([method, params]) =>
            method === "wizard.next" &&
            (params as { answer?: { stepId: string } }).answer?.stepId !== "exact-model",
        )
        .every(([, params]) => !Object.hasOwn(params as object, "answer")),
    ).toBe(true);
  });

  it("waits for a required restart and the applied configuration revision, never running an AI test", async () => {
    const f = fixture();
    const apply = deferred<void>();
    f.restartGateway.mockReturnValueOnce(apply.promise);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params, timeout) => {
      const result = await original(method, params, timeout);
      return method === "config.patch"
        ? { ...(result as object), sentinel: { payload: { stats: { requiresRestart: true } } } }
        : result;
    });
    await f.service.activate({ kind: "provider-auto:llama-cpp", modelRef: MODEL });
    await waitPhase(f, "applying");
    expect(f.service.busy).toBe(true);
    apply.resolve();
    await waitPhase(f, "ready");
    expect(f.restartGateway).toHaveBeenCalledOnce();
    expect(f.request.mock.calls.some(([method]) => method.startsWith("openclaw.setup."))).toBe(
      false,
    );
    expect(f.receipt()).toBeUndefined();
  });

  it("waits for configuration application using only read-only config queries", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const original = f.request.getMockImplementation()!;
      let reads = 0;
      f.request.mockImplementation(async (method, params, timeout) => {
        const result = await original(method, params, timeout);
        return method === "config.get" && ++reads === 2
          ? { ...(result as object), appliedConfigHash: "previous-revision" }
          : result;
      });
      await f.service.activate({ kind: "existing-model", modelRef: MODEL });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.service.getOperation()?.phase).toBe("applying");
      expect(f.service.getOperation()?.error).toBeUndefined();
      await vi.advanceTimersByTimeAsync(500);
      expect(f.service.getOperation()?.phase).toBe("ready");
      expect(f.request.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(3);
      expect(f.request.mock.calls.filter(([method]) => method === "config.patch")).toHaveLength(1);
      expect(f.restartGateway).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains a resumable receipt when application stays pending beyond its bounded wait", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const original = f.request.getMockImplementation()!;
      let applying = true;
      f.request.mockImplementation(async (method, params, timeout) => {
        const result = await original(method, params, timeout);
        return method === "config.get" && applying
          ? { ...(result as object), appliedConfigHash: "previous-revision" }
          : result;
      });
      const operation = await f.service.activate({ kind: "existing-model", modelRef: MODEL });
      await vi.advanceTimersByTimeAsync(LOCAL_MODEL_APPLY_SETTLE_TIMEOUT_MS + 1);
      expect(f.service.getOperation()).toMatchObject({ phase: "interrupted", busy: true });
      expect(f.receipt()?.id).toBe(operation.id);
      applying = false;
      await f.service.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.service.getOperation()?.phase).toBe("ready");
      expect(f.request.mock.calls.filter(([method]) => method === "config.patch")).toHaveLength(1);
      expect(f.receipt()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not report success if the applied configuration selects a different model", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    let reads = 0;
    f.request.mockImplementation(async (method, params, timeout) => {
      const result = await original(method, params, timeout);
      return method === "config.get" && ++reads > 1
        ? { ...(result as object), config: { agents: { defaults: { model: "cloud/other" } } } }
        : result;
    });
    await f.service.activate({ kind: "existing-model", modelRef: MODEL });
    await waitPhase(f, "error");
    expect(f.request.mock.calls.filter(([method]) => method === "config.patch")).toHaveLength(1);
    expect(f.service.getOperation()?.error).toContain("selection changed");
  });

  it("rejects a mismatched config write receipt rather than claiming selection succeeded", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, params, timeout) =>
      method === "config.patch"
        ? Promise.resolve({
            ok: true,
            config: { agents: { defaults: { model: "cloud/unexpected" } } },
          })
        : original(method, params, timeout),
    );
    await f.service.activate({ kind: "provider-auto:llama-cpp", modelRef: MODEL });
    await waitPhase(f, "error");
    expect(f.service.getOperation()?.error).toContain("does not match");
    expect(f.restartGateway).not.toHaveBeenCalled();
  });

  it("preserves the previous default when the Gateway rejects a stale configuration revision", async () => {
    const f = fixture();
    const before = structuredClone(f.readConfig());
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, params, timeout) => {
      if (method === "config.patch")
        throw new GatewayRequestError("config changed since last load", "INVALID_REQUEST");
      return original(method, params, timeout);
    });
    await f.service.activate({ kind: "provider-auto:llama-cpp", modelRef: MODEL });
    await waitPhase(f, "error");
    expect(f.readConfig()).toEqual(before);
    expect(f.service.getOperation()?.error).toContain("changed since last load");
    expect(f.request.mock.calls.filter(([method]) => method === "config.patch")).toHaveLength(1);
  });

  it("recovers a lost write reply by reading applied configuration, without repeating the write", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params, timeout) => {
      const result = await original(method, params, timeout);
      if (method === "config.patch") throw new Error("disconnected after config commit");
      return result;
    });
    await f.service.activate({ kind: "existing-model", modelRef: MODEL });
    await waitPhase(f, "interrupted");
    expect(f.receipt()?.configSelection).toBe(true);
    await f.service.resume();
    await waitPhase(f, "ready");
    expect(f.request.mock.calls.filter(([method]) => method === "config.patch")).toHaveLength(1);
    expect(
      f.request.mock.calls.some(
        ([method]) => method.startsWith("wizard.") || method.startsWith("openclaw.setup."),
      ),
    ).toBe(false);
  });

  it("does not cancel a config write as though it were a setup wizard", async () => {
    const f = fixture();
    const write = deferred<void>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params, timeout) => {
      if (method === "config.patch") await write.promise;
      return original(method, params, timeout);
    });
    const operation = await f.service.activate({ kind: "existing-model", modelRef: MODEL });
    await waitPhase(f, "applying");
    const cancellation = await f.service.cancel(operation.id);
    expect(cancellation.busy).toBe(true);
    expect(f.request.mock.calls.some(([method]) => method === "wizard.cancel")).toBe(false);
    write.resolve();
    await waitPhase(f, "ready");
    expect(f.service.getOperation()?.error).toBeUndefined();
  });

  it("allows the user to stop waiting on an interrupted selection without claiming rollback", async () => {
    const f = fixture({
      id: "selection",
      kind: "activate",
      configSelection: true,
      agentId: "main",
      modelRef: MODEL,
      gatewayIdentity: "test-gateway",
    });
    const result = await f.service.cancel("selection");
    expect(result).toMatchObject({ busy: false, phase: "cancelled" });
    expect(result.error).toContain("not rolled back");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.receipt()).toBeUndefined();
  });

  it("does not pretend a protected operation was cancelled", async () => {
    const f = fixture();
    const operation = await f.service.prepare({ authChoice: "llama-cpp" });
    await waitPhase(f, "step");
    f.request.mockImplementationOnce(async (method) => {
      expect(method).toBe("wizard.cancel");
      return { status: "running" };
    });
    const state = await f.service.cancel(operation.id);
    expect(state.busy).toBe(true);
    expect(state.cancellationPending).toBe(true);
    expect(state.phase).not.toBe("cancelled");
    expect(f.receipt()).toBeDefined();
    await f.service.cancel(operation.id);
    expect(f.receipt()).toBeUndefined();
  });

  it("validates external endpoint before collecting a key and redacts sensitive responses", async () => {
    const f = fixture();
    f.next(() => ({
      done: false,
      step: { id: "url", type: "text", initialValue: "http://localhost:8080" },
    }));
    const operation = await f.service.prepare({ authChoice: "llama-cpp-existing-server" });
    await waitPhase(f, "step");
    await expect(
      f.service.answer({ operationId: operation.id, stepId: "url", value: "http://10.0.0.1" }),
    ).rejects.toThrow("loopback");
    f.next(() => ({
      done: false,
      step: { id: "key", type: "text", sensitive: true, initialValue: "never-expose" },
    }));
    await f.service.answer({
      operationId: operation.id,
      stepId: "url",
      value: "http://localhost:8080",
    });
    await waitPhase(f, "step");
    expect(f.service.getOperation()?.step?.initialValue).toBeUndefined();
    f.next(() => ({ done: true, status: "error", error: "Rejected secret-123" }));
    await f.service.answer({ operationId: operation.id, stepId: "key", value: "secret-123" });
    await waitPhase(f, "error");
    expect(JSON.stringify(f.events)).not.toContain("secret-123");
    expect(JSON.stringify(f.events)).not.toContain("never-expose");
  });

  it("recovers a disconnected operation without repeating start or last answer", async () => {
    const f = fixture();
    const operation = await f.service.prepare({ authChoice: "llama-cpp" });
    await waitPhase(f, "step");
    f.next(() => {
      throw new Error("disconnected");
    });
    await f.service.answer({ operationId: operation.id, stepId: "consent", value: true });
    await waitPhase(f, "interrupted");
    expect(f.receipt()?.id).toBe(operation.id);
    f.next(() => ({ done: true, status: "done", preparedModelRef: PRESET }));
    await f.service.resume();
    await waitPhase(f, "prepared");
    const calls = f.request.mock.calls;
    expect(calls.filter(([method]) => method === "openclaw.setup.prepare.start")).toHaveLength(1);
    expect(
      calls.filter(
        ([method, params]) =>
          method === "wizard.next" &&
          (params as { answer?: { stepId: string } }).answer?.stepId === "consent",
      ),
    ).toHaveLength(1);
  });

  it("resumes by the retained session ID when a start reply is delayed", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const start = deferred<unknown>();
      const original = f.request.getMockImplementation()!;
      f.request.mockImplementation((method, params, timeout) =>
        method === "openclaw.setup.prepare.start"
          ? start.promise
          : original(method, params, timeout),
      );
      const operation = await f.service.prepare({ authChoice: "llama-cpp" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.service.getOperation()?.phase).toBe("interrupted");
      await f.service.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.service.getOperation()?.step?.id).toBe("consent");
      start.resolve({ done: false, status: "running" });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.service.getOperation()?.step?.id).toBe("consent");
      expect(
        f.request.mock.calls.filter(([method]) => method.endsWith("prepare.start")),
      ).toHaveLength(1);
      await f.service.cancel(operation.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores only a non-secret receipt and reconciles an expired activation", async () => {
    const receipt: LocalModelReceipt = {
      id: "retained",
      kind: "activate",
      agentId: "main",
      gatewayIdentity: "test-gateway",
      modelRef: MODEL,
    };
    const f = fixture(receipt);
    f.config({ agents: { defaults: { model: { primary: MODEL } } } });
    f.next(() => {
      throw new GatewayRequestError("wizard not found", "INVALID_REQUEST", {
        code: "WIZARD_NOT_FOUND",
      });
    });
    await f.service.resume();
    await waitPhase(f, "ready");
    expect(f.request.mock.calls.some(([method]) => method.endsWith(".start"))).toBe(false);
    expect(f.request.mock.calls.some(([method]) => method === "openclaw.setup.detect")).toBe(false);
  });
});
