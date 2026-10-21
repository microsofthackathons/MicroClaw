import { beforeEach, describe, expect, it, vi } from "vitest";
import { inspectLocalModelFiles } from "./local-model-files";
import { GatewayRequestError } from "./gateway-client";
import {
  SessionModelService,
  sessionModelChatKey,
  type SessionModelRuntime,
} from "./session-model-service";

vi.mock("./local-model-files", () => ({ inspectLocalModelFiles: vi.fn(() => new Map()) }));

type Row = Record<string, unknown>;
function fixture(githubCopilotEnabled = true) {
  const config: Row = {
    agents: {
      defaults: { model: { primary: "cloud/a", fallbacks: ["cloud/b"] } },
      list: [
        { id: "main", default: true },
        { id: "writer", model: { primary: "cloud/b" } },
      ],
    },
    models: {
      providers: {
        cloud: {
          apiKey: "fixture-credential",
          models: [{ id: "a" }, { id: "b" }, { id: "path/model" }],
        },
        "llama-cpp": { baseUrl: "http://127.0.0.1:8080/v1", models: [{ id: "local" }] },
      },
    },
    unrelated: { keep: true },
  };
  const sessions = new Map<string, Row>();
  const canonical = (key: string) =>
    key.toLowerCase().startsWith("agent:") ? key.toLowerCase() : `agent:main:${key.toLowerCase()}`;
  const inherited = (key: string) => {
    const agents = config.agents as Row;
    const agent = (agents.list as Row[]).find((entry) => entry.id === key.split(":")[1]);
    const model = (agent?.model ?? (agents.defaults as Row).model) as Row;
    return String(model.primary);
  };
  const modelFields = (ref: string) => ({
    modelProvider: ref.slice(0, ref.indexOf("/")),
    model: ref.slice(ref.indexOf("/") + 1),
  });
  let hash = "one";
  let authenticated = true;
  let catalog: Row[] = [{ provider: "github-copilot", id: "gpt-5", available: true }];
  const handle = async (method: string, params: Row = {}): Promise<unknown> => {
    const key = canonical(String(params.key ?? ""));
    if (method === "config.get") return { valid: true, hash, config: structuredClone(config) };
    if (method === "sessions.describe") return { session: sessions.get(key) ?? null };
    if (method === "sessions.list") {
      return { defaults: modelFields(inherited(`agent:${params.agentId}:main`)), sessions: [] };
    }
    if (method === "models.authStatus")
      return {
        providers: [{ provider: "github-copilot", status: authenticated ? "ok" : "missing" }],
      };
    if (method === "models.list") return { models: catalog };
    if (method === "sessions.patch") {
      const selected = params.model === null ? inherited(key) : String(params.model);
      const overridden = selected !== inherited(key);
      const old = sessions.get(key) ?? {};
      sessions.set(key, {
        ...old,
        key,
        agentId: key.split(":")[1],
        ...modelFields(selected),
        modelOverrideSource: overridden ? "user" : null,
        sessionId: old.sessionId ?? "fixture-session",
        lifecycleRevision: old.lifecycleRevision ?? "revision",
      });
      return {
        ok: true,
        key,
        entry: overridden
          ? {
              modelOverride: modelFields(selected).model,
              providerOverride: modelFields(selected).modelProvider,
            }
          : {},
        resolved: modelFields(selected),
      };
    }
    throw new Error(`Unexpected RPC: ${method}`);
  };
  const request = vi.fn(handle);
  const gateway = {
    connected: true,
    connectionGeneration: 1,
    serverVersion: "2026.9.3",
    mainSessionKey: "agent:main:main",
    methods: [
      "config.get",
      "sessions.describe",
      "sessions.list",
      "sessions.patch",
      "models.list",
      "models.authStatus",
    ],
    request: request as <T>(method: string, params?: unknown) => Promise<T>,
  };
  let current: typeof gateway | null = gateway;
  const assertMutable = vi.fn();
  let processNumber = 1;
  let stopped = { value: false };
  const runtime = (generation: string, identity = "fixture-profile"): SessionModelRuntime => {
    const captured = stopped;
    return { identity, generation, isStopped: () => captured.value };
  };
  let currentRuntime: SessionModelRuntime | null = runtime("process-1");
  const replaceRuntime = (stopPrevious = true, identity = "fixture-profile") => {
    if (stopPrevious) stopped.value = true;
    stopped = { value: false };
    currentRuntime = runtime(`process-${++processNumber}`, identity);
    gateway.connectionGeneration++;
  };
  const restartGateway = vi.fn(async () => {
    replaceRuntime();
  });
  const onRecoveryChanged = vi.fn();
  const service = new SessionModelService({
    githubCopilotEnabled,
    gateway: () => current,
    readConfig: () => config,
    assertMutable,
    runtime: () => currentRuntime,
    restartGateway,
    onRecoveryChanged,
  });
  return {
    service,
    gateway,
    request,
    handle,
    config,
    sessions,
    assertMutable,
    restartGateway,
    onRecoveryChanged,
    replaceRuntime,
    setRuntime: (value: SessionModelRuntime | null) => {
      currentRuntime = value;
    },
    setGateway: (next: typeof gateway | null) => {
      current = next;
    },
    setHash: (next: string) => {
      hash = next;
    },
    setAuth: (next: boolean) => {
      authenticated = next;
    },
    setCatalog: (next: Row[]) => {
      catalog = next;
    },
    patches: () => request.mock.calls.filter(([method]) => method === "sessions.patch"),
  };
}

