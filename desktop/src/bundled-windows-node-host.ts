import { app } from "electron";
import {
  type ChildProcessWithoutNullStreams,
  execFile,
  execFileSync,
  spawn,
} from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { CommandConsentMode } from "./command-consent";
import {
  type PowerShellFilesystemInitialization,
  validateNativePowerShellFilesystemInitialization,
} from "./windows-node-mxc-powershell-scope";
import { WINDOWS_NODE_MXC_NODE_COMMANDS } from "./windows-node-mxc";
import {
  type WindowsNodeMxcAmbientAccessAssessment,
  type WindowsNodeMxcAmbientAccessCategory,
  type WindowsNodeMxcEffectiveStrength,
} from "./windows-node-mxc-modes";
import { resolveWindowsNodeMxcWeixinMediaRoots } from "./windows-node-mxc-weixin";
import { loadGatewayEnvironment } from "./path-resolver";
import {
  WindowsNodeMxcPolicyAuthority,
  type LivePolicyApproval,
} from "./windows-node-mxc-live-policy";

export const BUNDLED_WINDOWS_NODE_CWD_CONTRACT = "microclaw.windows-cwd.v1";
export const BUNDLED_WINDOWS_NODE_ACTIVATION_CONTRACT = "microclaw.windows-activation.v1";
export const BUNDLED_WINDOWS_NODE_APPROVAL_PROOF_CONTRACT = "microclaw.windows-node-approval.v2";
export const BUNDLED_WINDOWS_NODE_RUNTIME_CONTRACT = "microclaw.windows-node-exec.v2";
export const BUNDLED_WINDOWS_NODE_DISPLAY_NAME = "MicroClaw Bundled Windows Node";
export const BUNDLED_WINDOWS_NODE_REVISION = "f0592215f27100d9ecece33d3069daac76a4125c";
const MXC_SDK_MANAGED_SHA256 = "59761d9a868cde01ef05139775ad6d072f9425b5b73b911bdf465b29b4bf20a6";
const MXC_SDK_NATIVE_SHA256 = {
  x64: {
    "mxc_ffi.dll": "bd45522f06dc9cc8001dcd5d7320bc2bf303fb08a39bf10f3404bd9a8001812c",
    "plm.exe": "beffc9c9ab974ca9e7455089fd8ecb36eb8c92811ddd1705db91370a689692c3",
    "wslcsdk.dll": "8d4d55d4283fb32a5909b57e78b576d01363d7b28bb9b2595115e80faf61db5b",
    "wxc-wslc-daemon.exe": "84f61c1bc13abde8da1c3f2ff100e6d59368ecaabdbfeca939e6fdb696202d0c",
  },
  arm64: {
    "mxc_ffi.dll": "1becaf695ad9ab6f6fe21ca4ad2e838d9218996a5d42cb82e609df1eb4d3db6b",
    "plm.exe": "8818982c6b91c78d9198dc03d5efc8a9a34a1075afb4a6a3e9f1a750c5462532",
    "wslcsdk.dll": "ad440e116a64af004fe021b95914163021c2e8f40b0f8b6d8ece210ee5cae3d4",
    "wxc-wslc-daemon.exe": "ad9a7a42a607c2670e493b9f4d5eb4f2cd959c9d05b8882df42f9d8ecc1f6fef",
  },
} as const;

export interface BundledWindowsNodeFolder {
  path: string;
  access: "ro" | "rw";
}

export interface BundledWindowsNodeHostStatus {
  processRunning: boolean;
  processId: number | null;
  hostPath: string;
  sdkProbePath: string;
  runtimeVersion: "1.0.1";
  cwdPolicyContract: typeof BUNDLED_WINDOWS_NODE_CWD_CONTRACT;
  displayName: typeof BUNDLED_WINDOWS_NODE_DISPLAY_NAME;
  helperRevision: typeof BUNDLED_WINDOWS_NODE_REVISION;
  pendingApproval: BundledApprovalRequest | null;
  lastError: string | null;
  nodeId: string | null;
  gatewayGeneration: string | null;
  policyFingerprint: string | null;
  activationLease: BundledWindowsNodeActivationLease | null;
  requestedStrength: WindowsNodeMxcEffectiveStrength | null;
  effectiveTier: string | null;
  ambientAccess: WindowsNodeMxcAmbientAccessAssessment | null;
}

export interface BundledWindowsNodeActivationLease {
  contract: typeof BUNDLED_WINDOWS_NODE_ACTIVATION_CONTRACT;
  mode: "diagnostic" | "active";
  gatewayGeneration: string;
  policyFingerprint: string;
  expiresAtUnixMs: number;
}

export interface BundledWindowsNodeApprovalProofContext {
  contract: typeof BUNDLED_WINDOWS_NODE_APPROVAL_PROOF_CONTRACT;
  secretBase64: string;
  gatewayGeneration: string;
  policyFingerprint: string;
  nodeId: string;
  readinessTransitionId: string;
}

export interface BundledApprovalRequest {
  id: string;
  executable: string;
  arguments: string[];
  agent: string | null;
  canonicalCwd: string;
  declaredAccess: Array<{
    access: "ro" | "rw";
    path: string;
  }>;
  providerInitialization?: PowerShellFilesystemInitialization;
}

interface StartOptions {
  gatewayUrl: string;
  gatewayToken: string;
  gatewayProcessId: number;
  gatewayGeneration: string;
  uiLocale: string;
  openClawStateRoot: string;
  folders: BundledWindowsNodeFolder[];
  requestedStrength: WindowsNodeMxcEffectiveStrength;
  commandConsentMode?: CommandConsentMode;
  effectiveTier: string;
  ambientAccess: BundledWindowsNodeAmbientAccess | null;
  approvalProof: BundledWindowsNodeApprovalProofContext;
  onApproval: (approval: BundledApprovalRequest | null) => void;
  onDiagnostic?: (event: string, details: Record<string, string | number | boolean | null>) => void;
}

export interface BundledWindowsNodeAmbientAccess extends WindowsNodeMxcAmbientAccessAssessment {
  targets: Array<{
    category: WindowsNodeMxcAmbientAccessCategory;
    path: string;
  }>;
}

export interface BundledWindowsNodeGateway {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export class BundledWindowsNodeHost {
  private process: ChildProcessWithoutNullStreams | null = null;
  private approvalServer: net.Server | null = null;
  private pendingApproval: {
    request: BundledApprovalRequest;
    socket: net.Socket;
    timer: NodeJS.Timeout;
  } | null = null;
  private lastError: string | null = null;
  private identityNodeId: string | null = null;
  private livePolicyAuthority: WindowsNodeMxcPolicyAuthority | null = null;
  private livePolicyPath: string | null = null;
  private livePolicyBaseJson: string | null = null;
  private startOptions: StartOptions | null = null;
  private activationLeaseSecret: Buffer | null = null;
  private activationLeasePath: string | null = null;
  private gatewayGeneration: string | null = null;
  private policyFingerprint: string | null = null;
  private activationLease: BundledWindowsNodeActivationLease | null = null;
  private activationLeaseEpoch = 0;
  private activationLeaseAuthorityRevision = 0;
  private activationLeaseWriteQueue: Promise<void> = Promise.resolve();
  private hostStderrTail: string[] = [];
  private hostExit: {
    processId: number | null;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  } | null = null;
  private readonly resourceRoot = resolveBundledWindowsNodeResourceRoot();
  private readonly hostPath = path.join(
    this.resourceRoot,
    "host",
    "microclaw-windows-node-host.exe",
  );

