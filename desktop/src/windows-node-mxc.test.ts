import { describe, expect, it } from "vitest";
import {
  applyWindowsNodeCommandPolicy,
  applyWindowsNodeMxcGatewayPolicy,
  assertWindowsNodeMxcFolderPolicyMutable,
  buildWindowsNodeMxcLockedToolPolicy,
  buildWindowsNodeMxcToolPolicy,
  canonicalizeApprovedCwd,
  classifyMxcProbe,
  classifyMxcSmoke,
  classifyMissingEffectiveToolSession,
  describeMxcExactBackendEligibility,
  extractEffectiveToolNames,
  getMxcTierWarning,
  getWindowsNodeMxcGatewayPolicyState,
  isWindowsNodeMxcIngressReleased,
  isWindowsNodeMxcFolderConfigured,
  listAgentSessionKeys,
  migrateWindowsNodeMxcToolBackupAliases,
  normalizeWindowsNodeMxcGatewayApproval,
  normalizeWindowsNodeMxcFolderPolicy,
  normalizeWindowsNodeRecord,
  planWindowsNodeMxcFolderUpsert,
  restoreWindowsNodeMxcGatewayPolicy,
  selectWindowsNodeMxcGatewayStartPolicy,
  validateEffectiveToolNames,
  validateNoGatewayNativeFilesystemTools,
  validateSelectedWindowsNode,
  validateWindowsNodeMxcGatewayPolicy,
  validateWindowsNodeMxcFolderPath,
  validateWindowsNodeMxcSettings,
  WINDOWS_NODE_MXC_CANVAS_COMMANDS,
  WINDOWS_NODE_MXC_GATEWAY_NATIVE_FS_TOOLS,
  WINDOWS_NODE_MXC_MEMORY_TOOLS,
  WINDOWS_NODE_MXC_TOOL_ALLOWLIST,
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
  NodeCanvasEnabled: true,
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
          profile: "limited-minimal-smoke",
          execution: { outcome: "passed", reason: "ok" },
        }),
      ).toBe(false);
    });

    it("binds smoke proof and ingress release to the exact Gateway generation", () => {
      const smoke = {
        profile: "limited-minimal-smoke" as const,
        gatewayGeneration: "generation-1",
        nodeId: "node-1",
        settingsFingerprint: "settings-1",
        probeTier: "appcontainer-dacl",
        containmentStrength: "limited-dacl" as const,
        ambientAccessHash: "a".repeat(64),
        checkedAt: new Date().toISOString(),
        execution: { outcome: "passed" as const, reason: "ok" },
        deniedOutsideRoot: null,
      };

      expect(
        selectCurrentWindowsNodeMxcSmoke(
          smoke,
          "generation-1",
          "node-1",
          "settings-1",
          "appcontainer-dacl",
          "limited-dacl",
          "a".repeat(64),
        ),
      ).toBe(smoke);
      expect(
        selectCurrentWindowsNodeMxcSmoke(
          smoke,
          "generation-2",
          "node-1",
          "settings-1",
          "appcontainer-dacl",
          "limited-dacl",
          "a".repeat(64),
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
  it("routes regular exec through the node without disabling existing native file tools", () => {
    const source = {
      tools: { allow: ["read", "write", "edit", "exec"], deny: ["browser"] },
      agents: {
        entries: {
          main: { tools: { allow: ["read", "write", "exec"] } },
          coder: { tools: { deny: ["browser"] } },
        },
      },
      gateway: {
        nodes: {
          commands: { allow: ["custom.read"], deny: ["other", "canvas.snapshot", "system.run"] },
        },
      },
    };
    const original = structuredClone(source);
    const applied = applyWindowsNodeCommandPolicy(source, "node-123");

    expect(source).toEqual(original);
    expect(applied).toMatchObject({
      tools: {
        allow: ["read", "write", "edit", "exec"],
        deny: ["browser"],
        exec: { host: "node", node: "node-123", ask: "always" },
      },
      agents: {
        entries: {
          main: {
            tools: {
              allow: ["read", "write", "exec"],
              exec: { host: "node", node: "node-123", ask: "always" },
            },
          },
          coder: { tools: { deny: ["browser"], exec: { node: "node-123" } } },
        },
      },
      gateway: {
        nodes: {
          commands: {
            allow: expect.arrayContaining([
              "custom.read",
              "system.run",
              "system.run.prepare",
              "system.which",
              "system.run.cwd-policy",
            ]),
            deny: ["other", "canvas.snapshot"],
          },
        },
      },
    });
    expect((applied.gateway as typeof source.gateway).nodes.commands.allow).not.toContain(
      "canvas.snapshot",
    );
    expect(applyWindowsNodeCommandPolicy(applied, "node-123")).toEqual(applied);
  });

  it("gives an explicit Gateway-start policy precedence over activation state", () => {
    expect(selectWindowsNodeMxcGatewayStartPolicy("locked", true)).toBe("locked");
    expect(selectWindowsNodeMxcGatewayStartPolicy("active", false)).toBe("active");
    expect(selectWindowsNodeMxcGatewayStartPolicy(null, true)).toBe("active");
    expect(selectWindowsNodeMxcGatewayStartPolicy(null, false)).toBe("locked");
  });

  it("exposes contained exec, Gateway web, brokered messaging, and reviewed Canvas while pinning exec", () => {
    expect(buildWindowsNodeMxcToolPolicy("node-123")).toEqual({
      profile: "full",
      allow: [
        "exec",
        "web_search",
        "web_fetch",
        "message",
        "canvas",
        "memory_search",
        "memory_get",
      ],
      deny: ["process", "group:fs"],
      codeMode: false,
      exec: {
        host: "node",
        node: "node-123",
        security: "allowlist",
        ask: "always",
        timeoutSeconds: 1800,
        strictInlineEval: true,
      },
    });
  });

  it("applies the policy to every configured agent and restores prior tools", () => {
    const source = {
      agents: {
        list: [
          {
            id: "main",
            tools: { allow: [...WINDOWS_NODE_MXC_GATEWAY_NATIVE_FS_TOOLS] },
          },
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

  it.each(["active", "locked"] as const)(
    "preserves keyed explicit rosters through %s policy and restoration",
    (state) => {
      const source = {
        agents: {
          ownership: "explicit",
          entries: { main: { tools: { allow: ["read"] } }, coder: { name: "Coder" } },
        },
      };
      const applied = applyWindowsNodeMxcGatewayPolicy(source, "node-123", {}, state);
      expect(applied.agentIds).toEqual(["main", "coder"]);
      expect(applied.config.agents).not.toHaveProperty("list");
      expect(applied.config.agents).toHaveProperty("ownership", "explicit");
      expect(validateWindowsNodeMxcGatewayPolicy(applied.config, "node-123", state).ready).toBe(
        true,
      );
      expect(restoreWindowsNodeMxcGatewayPolicy(applied.config, applied.backups)).toEqual(source);
    },
  );

  it("preserves original tool backups across canonical agent ID migrations", () => {
    const originalTools = { allow: ["legacy-tool"] };
    const pinnedTools = buildWindowsNodeMxcToolPolicy("node-123");
    const backups = migrateWindowsNodeMxcToolBackupAliases(
      { singer: originalTools },
      { singer: "creative-muse" },
    );
    const migratedConfig = {
      agents: {
        list: [
          { id: "creative-muse", tools: pinnedTools },
          { id: "singer", tools: pinnedTools },
        ],
      },
    };

    expect(restoreWindowsNodeMxcGatewayPolicy(migratedConfig, backups)).toEqual({
      agents: {
        list: [
          { id: "creative-muse", tools: originalTools },
          { id: "singer", tools: originalTools },
        ],
      },
    });
    expect(
      migrateWindowsNodeMxcToolBackupAliases(
        { singer: originalTools, "creative-muse": { allow: ["canonical-tool"] } },
        { singer: "creative-muse" },
      ),
    ).toMatchObject({
      "creative-muse": { allow: ["canonical-tool"] },
    });
  });

  it("keeps only requested WeChat lifecycle loaded while pausing other ingress", () => {
    const source = {
      agents: { list: [{ id: "main" }] },
      channels: {
        discord: { enabled: true, token: "preserved" },
        "openclaw-weixin": { enabled: true },
      },
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
      channels: {
        discord: { enabled: false, token: "preserved" },
        "openclaw-weixin": { enabled: true },
      },
      hooks: { enabled: false, token: "preserved", internal: { enabled: false } },
      cron: { enabled: false, maxConcurrentRuns: 2 },
      plugins: {
        enabled: true,
        allow: ["canvas", "memory-core", "openclaw-weixin"],
        slots: {
          memory: "memory-core",
        },
        entries: {
          "openclaw-weixin": { enabled: true },
          canvas: { enabled: true },
          "memory-core": { enabled: true },
        },
      },
    });
    expect(validateWindowsNodeMxcGatewayPolicy(applied.config, "node-123", "locked").ready).toBe(
      true,
    );
    expect(restoreWindowsNodeMxcGatewayPolicy(applied.config, applied.backups)).toEqual(source);
  });

  it.each(["locked", "active"] as const)(
    "keeps the configured Copilot provider loaded without relaxing the %s tool policy",
    (state) => {
      const source = {
        agents: {
          defaults: { model: { primary: "github-copilot/gpt-6.1-sol" } },
          list: [{ id: "main" }],
        },
        plugins: {
          allow: ["unsafe-provider"],
          deny: ["github-copilot", "unsafe-provider"],
          entries: {
            "github-copilot": { enabled: false },
            "unsafe-provider": { enabled: true },
            "memory-core": { enabled: true },
          },
        },
      };
      const original = structuredClone(source);
      const applied = applyWindowsNodeMxcGatewayPolicy(source, "node-123", {}, state);

      expect(applied.config).toMatchObject({
        plugins: {
          allow: ["canvas", "memory-core", "github-copilot"],
          deny: ["unsafe-provider"],
          slots: { memory: "memory-core" },
          entries: {
            canvas: { enabled: true },
            "github-copilot": { enabled: true },
            "unsafe-provider": { enabled: false },
            "memory-core": { enabled: true },
          },
        },
      });
      const agents = applied.config.agents as { list: Array<{ tools: unknown }> };
      expect(agents.list[0].tools).toEqual(
        state === "locked"
          ? buildWindowsNodeMxcLockedToolPolicy("node-123")
          : buildWindowsNodeMxcToolPolicy("node-123"),
      );
      expect(validateWindowsNodeMxcGatewayPolicy(applied.config, "node-123", state).ready).toBe(
        true,
      );
      expect(source).toEqual(original);
      expect(restoreWindowsNodeMxcGatewayPolicy(applied.config, applied.backups)).toEqual(source);
      expect(
        applyWindowsNodeMxcGatewayPolicy(applied.config, "node-123", applied.backups, state),
      ).toEqual(applied);
    },
  );

  it("preserves an explicitly enabled Copilot provider for session overrides", () => {
    const source = {
      agents: { defaults: { model: "qwen/qwen3.7-plus" }, list: [{ id: "main" }] },
      plugins: { entries: { "github-copilot": { enabled: true } } },
    };
    const applied = applyWindowsNodeMxcGatewayPolicy(source, "node-123", {}, "active");

    expect(applied.config).toMatchObject({
      plugins: {
        allow: ["canvas", "memory-core", "github-copilot"],
        entries: { "github-copilot": { enabled: true } },
      },
    });
    expect(validateWindowsNodeMxcGatewayPolicy(applied.config, "node-123").ready).toBe(true);
  });

  it("rejects a suppressed configured provider, a denied provider, and unreviewed plugins", () => {
    const source = {
      agents: {
        defaults: { model: "github-copilot/gpt-6.1-sol" },
        list: [{ id: "main" }],
      },
    };
    const baseline = applyWindowsNodeMxcGatewayPolicy(source, "node-123", {}, "active").config;
    const suppressed = structuredClone(baseline);
    suppressed.plugins = {
      ...(baseline.plugins as Record<string, unknown>),
      allow: ["canvas"],
      entries: { canvas: { enabled: true }, "github-copilot": { enabled: false } },
    };
    const denied = structuredClone(baseline);
    denied.plugins = {
      ...(baseline.plugins as Record<string, unknown>),
      deny: ["github-copilot"],
    };
    const unreviewed = structuredClone(baseline);
    unreviewed.plugins = {
      ...(baseline.plugins as Record<string, unknown>),
      allow: ["canvas", "github-copilot", "unsafe-provider"],
      entries: {
        canvas: { enabled: true },
        "github-copilot": { enabled: true },
        "unsafe-provider": { enabled: true },
      },
    };

    for (const drift of [suppressed, denied, unreviewed]) {
      expect(validateWindowsNodeMxcGatewayPolicy(drift, "node-123").ready).toBe(false);
    }
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
    const implicitMemoryCore = structuredClone(baseline);
    (
      implicitMemoryCore.plugins as {
        slots: Record<string, string>;
      }
    ).slots = {};
    expect(
      validateWindowsNodeMxcGatewayPolicy(implicitMemoryCore, "node-123", "active").blockers,
    ).toContain(
      'Gateway scoped memory recall requires the enabled memory-core plugin and plugins.slots.memory="memory-core"',
    );
  });

  it("never exposes Cron or automations tools and preserves native filesystem denial", () => {
    expect(WINDOWS_NODE_MXC_TOOL_ALLOWLIST).not.toContain("cron");
    expect(WINDOWS_NODE_MXC_TOOL_ALLOWLIST).not.toContain("automations");

    for (const forbiddenTool of ["cron", "automations"]) {
      const source = { agents: { list: [{ id: "main" }] } };
      const applied = applyWindowsNodeMxcGatewayPolicy(source, "node-123", {}, "active").config;
      const agent = (applied.agents as { list: Array<{ tools: { allow: string[] } }> }).list[0];
      agent.tools.allow.push(forbiddenTool);

      const result = validateWindowsNodeMxcGatewayPolicy(applied, "node-123", "active");
      expect(result.ready).toBe(false);
    }

    const policy = buildWindowsNodeMxcToolPolicy("node-123");
    expect(policy.deny).toContain("group:fs");
    for (const filesystemTool of WINDOWS_NODE_MXC_GATEWAY_NATIVE_FS_TOOLS) {
      expect(policy.allow).not.toContain(filesystemTool);
    }
  });

  it("preserves memory sources and plugin settings through active, locked, and Off transitions", () => {
    const source = {
      agents: {
        entries: {
          main: { workspace: "C:\\Users\\test\\.openclaw\\workspace" },
          coder: { tools: { allow: ["read", "memory_get"] } },
        },
      },
      memory: { search: { provider: "none", sources: ["memory"] } },
      plugins: {
        allow: ["other-memory"],
        deny: ["memory-core"],
        slots: { memory: "other-memory" },
        entries: {
          "other-memory": { enabled: true },
          "memory-core": { enabled: false, config: { dreaming: { enabled: false } } },
        },
      },
    };
    const original = structuredClone(source);
    const active = applyWindowsNodeMxcGatewayPolicy(source, "node-123");
    const locked = applyWindowsNodeMxcGatewayPolicy(
      active.config,
      "node-123",
      active.backups,
      "locked",
    );
    const resumed = applyWindowsNodeMxcGatewayPolicy(
      locked.config,
      "node-123",
      locked.backups,
      "active",
    );
    expect(active.config).toMatchObject({
      memory: source.memory,
      plugins: {
        allow: ["canvas", "memory-core"],
        deny: [],
        slots: { memory: "memory-core" },
        entries: {
          "other-memory": { enabled: false },
          "memory-core": { enabled: true, config: { dreaming: { enabled: false } } },
        },
      },
      cron: { enabled: false },
      hooks: { enabled: false, internal: { enabled: false } },
    });
    expect(validateWindowsNodeMxcGatewayPolicy(active.config, "node-123").ready).toBe(true);
    expect(validateWindowsNodeMxcGatewayPolicy(locked.config, "node-123", "locked").ready).toBe(
      true,
    );
    expect(resumed).toEqual(active);
    expect(restoreWindowsNodeMxcGatewayPolicy(resumed.config, resumed.backups)).toEqual(source);
    expect(source).toEqual(original);
    const regular = applyWindowsNodeCommandPolicy(source, "node-123");
    expect(regular.plugins).toEqual(source.plugins);
    expect(regular.memory).toEqual(source.memory);
  });

  it("rejects disabled, denied, or substituted memory providers", () => {
    const baseline = applyWindowsNodeMxcGatewayPolicy(
      { agents: { entries: { main: {} } } },
      "node-123",
    ).config;
    const plugins = baseline.plugins as Record<string, unknown>;
    for (const change of [
      { slots: { memory: "none" } },
      { slots: { memory: "other-memory" } },
      { deny: ["memory-core"] },
      { allow: ["canvas"] },
      { entries: { canvas: { enabled: true }, "memory-core": { enabled: false } } },
    ]) {
      expect(
        validateWindowsNodeMxcGatewayPolicy(
          { ...baseline, plugins: { ...plugins, ...change } },
          "node-123",
        ).ready,
      ).toBe(false);
    }
    for (const denied of [...WINDOWS_NODE_MXC_MEMORY_TOOLS, "group:memory"]) {
      expect(
        validateWindowsNodeMxcGatewayPolicy({ ...baseline, tools: { deny: [denied] } }, "node-123")
          .blockers,
      ).toContain("Global Gateway tool policy blocks scoped memory recall");
    }
  });

  it("requires both recall tools when active and exposes neither when locked", () => {
    for (const tool of WINDOWS_NODE_MXC_MEMORY_TOOLS) {
      expect(
        validateEffectiveToolNames(WINDOWS_NODE_MXC_TOOL_ALLOWLIST.filter((name) => name !== tool))
          .ready,
      ).toBe(false);
      expect(validateEffectiveToolNames([tool], "locked").ready).toBe(false);
    }
    for (const tool of ["intent", "read", "write", "edit", "apply_patch", "cron", "gateway"]) {
      expect(validateEffectiveToolNames([...WINDOWS_NODE_MXC_TOOL_ALLOWLIST, tool]).ready).toBe(
        false,
      );
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

  it.each(WINDOWS_NODE_MXC_GATEWAY_NATIVE_FS_TOOLS)(
    "fails closed when policy drift enables the Gateway-native %s tool",
    (filesystemTool) => {
      const config = {
        agents: {
          list: [
            {
              id: "main",
              tools: {
                ...buildWindowsNodeMxcToolPolicy("node-123"),
                allow: ["exec", filesystemTool],
              },
            },
          ],
        },
      };
      const result = validateWindowsNodeMxcGatewayPolicy(config, "node-123");
      expect(result.ready).toBe(false);
      expect(result.blockers).toContain(
        `Agent "main" enables Gateway-native filesystem tools while MXC is enabled: ${filesystemTool}`,
      );
    },
  );

  it("detects plugin or host-exec policy drift", () => {
    const config = {
      agents: {
        list: [
          {
            id: "main",
            tools: {
              ...buildWindowsNodeMxcToolPolicy("node-123"),
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

  it("requires the exact reviewed inventory including scoped memory recall", () => {
    expect(
      validateEffectiveToolNames([
        "exec",
        "web_search",
        "web_fetch",
        "message",
        "canvas",
        "memory_search",
        "memory_get",
      ]).ready,
    ).toBe(true);
    expect(validateEffectiveToolNames(["exec"]).ready).toBe(false);
    expect(validateEffectiveToolNames(["exec", "read"]).ready).toBe(false);
  });

  it.each(["full", "limited-dacl"] as const)(
    "keeps Gateway-native filesystem tools forbidden for %s when safe capabilities are restored",
    () => {
      const restoredCapabilities = [...WINDOWS_NODE_MXC_TOOL_ALLOWLIST];
      expect(validateNoGatewayNativeFilesystemTools(restoredCapabilities).ready).toBe(true);

      for (const filesystemTool of WINDOWS_NODE_MXC_GATEWAY_NATIVE_FS_TOOLS) {
        const check = validateNoGatewayNativeFilesystemTools([
          ...restoredCapabilities,
          filesystemTool,
        ]);
        expect(check.ready).toBe(false);
        expect(check.blockers[0]).toContain(filesystemTool);
        const effectiveCheck = validateEffectiveToolNames([
          "exec",
          "web_search",
          "web_fetch",
          "message",
          filesystemTool,
        ]);
        expect(effectiveCheck.ready).toBe(false);
        expect(validateEffectiveToolNames([filesystemTool], "locked").ready).toBe(false);
        expect(
          shouldStopManagedGatewayForWindowsNodeMxc({
            effectiveEnabled: false,
            effectiveToolsState: effectiveCheck.ready ? "verified" : "drift",
            gatewayPolicyState: "active",
          }),
        ).toBe(true);
      }
    },
  );

  it("fails closed when the filesystem group denial is removed", () => {
    const policy = buildWindowsNodeMxcToolPolicy("node-123") as {
      deny: string[];
    };
    policy.deny = policy.deny.filter((entry) => entry !== "group:fs");
    const result = validateWindowsNodeMxcGatewayPolicy(
      { agents: { list: [{ id: "main", tools: policy }] } },
      "node-123",
    );
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain(
      'Agent "main" does not deny the Gateway-native filesystem tool group',
    );
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

  it("blocks host fallback, missing contained network, clipboard, MCP, and peripheral drift", () => {
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
        ro: ["c:\\data"],
      },
    });
    expect(
      normalizeWindowsNodeMxcFolderPolicy({ rw: ["C:\\Data"], ro: ["c:\\data"] }, validate),
    ).toMatchObject({ ok: false, reason: "duplicate", path: "C:\\Data" });
  });
});

describe("MXC probe and smoke classification", () => {
  it("fails closed on DACL-only machines", () => {
    const probe = classifyMxcProbe(
      0,
      JSON.stringify({
        tier: "appcontainer-dacl",
        needsDaclAugmentation: true,
        probes: {
          baseContainerApiPresent: false,
          bfscfgPresent: false,
          bfsCompiledIn: false,
        },
      }),
      "",
    );
    expect(probe.outcome).toBe("unsupported");
    expect(probe.degraded).toBe(true);
    expect(probe.probes).toEqual({
      baseContainerApiPresent: false,
      bfscfgPresent: false,
      bfsCompiledIn: false,
    });
    expect(probe.reason).toContain("cannot enforce the configured filesystem roots");
    expect(getMxcTierWarning(probe)).toContain("Rejected degraded MXC containment");
    expect(describeMxcExactBackendEligibility(probe)).toMatchObject({
      eligible: false,
      blockers: [
        expect.stringContaining("Base Container API is unavailable"),
        expect.stringContaining("runtime was built without the appcontainer-bfs backend"),
      ],
      remediation: [
        expect.stringContaining("processmodel.dll"),
        expect.stringContaining("Do not copy bfscfg.exe"),
      ],
    });
  });

  it("fails closed when an otherwise strong tier requests DACL augmentation", () => {
    const probe = classifyMxcProbe(
      0,
      JSON.stringify({ tier: "base-container", needsDaclAugmentation: true }),
      "",
    );
    expect(probe.outcome).toBe("unsupported");
    expect(probe.degraded).toBe(true);
  });

  it("treats base-container and BFS as full-strength", () => {
    expect(
      classifyMxcProbe(
        0,
        JSON.stringify({
          tier: "base-container",
          probes: { baseContainerApiPresent: true },
        }),
        "",
      ).outcome,
    ).toBe("supported");
    expect(
      classifyMxcProbe(
        0,
        JSON.stringify({
          tier: "appcontainer-bfs",
          probes: { bfsCompiledIn: true, bfscfgPresent: true },
        }),
        "",
      ).outcome,
    ).toBe("supported");
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

    node!.commands.push(
      "system.run.readiness",
      "system.which",
      "system.run.cwd-policy",
      ...WINDOWS_NODE_MXC_CANVAS_COMMANDS,
    );
    expect(validateSelectedWindowsNode(node).ready).toBe(true);

    node!.commands.push("canvas.eval");
    expect(validateSelectedWindowsNode(node)).toMatchObject({
      ready: false,
      blockers: ["Selected node declares unexpected commands: canvas.eval"],
    });
  });
});
