import { describe, expect, it } from "vitest";
import {
  applyWindowsNodeCommandPolicy,
  applyWindowsNodeMxcGatewayPolicy,
  assertWindowsNodeMxcFolderPolicyMutable,
  buildWindowsNodeMxcToolPolicy,
  canonicalizeApprovedCwd,
  classifyMxcProbe,
  classifyMxcSmoke,
  describeMxcExactBackendEligibility,
  isWindowsNodeMxcIngressReleased,
  isWindowsNodeMxcFolderConfigured,
  normalizeWindowsNodeMxcGatewayApproval,
  normalizeWindowsNodeMxcFolderPolicy,
  normalizeWindowsNodeRecord,
  planWindowsNodeMxcFolderUpsert,
  validateSelectedWindowsNode,
  validateWindowsNodeMxcGatewayPolicy,
  validateWindowsNodeMxcFolderPath,
  validateWindowsNodeMxcSettings,
  WINDOWS_NODE_MXC_NODE_COMMANDS,
} from "./windows-node-mxc";
import {
  classifyDeniedCwdSmoke,
  isCurrentBundledWindowsNodeApprovalCallback,
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
  SystemRunAllowOutbound: true,
  SystemRunAllowWindowsUi: true,
  SandboxClipboard: 0,
};

describe("Gateway node exec approval bridge", () => {
  const nodeId = "a".repeat(64);
  const payload = {
    id: "approval-1",
    allowedDecisions: ["allow-once", "deny", "allow-always"],
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
        executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        executableSha256: "c".repeat(64),
        cwdBinding: "isolated-scratch:v1",
        declaredAccess: [],
      },
    },
  };

  it("accepts only a canonical approval for the selected node", () => {
    expect(normalizeWindowsNodeMxcGatewayApproval(payload, nodeId)).toEqual({
      id: "approval-1",
      command: 'powershell.exe -Command "Set-Content test.txt ok"',
      executable: "powershell.exe",
      arguments: ["-Command", "Set-Content test.txt ok"],
      executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      executableSha256: "c".repeat(64),
      hasMutableFileOperand: false,
      canonicalCwd: "isolated-scratch:v1",
      agent: "main",
      sessionKey: "agent:main:approval-regression",
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
            declaredAccess: [
              { access: "rw", path: String.raw`C:\Users\test\Desktop` },
              { access: "ro", path: String.raw`C:\Users\test\Documents` },
            ],
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
      executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      executableSha256: "c".repeat(64),
      hasMutableFileOperand: false,
      canonicalCwd: "isolated-scratch:v1",
      agent: "main",
      sessionKey: "agent:main:approval-regression",
      declaredAccess: [
        { access: "rw", path: String.raw`C:\Users\test\Desktop` },
        { access: "ro", path: String.raw`C:\Users\test\Documents` },
      ],
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(approval?.command).not.toContain("declare-access");
  });

  it("rejects a prompt whose displayed declarations differ from the signed plan", () => {
    expect(
      normalizeWindowsNodeMxcGatewayApproval(
        {
          ...payload,
          request: {
            ...payload.request,
            systemRunPlan: {
              ...payload.request.systemRunPlan,
              commandPreview:
                "# [declare-access]ro:C:\\Users\\test\\Documents[/declare-access]\necho ok",
              declaredAccess: [{ access: "rw", path: "C:\\Users\\test\\Documents" }],
            },
          },
        },
        nodeId,
      ),
    ).toBeNull();
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
      { ...payload.request.systemRunPlan, executablePath: undefined },
      { ...payload.request.systemRunPlan, executableSha256: undefined },
      { ...payload.request.systemRunPlan, cwdBinding: undefined },
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

  it("only offers remembering when Windows Node says the command is eligible", () => {
    expect(
      normalizeWindowsNodeMxcGatewayApproval({ ...payload, allowedDecisions: undefined }, nodeId)
        ?.allowedDecisions,
    ).toEqual(["allow-once", "deny"]);
    const withPreview = {
      ...payload,
      request: {
        ...payload.request,
        systemRunPlan: {
          ...payload.request.systemRunPlan,
          commandConsent: { required: true, allowAlwaysAvailable: true },
        },
      },
    };
    expect(normalizeWindowsNodeMxcGatewayApproval(withPreview, nodeId)?.allowedDecisions).toContain(
      "allow-always",
    );
    withPreview.request.systemRunPlan.commandConsent.required = false;
    expect(normalizeWindowsNodeMxcGatewayApproval(withPreview, nodeId)).toBeNull();
  });

  it("accepts the pinned Gateway event envelope with decisions inside the request", () => {
    expect(
      normalizeWindowsNodeMxcGatewayApproval(
        {
          id: "approval-pinned-shape",
          createdAtMs: 1_777_000_000_000,
          expiresAtMs: 1_777_000_120_000,
          request: {
            command: 'powershell.exe -Command "Set-Content test.txt ok"',
            systemRunBinding: {
              argv: payload.request.systemRunPlan.argv,
              cwd: null,
              agentId: "main",
              sessionKey: "agent:main:approval-regression",
              envHash: null,
            },
            systemRunPlan: payload.request.systemRunPlan,
            cwd: null,
            nodeId,
            host: "node",
            security: "full",
            ask: "always",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
            agentId: "main",
            sessionKey: "agent:main:approval-regression",
          },
        },
        nodeId,
      )?.allowedDecisions,
    ).toEqual(["allow-once", "deny"]);
  });
});

describe("bundled Windows Node CWD attestation", () => {
  it("ignores approval callbacks from replaced host or Gateway generations", () => {
    const current = {
      expectedHostGeneration: 4,
      currentHostGeneration: 4,
      gatewayConnected: true,
      gatewayMatches: true,
      gatewayProcessMatches: true,
      expectedGatewayGeneration: "gateway-4",
      currentGatewayGeneration: "gateway-4",
    };

    expect(isCurrentBundledWindowsNodeApprovalCallback(current)).toBe(true);
    for (const stale of [
      { currentHostGeneration: 5 },
      { gatewayConnected: false },
      { gatewayMatches: false },
      { gatewayProcessMatches: false },
      { currentGatewayGeneration: "gateway-5" },
    ]) {
      expect(isCurrentBundledWindowsNodeApprovalCallback({ ...current, ...stale })).toBe(false);
    }
  });

  it("requires every exact fail-closed contract property", () => {
    expect(
      validateBundledCwdAttestation({
        payload: {
          contract: "microclaw.windows-cwd.v1",
          approvedRootOnly: true,
          canonicalFinalPath: true,
          rejectsReparseComponents: true,
          durableApprovalBindsCwd: false,
          durableApprovalBindsDeclaredAccess: false,
          launchTimeRevalidation: true,
          omittedCwdUsesIsolatedScratch: true,
          hostFallbackAbsent: true,
          activationLeaseContract: "microclaw.windows-activation.v1",
          generationBoundActivation: true,
          policyBoundActivation: true,
          launchTimeLeaseRevalidation: true,
          approvalProofContract: "microclaw.windows-node-approval.v2",
          activeRunsRequireApprovalProof: true,
          approvalProofOneUse: true,
          approvalProofBindsPreparedPlan: true,
          approvalProofPlanContract: "microclaw.windows-node-approval-plan.v2",
          approvalProofBindsExecutableContent: true,
          approvalProofBindsActivation: true,
          launchTimeApprovalProofRevalidation: true,
          readinessProofContract: "microclaw.windows-node-readiness.v1",
          readinessProofBindsTransition: true,
          readinessProofBindsPreparedPlan: true,
          readinessProofExactBuiltInsOnly: true,
          readinessProofOneUse: true,
          launchTimeReadinessProofRevalidation: true,
          exactFilesystemIsolationRequired: true,
          degradedIsolationTierRejected: true,
          durableApprovalStoreProtected: true,
          durableApprovalsPresent: true,
          requestedContainmentStrength: "full",
          folderPolicyIsExclusiveBoundary: true,
          durableApprovalsAllowed: true,
          ambientAssessmentBound: false,
          outboundNetworkEnabled: true,
        },
      }),
    ).toEqual({ ready: true, blockers: [], durableApprovalsPresent: true });
  });

  it.each([
    "activeRunsRequireApprovalProof",
    "approvalProofOneUse",
    "approvalProofBindsPreparedPlan",
    "approvalProofBindsExecutableContent",
    "approvalProofBindsActivation",
    "launchTimeApprovalProofRevalidation",
    "readinessProofBindsTransition",
    "readinessProofBindsPreparedPlan",
    "readinessProofExactBuiltInsOnly",
    "readinessProofOneUse",
    "launchTimeReadinessProofRevalidation",
    "exactFilesystemIsolationRequired",
    "degradedIsolationTierRejected",
    "durableApprovalStoreProtected",
    "folderPolicyIsExclusiveBoundary",
    "durableApprovalsAllowed",
    "outboundNetworkEnabled",
  ])("fails closed when %s is not attested", (property) => {
    const payload = {
      contract: "microclaw.windows-cwd.v1",
      approvedRootOnly: true,
      canonicalFinalPath: true,
      rejectsReparseComponents: true,
      durableApprovalBindsCwd: false,
      durableApprovalBindsDeclaredAccess: false,
      launchTimeRevalidation: true,
      omittedCwdUsesIsolatedScratch: true,
      hostFallbackAbsent: true,
      activationLeaseContract: "microclaw.windows-activation.v1",
      generationBoundActivation: true,
      policyBoundActivation: true,
      launchTimeLeaseRevalidation: true,
      approvalProofContract: "microclaw.windows-node-approval.v2",
      activeRunsRequireApprovalProof: true,
      approvalProofOneUse: true,
      approvalProofBindsPreparedPlan: true,
      approvalProofPlanContract: "microclaw.windows-node-approval-plan.v2",
      approvalProofBindsExecutableContent: true,
      approvalProofBindsActivation: true,
      launchTimeApprovalProofRevalidation: true,
      readinessProofContract: "microclaw.windows-node-readiness.v1",
      readinessProofBindsTransition: true,
      readinessProofBindsPreparedPlan: true,
      readinessProofExactBuiltInsOnly: true,
      readinessProofOneUse: true,
      launchTimeReadinessProofRevalidation: true,
      exactFilesystemIsolationRequired: true,
      degradedIsolationTierRejected: true,
      durableApprovalStoreProtected: true,
      durableApprovalsPresent: false,
      requestedContainmentStrength: "full",
      folderPolicyIsExclusiveBoundary: true,
      durableApprovalsAllowed: true,
      ambientAssessmentBound: false,
      outboundNetworkEnabled: true,
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
          gatewayPolicyState: "locked",
        }),
      ).toBe(false);
      expect(
        shouldStopManagedGatewayForWindowsNodeMxc({
          effectiveEnabled: false,
          gatewayPolicyState: "drift",
        }),
      ).toBe(true);
      expect(
        shouldStopManagedGatewayForWindowsNodeMxc({
          effectiveEnabled: true,
          gatewayPolicyState: "active",
        }),
      ).toBe(false);
      expect(
        shouldStopManagedGatewayForWindowsNodeMxc({
          effectiveEnabled: false,
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
          profile: "limited-minimal-smoke",
          execution: { outcome: "passed", reason: "ok" },
        }),
      ).toBe(false);
    });

    it("binds smoke proof and ingress release to the exact Gateway generation", () => {
      const smoke = {
        profile: "full-smoke" as const,
        gatewayGeneration: "generation-1",
        nodeId: "node-1",
        settingsFingerprint: "settings-1",
        probeTier: "base-container",
        containmentStrength: "full" as const,
        ambientAccessHash: null,
        checkedAt: new Date().toISOString(),
        execution: { outcome: "passed" as const, reason: "ok" },
        deniedOutsideRoot: { outcome: "passed" as const, reason: "denied" },
      };

      expect(
        selectCurrentWindowsNodeMxcSmoke(
          smoke,
          "generation-1",
          "node-1",
          "settings-1",
          "base-container",
          "full",
          null,
        ),
      ).toBe(smoke);
      expect(
        selectCurrentWindowsNodeMxcSmoke(
          smoke,
          "generation-2",
          "node-1",
          "settings-1",
          "base-container",
          "full",
          null,
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
  it("routes Windows Node exec through the pinned node and preserves unrelated Gateway configuration", () => {
    const source = {
      agents: { list: [{ id: "main", tools: { allow: ["read", "write", "browser"] } }] },
      tools: { allow: ["read", "write", "browser"] },
      channels: { discord: { enabled: true }, "openclaw-weixin": { enabled: true } },
      cron: { enabled: true },
      hooks: { enabled: true, internal: { enabled: true } },
      plugins: { enabled: true, entries: { custom: { enabled: true } } },
    };
    const applied = applyWindowsNodeMxcGatewayPolicy(source, "node-123");
    const agent = (applied.config.agents as { list: Array<{ tools: Record<string, unknown> }> })
      .list[0];
    const expectedExec = buildWindowsNodeMxcToolPolicy("node-123").exec;

    expect(agent.tools).toMatchObject({ allow: ["read", "write", "browser"], exec: expectedExec });
    expect(applied.config).toMatchObject({
      tools: { allow: ["read", "write", "browser"], exec: expectedExec },
      channels: source.channels,
      cron: source.cron,
      hooks: source.hooks,
      plugins: source.plugins,
    });
    expect(applied.backups).toEqual({});
  });

  it("validates only the pinned command route and required Windows Node commands", () => {
    const source = {
      agents: { list: [{ id: "main" }] },
      channels: { discord: { enabled: true } },
      plugins: { entries: { custom: { enabled: true } } },
      cron: { enabled: true },
      hooks: { enabled: true },
    };
    const config = applyWindowsNodeMxcGatewayPolicy(source, "node-123").config;

    expect(validateWindowsNodeMxcGatewayPolicy(config, "node-123").ready).toBe(true);
    expect(
      validateWindowsNodeMxcGatewayPolicy(
        { ...config, tools: { exec: { host: "gateway" } } },
        "node-123",
      ).ready,
    ).toBe(false);
    const withoutRequiredCommand = structuredClone(config);
    const nodes = (withoutRequiredCommand.gateway as { nodes: { commands: { allow: string[] } } })
      .nodes;
    nodes.commands.allow = nodes.commands.allow.filter((command) => command !== "system.run");
    expect(validateWindowsNodeMxcGatewayPolicy(withoutRequiredCommand, "node-123").ready).toBe(
      false,
    );
  });

  it("adds only system commands without changing permissions for stock Canvas nodes", () => {
    const config = applyWindowsNodeMxcGatewayPolicy(
      { agents: { list: [{ id: "main" }] } },
      "node-123",
    ).config;
    const commands = (config.gateway as { nodes: { commands: { allow: string[] } } }).nodes
      .commands;
    expect(commands.allow).toEqual([...WINDOWS_NODE_MXC_NODE_COMMANDS]);
    expect(commands.allow.some((command) => command.startsWith("canvas."))).toBe(false);
    const existing = {
      agents: { list: [{ id: "main" }] },
      gateway: { nodes: { commands: { allow: ["canvas.present"] } } },
    };
    const preserved = applyWindowsNodeCommandPolicy(existing, "node-123");
    expect((preserved.gateway as typeof existing.gateway).nodes.commands.allow).toContain(
      "canvas.present",
    );
  });
});

describe("Windows Node strict settings", () => {
  it("accepts the minimum system-only strict MXC settings", () => {
    expect(validateWindowsNodeMxcSettings(strictSettings).ready).toBe(true);
  });

  it("blocks host fallback, missing contained network, and clipboard drift", () => {
    const result = validateWindowsNodeMxcSettings({
      ...strictSettings,
      SystemRunBlockHostFallbackWhenMxcUnavailable: false,
      SystemRunAllowOutbound: false,
      SandboxClipboard: 1,
      EnableMcpServer: true,
      NodeScreenEnabled: true,
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "Strict MXC host-fallback blocking is disabled",
        "Contained outbound network access must be enabled for this mode",
        "Sandbox clipboard policy must be None",
      ]),
    );
  });
});

describe("Windows cwd policy", () => {
  const realpaths = new Map([
    ["c:\\", "C:\\"],
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

  it("uses the more specific read-only child of a read-write parent", () => {
    expect(
      canonicalizeApprovedCwd(
        "C:\\Approved\\Work",
        [
          { path: "C:\\Approved", access: "rw" },
          { path: "C:\\Approved\\Work", access: "ro" },
        ],
        realpath,
      ),
    ).toMatchObject({ allowed: true, access: "ro" });
  });

  it("accepts a working directory beneath a drive-root grant", () => {
    expect(
      canonicalizeApprovedCwd("C:\\Approved\\Work", [{ path: "C:\\", access: "rw" }], realpath),
    ).toMatchObject({ allowed: true, access: "rw" });
    expect(
      canonicalizeApprovedCwd("D:\\Outside", [{ path: "C:\\", access: "rw" }], realpath).allowed,
    ).toBe(false);
  });

  it("rejects relative and unapproved cwd values", () => {
    expect(canonicalizeApprovedCwd("relative", [], realpath).reason).toContain("absolute");
    expect(
      canonicalizeApprovedCwd("D:\\Outside", [{ path: "C:\\Approved", access: "rw" }], realpath)
        .reason,
    ).toContain("outside");
  });

  it("rejects a resolved cwd outside the approved roots", () => {
    const result = canonicalizeApprovedCwd(
      "C:\\Junction",
      [{ path: "C:\\Approved", access: "rw" }],
      realpath,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("outside");
  });
});

describe("Windows Node MXC global folder policy", () => {
  const realpath = (candidate: string) => candidate;
  const noReparse = () => false;

  it("canonicalizes empty-list RO and RW additions", () => {
    expect(planWindowsNodeMxcFolderUpsert({ rw: [], ro: [] }, "C:\\Data\\", "ro")).toEqual({
      ok: true,
      dirs: { rw: [], ro: ["C:\\Data"] },
    });
    expect(planWindowsNodeMxcFolderUpsert({ rw: [], ro: [] }, "C:\\Work", "rw")).toEqual({
      ok: true,
      dirs: { rw: ["C:\\Work"], ro: [] },
    });
  });

  it("deduplicates case-insensitively and changes equal-path access", () => {
    expect(
      planWindowsNodeMxcFolderUpsert({ rw: ["C:\\Data"], ro: [] }, "c:\\data", "rw"),
    ).toMatchObject({ ok: false, reason: "duplicate" });
    expect(planWindowsNodeMxcFolderUpsert({ rw: [], ro: ["C:\\Data"] }, "c:\\data", "rw")).toEqual({
      ok: true,
      dirs: { rw: ["c:\\data"], ro: [] },
    });
    expect(isWindowsNodeMxcFolderConfigured({ rw: ["C:\\Data"], ro: [] }, "c:\\DATA")).toBe(true);
  });

  it.each(["ro", "rw"] as const)(
    "retains explicit child folders when adding and later removing an %s parent",
    (access) => {
      const children = { rw: ["C:\\Data\\RwChild"], ro: ["C:\\Data\\RoChild"] };
      const result = planWindowsNodeMxcFolderUpsert(children, "C:\\Data", access);
      expect(result).toEqual({
        ok: true,
        dirs:
          access === "rw"
            ? { rw: ["C:\\Data", "C:\\Data\\RwChild"], ro: ["C:\\Data\\RoChild"] }
            : { rw: ["C:\\Data\\RwChild"], ro: ["C:\\Data", "C:\\Data\\RoChild"] },
      });

      const validate = (candidate: string) => ({ ok: true, canonicalPath: candidate });
      const saved = normalizeWindowsNodeMxcFolderPolicy(result.dirs, validate);
      expect(saved).toMatchObject({ ok: true, dirs: result.dirs });
      const withoutParent = {
        rw: saved.dirs.rw.filter((folder) => folder !== "C:\\Data"),
        ro: saved.dirs.ro.filter((folder) => folder !== "C:\\Data"),
      };
      expect(normalizeWindowsNodeMxcFolderPolicy(withoutParent, validate)).toEqual({
        ok: true,
        dirs: children,
      });
    },
  );

  it.each([
    ["ro", "ro"],
    ["ro", "rw"],
    ["rw", "ro"],
    ["rw", "rw"],
  ] as const)("allows an explicit %s child under an %s parent", (childAccess, parentAccess) => {
    const parent = { rw: [], ro: [] } as { rw: string[]; ro: string[] };
    parent[parentAccess].push("C:\\Data");
    const result = planWindowsNodeMxcFolderUpsert(parent, "C:\\Data\\Child", childAccess);
    expect(result.ok).toBe(true);
    expect(result.dirs[parentAccess]).toContain("C:\\Data");
    expect(result.dirs[childAccess]).toContain("C:\\Data\\Child");
  });

  it("retains an explicit child when its access changes to match its parent", () => {
    const result = planWindowsNodeMxcFolderUpsert(
      { rw: ["C:\\Data\\Child"], ro: ["C:\\Data"] },
      "C:\\Data\\Child",
      "ro",
    );

    expect(result).toMatchObject({
      ok: true,
      dirs: { rw: [], ro: ["C:\\Data", "C:\\Data\\Child"] },
    });
  });

  it("rejects UNC, device, and reparse paths", () => {
    for (const candidate of [
      "\\\\server\\share",
      "\\\\?\\C:\\Data",
      "\\??\\C:\\Data",
      "\\Device\\HarddiskVolume1",
    ]) {
      expect(validateWindowsNodeMxcFolderPath(candidate, realpath, noReparse)).toMatchObject({
        ok: false,
        reason: "path-nonlocal",
      });
    }
    expect(
      validateWindowsNodeMxcFolderPath(
        "C:\\Data\\Junction",
        realpath,
        (candidate) => candidate.toLowerCase() === "c:\\data\\junction",
      ),
    ).toMatchObject({ ok: false, reason: "path-reparse-point" });
  });

  it("admits a profile parent without adding MicroClaw-specific protected roots", () => {
    expect(validateWindowsNodeMxcFolderPath("C:\\Users\\Alice", realpath, noReparse)).toEqual({
      ok: true,
      canonicalPath: "C:\\Users\\Alice",
    });
    expect(validateWindowsNodeMxcFolderPath("C:\\Users\\Alice\\.aws", realpath, noReparse)).toEqual(
      { ok: true, canonicalPath: "C:\\Users\\Alice\\.aws" },
    );
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

  it("normalizes a complete policy deterministically and rejects equal access conflicts", () => {
    const validate = (candidate: string) => ({ ok: true, canonicalPath: candidate });
    expect(
      normalizeWindowsNodeMxcFolderPolicy(
        {
          rw: ["C:\\Data\\Write", "C:\\All"],
          ro: ["C:\\Data", "C:\\All\\Read", "c:\\data"],
        },
        validate,
      ),
    ).toEqual({
      ok: true,
      dirs: {
        rw: ["C:\\All", "C:\\Data\\Write"],
        ro: ["C:\\All\\Read", "c:\\data"],
      },
    });
    expect(
      normalizeWindowsNodeMxcFolderPolicy({ rw: ["C:\\Data"], ro: ["c:\\data"] }, validate),
    ).toMatchObject({ ok: false, reason: "duplicate", path: "C:\\Data" });
  });
});

describe("MXC probe and smoke classification", () => {
  it("rejects retired DACL-only probe results as unsupported evidence", () => {
    const probe = classifyMxcProbe(
      0,
      JSON.stringify({
        contract: "microclaw.mxc-sdk-probe.v1",
        supported: false,
        windowsUnsupported: false,
        probeErrored: false,
        needsDaclAugmentation: true,
        supportsProtectedPathDenies: false,
        tier: "appcontainer-dacl",
        warnings: [],
        reasons: ["Legacy DACL-only containment is retired"],
      }),
      "",
    );
    expect(probe.outcome).toBe("error");
    expect(probe.reason).toContain("Legacy DACL-only containment is retired");
    expect(describeMxcExactBackendEligibility(probe)).toMatchObject({
      eligible: false,
      blockers: [expect.stringContaining("Legacy DACL-only containment is retired")],
    });
  });

  it("does not interpret legacy DACL augmentation metadata as a supported mode", () => {
    const probe = classifyMxcProbe(
      0,
      JSON.stringify({
        contract: "microclaw.mxc-sdk-probe.v1",
        supported: true,
        windowsUnsupported: false,
        probeErrored: false,
        needsDaclAugmentation: true,
        supportsProtectedPathDenies: true,
        tier: "base-container",
        warnings: [],
        reasons: [],
      }),
      "",
    );
    expect(probe.outcome).toBe("error");
    expect(probe.reason).toContain("MXC did not verify BaseContainer");
  });

  it("treats base-container and BFS as full-strength", () => {
    expect(
      classifyMxcProbe(
        0,
        JSON.stringify({
          contract: "microclaw.mxc-sdk-probe.v1",
          supported: true,
          windowsUnsupported: false,
          probeErrored: false,
          needsDaclAugmentation: false,
          supportsProtectedPathDenies: true,
          tier: "base-container",
          warnings: [],
          reasons: [],
        }),
        "",
      ).outcome,
    ).toBe("supported");
    expect(
      classifyMxcProbe(
        0,
        JSON.stringify({
          contract: "microclaw.mxc-sdk-probe.v1",
          supported: false,
          windowsUnsupported: false,
          probeErrored: false,
          needsDaclAugmentation: false,
          supportsProtectedPathDenies: false,
          tier: "appcontainer-bfs",
          warnings: [],
          reasons: ["This legacy backend is not supported"],
        }),
        "",
      ).outcome,
    ).toBe("error");
  });

  it("rejects contradictory exact-backend probe evidence", () => {
    expect(
      classifyMxcProbe(
        0,
        JSON.stringify({
          tier: "base-container",
          probes: { baseContainerApiPresent: false },
        }),
        "",
      ).outcome,
    ).toBe("error");
    expect(
      classifyMxcProbe(
        0,
        JSON.stringify({
          tier: "appcontainer-bfs",
          probes: { bfsCompiledIn: false, bfscfgPresent: true },
        }),
        "",
      ).outcome,
    ).toBe("error");
  });

  it("fails closed on an unknown isolation tier", () => {
    const probe = classifyMxcProbe(
      0,
      JSON.stringify({
        contract: "microclaw.mxc-sdk-probe.v1",
        supported: false,
        windowsUnsupported: false,
        probeErrored: false,
        needsDaclAugmentation: false,
        supportsProtectedPathDenies: false,
        tier: "host",
        warnings: [],
        reasons: ["Unrecognized isolation tier"],
      }),
      "",
    );
    expect(probe.outcome).toBe("error");
    expect(probe.reason).toContain("Unrecognized isolation tier");
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

  it("requires an explicit typed denial for an unapproved CWD", () => {
    expect(classifyDeniedCwdSmoke("cwd-sensitive-root: protected")).toMatchObject({
      outcome: "failed",
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

    node!.commands.push("system.run.readiness", "system.which", "system.run.cwd-policy");
    expect(validateSelectedWindowsNode(node).ready).toBe(true);

    expect(validateSelectedWindowsNode(node).ready).toBe(true);
  });
});