  createApprovalProofContext(
    gatewayGeneration: string,
    nodeId: string,
    folders: BundledWindowsNodeFolder[],
    readinessTransitionId: string,
    requestedStrength: WindowsNodeMxcEffectiveStrength = "full",
    effectiveTier = "base-container",
    ambientAccess: BundledWindowsNodeAmbientAccess | null = null,
    commandConsentMode: CommandConsentMode = "ask-when-needed",
  ): BundledWindowsNodeApprovalProofContext {
    if (!gatewayGeneration.trim()) throw new Error("Gateway generation is required");
    if (!/^[a-f0-9]{64}$/i.test(nodeId)) throw new Error("Bundled Windows node ID is invalid");
    if (!isUuid(readinessTransitionId)) {
      throw new Error("Bundled Windows node readiness transition ID is invalid");
    }
    const policyJson = this.buildPolicyJson(
      folders,
      requestedStrength,
      effectiveTier,
      ambientAccess,
      commandConsentMode,
    );
    return {
      contract: BUNDLED_WINDOWS_NODE_APPROVAL_PROOF_CONTRACT,
      secretBase64: randomBytes(32).toString("base64"),
      gatewayGeneration,
      policyFingerprint: createHash("sha256").update(policyJson, "utf8").digest("hex"),
      nodeId: nodeId.toLowerCase(),
      readinessTransitionId: readinessTransitionId.toLowerCase(),
    };
  }

