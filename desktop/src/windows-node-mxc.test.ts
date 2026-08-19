import { describe, expect, it } from "vitest";
import {
  applyWindowsNodeMxcGatewayPolicy,
  assertWindowsNodeMxcFolderPolicyMutable,
  buildWindowsNodeMxcLockedToolPolicy,
  buildWindowsNodeMxcToolPolicy,
  canonicalizeApprovedCwd,
  classifyMxcProbe,
  classifyMxcSmoke,
  classifyMissingEffectiveToolSession,
  extractEffectiveToolNames,
  getMxcTierWarning,
  getWindowsNodeMxcGatewayPolicyState,
  isWindowsNodeMxcIngressReleased,
  isWindowsNodeMxcFolderConfigured,
  listAgentSessionKeys,
  normalizeWindowsNodeMxcGatewayApproval,
  normalizeWindowsNodeRecord,
  planWindowsNodeMxcFolderUpsert,
  restoreWindowsNodeMxcGatewayPolicy,
  validateEffectiveToolNames,
  validateSelectedWindowsNode,
  validateWindowsNodeMxcGatewayPolicy,
  validateWindowsNodeMxcFolderPath,
  validateWindowsNodeMxcSettings,
} from "./windows-node-mxc";
import {
  classifyDeniedCwdSmoke,
  isCurrentBundledActivationLease,
  isCurrentWindowsNodeMxcSmoke,
  selectCurrentWindowsNodeMxcSmoke,
  shouldStopManagedGatewayForWindowsNodeMxc,
  validateBundledCwdAttestation,
} from "./windows-node-mxc-service";

const strictSettings = {
  EnableNodeMode: true,
  NodeSystemRunEnabled: true,
  NodeCanvasEnabled: false,
  NodeScreenEnabled: false,
  NodeCameraEnabled: false,
  NodeLocationEnabled: false,
  NodeBrowserProxyEnabled: false,
  NodeSttEnabled: false,
  NodeTtsEnabled: false,
  EnableMcpServer: false,
  SystemRunSandboxEnabled: true,
  SystemRunBlockHostFallbackWhenMxcUnavailable: true,
  SystemRunAllowOutbound: false,
  SystemRunAllowWindowsUi: true,
  SandboxClipboard: 0,
};