beforeEach(() => vi.mocked(inspectLocalModelFiles).mockReset().mockReturnValue(new Map()));

describe("disabled GitHub Copilot session models", () => {
  it("rejects direct selection before making any Gateway request", async () => {
    const f = fixture(false);
    await expect(
      f.service.select({ sessionKey: "chat", modelRef: "github-copilot/gpt-5" }),
    ).rejects.toThrow("GitHub Copilot is disabled");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("refuses resetting an override to a disabled inherited model without patching the session", async () => {
    const f = fixture(false);
    const agents = f.config.agents as Row;
    (agents.defaults as Row).model = { primary: "github-copilot/gpt-5" };
    await expect(f.service.select({ sessionKey: "chat", modelRef: null })).rejects.toThrow(
      "GitHub Copilot is disabled",
    );
    expect(f.patches()).toEqual([]);
  });
});

describe("session model reads", () => {
  it("uses the same canonical identity for send/terminal-event chat guards", () => {
    const f = fixture();
    expect(sessionModelChatKey(f.config, "main")).toBe(
      sessionModelChatKey(f.config, "agent:main:main"),
    );
    expect(sessionModelChatKey(f.config, "CHAT")).toBe(
      sessionModelChatKey(f.config, "agent:main:chat"),
    );
    expect(sessionModelChatKey(f.config, "agent:writer:signal:group:Case")).toBe(
      "agent:writer:signal:group:Case",
    );
    expect(sessionModelChatKey(f.config, "agent:removed:chat")).toBe("agent:removed:chat");
  });
  it.each([
    ["main", "agent:main:main", "cloud/a"],
    [" New-Chat ", "agent:main:new-chat", "cloud/a"],
    ["AGENT:WRITER:Draft", "agent:writer:draft", "cloud/b"],
    [
      "agent:writer:matrix:group:!Case:Server:thread:Token",
      "agent:writer:matrix:group:!Case:Server:thread:Token",
      "cloud/b",
    ],
    [
      "agent:writer:signal:group:Case:thread:ABC",
      "agent:writer:signal:group:Case:thread:abc",
      "cloud/b",
    ],
  ])("inherits for missing %s without creating metadata", async (key, canonical, ref) => {
    const f = fixture();
    await expect(f.service.get(key)).resolves.toEqual({
      sessionKey: canonical,
      modelRef: ref,
      overridden: false,
    });
    expect(f.patches()).toHaveLength(0);
    expect(f.sessions.size).toBe(0);
    expect(
      f.request.mock.calls.every(([method]) =>
        ["sessions.describe", "sessions.list", "config.get"].includes(method),
      ),
    ).toBe(true);
  });

  it("uses official selected model rather than a runtime fallback and does not scan configuration", async () => {
    const f = fixture();
    f.sessions.set("agent:main:chat", {
      key: "agent:main:chat",
      agentId: "main",
      model: "b",
      modelProvider: "cloud",
      modelOverrideSource: "user",
      activeModel: "a",
      activeModelProvider: "cloud",
    });
    await expect(f.service.get("chat")).resolves.toEqual({
      sessionKey: "agent:main:chat",
      modelRef: "cloud/b",
      overridden: true,
    });
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(["sessions.describe"]);
  });

  it("supports custom main aliases and the legacy main owner", async () => {
    const f = fixture();
    f.config.session = { mainKey: "Home" };
    (f.config.agents as Row).list = [{ id: "writer", model: { primary: "cloud/b" } }];
    f.gateway.mainSessionKey = "agent:writer:home";
    await expect(f.service.get("agent:main:main")).resolves.toMatchObject({
      sessionKey: "agent:writer:home",
      modelRef: "cloud/b",
    });
  });

  it("rejects invalid and unknown-agent keys", async () => {
    const f = fixture();
    for (const key of ["", "a\nb", "unknown", "agent:main:", "agent:../bad:x", null]) {
      await expect(f.service.get(key)).rejects.toThrow(/Invalid/);
    }
    await expect(f.service.get("agent:missing:chat")).rejects.toThrow(/configured agent/);
  });
});

describe("session model selection", () => {
  it("rejects realtime selection before any session mutation or provider request", async () => {
    const f = fixture();
    await expect(
      f.service.select({
        sessionKey: "agent:main:main",
        modelRef: "qwen/qwen3.8-omni-flash-realtime",
      }),
    ).rejects.toThrow("UNSUPPORTED_CHAT_MODEL");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.restartGateway).not.toHaveBeenCalled();
    expect(f.sessions.size).toBe(0);
  });

  it.each(["2026.9.3", "2026.10.2", "2026.10.3"])(
    "selects a configured cloud model on %s with only an official metadata patch",
    async (version) => {
      const f = fixture();
      f.gateway.serverVersion = version;
      const config = structuredClone(f.config);
      await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/b" })).resolves.toEqual({
        sessionKey: "agent:main:chat",
        modelRef: "cloud/b",
        overridden: true,
      });
      expect(f.patches()[0][1]).toEqual({
        key: "agent:main:chat",
        agentId: "main",
        model: "cloud/b",
      });
      expect(f.config).toEqual(config);
      expect(
        f.request.mock.calls.every(([method]) =>
          ["sessions.describe", "sessions.list", "sessions.patch", "config.get"].includes(method),
        ),
      ).toBe(true);
    },
  );

  it("clears only the session override and restores the agent default", async () => {
    const f = fixture();
    await f.service.select({ sessionKey: "agent:writer:chat", modelRef: "cloud/a" });
    f.request.mockClear();
    await expect(
      f.service.select({ sessionKey: "agent:writer:chat", modelRef: null }),
    ).resolves.toEqual({
      sessionKey: "agent:writer:chat",
      modelRef: "cloud/b",
      overridden: false,
    });
    expect(f.patches()[0][1]).toEqual({
      key: "agent:writer:chat",
      agentId: "writer",
      model: null,
      expectedSessionId: "fixture-session",
      expectedLifecycleRevision: "revision",
    });
  });

  it("reports upstream default-selection normalization honestly", async () => {
    const f = fixture();
    await expect(
      f.service.select({ sessionKey: "chat", modelRef: "cloud/a" }),
    ).resolves.toMatchObject({ modelRef: "cloud/a", overridden: false });
  });

  it("clears to the existing default without expanding a restrictive allowlist", async () => {
    const f = fixture();
    ((f.config.agents as Row).defaults as Row).modelPolicy = { allow: ["cloud/b"] };
    await f.service.select({ sessionKey: "chat", modelRef: "cloud/b" });
    const config = structuredClone(f.config);
    await expect(f.service.select({ sessionKey: "chat", modelRef: null })).resolves.toMatchObject({
      modelRef: "cloud/a",
      overridden: false,
    });
    expect(f.config).toEqual(config);
  });

  it.each(["present", "external", "unknown"] as const)(
    "selects local files with %s status without endpoint requests",
    async (status) => {
      const f = fixture();
      vi.mocked(inspectLocalModelFiles).mockReturnValue(new Map([["local", status]]));
      await expect(
        f.service.select({ sessionKey: "chat", modelRef: "llama-cpp/local" }),
      ).resolves.toMatchObject({ modelRef: "llama-cpp/local" });
      expect(inspectLocalModelFiles).toHaveBeenCalledTimes(2);
    },
  );

  it("rechecks local files immediately before patching", async () => {
    const f = fixture();
    vi.mocked(inspectLocalModelFiles)
      .mockReturnValueOnce(new Map([["local", "present"]]))
      .mockReturnValueOnce(new Map([["local", "missing"]]));
    await expect(
      f.service.select({ sessionKey: "chat", modelRef: "llama-cpp/local" }),
    ).rejects.toThrow(/files are missing/);
    expect(f.patches()).toHaveLength(0);
  });

  it("checks inherited local files when clearing, not the old overridden model", async () => {
    const f = fixture();
    ((f.config.agents as Row).defaults as Row).model = { primary: "llama-cpp/local" };
    await f.service.select({ sessionKey: "chat", modelRef: "cloud/b" });
    f.request.mockClear();
    vi.mocked(inspectLocalModelFiles).mockReturnValue(new Map([["local", "missing"]]));
    await expect(f.service.select({ sessionKey: "chat", modelRef: null })).rejects.toThrow(
      /files are missing/,
    );
    expect(f.patches()).toHaveLength(0);
  });

  it.each([
    "https://example.com/v1",
    "file:///model",
    "http://user:secret@localhost/v1",
    "http://127.0.0.1.evil/v1",
  ])("rejects unsafe local URL %s", async (baseUrl) => {
    const f = fixture();
    ((f.config.models as Row).providers as Record<string, Row>)["llama-cpp"].baseUrl = baseUrl;
    await expect(
      f.service.select({ sessionKey: "chat", modelRef: "llama-cpp/local" }),
    ).rejects.toThrow();
    expect(f.patches()).toHaveLength(0);
  });

  it.each([
    "cloud/unknown",
    "unknown/a",
    "cloud",
    "cloud/*",
    "cloud/a@other-profile",
    "cloud/a\nb",
  ])("rejects invalid/unconfigured %s", async (modelRef) => {
    const f = fixture();
    await expect(f.service.select({ sessionKey: "chat", modelRef })).rejects.toThrow();
    expect(f.patches()).toHaveLength(0);
  });

  it("rejects extra mutation fields", async () => {
    const f = fixture();
    await expect(
      f.service.select({ sessionKey: "chat", modelRef: "cloud/b", provider: {} }),
    ).rejects.toThrow(/Invalid/);
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(["agent", "defaults"])(
    "blocks sticky %s scope instead of changing defaults",
    async (scope) => {
      const f = fixture();
      ((f.config.agents as Row).defaults as Row).modelSelectionScope = scope;
      await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/b" })).rejects.toThrow(
        /modelSelectionScope/,
      );
      expect(f.patches()).toHaveLength(0);
    },
  );

  it.each(["legacy", "default-policy", "agent-policy"])(
    "honors restrictive %s allowlists",
    async (kind) => {
      const f = fixture();
      const defaults = (f.config.agents as Row).defaults as Row;
      if (kind === "legacy") defaults.models = { "cloud/a": {} };
      if (kind === "default-policy") defaults.modelPolicy = { allow: ["cloud/a"] };
      if (kind === "agent-policy")
        ((f.config.agents as Row).list as Row[])[0].modelPolicy = { allow: ["cloud/a"] };
      await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/b" })).rejects.toThrow(
        /allowlist/,
      );
      expect(f.patches()).toHaveLength(0);
    },
  );

  it.each(["legacy", "default-policy", "agent-policy"])(
    "keeps the effective primary implicitly allowed by exact-only %s restrictions",
    async (kind) => {
      const f = fixture();
      const defaults = (f.config.agents as Row).defaults as Row;
      const agents = (f.config.agents as Row).list as Row[];
      if (kind === "legacy") defaults.models = { "github-copilot/gpt-5": {} };
      if (kind === "default-policy") defaults.modelPolicy = { allow: ["github-copilot/gpt-5"] };
      if (kind === "agent-policy")
        agents.forEach((agent) => {
          agent.modelPolicy = { allow: ["github-copilot/gpt-5"] };
        });
      const config = structuredClone(f.config);
      await expect(
        f.service.select({ sessionKey: "chat", modelRef: "cloud/a" }),
      ).resolves.toMatchObject({
        modelRef: "cloud/a",
        overridden: false,
      });
      await expect(
        f.service.select({ sessionKey: "agent:writer:chat", modelRef: "cloud/b" }),
      ).resolves.toMatchObject({
        modelRef: "cloud/b",
        overridden: false,
      });
      await expect(
        f.service.select({ sessionKey: "agent:writer:chat", modelRef: "cloud/a" }),
      ).rejects.toThrow(/allowlist/);
      expect(f.config).toEqual(config);
    },
  );

  it("permits the configured local primary despite a legacy Copilot-only map", async () => {
    const f = fixture();
    const defaults = (f.config.agents as Row).defaults as Row;
    defaults.model = { primary: "llama-cpp/local" };
    defaults.models = { "github-copilot/gpt-5": {} };
    await expect(
      f.service.select({ sessionKey: "chat", modelRef: "llama-cpp/local" }),
    ).resolves.toMatchObject({
      modelRef: "llama-cpp/local",
      overridden: false,
    });
    await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/a" })).rejects.toThrow(
      /allowlist/,
    );
  });

  it.each([["llama-cpp/*"], ["llama-cpp/*", "cloud/b"]])(
    "does not implicitly permit a primary outside wildcard/mixed policy %j",
    async (...allow) => {
      const f = fixture();
      ((f.config.agents as Row).defaults as Row).modelPolicy = { allow };
      await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/a" })).rejects.toThrow(
        /allowlist/,
      );
      expect(f.patches()).toHaveLength(0);
    },
  );

  it("allows a primary covered by a wildcard or explicitly included in a mixed policy", async () => {
    const f = fixture();
    const defaults = (f.config.agents as Row).defaults as Row;
    defaults.modelPolicy = { allow: ["cloud/*"] };
    await expect(
      f.service.select({ sessionKey: "chat", modelRef: "cloud/a" }),
    ).resolves.toMatchObject({ overridden: false });
    defaults.modelPolicy = { allow: ["llama-cpp/*", "cloud/a"] };
    await expect(
      f.service.select({ sessionKey: "chat", modelRef: "cloud/a" }),
    ).resolves.toMatchObject({ overridden: false });
  });

  it.each(["migrated", "empty-policy-object", "explicit-empty-allow", "agent-empty-allow"])(
    "does not treat the models metadata map as a restriction when %s",
    async (kind) => {
      const f = fixture();
      const defaults = (f.config.agents as Row).defaults as Row;
      defaults.models = { "github-copilot/gpt-5": {} };
      if (kind === "migrated") f.config.meta = { migrations: { modelPolicyAllowlist: true } };
      if (kind === "empty-policy-object") defaults.modelPolicy = {};
      if (kind === "explicit-empty-allow") defaults.modelPolicy = { allow: [] };
      if (kind === "agent-empty-allow")
        ((f.config.agents as Row).list as Row[])[0].modelPolicy = { allow: [] };
      await expect(
        f.service.select({ sessionKey: "chat", modelRef: "cloud/b" }),
      ).resolves.toMatchObject({
        modelRef: "cloud/b",
        overridden: true,
      });
    },
  );

  it("does not widen a defaults policy through an agent's alias overlay", async () => {
    const f = fixture();
    const defaults = (f.config.agents as Row).defaults as Row;
    defaults.models = { "cloud/b": { alias: "shared" } };
    defaults.modelPolicy = { allow: ["shared"] };
    const agent = ((f.config.agents as Row).list as Row[])[0];
    agent.models = { "cloud/path/model": { alias: "shared" } };
    await expect(
      f.service.select({ sessionKey: "chat", modelRef: "cloud/path/model" }),
    ).rejects.toThrow(/allowlist/);
    await expect(
      f.service.select({ sessionKey: "chat", modelRef: "cloud/b" }),
    ).resolves.toMatchObject({ modelRef: "cloud/b" });
  });

  it("uses the inherited primary, not the current override, for the implicit exception", async () => {
    const f = fixture();
    await f.service.select({ sessionKey: "chat", modelRef: "cloud/b" });
    ((f.config.agents as Row).defaults as Row).modelPolicy = { allow: ["llama-cpp/local"] };
    await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/b" })).rejects.toThrow(
      /allowlist/,
    );
    await expect(
      f.service.select({ sessionKey: "chat", modelRef: "cloud/a" }),
    ).resolves.toMatchObject({
      modelRef: "cloud/a",
      overridden: false,
    });
  });

  it("honors model policy wildcards without allowing unconfigured models", async () => {
    const f = fixture();
    ((f.config.agents as Row).defaults as Row).modelPolicy = { allow: ["cloud/path/*"] };
    await expect(
      f.service.select({ sessionKey: "chat", modelRef: "cloud/path/model" }),
    ).resolves.toMatchObject({ modelRef: "cloud/path/model" });
    await expect(
      f.service.select({ sessionKey: "chat", modelRef: "cloud/path/unknown" }),
    ).rejects.toThrow(/not configured/);
  });

  it("validates Copilot auth and prepared official catalogue for the owning agent", async () => {
    const f = fixture();
    await expect(
      f.service.select({ sessionKey: "agent:writer:chat", modelRef: "github-copilot/gpt-5" }),
    ).resolves.toMatchObject({ modelRef: "github-copilot/gpt-5" });
    expect(f.request).toHaveBeenCalledWith("models.authStatus", { agentId: "writer" });
    expect(f.request).toHaveBeenCalledWith("models.list", {
      agentId: "writer",
      view: "all",
      preparedOnly: true,
    });
  });

  it.each(["missing-auth", "missing-model", "unavailable"])(
    "rejects Copilot %s",
    async (reason) => {
      const f = fixture();
      if (reason === "missing-auth") f.setAuth(false);
      if (reason === "missing-model") f.setCatalog([]);
      if (reason === "unavailable")
        f.setCatalog([{ provider: "github-copilot", id: "gpt-5", available: false }]);
      await expect(
        f.service.select({ sessionKey: "chat", modelRef: "github-copilot/gpt-5" }),
      ).rejects.toThrow();
      expect(f.patches()).toHaveLength(0);
    },
  );

  it("rejects simultaneous selections and chat sends while validation or patch is pending", async () => {
    const f = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.request.mockImplementationOnce(async (...args) => {
      await pending;
      return f.handle(...args);
    });
    const first = f.service.select({ sessionKey: "chat", modelRef: "cloud/b" });
    expect(f.service.busy).toBe(true);
    expect(() => f.service.assertChatAllowed()).toThrow(/in progress/);
    await expect(f.service.select({ sessionKey: "other", modelRef: "cloud/b" })).rejects.toThrow(
      /in progress/,
    );
    release();
    await first;
    expect(f.service.busy).toBe(false);
  });

  it("rejects active chat and sandbox/model mutation policies before and after awaits", async () => {
    const f = fixture();
    f.assertMutable.mockImplementationOnce(() => {
      throw new Error("active chat");
    });
    await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/b" })).rejects.toThrow(
      /active chat/,
    );
    expect(f.request).not.toHaveBeenCalled();
    f.assertMutable
      .mockReset()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error("configuration locked");
      });
    await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/b" })).rejects.toThrow(
      /configuration locked/,
    );
    expect(f.patches()).toHaveLength(0);
  });

  it("rejects active/locked Gateway sessions", async () => {
    const f = fixture();
    f.sessions.set("agent:main:chat", {
      key: "agent:main:chat",
      agentId: "main",
      modelProvider: "cloud",
      model: "a",
      status: "running",
    });
    await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/b" })).rejects.toThrow(
      /active chat/,
    );
    f.sessions.get("agent:main:chat")!.status = "done";
    f.sessions.get("agent:main:chat")!.modelSelectionLocked = true;
    await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/b" })).rejects.toThrow(
      /locked/,
    );
  });

  it.each(["disconnected", "replaced", "reconnected", "config-changed", "hash-changed"])(
    "rejects %s Gateway state",
    async (reason) => {
      const f = fixture();
      if (reason === "disconnected") f.gateway.connected = false;
      else
        f.request.mockImplementationOnce(async (...args) => {
          const result = await f.handle(...args);
          if (reason === "replaced") f.setGateway({ ...f.gateway });
          if (reason === "reconnected") f.gateway.connectionGeneration++;
          if (reason === "config-changed") f.config.changed = true;
          if (reason === "hash-changed") f.setHash("two");
          return result;
        });
      await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/b" })).rejects.toThrow(
        /Gateway|configuration|connection/,
      );
      expect(f.patches()).toHaveLength(0);
    },
  );

  it("does not treat a matching value as proof that an unacknowledged patch has stopped", async () => {
    const f = fixture();
    f.request.mockImplementation(async (method, params) => {
      if (method === "sessions.patch") throw new Error("request timed out");
      return f.handle(method, params);
    });
    await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/b" })).rejects.toThrow(
      /may have been saved/,
    );
    expect(f.patches()).toHaveLength(1);
    await f.service.get("other");
    await f.service.get("chat");
    expect(() => f.service.assertChatAllowed()).toThrow(/unknown/);
    await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/b" })).rejects.toThrow(
      /unknown/,
    );
    await f.handle("sessions.patch", { key: "agent:main:chat", model: "cloud/b" });
    await f.service.get("chat");
    expect(() => f.service.assertChatAllowed()).toThrow(/unknown/);
    await f.service.recover({
      recoveryId: f.service.getRecovery()!.id,
      confirmed: true,
      restart: true,
    });
    expect(() => f.service.assertChatAllowed()).not.toThrow();
    expect((await f.service.get("chat")).modelRef).toBe("cloud/b");
    expect(f.patches()).toHaveLength(1);
  });

  it.each([false, true])(
    "recovers a lost patch without replay or rollback (late write persisted: %s)",
    async (lateApplied) => {
      const f = fixture();
      f.request.mockImplementation((method, params) => {
        if (method === "sessions.patch") throw new Error("request timed out");
        return f.handle(method, params);
      });
      await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/b" })).rejects.toThrow(
        /may have been saved/,
      );
      f.gateway.connectionGeneration++;
      expect((await f.service.get("chat")).modelRef).toBe("cloud/a");
      expect(f.service.getRecovery()).toMatchObject({ requiresRestart: true, canRecover: true });
      const id = f.service.getRecovery()!.id;
      if (lateApplied)
        await f.handle("sessions.patch", { key: "agent:main:chat", model: "cloud/b" });
      await f.service.recover({ recoveryId: id, confirmed: true, restart: true });
      expect(f.restartGateway).toHaveBeenCalledOnce();
      expect(f.service.getRecovery()).toBeNull();
      expect(f.service.busy).toBe(false);
      expect(() => f.service.assertChatAllowed()).not.toThrow();
      expect((await f.service.get("chat")).modelRef).toBe(lateApplied ? "cloud/b" : "cloud/a");
      expect((await f.service.get("agent:writer:other")).modelRef).toBe("cloud/b");
      expect(f.patches()).toHaveLength(1);
    },
  );

  it("can reconcile the original model after a definitive server reply without restarting", async () => {
    const f = fixture();
    f.request.mockImplementation((method, params) => {
      if (method === "sessions.patch")
        throw new GatewayRequestError("Store unavailable", "UNAVAILABLE");
      return f.handle(method, params);
    });
    await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/b" })).rejects.toThrow(
      /may have been saved/,
    );
    expect(f.service.getRecovery()?.requiresRestart).toBe(false);
    const current = await f.service.get("chat");
    expect(current.modelRef).toBe("cloud/a");
    expect(f.service.busy).toBe(false);
    expect(f.restartGateway).not.toHaveBeenCalled();
    expect(f.patches()).toHaveLength(1);
  });

  it("reconciles a newer saved model after an acknowledged write's readback failed", async () => {
    const f = fixture();
    let acknowledged = false;
    f.request.mockImplementation(async (method, params) => {
      if (acknowledged && method === "sessions.describe") throw new Error("Readback failed");
      const result = await f.handle(method, params);
      if (method === "sessions.patch") acknowledged = true;
      return result;
    });
    await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/b" })).rejects.toThrow(
      /may have been saved/,
    );
    expect(f.service.getRecovery()?.requiresRestart).toBe(false);
    await f.handle("sessions.patch", { key: "agent:main:chat", model: "cloud/a" });
    f.request.mockImplementation(f.handle);
    await f.service.recover({
      recoveryId: f.service.getRecovery()!.id,
      confirmed: true,
      restart: false,
    });
    expect((await f.service.get("chat")).modelRef).toBe("cloud/a");
    expect(f.service.busy).toBe(false);
    expect(f.restartGateway).not.toHaveBeenCalled();
    expect(f.patches()).toHaveLength(1);
  });

  it("accepts a fresh read after a proven process replacement, not merely a reconnect or new label", async () => {
    const f = fixture();
    f.request.mockImplementation((method, params) => {
      if (method === "sessions.patch") throw new Error("connection lost");
      return f.handle(method, params);
    });
    await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/b" })).rejects.toThrow();
    f.replaceRuntime(false);
    await f.service.get("chat");
    expect(f.service.busy).toBe(true);
    const id = f.service.getRecovery()!.id;
    f.restartGateway.mockResolvedValueOnce();
    await expect(
      f.service.recover({ recoveryId: id, confirmed: true, restart: true }),
    ).rejects.toThrow(/not been proven stopped/);
    expect(f.service.busy).toBe(true);
    const replacement = fixture();
    replacement.request.mockImplementation((method, params) => {
      if (method === "sessions.patch") throw new Error("connection lost");
      return replacement.handle(method, params);
    });
    await expect(
      replacement.service.select({ sessionKey: "chat", modelRef: "cloud/b" }),
    ).rejects.toThrow();
    replacement.replaceRuntime();
    expect((await replacement.service.get("chat")).modelRef).toBe("cloud/a");
    expect(replacement.service.busy).toBe(false);
    expect(replacement.restartGateway).not.toHaveBeenCalled();
  });

  it("requires the current recovery ID, restart consent and the original Gateway profile", async () => {
    const f = fixture();
    f.request.mockImplementation((method, params) => {
      if (method === "sessions.patch") throw new Error("connection lost");
      return f.handle(method, params);
    });
    await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/b" })).rejects.toThrow();
    const id = f.service.getRecovery()!.id;
    await expect(
      f.service.recover({ recoveryId: id, confirmed: false, restart: true }),
    ).rejects.toThrow(/explicitly/);
    await expect(
      f.service.recover({ recoveryId: "stale", confirmed: true, restart: true }),
    ).rejects.toThrow(/changed/);
    await expect(
      f.service.recover({ recoveryId: id, confirmed: true, restart: false }),
    ).rejects.toThrow(/confirmed Gateway restart/);
    f.assertMutable.mockImplementationOnce(() => {
      throw new Error("Chat is still active");
    });
    await expect(
      f.service.recover({ recoveryId: id, confirmed: true, restart: true }),
    ).rejects.toThrow(/Chat is still active/);
    f.replaceRuntime(true, "different-profile");
    await f.service.get("chat");
    await expect(
      f.service.recover({ recoveryId: id, confirmed: true, restart: true }),
    ).rejects.toThrow(/original Gateway/);
    expect(f.service.busy).toBe(true);
    expect(f.restartGateway).not.toHaveBeenCalled();
    expect(f.patches()).toHaveLength(1);
  });

  it("keeps the fence on failed restart/readback and blocks concurrent recovery", async () => {
    const f = fixture();
    f.request.mockImplementation((method, params) => {
      if (method === "sessions.patch") throw new Error("connection lost");
      return f.handle(method, params);
    });
    await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/b" })).rejects.toThrow();
    const params = { recoveryId: f.service.getRecovery()!.id, confirmed: true, restart: true };
    f.restartGateway.mockRejectedValueOnce(new Error("Could not stop Gateway"));
    await expect(f.service.recover(params)).rejects.toThrow(/Could not stop/);
    expect(f.service.busy).toBe(true);
    let restarted!: () => void;
    f.restartGateway.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          restarted = () => {
            f.replaceRuntime();
            resolve();
          };
        }),
    );
    const pending = f.service.recover(params);
    expect(f.service.getRecovery()).toMatchObject({ recovering: true, canRecover: false });
    await expect(f.service.recover(params)).rejects.toThrow(/in progress/);
    expect(() => f.service.assertChatAllowed()).toThrow(/in progress/);
    restarted();
    await pending;
    expect(f.service.busy).toBe(false);
    expect(f.patches()).toHaveLength(1);
  });

  it("does not leave other conversations locked when the original owner was removed", async () => {
    const f = fixture();
    f.request.mockImplementation((method, params) => {
      if (method === "sessions.patch") throw new Error("connection lost");
      return f.handle(method, params);
    });
    await expect(
      f.service.select({ sessionKey: "agent:writer:chat", modelRef: "cloud/a" }),
    ).rejects.toThrow();
    (f.config.agents as Row).list = [{ id: "main", default: true }];
    await f.service.recover({
      recoveryId: f.service.getRecovery()!.id,
      confirmed: true,
      restart: true,
    });
    expect(f.service.busy).toBe(false);
    expect((await f.service.get("chat")).modelRef).toBe("cloud/a");
    expect(f.patches()).toHaveLength(1);
  });

  it("keeps definite validation rejections retryable without retrying them itself", async () => {
    const f = fixture();
    f.request.mockImplementation(async (method, params) => {
      if (method === "sessions.patch")
        throw new GatewayRequestError("model not allowed", "INVALID_REQUEST");
      return f.handle(method, params);
    });
    await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/b" })).rejects.toThrow(
      /model not allowed/,
    );
    expect(f.patches()).toHaveLength(1);
    expect(f.service.busy).toBe(false);
  });

  it("treats readback failures after acknowledgement as uncertain even if the error is INVALID_REQUEST", async () => {
    const f = fixture();
    let applied = false;
    f.request.mockImplementation(async (method, params) => {
      if (applied && method === "sessions.describe")
        throw new GatewayRequestError("session changed", "INVALID_REQUEST");
      const result = await f.handle(method, params);
      if (method === "sessions.patch") applied = true;
      return result;
    });
    await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/b" })).rejects.toThrow(
      /may have been saved/,
    );
    expect(f.service.busy).toBe(true);
  });

  it("rejects mismatched applied result/readback instead of claiming success", async () => {
    const f = fixture();
    f.request.mockImplementation(async (method, params) => {
      const result = await f.handle(method, params);
      if (method === "sessions.patch") f.sessions.get("agent:main:chat")!.model = "a";
      return result;
    });
    await expect(f.service.select({ sessionKey: "chat", modelRef: "cloud/b" })).rejects.toThrow(
      /could not be confirmed/,
    );
    expect(f.patches()).toHaveLength(1);
  });
});