  async start(options: StartOptions): Promise<void> {
    if (this.process && this.process.exitCode === null) return;
    this.stop(true);
    this.startOptions = options;
    this.lastError = null;
    this.hostStderrTail = [];
    this.hostExit = null;
    assertLoopbackGateway(options.gatewayUrl);
    assertBundledArtifacts(this.hostPath);
    if (
      !this.livePolicyPath ||
      this.livePolicyAuthority?.gatewayGeneration !== options.gatewayGeneration
    ) {
      throw new Error("The live folder policy authority has not been initialized");
    }

    const stateRoot = path.join(app.getPath("userData"), "windows-node");
    const identityDirectory = path.join(stateRoot, "identity");
    const approvalsPath = path.join(stateRoot, "diagnostic-approvals.json");
    const policyPath = path.join(stateRoot, "policy.json");
    const activationLeasePath = path.join(stateRoot, "activation-lease.json");
    const scratchRoot = path.join(stateRoot, "scratch");
    await fs.promises.mkdir(stateRoot, { recursive: true });
    await fs.promises.mkdir(scratchRoot, { recursive: true });
    const policyJson = this.buildPolicyJson(
      options.folders,
      options.requestedStrength,
      options.effectiveTier,
      options.ambientAccess,
      options.commandConsentMode,
    );
    await writeTextAtomically(policyPath, policyJson);
    await fs.promises.rm(activationLeasePath, { force: true });
    const activationLeaseSecret = randomBytes(32);
    const policyFingerprint = createHash("sha256").update(policyJson, "utf8").digest("hex");
    if (
      options.approvalProof.contract !== BUNDLED_WINDOWS_NODE_APPROVAL_PROOF_CONTRACT ||
      options.approvalProof.gatewayGeneration !== options.gatewayGeneration ||
      options.approvalProof.policyFingerprint !== policyFingerprint ||
      !/^[a-f0-9]{64}$/i.test(options.approvalProof.nodeId) ||
      !isUuid(options.approvalProof.readinessTransitionId) ||
      Buffer.from(options.approvalProof.secretBase64, "base64").length !== 32
    ) {
      throw new Error("Bundled Windows node approval proof context does not match this generation");
    }
    this.activationLeaseSecret = activationLeaseSecret;
    this.activationLeasePath = activationLeasePath;
    this.gatewayGeneration = options.gatewayGeneration;
    this.policyFingerprint = policyFingerprint;
    this.activationLease = null;

    const pipeName = `microclaw-node-approval-${process.pid}-${randomBytes(12).toString("hex")}`;
    this.approvalServer = net.createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        if (this.pendingApproval) {
          socket.end('{"decision":"deny"}\n');
          return;
        }
        try {
          const request = validateApprovalRequest(JSON.parse(buffer.slice(0, newline)));
          const timer = setTimeout(() => {
            if (this.pendingApproval?.request.id === request.id) this.respond(request.id, "deny");
          }, 5 * 60_000);
          this.pendingApproval = { request, socket, timer };
          options.onApproval(request);
        } catch {
          socket.end('{"decision":"deny"}\n');
        }
      });
      socket.on("close", () => {
        if (this.pendingApproval?.socket === socket) {
          clearTimeout(this.pendingApproval.timer);
          this.pendingApproval = null;
          options.onApproval(null);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.approvalServer!.once("error", reject);
      this.approvalServer!.listen(`\\\\.\\pipe\\${pipeName}`, resolve);
    });

    const gatewayEnvironment = loadGatewayEnvironment(options.openClawStateRoot);
    const gatewayTempRoot =
      gatewayEnvironment.TEMP || gatewayEnvironment.TMP || app.getPath("temp");
    const child = spawn(this.hostPath, [], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: createBundledWindowsNodeEnvironment(
        process.env.SystemRoot,
        scratchRoot,
        process.env,
        gatewayTempRoot,
      ),
    });
    this.process = child;
    options.onDiagnostic?.("spawned", {
      processId: child.pid ?? null,
      gatewayProcessId: options.gatewayProcessId,
      gatewayGeneration: options.gatewayGeneration,
      expectedNodeIdPrefix: options.approvalProof.nodeId.slice(0, 12),
    });
    child.stdout.on("data", () => undefined);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      for (const rawLine of data.split(/\r?\n/)) {
        const line = sanitizeBundledHostDiagnostic(rawLine);
        if (!line) continue;
        const diagnostic = classifyBundledHostDiagnostic(line);
        if (diagnostic) {
          this.hostStderrTail.push(diagnostic);
          this.hostStderrTail.splice(0, Math.max(0, this.hostStderrTail.length - 12));
          options.onDiagnostic?.("stderr", {
            processId: child.pid ?? null,
            detail: diagnostic,
          });
        }
        console.warn(`[bundled-windows-node] ${line}`);
      }
    });
    child.once("error", (error) => {
      if (this.process !== child) return;
      this.lastError = `Bundled Windows node failed to start: ${sanitizeBundledHostDiagnostic(error.message)}`;
      options.onDiagnostic?.("spawn-error", {
        processId: child.pid ?? null,
        error: this.lastError,
      });
    });
    child.once("exit", (code, signal) => {
      if (this.process !== child) return;
      this.hostExit = {
        processId: child.pid ?? null,
        exitCode: code,
        signal,
      };
      this.lastError = formatBundledHostExitError(this.hostExit, this.hostStderrTail);
      options.onDiagnostic?.("exit", {
        ...this.hostExit,
        error: this.lastError,
      });
      this.process = null;
      this.stop();
    });
    endBundledWindowsNodeBootstrap(child.stdin, {
      gatewayUrl: options.gatewayUrl,
      gatewayToken: options.gatewayToken,
      gatewayProcessId: options.gatewayProcessId,
      policyPath,
      livePolicyPath: this.livePolicyPath,
      livePolicyPublicKey: this.livePolicyAuthority.publicKey,
      identityDirectory,
      approvalPipeName: pipeName,
      approvalsPath,
      activationLeasePath,
      activationLeaseSecret: activationLeaseSecret.toString("base64"),
      gatewayGeneration: options.gatewayGeneration,
      policyFingerprint,
      approvalProofSecret: options.approvalProof.secretBase64,
      nodeId: options.approvalProof.nodeId,
      readinessTransitionId: options.approvalProof.readinessTransitionId,
      uiLocale: options.uiLocale,
    });
  }

  async initializeLivePolicy(
    proof: BundledWindowsNodeApprovalProofContext,
    options: Pick<
      StartOptions,
      "folders" | "requestedStrength" | "effectiveTier" | "ambientAccess" | "commandConsentMode"
    >,
  ): Promise<Record<string, string>> {
    const policyJson = this.buildPolicyJson(
      options.folders,
      options.requestedStrength,
      options.effectiveTier,
      options.ambientAccess,
      options.commandConsentMode,
    );
    const authority = new WindowsNodeMxcPolicyAuthority(proof.gatewayGeneration);
    const issued = authority.issue(policyJson);
    if (issued.policy.policyFingerprint !== proof.policyFingerprint) {
      throw new Error("The initial live policy does not match the approval context");
    }
    const policyPath = path.join(app.getPath("userData"), "windows-node", "live-policy.json");
    await fs.promises.mkdir(path.dirname(policyPath), { recursive: true });
    await writeJsonAtomically(policyPath, issued.envelope);
    this.livePolicyAuthority = authority;
    this.livePolicyPath = policyPath;
    this.livePolicyBaseJson = policyJson;
    return {
      MICROCLAW_MXC_LIVE_POLICY_PATH: policyPath,
      MICROCLAW_MXC_LIVE_POLICY_PUBLIC_KEY: authority.publicKey,
    };
  }

  async applyLiveFolderPolicy(
    gateway: BundledWindowsNodeGateway,
    folders: BundledWindowsNodeFolder[],
    approval: LivePolicyApproval | null = null,
  ): Promise<BundledWindowsNodeApprovalProofContext> {
    return this.applyLivePolicy(
      gateway,
      { approvedRoots: this.buildApprovedRoots(folders) },
      { folders },
      approval,
    );
  }

  async applyLiveCommandConsentPolicy(
    gateway: BundledWindowsNodeGateway,
    commandConsentMode: CommandConsentMode,
  ): Promise<BundledWindowsNodeApprovalProofContext> {
    return this.applyLivePolicy(gateway, { commandConsentMode }, { commandConsentMode }, null);
  }

  async applyLiveSandboxMode(
    gateway: BundledWindowsNodeGateway,
    requestedStrength: "off" | "full",
    effectiveTier: "host" | "base-container",
  ): Promise<BundledWindowsNodeApprovalProofContext> {
    const options = this.startOptions;
    if (!options) throw new Error("A running, managed node is required to change sandbox mode");
    if ((requestedStrength === "off") !== (effectiveTier === "host"))
      throw new Error("Sandbox mode and execution tier do not match");
    return this.applyLivePolicy(
      gateway,
      {
        requestedStrength,
        effectiveTier,
        approvedRoots: requestedStrength === "off" ? [] : this.buildApprovedRoots(options.folders),
      },
      { requestedStrength, effectiveTier, ambientAccess: null },
      null,
    );
  }

  private async applyLivePolicy(
    gateway: BundledWindowsNodeGateway,
    changes: Record<string, unknown>,
    optionsChanges: Partial<
      Pick<
        StartOptions,
        "folders" | "commandConsentMode" | "requestedStrength" | "effectiveTier" | "ambientAccess"
      >
    >,
    approval: LivePolicyApproval | null,
  ): Promise<BundledWindowsNodeApprovalProofContext> {
    const expectedProcess = this.process;
    const options = this.startOptions;
    const authority = this.livePolicyAuthority;
    if (
      !expectedProcess ||
      expectedProcess.exitCode !== null ||
      !options ||
      !authority ||
      !this.livePolicyPath ||
      !this.livePolicyBaseJson ||
      authority.gatewayGeneration !== options.gatewayGeneration
    ) {
      throw new Error("A running, managed node is required to apply a live policy");
    }
    const runtimePolicy: Record<string, unknown> = JSON.parse(this.livePolicyBaseJson);
    const policyJson = JSON.stringify(
      {
        ...runtimePolicy,
        ...changes,
        livePolicyEpoch: randomUUID(),
      },
      null,
      2,
    );
    const issued = authority.issue(policyJson, approval);
    this.revokeActivationLease();
    await writeJsonAtomically(this.livePolicyPath, issued.envelope);
    let response = await gateway.request<Record<string, unknown>>("node.invoke", {
      nodeId: options.approvalProof.nodeId,
      command: "system.run.cwd-policy",
      params: { livePolicyStatus: true },
      timeoutMs: 35_000,
      idempotencyKey: randomBytes(16).toString("hex"),
    });
    for (let depth = 0; depth < 3 && response && response.revision === undefined; depth++) {
      if (response.ok === false) throw new Error("The native node rejected the live policy update");
      if (
        response.payload &&
        typeof response.payload === "object" &&
        !Array.isArray(response.payload)
      ) {
        response = response.payload as Record<string, unknown>;
      } else {
        break;
      }
    }
    if (
      this.process !== expectedProcess ||
      expectedProcess.exitCode !== null ||
      this.startOptions !== options ||
      response?.ok === false ||
      response?.revision !== issued.policy.revision ||
      response?.policyFingerprint !== issued.policy.policyFingerprint
    ) {
      throw new Error("The native node did not acknowledge the exact live policy revision");
    }
    const proof = { ...options.approvalProof, policyFingerprint: issued.policy.policyFingerprint };
    this.policyFingerprint = proof.policyFingerprint;
    this.livePolicyBaseJson = policyJson;
    this.startOptions = { ...options, ...optionsChanges, approvalProof: proof };
    this.activationLeaseAuthorityRevision++;
    return proof;
  }

  private buildApprovedRoots(folders: BundledWindowsNodeFolder[]) {
    const { inboundRoot } = resolveWindowsNodeMxcWeixinMediaRoots(app.getPath("userData"));
    return [
      ...folders.map((folder) => ({
        path: folder.path,
        access: folder.access === "rw" ? "ReadWrite" : "ReadOnly",
      })),
      { path: inboundRoot, access: "ReadOnly" },
    ];
  }

  private buildPolicyJson(
    folders: BundledWindowsNodeFolder[],
    requestedStrength: WindowsNodeMxcEffectiveStrength,
    effectiveTier: string,
    ambientAccess: BundledWindowsNodeAmbientAccess | null,
    commandConsentMode: CommandConsentMode = "ask-when-needed",
  ): string {
    if (requestedStrength !== "off" && requestedStrength !== "full") {
      throw new Error("The retired DACL containment mode cannot be activated");
    }
    if (
      (requestedStrength === "off" && effectiveTier !== "host") ||
      (requestedStrength === "full" && effectiveTier !== "base-container")
    ) {
      throw new Error("The requested sandbox mode does not match the execution tier");
    }
    if (ambientAccess !== null) {
      throw new Error("The retired DACL ambient assessment cannot be activated");
    }
    return JSON.stringify(
      {
        policySchemaVersion: 2,
        requestedStrength,
        effectiveTier,
        commandConsentMode,
        approvedRoots: requestedStrength === "off" ? [] : this.buildApprovedRoots(folders),
        networkAllowed: true,
        allowWindowsUi: true,
        clipboard: "none",
        inputInjection: false,
        strictNoHostFallback: true,
      },
      null,
      2,
    );
  }

  async validateFolderPolicy(
    folders: BundledWindowsNodeFolder[],
    openClawStateRoot?: string,
  ): Promise<void> {
    await this.validateRuntimeIntegrity();
    const policy = this.buildPolicyJson(folders, "full", "base-container", null);
    const stateRoot = path.join(app.getPath("userData"), "windows-node");
    const approvalsPath = path.join(stateRoot, "diagnostic-approvals.json");
    const gatewayStateRoot = openClawStateRoot ?? this.startOptions?.openClawStateRoot;
    const gatewayEnvironment = gatewayStateRoot ? loadGatewayEnvironment(gatewayStateRoot) : {};
    const gatewayTempRoot =
      gatewayEnvironment.TEMP || gatewayEnvironment.TMP || app.getPath("temp");
    const child = spawn(this.hostPath, ["--validate-folders", approvalsPath], {
      timeout: 30_000,
      windowsHide: true,
      env: createBundledWindowsNodeEnvironment(
        process.env.SystemRoot,
        path.join(stateRoot, "scratch"),
        process.env,
        gatewayTempRoot,
      ),
    });
    await new Promise<void>((resolve, reject) => {
      let output = "";
      let errorOutput = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        errorOutput += chunk;
      });
      child.on("error", reject);
      child.stdin.on("error", reject);
      child.on("close", (code) => {
        if (code === 0 && output.trim() === "validated") resolve();
        else reject(new Error(errorOutput.trim() || `MXC folder validation failed (exit ${code})`));
      });
      child.stdin.end(policy);
    });
  }

  async setActivationLease(
    mode: "diagnostic" | "active",
    ttlMs: number,
  ): Promise<BundledWindowsNodeActivationLease> {
    const expectedProcess = this.process;
    if (!expectedProcess || expectedProcess.exitCode !== null) {
      throw new Error("Bundled Windows node process is not running");
    }
    const secret = this.activationLeaseSecret;
    const leasePath = this.activationLeasePath;
    const gatewayGeneration = this.gatewayGeneration;
    const policyFingerprint = this.policyFingerprint;
    if (!secret || !leasePath || !gatewayGeneration || !policyFingerprint) {
      throw new Error("Bundled Windows node activation state is unavailable");
    }
    if (!Number.isFinite(ttlMs) || ttlMs < 5_000 || ttlMs > 5 * 60_000) {
      throw new Error("Activation lease lifetime must be between 5 seconds and 5 minutes");
    }
    const lease: BundledWindowsNodeActivationLease = {
      contract: BUNDLED_WINDOWS_NODE_ACTIVATION_CONTRACT,
      mode,
      gatewayGeneration,
      policyFingerprint,
      expiresAtUnixMs: Date.now() + Math.floor(ttlMs),
    };
    const signature = createHmac("sha256", secret)
      .update(
        [
          lease.contract,
          lease.mode,
          lease.gatewayGeneration,
          lease.policyFingerprint,
          String(lease.expiresAtUnixMs),
        ].join("\n"),
        "utf8",
      )
      .digest("hex");
    const epoch = this.activationLeaseEpoch;
    const assertCurrentGeneration = () => {
      if (
        epoch !== this.activationLeaseEpoch ||
        this.process !== expectedProcess ||
        expectedProcess.exitCode !== null ||
        this.activationLeasePath !== leasePath
      ) {
        throw new Error("Bundled Windows node activation generation changed before lease update");
      }
    };
    const update = this.activationLeaseWriteQueue.then(async () => {
      assertCurrentGeneration();
      await writeJsonAtomically(
        leasePath,
        { ...lease, signature },
        (source, destination) => fs.renameSync(source, destination),
        assertCurrentGeneration,
      );
      if (
        epoch !== this.activationLeaseEpoch ||
        this.process !== expectedProcess ||
        expectedProcess.exitCode !== null ||
        this.activationLeasePath !== leasePath
      ) {
        await fs.promises.rm(leasePath, { force: true });
        throw new Error("Bundled Windows node activation generation changed during lease update");
      }
      if (
        !this.activationLease ||
        this.activationLease.expiresAtUnixMs <= Date.now() ||
        this.activationLease.contract !== lease.contract ||
        this.activationLease.mode !== lease.mode ||
        this.activationLease.gatewayGeneration !== lease.gatewayGeneration ||
        this.activationLease.policyFingerprint !== lease.policyFingerprint
      ) {
        this.activationLeaseAuthorityRevision += 1;
      }
      this.activationLease = lease;
    });
    this.activationLeaseWriteQueue = update.catch(() => undefined);
    await update;
    return lease;
  }

  getActivationLeaseBindingHash(
    proofContext: BundledWindowsNodeApprovalProofContext,
  ): string | null {
    const lease = this.activationLease;
    const secret = this.activationLeaseSecret;
    if (
      !this.process ||
      this.process.exitCode !== null ||
      this.startOptions?.approvalProof !== proofContext ||
      !secret ||
      !lease ||
      lease.contract !== BUNDLED_WINDOWS_NODE_ACTIVATION_CONTRACT ||
      lease.mode !== "active" ||
      lease.expiresAtUnixMs <= Date.now() ||
      lease.gatewayGeneration !== this.gatewayGeneration ||
      lease.policyFingerprint !== this.policyFingerprint
    ) {
      return null;
    }
    // Renewals preserve authority; revocation, mode changes and host replacement do not.
    return createHmac("sha256", secret)
      .update(
        JSON.stringify({
          contract: "microclaw.weixin-activation-authority.v1",
          leaseContract: lease.contract,
          mode: lease.mode,
          gatewayGeneration: lease.gatewayGeneration,
          policyFingerprint: lease.policyFingerprint,
          readinessTransitionId: proofContext.readinessTransitionId,
          epoch: this.activationLeaseEpoch,
          revision: this.activationLeaseAuthorityRevision,
        }),
        "utf8",
      )
      .digest("hex");
  }

  revokeActivationLease(): void {
    this.activationLeaseEpoch += 1;
    this.activationLease = null;
    if (this.activationLeasePath) {
      const revocationError = revokeActivationLeaseFile(this.activationLeasePath, () => {
        const child = this.process;
        if (child?.pid && child.exitCode === null) {
          terminateBundledWindowsNodeProcessTree(child.pid);
        }
      });
      if (revocationError) {
        this.lastError =
          "Activation lease could not be deleted, so the bundled Windows node was terminated";
        console.error(`[windows-node] ${this.lastError}:`, revocationError);
      }
    }
  }

  async ensurePaired(gateway: BundledWindowsNodeGateway): Promise<void> {
    if (!this.startOptions) throw new Error("Bundled Windows node has not been started");
    let expectedProcess = this.process;
    if (!expectedProcess || expectedProcess.exitCode !== null) {
      throw new Error("Bundled Windows node process is not running");
    }
    const requireMxcSurface = this.startOptions.requestedStrength !== "off";
    const nodeId = this.ensureIdentityNodeId(requireMxcSurface);
    let approved = false;
    let lastForeignNodeCount = -1;
    const deadline = Date.now() + 5 * 60_000;
    const restartAfterApproval = async () => {
      const startOptions = this.startOptions;
      if (!startOptions || this.process !== expectedProcess) {
        throw new Error("Bundled Windows node changed before pairing approval completed");
      }
      this.stop(true);
      const restartEpoch = this.activationLeaseEpoch;
      const assertRestartCurrent = () => {
        if (
          this.activationLeaseEpoch !== restartEpoch ||
          this.process !== null ||
          this.startOptions !== null
        ) {
          throw new Error("Bundled Windows node changed while waiting for pairing reconnection");
        }
      };
      while (Date.now() < deadline) {
        assertRestartCurrent();
        try {
          const nodes = await gateway.request<unknown>("node.list", {});
          assertRestartCurrent();
          if (!inspectBundledNodeList(nodes, nodeId).node?.connected) {
            await this.start(startOptions);
            expectedProcess = this.process;
            if (!expectedProcess) {
              throw new Error("Bundled Windows node did not restart after pairing approval");
            }
            return;
          }
        } catch (error) {
          if (!isGatewayRequestTimeout(error)) throw error;
        }
        await delay(500);
      }
      throw new Error("The previous Windows node connection did not close after pairing approval");
    };

    while (Date.now() < deadline) {
      const processError = this.describePairingProcessChange(expectedProcess);
      if (processError) {
        throw new Error(processError);
      }
      try {
        if (!approved) {
          approved = await approveBundledDevicePairRequest(gateway, nodeId, restartAfterApproval);
        }
        const nodePairing = await gateway.request<unknown>("node.pair.list", {});
        const nodePairRequestId = findBundledNodePairRequest(nodePairing, nodeId);
        if (nodePairRequestId) {
          await gateway.request("node.pair.approve", { requestId: nodePairRequestId });
          approved = true;
          await restartAfterApproval();
          continue;
        }

        const nodes = await gateway.request<unknown>("node.list", {});
        const observation = inspectBundledNodeList(nodes, nodeId);
        if (observation.foreignNodeCount !== lastForeignNodeCount) {
          lastForeignNodeCount = observation.foreignNodeCount;
          this.startOptions?.onDiagnostic?.("pairing-node-list", {
            expectedNodeIdPrefix: nodeId.slice(0, 12),
            exactNodePresent: observation.node !== null,
            exactNodeConnected: observation.node?.connected ?? false,
            foreignNodeCount: observation.foreignNodeCount,
          });
        }
        const connected = observation.node;
        if (connected?.connected) {
          if (connected.displayName !== BUNDLED_WINDOWS_NODE_DISPLAY_NAME) {
            await gateway.request("node.rename", {
              nodeId,
              displayName: BUNDLED_WINDOWS_NODE_DISPLAY_NAME,
            });
          }
          this.lastError = null;
          return;
        }
      } catch (error) {
        if (!isGatewayRequestTimeout(error)) throw error;
      }
      await delay(500);
    }

    const message = approved
      ? "App-owned Windows node did not reconnect after automatic pairing or reapproval"
      : "App-owned Windows node did not remain connected with its existing pairing";
    this.lastError = message;
    if (this.process === expectedProcess) this.stop();
    throw new Error(message);
  }

  private describePairingProcessChange(
    expectedProcess: ChildProcessWithoutNullStreams,
  ): string | null {
    if (expectedProcess.exitCode !== null || expectedProcess.signalCode !== null) {
      return (
        this.lastError ??
        formatBundledHostExitError(
          {
            processId: expectedProcess.pid ?? null,
            exitCode: expectedProcess.exitCode,
            signal: expectedProcess.signalCode,
          },
          this.hostStderrTail,
        )
      );
    }
    if (this.process !== expectedProcess) {
      return "Bundled Windows node process was replaced during pairing";
    }
    return null;
  }

  ensureIdentityNodeId(_includeMxc = true): string {
    this.identityNodeId = null;
    assertBundledArtifacts(this.hostPath);
    const identityDirectory = path.join(app.getPath("userData"), "windows-node", "identity");
    const nodeId = execFileSync(this.hostPath, ["--identity", identityDirectory], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    }).trim();
    if (!/^[a-f0-9]{64}$/i.test(nodeId)) {
      throw new Error("Bundled Windows node returned an invalid identity");
    }
    this.identityNodeId = nodeId.toLowerCase();
    return this.identityNodeId;
  }

  getValidatedMxcExecutablePath(): string {
    assertBundledArtifacts(this.hostPath);
    return this.hostPath;
  }

  async validateRuntimeIntegrity(): Promise<void> {
    const architecture = getSupportedArchitecture();
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(this.resourceRoot, "RUNTIME.json"), "utf8"),
    ) as Record<string, unknown>;
    validateBundledWindowsNodeRuntimeManifest(manifest, architecture);
    if ((await sha256FileAsync(this.hostPath)) !== manifest.hostSha256)
      throw new Error("Bundled Windows node host hash mismatch");
  }

  async rememberCommand(request: {
    executable: string;
    arguments: string[];
    canonicalCwd: string;
    agent: string | null;
    sessionKey: string;
  }): Promise<void> {
    const stateDirectory = path.join(app.getPath("userData"), "windows-node", "command-consent");
    const input = JSON.stringify({
      command: [request.executable, ...request.arguments],
      ...(request.canonicalCwd === "isolated-scratch:v1" ? {} : { cwd: request.canonicalCwd }),
      agentId: request.agent,
      sessionKey: request.sessionKey,
    });
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        this.hostPath,
        ["--remember-command", stateDirectory],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 15_000,
          env: createBundledWindowsNodeEnvironment(process.env.SystemRoot, app.getPath("temp")),
        },
        (error, stdout, stderr) => {
          if (error)
            return reject(
              new Error(
                `Windows Node could not remember the command: ${stderr.trim() || error.message}`,
              ),
            );
          if (stdout.trim() !== "remembered")
            return reject(new Error("Windows Node did not confirm the allowlist entry"));
          resolve();
        },
      );
      if (!child.stdin) return reject(new Error("Windows Node consent input is unavailable"));
      child.stdin.on("error", reject);
      child.stdin.end(input + "\n");
    });
  }

  respond(requestId: string, decision: "deny" | "allow-once" | "allow-always"): void {
    const pending = this.pendingApproval;
    if (!pending) throw new Error("No bundled Windows node approval is pending");
    assertApprovalResponseMatches(pending.request.id, requestId);
    clearTimeout(pending.timer);
    pending.socket.end(`${JSON.stringify({ decision })}\n`);
    this.pendingApproval = null;
    this.startOptions?.onApproval(null);
  }

  stop(requireTreeTermination = false): void {
    const child = this.process;
    this.revokeActivationLease();
    if (this.pendingApproval) {
      clearTimeout(this.pendingApproval.timer);
      this.pendingApproval.socket.end('{"decision":"deny"}\n');
      this.pendingApproval = null;
      this.startOptions?.onApproval(null);
    }
    this.approvalServer?.close();
    this.approvalServer = null;
    this.process = null;
    this.startOptions = null;
    this.activationLeaseSecret = null;
    this.activationLeasePath = null;
    this.gatewayGeneration = null;
    this.policyFingerprint = null;
    if (child?.pid && child.exitCode === null) {
      try {
        terminateBundledWindowsNodeProcessTree(child.pid);
      } catch (error) {
        if (child.exitCode === null) this.process = child;
        this.lastError = `Could not terminate bundled Windows node process tree ${child.pid}`;
        if (requireTreeTermination) throw error;
        console.error(`[windows-node] ${this.lastError}:`, error);
      }
    }
  }

  status(): BundledWindowsNodeHostStatus {
    return {
      processRunning: this.process !== null && this.process.exitCode === null,
      processId: this.process?.pid ?? null,
      hostPath: this.hostPath,
      sdkProbePath: this.hostPath,
      runtimeVersion: "1.0.1",
      cwdPolicyContract: BUNDLED_WINDOWS_NODE_CWD_CONTRACT,
      displayName: BUNDLED_WINDOWS_NODE_DISPLAY_NAME,
      helperRevision: BUNDLED_WINDOWS_NODE_REVISION,
      pendingApproval: this.pendingApproval?.request ?? null,
      lastError: this.lastError,
      // Identity is initialized by activation/pairing, never by a display snapshot.
      nodeId: this.identityNodeId,
      gatewayGeneration: this.gatewayGeneration,
      policyFingerprint: this.policyFingerprint,
      requestedStrength: this.startOptions?.requestedStrength ?? null,
      effectiveTier: this.startOptions?.effectiveTier ?? null,
      ambientAccess: this.startOptions?.ambientAccess
        ? {
            contract: this.startOptions.ambientAccess.contract,
            hash: this.startOptions.ambientAccess.hash,
            checkedAt: this.startOptions.ambientAccess.checkedAt,
            entries: this.startOptions.ambientAccess.entries.map((entry) => ({ ...entry })),
          }
        : null,
      activationLease:
        this.activationLease && this.activationLease.expiresAtUnixMs > Date.now()
          ? { ...this.activationLease }
          : null,
    };
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function endBundledWindowsNodeBootstrap(
  stdin: { end(chunk: string): unknown },
  bootstrap: Record<string, unknown>,
  ownerProcessId = process.pid,
): void {
  stdin.end(`${JSON.stringify({ ...bootstrap, ownerProcessId })}\n`);
}

export function terminateBundledWindowsNodeProcessTree(
  pid: number,
  run: typeof execFileSync = execFileSync,
  isAlive: (candidate: number) => boolean = isProcessAlive,
  listTree: (rootPids: readonly number[]) => number[] = listWindowsProcessTree,
): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid bundled node process ID");
  const trackedPids = new Set(listTree([pid]));
  trackedPids.add(pid);
  let terminationError: unknown = null;
  try {
    if (process.platform === "win32") {
      run("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 10_000,
        stdio: "ignore",
      });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch (error) {
    terminationError = error;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const latePid of listTree([...trackedPids])) trackedPids.add(latePid);
    const survivors = [...trackedPids].filter((trackedPid) => isAlive(trackedPid));
    if (survivors.length === 0) return;
    for (const trackedPid of survivors) {
      try {
        if (process.platform === "win32") {
          run("taskkill", ["/pid", String(trackedPid), "/T", "/F"], {
            windowsHide: true,
            timeout: 10_000,
            stdio: "ignore",
          });
        } else {
          process.kill(trackedPid, "SIGKILL");
        }
      } catch (error) {
        terminationError ??= error;
      }
    }
  }
  for (const latePid of listTree([...trackedPids])) trackedPids.add(latePid);
  const survivors = [...trackedPids].filter((trackedPid) => isAlive(trackedPid));
  if (survivors.length > 0) {
    throw new Error(
      `Bundled Windows node process tree ${pid} still has live processes: ${survivors.join(", ")}`,
      { cause: terminationError },
    );
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listWindowsProcessTree(rootPids: readonly number[]): number[] {
  if (process.platform !== "win32") return [...rootPids];
  const output = execFileSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 },
  ).trim();
  if (!output) throw new Error("Windows process inventory was empty");
  const parsed = JSON.parse(output) as
    | { ProcessId?: unknown; ParentProcessId?: unknown }
    | Array<{ ProcessId?: unknown; ParentProcessId?: unknown }>;
  const records = Array.isArray(parsed) ? parsed : [parsed];
  const children = new Map<number, number[]>();
  for (const record of records) {
    const processId = Number(record.ProcessId);
    const parentProcessId = Number(record.ParentProcessId);
    if (!Number.isSafeInteger(processId) || !Number.isSafeInteger(parentProcessId)) continue;
    const siblings = children.get(parentProcessId) ?? [];
    siblings.push(processId);
    children.set(parentProcessId, siblings);
  }
  const result: number[] = [];
  const pending = [...rootPids];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    result.push(current);
    pending.push(...(children.get(current) ?? []));
  }
  return result;
}