describe("Gateway node exec approval bridge", () => {
  const nodeId = "a".repeat(64);
  const payload = {
    id: "approval-1",
    allowedDecisions: ["allow-once", "deny"],
    request: {
      host: "node",
      nodeId,
      systemRunPlan: {
        argv: ["powershell.exe", "-Command", "Set-Content test.txt ok"],
        cwd: null,
        commandText: 'powershell.exe -Command "Set-Content test.txt ok"',
        commandPreview: "Set-Content test.txt ok",
        agentId: "main",
        sessionKey: "agent:main:approval-regression",
      },
    },
  };

  it("accepts only a canonical approval for the selected node", () => {
    expect(normalizeWindowsNodeMxcGatewayApproval(payload, nodeId)).toEqual({
      id: "approval-1",
      command: 'powershell.exe -Command "Set-Content test.txt ok"',
      executable: "powershell.exe",
      arguments: ["-Command", "Set-Content test.txt ok"],
      canonicalCwd: "isolated-scratch:v1",
      agent: "main",
      declaredAccess: [],
      allowedDecisions: ["allow-once", "deny"],
    });
  });

  it("separates normalized RO and RW declarations from the clean command", () => {
    const approval = normalizeWindowsNodeMxcGatewayApproval(
      {
        ...payload,
        request: {
          ...payload.request,
          systemRunPlan: {
            ...payload.request.systemRunPlan,
            commandPreview: [
              String.raw`# [declare-access]rw:C:\Users\test\Desktop[/declare-access]`,
              String.raw`REM [declare-access]ro:C:\Users\test\Documents[/declare-access]`,
              "Set-Content test.txt ok",
            ].join("\n"),
          },
        },
      },
      nodeId,
    );

    expect(approval).toEqual({
      id: "approval-1",
      command: 'powershell.exe -Command "Set-Content test.txt ok"',
      executable: "powershell.exe",
      arguments: ["-Command", "Set-Content test.txt ok"],
      canonicalCwd: "isolated-scratch:v1",
      agent: "main",
      declaredAccess: [
        { access: "rw", path: String.raw`C:\Users\test\Desktop` },
        { access: "ro", path: String.raw`C:\Users\test\Documents` },
      ],
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(approval?.command).not.toContain("declare-access");
  });

  it.each([
    "# [declare-access]rw:C:\\Users\\test\\Desktop",
    "# [declare-access]write:C:\\Users\\test\\Desktop[/declare-access]\necho test",
    "# [declare-access]rw:relative[/declare-access]\necho test",
    "echo before\n# [declare-access]rw:C:\\Users\\test\\Desktop[/declare-access]\necho test",
    "# [declare-access]rw:C:\\Users\\test\\Desktop[/declare-access]",
  ])("rejects malformed declared-access previews: %s", (commandPreview) => {
    expect(
      normalizeWindowsNodeMxcGatewayApproval(
        {
          ...payload,
          request: {
            ...payload.request,
            systemRunPlan: {
              ...payload.request.systemRunPlan,
              commandPreview,
            },
          },
        },
        nodeId,
      ),
    ).toBeNull();
  });

  it("rejects another node, host execution, and a malformed canonical plan", () => {
    expect(normalizeWindowsNodeMxcGatewayApproval(payload, "b".repeat(64))).toBeNull();
    expect(
      normalizeWindowsNodeMxcGatewayApproval(
        { ...payload, request: { ...payload.request, host: "gateway" } },
        nodeId,
      ),
    ).toBeNull();
    expect(
      normalizeWindowsNodeMxcGatewayApproval(
        {
          ...payload,
          request: {
            ...payload.request,
            systemRunPlan: { ...payload.request.systemRunPlan, argv: [] },
          },
        },
        nodeId,
      ),
    ).toBeNull();
    for (const invalidPlan of [
      { ...payload.request.systemRunPlan, argv: ["powershell.exe", 1] },
      { ...payload.request.systemRunPlan, commandText: undefined },
      { ...payload.request.systemRunPlan, cwd: undefined },
      { ...payload.request.systemRunPlan, agentId: undefined },
      { ...payload.request.systemRunPlan, sessionKey: undefined },
    ]) {
      expect(
        normalizeWindowsNodeMxcGatewayApproval(
          {
            ...payload,
            request: {
              ...payload.request,
              command: "unrelated fallback",
              systemRunPlan: invalidPlan,
            },
          },
          nodeId,
        ),
      ).toBeNull();
    }
  });

  it("never invents allow-always when the Gateway does not advertise it", () => {
    expect(
      normalizeWindowsNodeMxcGatewayApproval({ ...payload, allowedDecisions: undefined }, nodeId)
        ?.allowedDecisions,
    ).toEqual(["allow-once", "deny"]);
  });
});

describe("bundled Windows Node CWD attestation", () => {
  it("requires every exact fail-closed contract property", () => {
    expect(
      validateBundledCwdAttestation({
        payload: {
          contract: "microclaw.windows-cwd.v1",
          approvedRootOnly: true,
          canonicalFinalPath: true,
          rejectsReparseComponents: true,
          durableApprovalBindsCwd: true,
          durableApprovalBindsDeclaredAccess: true,
          launchTimeRevalidation: true,
          omittedCwdUsesIsolatedScratch: true,
          hostFallbackAbsent: true,
          activationLeaseContract: "microclaw.windows-activation.v1",
          generationBoundActivation: true,
          policyBoundActivation: true,
          launchTimeLeaseRevalidation: true,
          approvalProofContract: "microclaw.windows-node-approval.v1",
          activeRunsRequireApprovalProof: true,
          approvalProofOneUse: true,
          approvalProofBindsPreparedPlan: true,
          approvalProofBindsActivation: true,
          durableApprovalsPresent: true,
        },
      }),
    ).toEqual({ ready: true, blockers: [], durableApprovalsPresent: true });
  });

   it.each([
     "activeRunsRequireApprovalProof",
     "approvalProofOneUse",
     "approvalProofBindsPreparedPlan",
     "approvalProofBindsActivation",
   ])("fails closed when %s is not attested", (property) => {
     const payload = {
       contract: "microclaw.windows-cwd.v1",
       approvedRootOnly: true,
       canonicalFinalPath: true,
       rejectsReparseComponents: true,
       durableApprovalBindsCwd: true,
       durableApprovalBindsDeclaredAccess: true,
       launchTimeRevalidation: true,
       omittedCwdUsesIsolatedScratch: true,
       hostFallbackAbsent: true,
       activationLeaseContract: "microclaw.windows-activation.v1",
       generationBoundActivation: true,
       policyBoundActivation: true,
       launchTimeLeaseRevalidation: true,
       approvalProofContract: "microclaw.windows-node-approval.v1",
       activeRunsRequireApprovalProof: true,
       approvalProofOneUse: true,
       approvalProofBindsPreparedPlan: true,
       approvalProofBindsActivation: true,
       durableApprovalsPresent: false,
     };

     expect(
       validateBundledCwdAttestation({
         payload: { ...payload, [property]: false },
       }).ready,
     ).toBe(false);
   });

  describe("Windows Node MXC diagnostic lifecycle", () => {
    it("keeps an unverified locked diagnostic Gateway alive but stops actual drift", () => {
      expect(
        shouldStopManagedGatewayForWindowsNodeMxc({
          effectiveEnabled: false,
          effectiveToolsState: "unverified",
          gatewayPolicyState: "locked",
        }),
      ).toBe(false);
      expect(
        shouldStopManagedGatewayForWindowsNodeMxc({
          effectiveEnabled: false,
          effectiveToolsState: "drift",
          gatewayPolicyState: "locked",
        }),
      ).toBe(true);
      expect(
        shouldStopManagedGatewayForWindowsNodeMxc({
          effectiveEnabled: true,
          effectiveToolsState: "verified",
          gatewayPolicyState: "active",
        }),
      ).toBe(false);
      expect(
        shouldStopManagedGatewayForWindowsNodeMxc({
          effectiveEnabled: false,
          effectiveToolsState: "verified",
          gatewayPolicyState: "active",
        }),
      ).toBe(true);
    });

    it("rejects legacy smoke records without the denied-root proof", () => {
      expect(
        isCurrentWindowsNodeMxcSmoke({
          nodeId: "node-1",
          settingsFingerprint: "settings",
          probeTier: "appcontainer-dacl",
          checkedAt: "2026-08-18T00:00:00.000Z",
          hostname: { outcome: "passed", reason: "ok" },
          powershell: { outcome: "passed", reason: "ok" },
        }),
      ).toBe(false);
    });

    it("binds smoke proof and ingress release to the exact Gateway generation", () => {
      const smoke = {
        gatewayGeneration: "generation-1",
        nodeId: "node-1",
        settingsFingerprint: "settings-1",
        probeTier: "appcontainer-dacl",
        checkedAt: new Date().toISOString(),
        hostname: { outcome: "passed" as const, reason: "ok" },
        powershell: { outcome: "passed" as const, reason: "ok" },
        deniedOutsideRoot: { outcome: "passed" as const, reason: "denied" },
      };

      expect(
        selectCurrentWindowsNodeMxcSmoke(
          smoke,
          "generation-1",
          "node-1",
          "settings-1",
          "appcontainer-dacl",
        ),
      ).toBe(smoke);
      expect(
        selectCurrentWindowsNodeMxcSmoke(
          smoke,
          "generation-2",
          "node-1",
          "settings-1",
          "appcontainer-dacl",
        ),
      ).toBeNull();
      expect(isWindowsNodeMxcIngressReleased(true, "generation-1", "generation-1", false)).toBe(
        true,
      );
      expect(isWindowsNodeMxcIngressReleased(true, "generation-2", "generation-1", false)).toBe(
        false,
      );
      expect(isWindowsNodeMxcIngressReleased(true, "generation-1", "generation-1", true)).toBe(
        false,
      );
      expect(isWindowsNodeMxcIngressReleased(false, "", null, false)).toBe(true);
    });

    it("requires an unexpired activation lease for the exact generation and policy", () => {
      const lease = {
        contract: "microclaw.windows-activation.v1" as const,
        mode: "active" as const,
        gatewayGeneration: "generation-1",
        policyFingerprint: "policy-1",
        expiresAtUnixMs: Date.now() + 60_000,
      };

      expect(isCurrentBundledActivationLease(lease, "active", "generation-1", "policy-1")).toBe(
        true,
      );
      expect(isCurrentBundledActivationLease(lease, "active", "generation-2", "policy-1")).toBe(
        false,
      );
      expect(isCurrentBundledActivationLease(lease, "active", "generation-1", "policy-2")).toBe(
        false,
      );
      expect(
        isCurrentBundledActivationLease(
          { ...lease, expiresAtUnixMs: Date.now() - 1 },
          "active",
          "generation-1",
          "policy-1",
        ),
      ).toBe(false);
    });
  });

  it("rejects a command-name-only or incomplete attestation", () => {
    const result = validateBundledCwdAttestation({
      contract: "microclaw.windows-cwd.v1",
      approvedRootOnly: true,
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain(
      "Bundled node CWD attestation is missing or invalid: launchTimeRevalidation",
    );
  });
});

describe("Windows Node MXC Gateway policy", () => {
  it("exposes only exec and pins it to one stable node", () => {
    expect(buildWindowsNodeMxcToolPolicy("node-123")).toEqual({
      profile: "full",
      allow: ["exec"],
      deny: ["process", "group:fs", "group:plugins"],
      codeMode: false,
      exec: {
        host: "node",
        node: "node-123",
        security: "allowlist",
        ask: "on-miss",
        timeoutSec: 1800,
        strictInlineEval: true,
      },
    });
  });

  it("applies the policy to every configured agent and restores prior tools", () => {
    const source = {
      agents: {
        list: [
          { id: "main", tools: { allow: ["read"] } },
          { id: "coder", name: "Coder" },
        ],
      },
    };
    const applied = applyWindowsNodeMxcGatewayPolicy(source, "node-123");

    expect(applied.config).not.toBe(source);
    expect(
      (applied.config.agents as { list: Array<{ tools: unknown }> }).list.map(
        (entry) => entry.tools,
      ),
    ).toEqual([
      buildWindowsNodeMxcToolPolicy("node-123"),
      buildWindowsNodeMxcToolPolicy("node-123"),
    ]);
    expect(validateWindowsNodeMxcGatewayPolicy(applied.config, "node-123").ready).toBe(true);
    expect(restoreWindowsNodeMxcGatewayPolicy(applied.config, applied.backups)).toEqual(source);
  });

  it("disables and restores every MicroClaw-managed external ingress surface", () => {
    const source = {
      agents: { list: [{ id: "main" }] },
      channels: { discord: { enabled: true, token: "preserved" } },
      hooks: { enabled: true, token: "preserved", internal: { enabled: true } },
      cron: { enabled: true, maxConcurrentRuns: 2 },
      plugins: {
        enabled: true,
        allow: ["openclaw-weixin"],
        entries: { "openclaw-weixin": { enabled: true } },
      },
    };

    const applied = applyWindowsNodeMxcGatewayPolicy(source, "node-123", {}, "locked");

    expect(applied.config).toMatchObject({
      channels: { discord: { enabled: false, token: "preserved" } },
      hooks: { enabled: false, token: "preserved", internal: { enabled: false } },
      cron: { enabled: false, maxConcurrentRuns: 2 },
      plugins: {
        enabled: false,
        allow: ["openclaw-weixin"],
        entries: { "openclaw-weixin": { enabled: false } },
      },
    });
    expect(validateWindowsNodeMxcGatewayPolicy(applied.config, "node-123", "locked").ready).toBe(
      true,
    );
    expect(restoreWindowsNodeMxcGatewayPolicy(applied.config, applied.backups)).toEqual(source);
  });

  it("fails closed when channels, hooks, cron, or plugins are re-enabled", () => {
    const source = { agents: { list: [{ id: "main" }] } };
    const baseline = applyWindowsNodeMxcGatewayPolicy(source, "node-123", {}, "active").config;
    const drifts = [
      { ...baseline, cron: { enabled: true } },
      { ...baseline, hooks: { enabled: true, internal: { enabled: false } } },
      { ...baseline, hooks: { enabled: false, internal: { enabled: true } } },
      { ...baseline, channels: { discord: { enabled: true } } },
      { ...baseline, plugins: { enabled: true, entries: {} } },
      { ...baseline, plugins: { enabled: false, entries: { channel: { enabled: true } } } },
    ];

    for (const drift of drifts) {
      expect(validateWindowsNodeMxcGatewayPolicy(drift, "node-123", "active").ready).toBe(false);
    }
  });

  it("uses an empty locked tool inventory until all readiness proofs pass", () => {
    const source = { agents: { list: [{ id: "main" }] } };
    const applied = applyWindowsNodeMxcGatewayPolicy(source, "node-123", {}, "locked");
    const tools = (applied.config.agents as { list: Array<{ tools: unknown }> }).list[0].tools;

    expect(tools).toEqual(buildWindowsNodeMxcLockedToolPolicy("node-123"));
    expect(tools).toMatchObject({
      allow: ["__microclaw_windows_node_mxc_locked__"],
    });
    expect(getWindowsNodeMxcGatewayPolicyState(applied.config, "node-123")).toBe("locked");
    expect(validateEffectiveToolNames([], "locked").ready).toBe(true);
    expect(validateEffectiveToolNames(["exec"], "locked").ready).toBe(false);
  });

  it("detects file-tool, plugin, or host-exec policy drift", () => {
    const config = {
      agents: {
        list: [
          {
            id: "main",
            tools: {
              ...buildWindowsNodeMxcToolPolicy("node-123"),
              allow: ["exec", "read"],
              exec: { host: "gateway" },
            },
          },
        ],
      },
    };
    const result = validateWindowsNodeMxcGatewayPolicy(config, "node-123");
    expect(result.ready).toBe(false);
    expect(result.blockers[0]).toContain("tool policy drifted");
  });

  it("requires the effective runtime inventory to contain only exec", () => {
    expect(validateEffectiveToolNames(["exec"]).ready).toBe(true);
    expect(validateEffectiveToolNames(["exec", "read"]).ready).toBe(false);
  });

  it("parses pinned OpenClaw grouped tool IDs and rejects unknown payloads", () => {
    expect(
      extractEffectiveToolNames({
        groups: [
          {
            id: "core",
            tools: [
              { id: "exec", label: "Execute", description: "Run", source: "core" },
              { id: "read", label: "Read", description: "Read", source: "core" },
            ],
          },
        ],
      }),
    ).toEqual(["exec", "read"]);
    expect(extractEffectiveToolNames({ groups: [] })).toEqual([]);
    expect(() => extractEffectiveToolNames({ tools: [] })).toThrow("groups inventory");
  });

  it("uses persisted agent sessions and the trusted global session for unsurfaced agents", async () => {
    const request = async (method: string) => {
      expect(method).toBe("sessions.list");
      return {
        sessions: [{ key: "global", agentId: "main" }, { key: "agent:coder:work" }],
      };
    };
    const keys = await listAgentSessionKeys({ request }, ["main", "coder", "unused"]);

    expect([...keys]).toEqual([
      ["main", "global"],
      ["coder", "agent:coder:work"],
      ["unused", "global"],
    ]);
  });

  it("uses exact static policy for agents without a persisted runtime session", () => {
    expect(classifyMissingEffectiveToolSession("unused", "locked")).toMatchObject({
      ready: true,
      blockers: [],
      warnings: [expect.stringContaining("locked config applies")],
    });
    expect(classifyMissingEffectiveToolSession("unused", "active")).toMatchObject({
      ready: true,
      blockers: [],
      warnings: [expect.stringContaining("exact active config applies")],
    });
  });
});

describe("Windows Node strict settings", () => {
  it("accepts the minimum system-only strict MXC settings", () => {
    expect(validateWindowsNodeMxcSettings(strictSettings).ready).toBe(true);
  });

  it("blocks host fallback, network, clipboard, MCP, and peripheral drift", () => {
    const result = validateWindowsNodeMxcSettings({
      ...strictSettings,
      SystemRunBlockHostFallbackWhenMxcUnavailable: false,
      SystemRunAllowOutbound: true,
      SandboxClipboard: 1,
      EnableMcpServer: true,
      NodeScreenEnabled: true,
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "Strict MXC host-fallback blocking is disabled",
        "Outbound network access must remain blocked",
        "Sandbox clipboard policy must be None",
        "Local MCP must remain disabled for this mode",
        "Screen capability must be disabled",
      ]),
    );
  });
});

describe("Windows cwd policy", () => {
  const realpaths = new Map([
    ["c:\\approved", "C:\\Approved"],
    ["c:\\approved\\work", "C:\\Approved\\Work"],
    ["c:\\junction", "C:\\Users\\Alice\\.ssh"],
    ["c:\\users\\alice\\.ssh", "C:\\Users\\Alice\\.ssh"],
    ["d:\\outside", "D:\\Outside"],
  ]);
  const realpath = (candidate: string) => {
    const resolved = realpaths.get(candidate.toLowerCase());
    if (!resolved) throw new Error("missing");
    return resolved;
  };

  it("canonicalizes case-insensitively into the most specific approved folder", () => {
    expect(
      canonicalizeApprovedCwd(
        "C:\\APPROVED\\work",
        [
          { path: "C:\\Approved", access: "ro" },
          { path: "C:\\Approved\\Work", access: "rw" },
        ],
        realpath,
      ),
    ).toEqual({
      allowed: true,
      canonicalPath: "c:\\approved\\work",
      access: "rw",
      reason: null,
    });
  });

  it("rejects relative and unapproved cwd values", () => {
    expect(canonicalizeApprovedCwd("relative", [], realpath).reason).toContain("absolute");
    expect(
      canonicalizeApprovedCwd("D:\\Outside", [{ path: "C:\\Approved", access: "rw" }], realpath)
        .reason,
    ).toContain("outside");
  });

  it("rejects a junction that resolves into a sensitive root", () => {
    const result = canonicalizeApprovedCwd(
      "C:\\Junction",
      [{ path: "C:\\Junction", access: "rw" }],
      realpath,
      ["C:\\Users\\Alice\\.ssh"],
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("sensitive");
  });
});

describe("Windows Node MXC global folder policy", () => {
  const realpath = (candidate: string) => candidate;
  const noReparse = () => false;

  it("canonicalizes empty-list RO and RW additions", () => {
    expect(planWindowsNodeMxcFolderUpsert({ rw: [], ro: [] }, "C:\\Data\\", "ro")).toEqual({
      ok: true,
      removedChildren: [],
      dirs: { rw: [], ro: ["C:\\Data"] },
    });
    expect(planWindowsNodeMxcFolderUpsert({ rw: [], ro: [] }, "C:\\Work", "rw")).toEqual({
      ok: true,
      removedChildren: [],
      dirs: { rw: ["C:\\Work"], ro: [] },
    });
  });

  it("deduplicates case-insensitively and changes equal-path access", () => {
    expect(
      planWindowsNodeMxcFolderUpsert({ rw: ["C:\\Data"], ro: [] }, "c:\\data", "rw"),
    ).toMatchObject({ ok: false, reason: "duplicate" });
    expect(planWindowsNodeMxcFolderUpsert({ rw: [], ro: ["C:\\Data"] }, "c:\\data", "rw")).toEqual({
      ok: true,
      removedChildren: [],
      dirs: { rw: ["c:\\data"], ro: [] },
    });
    expect(isWindowsNodeMxcFolderConfigured({ rw: ["C:\\Data"], ro: [] }, "c:\\DATA")).toBe(true);
  });

  it("keeps only unambiguous nested access", () => {
    expect(
      planWindowsNodeMxcFolderUpsert({ rw: [], ro: ["C:\\Data"] }, "C:\\Data\\Child", "ro"),
    ).toMatchObject({ ok: false, reason: "parent-covers", parentDir: "C:\\Data" });
    expect(
      planWindowsNodeMxcFolderUpsert({ rw: ["C:\\Data"], ro: [] }, "C:\\Data\\Child", "ro"),
    ).toMatchObject({ ok: false, reason: "parent-rw-covers", parentDir: "C:\\Data" });
    expect(
      planWindowsNodeMxcFolderUpsert(
        { rw: ["C:\\Data\\RwChild"], ro: ["C:\\Data\\RoChild"] },
        "C:\\Data",
        "ro",
      ),
    ).toEqual({
      ok: true,
      removedChildren: ["C:\\Data\\RoChild"],
      dirs: { rw: ["C:\\Data\\RwChild"], ro: ["C:\\Data"] },
    });
    expect(
      planWindowsNodeMxcFolderUpsert(
        { rw: ["C:\\Data\\RwChild"], ro: ["C:\\Data\\RoChild"] },
        "C:\\Data",
        "rw",
      ),
    ).toEqual({
      ok: true,
      removedChildren: ["C:\\Data\\RwChild", "C:\\Data\\RoChild"],
      dirs: { rw: ["C:\\Data"], ro: [] },
    });
  });

  it("downgrades a nested RW root to its inherited RO access", () => {
    const result = planWindowsNodeMxcFolderUpsert(
      { rw: ["C:\\Data\\Child"], ro: ["C:\\Data"] },
      "C:\\Data\\Child",
      "ro",
    );

    expect(result).toMatchObject({
      ok: true,
      inheritsFromParent: true,
      dirs: { rw: [], ro: ["C:\\Data"] },
    });
  });

  it("rejects UNC, device, reparse, and sensitive roots", () => {
    for (const candidate of [
      "\\\\server\\share",
      "\\\\?\\C:\\Data",
      "\\??\\C:\\Data",
      "\\Device\\HarddiskVolume1",
    ]) {
      expect(validateWindowsNodeMxcFolderPath(candidate, realpath, noReparse, [])).toMatchObject({
        ok: false,
        reason: "path-nonlocal",
      });
    }
    expect(
      validateWindowsNodeMxcFolderPath(
        "C:\\Data\\Junction",
        realpath,
        (candidate) => candidate.toLowerCase() === "c:\\data\\junction",
        [],
      ),
    ).toMatchObject({ ok: false, reason: "path-reparse-point" });
    expect(
      validateWindowsNodeMxcFolderPath("C:\\Users\\Alice", realpath, noReparse, [
        "C:\\Users\\Alice\\.ssh",
      ]),
    ).toMatchObject({ ok: false, reason: "path-sensitive" });
    expect(
      validateWindowsNodeMxcFolderPath("C:\\Users\\Alice\\.ssh\\Keys", realpath, noReparse, [
        "C:\\Users\\Alice\\.ssh",
      ]),
    ).toMatchObject({ ok: false, reason: "path-sensitive" });
  });

  it("blocks mutation whenever MXC is selected", () => {
    expect(() => assertWindowsNodeMxcFolderPolicyMutable(true)).toThrow(
      "Disable Windows Node + MXC mode",
    );
    expect(() => assertWindowsNodeMxcFolderPolicyMutable(false)).not.toThrow();
  });

  it("blocks mutation during security transitions and concurrent folder edits", () => {
    expect(() => assertWindowsNodeMxcFolderPolicyMutable(false, true, false)).toThrow(
      "security-mode transition",
    );
    expect(() => assertWindowsNodeMxcFolderPolicyMutable(false, false, true)).toThrow(
      "already in progress",
    );
  });
});

describe("MXC probe and smoke classification", () => {
  it("accepts DACL-only machines with a prominent degraded warning", () => {
    const probe = classifyMxcProbe(
      0,
      JSON.stringify({ tier: "appcontainer-dacl", needsDaclAugmentation: true }),
      "",
    );
    expect(probe.outcome).toBe("supported");
    expect(probe.degraded).toBe(true);
    expect(getMxcTierWarning(probe)).toContain("requires host DACL augmentation");
  });

  it("treats base-container and BFS as full-strength", () => {
    for (const tier of ["base-container", "appcontainer-bfs"]) {
      expect(classifyMxcProbe(0, JSON.stringify({ tier }), "").degraded).toBe(false);
    }
  });

  it("fails closed on an unknown isolation tier", () => {
    const probe = classifyMxcProbe(0, JSON.stringify({ tier: "host" }), "");
    expect(probe.outcome).toBe("error");
    expect(probe.reason).toContain("unrecognized isolation tier");
  });

  it("requires a contained external-child marker", () => {
    expect(
      classifyMxcSmoke({ exitCode: 0, stdout: "MICROCLAW_MXC_HOSTNAME_OK" }, "HOSTNAME_OK").outcome,
    ).toBe("passed");
    expect(
      classifyMxcSmoke(
        { exitCode: -1, stderr: "0xC0000142 DLL initialization failed" },
        "HOSTNAME_OK",
      ).outcome,
    ).toBe("child-launch-failed");
    expect(
      classifyMxcSmoke(
        { exitCode: -1, stderr: "MXC unavailable and host fallback blocked" },
        "HOSTNAME_OK",
      ).outcome,
    ).toBe("sandbox-unavailable");
  });

  it("requires an explicit typed denial for a protected or unapproved CWD", () => {
    expect(classifyDeniedCwdSmoke("cwd-sensitive-root: protected")).toMatchObject({
      outcome: "passed",
    });
    expect(classifyDeniedCwdSmoke("cwd-outside-approved-roots: denied")).toMatchObject({
      outcome: "passed",
    });
    expect(classifyDeniedCwdSmoke("approval timed out")).toMatchObject({ outcome: "failed" });
  });
});

describe("selected node readiness", () => {
  it("requires a paired local connected Windows node with strict cwd support", () => {
    const node = normalizeWindowsNodeRecord({
      id: "node-123",
      displayName: "Local Windows",
      platform: "win32",
      connected: true,
      paired: true,
      remoteIp: "127.0.0.1",
      commands: ["system.run", "system.run.prepare"],
    });
    const blocked = validateSelectedWindowsNode(node);
    expect(blocked.ready).toBe(false);
    expect(blocked.blockers).toContain(
      "Pinned Windows Node does not expose canonical approved-root cwd enforcement or cwd-bound durable approvals",
    );

    node!.commands.push("system.which", "system.run.cwd-policy");
    expect(validateSelectedWindowsNode(node).ready).toBe(true);
  });
});