export function findBundledDevicePairRequest(payload: unknown, nodeId: string): string | null {
  const pending = getRecordArray(payload, "pending");
  const matches = pending.filter((entry) => {
    const deviceId = stringField(entry, "deviceId");
    const clientId = stringField(entry, "clientId");
    const role = stringField(entry, "role");
    const remoteIp = stringField(entry, "remoteIp");
    return (
      deviceId.toLowerCase() === nodeId.toLowerCase() &&
      clientId === "node-host" &&
      role === "node" &&
      (!remoteIp || isLoopbackAddress(remoteIp))
    );
  });
  if (matches.length > 1) {
    throw new Error("Multiple pairing requests claimed the app-owned Windows node identity");
  }

  const requestId = matches.length === 1 ? stringField(matches[0], "requestId") : "";
  if (matches.length === 1 && !requestId) {
    throw new Error("App-owned Windows node pairing request is missing its request ID");
  }
  return requestId || null;
}

export async function approveBundledDevicePairRequest(
  gateway: BundledWindowsNodeGateway,
  nodeId: string,
  onApproved: () => void | Promise<void>,
): Promise<boolean> {
  const pending = await gateway.request<unknown>("device.pair.list", {});
  const requestId = findBundledDevicePairRequest(pending, nodeId);
  if (!requestId) return false;
  await gateway.request("device.pair.approve", { requestId });
  await onApproved();
  return true;
}

export function findBundledNodePairRequest(payload: unknown, nodeId: string): string | null {
  const pending = getRecordArray(payload, "pending");
  const matches = pending.filter((entry) => {
    const candidateId = stringField(entry, "nodeId") || stringField(entry, "deviceId");
    const platform = stringField(entry, "platform").toLowerCase();
    const remoteIp = stringField(entry, "remoteIp");
    return (
      candidateId.toLowerCase() === nodeId.toLowerCase() &&
      (!platform || platform === "windows" || platform === "win32") &&
      (!remoteIp || isLoopbackAddress(remoteIp)) &&
      hasExpectedBundledCommands(stringArrayField(entry, "commands"))
    );
  });
  if (matches.length > 1) {
    throw new Error(
      "Multiple node reapproval requests claimed the app-owned Windows node identity",
    );
  }
  const requestId = matches.length === 1 ? stringField(matches[0], "requestId") : "";
  if (matches.length === 1 && !requestId) {
    throw new Error("App-owned Windows node reapproval request is missing its request ID");
  }
  return requestId || null;
}

export function assertApprovalResponseMatches(pendingRequestId: string, responseRequestId: string) {
  if (!pendingRequestId || pendingRequestId !== responseRequestId) {
    throw new Error("Bundled Windows node approval response does not match the pending request");
  }
}

export function inspectBundledNodeList(
  payload: unknown,
  nodeId: string,
): {
  node: { connected: boolean; displayName: string; commands: string[] } | null;
  foreignNodeCount: number;
} {
  const nodes = Array.isArray(payload)
    ? records(payload)
    : getRecordArray(payload, "nodes", "paired");
  const matches = nodes.filter((node) => {
    const id = stringField(node, "nodeId") || stringField(node, "id");
    return id.toLowerCase() === nodeId.toLowerCase();
  });
  if (matches.length > 1) {
    throw new Error("Multiple Gateway node records claimed the app-owned Windows node identity");
  }
  const foreignNodeCount = nodes.filter((node) => {
    const id = stringField(node, "nodeId") || stringField(node, "id");
    return id.length > 0 && id.toLowerCase() !== nodeId.toLowerCase();
  }).length;
  const match = matches[0];
  if (!match) return { node: null, foreignNodeCount };
  const node = {
    connected:
      match.connected === true ||
      match.isConnected === true ||
      stringField(match, "status").toLowerCase() === "connected",
    displayName: stringField(match, "displayName") || stringField(match, "name"),
    commands: stringArrayField(match, "commands"),
  };
  if (node.connected && !hasExpectedBundledCommands(node.commands)) {
    throw new Error("Connected app-owned Windows node declared an unexpected command surface");
  }
  return { node, foreignNodeCount };
}

export function sanitizeBundledHostDiagnostic(value: string): string {
  let sanitized = value
    .trim()
    .replace(/([A-Za-z0-9_-]*(?:token|secret|proof)[A-Za-z0-9_-]*\s*[=:]\s*)\S+/gi, "$1[redacted]")
    .replace(/[A-Za-z0-9+/=_-]{80,}/g, "[redacted]");
  const userProfile = process.env.USERPROFILE?.trim();
  if (userProfile) {
    sanitized = sanitized.replaceAll(userProfile, "<home>");
  }
  return sanitized.slice(0, 1_000);
}

export function classifyBundledHostDiagnostic(value: string): string | null {
  const connectionFailure = /^node-connection-failure:\s*([A-Za-z]+)$/i.exec(value);
  if (connectionFailure) return `node-connection-failure: ${connectionFailure[1]}`;
  if (
    value === "node-device-token-recovery: cleared the exact bundled node token and reconnecting"
  ) {
    return value;
  }
  const policyFailure = /^([a-z][a-z0-9-]+):/i.exec(value);
  if (policyFailure) return `host-policy-failure: ${policyFailure[1].toLowerCase()}`;
  const unhandled = /^host-unhandled:\s*([A-Za-z0-9_.]+)/i.exec(value);
  if (unhandled) return `host-unhandled: ${unhandled[1]}`;
  return null;
}

function formatBundledHostExitError(
  exit: { processId: number | null; exitCode: number | null; signal: NodeJS.Signals | null },
  stderrTail: readonly string[],
): string {
  const outcome =
    exit.exitCode !== null
      ? `code ${exit.exitCode}`
      : exit.signal
        ? `signal ${exit.signal}`
        : "an unknown status";
  const detail = stderrTail.at(-1);
  return `Bundled Windows node process ${exit.processId ?? "unknown"} exited with ${outcome}${
    detail ? `: ${detail}` : ""
  }`;
}

function getRecordArray(payload: unknown, ...keys: string[]): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(record[key])) return records(record[key] as unknown[]);
  }
  return [];
}

function records(values: unknown[]): Record<string, unknown>[] {
  return values.filter(
    (value): value is Record<string, unknown> =>
      value !== null && typeof value === "object" && !Array.isArray(value),
  );
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
    : [];
}

function hasExpectedBundledCommands(commands: string[]): boolean {
  const expected = new Set<string>(WINDOWS_NODE_MXC_NODE_COMMANDS);
  const actual = new Set(commands);
  return (
    actual.size === commands.length &&
    actual.size === expected.size &&
    commands.every((command) => expected.has(command))
  );
}

function isLoopbackAddress(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isGatewayRequestTimeout(error: unknown): boolean {
  return error instanceof Error && /^request '.+' timed out after \d+ms$/.test(error.message);
}

export function resolveBundledWindowsNodeResourceRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "windows-node")
    : path.join(__dirname, "..", "resources", "windows-node");
}

export function assertLoopbackGateway(gatewayUrl: string): void {
  const url = new URL(gatewayUrl);
  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    !["127.0.0.1", "::1", "[::1]", "localhost"].includes(url.hostname.toLowerCase())
  ) {
    throw new Error("Bundled Windows node only accepts a loopback WebSocket Gateway");
  }
}

export function validateBundledWindowsNodeRuntimeManifest(
  manifest: Record<string, unknown>,
  architecture: "x64" | "arm64",
): void {
  if (
    manifest.architecture !== architecture ||
    manifest.runtimeIdentifier !== `win-${architecture}` ||
    manifest.mxcVersion !== "1.0.1" ||
    manifest.mxcManagedSha256 !== MXC_SDK_MANAGED_SHA256 ||
    JSON.stringify(manifest.mxcNativeSha256) !==
      JSON.stringify(MXC_SDK_NATIVE_SHA256[architecture]) ||
    manifest.windowsNodeRevision !== BUNDLED_WINDOWS_NODE_REVISION ||
    manifest.contract !== BUNDLED_WINDOWS_NODE_RUNTIME_CONTRACT ||
    typeof manifest.hostSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.hostSha256)
  ) {
    throw new Error("Bundled Windows node runtime manifest does not match this application");
  }
}

function assertBundledArtifacts(hostPath: string): void {
  if (!fs.existsSync(hostPath))
    throw new Error(`Bundled Windows node host is missing: ${hostPath}`);
  const architecture = getSupportedArchitecture();
  const resourceRoot = path.dirname(path.dirname(hostPath));
  const manifest = JSON.parse(
    fs.readFileSync(path.join(resourceRoot, "RUNTIME.json"), "utf8"),
  ) as Record<string, unknown>;
  validateBundledWindowsNodeRuntimeManifest(manifest, architecture);
  const hostHash = sha256File(hostPath);
  if (manifest.hostSha256 !== hostHash)
    throw new Error(`Bundled Windows node host hash mismatch: ${hostHash}`);
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function sha256FileAsync(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function getSupportedArchitecture(): "x64" | "arm64" {
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`Bundled Windows node does not support architecture ${process.arch}`);
  }
  return process.arch;
}

async function writeJsonAtomically(
  filePath: string,
  value: unknown,
  rename?: (source: string, destination: string) => Promise<void> | void,
  beforeReplaceAttempt?: () => void,
): Promise<void> {
  await writeTextAtomically(filePath, JSON.stringify(value, null, 2), rename, beforeReplaceAttempt);
}

async function writeTextAtomically(
  filePath: string,
  contents: string,
  rename?: (source: string, destination: string) => Promise<void> | void,
  beforeReplaceAttempt?: () => void,
): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.promises.writeFile(temporary, contents, {
      encoding: "utf8",
      mode: 0o600,
    });
    await replaceFileWithRetry(
      temporary,
      filePath,
      rename ?? fs.promises.rename,
      delay,
      beforeReplaceAttempt,
    );
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

export async function replaceFileWithRetry(
  source: string,
  destination: string,
  rename: (source: string, destination: string) => Promise<void> | void = fs.promises.rename,
  wait: (milliseconds: number) => Promise<void> = delay,
  beforeAttempt: () => void = () => undefined,
): Promise<void> {
  const attempts = 5;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      beforeAttempt();
      await rename(source, destination);
      return;
    } catch (error) {
      if (attempt === attempts || !isTransientWindowsReplaceError(error)) throw error;
      await wait(attempt * 20);
    }
  }
}

export function revokeActivationLeaseFile(
  leasePath: string,
  terminateHost: () => void,
  remove: (leasePath: string) => void = (target) => fs.rmSync(target, { force: true }),
): Error | null {
  try {
    remove(leasePath);
    return null;
  } catch (error) {
    terminateHost();
    return error instanceof Error ? error : new Error(String(error));
  }
}

function isTransientWindowsReplaceError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return ["EACCES", "EBUSY", "EPERM"].includes(String(error.code));
}

export function createBundledWindowsNodeEnvironment(
  systemRoot: string | undefined,
  scratchRoot: string,
  hostEnvironment?: NodeJS.ProcessEnv,
  gatewayTempRoot?: string,
): NodeJS.ProcessEnv {
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("A valid Windows system root is required for the bundled Windows node");
  }
  if (gatewayTempRoot !== undefined && !path.win32.isAbsolute(gatewayTempRoot)) {
    throw new Error("The Gateway temporary directory must be an absolute Windows path");
  }
  const environment: NodeJS.ProcessEnv = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATH: [
      path.win32.join(systemRoot, "System32"),
      path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    ].join(path.win32.delimiter),
    PATHEXT: ".COM;.EXE",
    TEMP: gatewayTempRoot ?? scratchRoot,
    TMP: gatewayTempRoot ?? scratchRoot,
  };
  if (hostEnvironment) {
    environment.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    for (const name of [
      "PATH",
      "PATHEXT",
      "USERPROFILE",
      "HOME",
      "HOMEDRIVE",
      "HOMEPATH",
      "APPDATA",
      "LOCALAPPDATA",
      "PROGRAMDATA",
      "ProgramFiles",
      "ProgramFiles(x86)",
      "ProgramW6432",
      "ComSpec",
      "SystemDrive",
      "USERNAME",
      "USERDOMAIN",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
    ]) {
      if (hostEnvironment[name] !== undefined) environment[name] = hostEnvironment[name];
    }
  }
  return environment;
}

export function validateApprovalRequest(value: unknown): BundledApprovalRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed bundled Windows node approval request");
  const request = value as Partial<BundledApprovalRequest>;
  if (
    typeof request.id !== "string" ||
    typeof request.executable !== "string" ||
    !Array.isArray(request.arguments) ||
    request.arguments.some((argument) => typeof argument !== "string") ||
    typeof request.canonicalCwd !== "string" ||
    !Array.isArray(request.declaredAccess) ||
    request.declaredAccess.some(
      (declaration) =>
        !declaration ||
        (declaration.access !== "ro" && declaration.access !== "rw") ||
        typeof declaration.path !== "string",
    )
  ) {
    throw new Error("Malformed bundled Windows node approval request");
  }
  const providerInitialization = Object.hasOwn(request, "providerInitialization")
    ? validateNativePowerShellFilesystemInitialization(
        request.providerInitialization,
        request.executable,
        request.arguments,
        request.declaredAccess,
      )
    : undefined;
  if (providerInitialization === null)
    throw new Error("Malformed bundled Windows node PowerShell initialization");
  return {
    id: request.id,
    executable: request.executable,
    arguments: request.arguments,
    agent: typeof request.agent === "string" ? request.agent : null,
    canonicalCwd: request.canonicalCwd,
    declaredAccess: request.declaredAccess,
    ...(providerInitialization ? { providerInitialization } : {}),
  };
}
