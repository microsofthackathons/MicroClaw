import { app } from "electron";
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { WINDOWS_NODE_MXC_NODE_COMMANDS } from "./windows-node-mxc";

export const BUNDLED_WINDOWS_NODE_CWD_CONTRACT = "microclaw.windows-cwd.v1";
export const BUNDLED_WINDOWS_NODE_ACTIVATION_CONTRACT = "microclaw.windows-activation.v1";
export const BUNDLED_WINDOWS_NODE_APPROVAL_PROOF_CONTRACT = "microclaw.windows-node-approval.v1";
export const BUNDLED_WINDOWS_NODE_DISPLAY_NAME = "MicroClaw Bundled Windows Node";
export const BUNDLED_WINDOWS_NODE_REVISION = "fc9add75eda78daf548d80a55ffb64e63b159961";
export const MXC_HOST_PREP_PATCH_REVISION = "695c2b89c6142090a098ec4484f49aff8157f0b3";
const MXC_WXC_EXEC_SHA256 = {
  x64: "db0a3422be9e1b396cc1b2547c70ff16b27412438a31c10a45abf370cac86ae2",
  arm64: "e430d0e4f44f616e91db684f8d825a6dc93e06a1262b8d00bcaac7522a317aab",
} as const;
const MXC_OFFICIAL_HOST_PREP_SHA256 = {
  x64: "531fb3cdb4b0c964908fd71b71d40961417afb399cbab72f92a25e95309a6416",
  arm64: "3ef702332286a39153fc259310b5021e3de3c191751d7522684f6475f73af5ef",
} as const;

export interface BundledWindowsNodeFolder {
  path: string;
  access: "ro" | "rw";
}

export interface BundledWindowsNodeHostStatus {
  processRunning: boolean;
  processId: number | null;
  hostPath: string;
  wxcExecPath: string;
  runtimeVersion: "0.7.0";
  cwdPolicyContract: typeof BUNDLED_WINDOWS_NODE_CWD_CONTRACT;
  displayName: typeof BUNDLED_WINDOWS_NODE_DISPLAY_NAME;
  helperRevision: typeof BUNDLED_WINDOWS_NODE_REVISION;
  pendingApproval: BundledApprovalRequest | null;
  lastError: string | null;
  nodeId: string | null;
  gatewayGeneration: string | null;
  policyFingerprint: string | null;
  activationLease: BundledWindowsNodeActivationLease | null;
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
}

interface StartOptions {
  gatewayUrl: string;
  gatewayToken: string;
  gatewayProcessId: number;
  gatewayGeneration: string;
  uiLocale: string;
  openClawStateRoot: string;
  folders: BundledWindowsNodeFolder[];
  approvalProof: BundledWindowsNodeApprovalProofContext;
  onApproval: (approval: BundledApprovalRequest | null) => void;
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
  private startOptions: StartOptions | null = null;
  private activationLeaseSecret: Buffer | null = null;
  private activationLeasePath: string | null = null;
  private gatewayGeneration: string | null = null;
  private policyFingerprint: string | null = null;
  private activationLease: BundledWindowsNodeActivationLease | null = null;
  private activationLeaseEpoch = 0;
  private activationLeaseWriteQueue: Promise<void> = Promise.resolve();
  private readonly resourceRoot = resolveBundledWindowsNodeResourceRoot();
  private readonly hostPath = path.join(
    this.resourceRoot,
    "host",
    "microclaw-windows-node-host.exe",
  );
  private readonly wxcExecPath = path.join(this.resourceRoot, "mxc", "wxc-exec.exe");

  createApprovalProofContext(
    gatewayGeneration: string,
    nodeId: string,
    folders: BundledWindowsNodeFolder[],
    openClawStateRoot: string,
  ): BundledWindowsNodeApprovalProofContext {
    if (!gatewayGeneration.trim()) throw new Error("Gateway generation is required");
    if (!/^[a-f0-9]{64}$/i.test(nodeId)) throw new Error("Bundled Windows node ID is invalid");
    const policyJson = this.buildPolicyJson(folders, openClawStateRoot);
    return {
      contract: BUNDLED_WINDOWS_NODE_APPROVAL_PROOF_CONTRACT,
      secretBase64: randomBytes(32).toString("base64"),
      gatewayGeneration,
      policyFingerprint: createHash("sha256").update(policyJson, "utf8").digest("hex"),
      nodeId: nodeId.toLowerCase(),
    };
  }

  async start(options: StartOptions): Promise<void> {
    if (this.process && this.process.exitCode === null) return;
    this.stop(true);
    this.startOptions = options;
    this.lastError = null;
    assertLoopbackGateway(options.gatewayUrl);
    assertBundledArtifacts(this.hostPath, this.wxcExecPath);

    const stateRoot = path.join(app.getPath("userData"), "windows-node");
    const identityDirectory = path.join(stateRoot, "identity");
    const approvalsPath = path.join(stateRoot, "diagnostic-approvals.json");
    const policyPath = path.join(stateRoot, "policy.json");
    const activationLeasePath = path.join(stateRoot, "activation-lease.json");
    const scratchRoot = path.join(stateRoot, "scratch");
    await fs.promises.mkdir(stateRoot, { recursive: true });
    await fs.promises.mkdir(scratchRoot, { recursive: true });
    const policyJson = this.buildPolicyJson(options.folders, options.openClawStateRoot);
    await writeTextAtomically(policyPath, policyJson);
    await fs.promises.rm(activationLeasePath, { force: true });
    const activationLeaseSecret = randomBytes(32);
    const policyFingerprint = createHash("sha256").update(policyJson, "utf8").digest("hex");
    if (
      options.approvalProof.contract !== BUNDLED_WINDOWS_NODE_APPROVAL_PROOF_CONTRACT ||
      options.approvalProof.gatewayGeneration !== options.gatewayGeneration ||
      options.approvalProof.policyFingerprint !== policyFingerprint ||
      !/^[a-f0-9]{64}$/i.test(options.approvalProof.nodeId) ||
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

    const child = spawn(this.hostPath, [], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: createBundledWindowsNodeEnvironment(process.env.SystemRoot, scratchRoot),
    });
    this.process = child;
    child.stdout.on("data", () => undefined);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      const line = data.trim();
      if (line) console.warn(`[bundled-windows-node] ${line}`);
    });
    child.once("exit", (code) => {
      if (this.process !== child) return;
      if (code && code !== 0) this.lastError = `Bundled Windows node exited with code ${code}`;
      this.process = null;
      this.stop();
    });
    child.stdin.write(
      `${JSON.stringify({
        gatewayUrl: options.gatewayUrl,
        gatewayToken: options.gatewayToken,
        gatewayProcessId: options.gatewayProcessId,
        policyPath,
        identityDirectory,
        approvalPipeName: pipeName,
        approvalsPath,
        activationLeasePath,
        activationLeaseSecret: activationLeaseSecret.toString("base64"),
        gatewayGeneration: options.gatewayGeneration,
        policyFingerprint,
        approvalProofSecret: options.approvalProof.secretBase64,
        nodeId: options.approvalProof.nodeId,
        uiLocale: options.uiLocale,
      })}\n`,
    );
  }

  private buildPolicyJson(folders: BundledWindowsNodeFolder[], openClawStateRoot: string): string {
    const stateRoot = path.join(app.getPath("userData"), "windows-node");
    return JSON.stringify(
      {
        approvedRoots: folders.map((folder) => ({
          path: folder.path,
          access: folder.access === "rw" ? "ReadWrite" : "ReadOnly",
        })),
        deniedRoots: sensitiveWindowsRoots(stateRoot, openClawStateRoot),
        wxcExecPath: this.wxcExecPath,
        networkAllowed: false,
        allowWindowsUi: true,
        clipboard: "none",
        inputInjection: false,
        strictNoHostFallback: true,
      },
      null,
      2,
    );
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
      this.activationLease = lease;
    });
    this.activationLeaseWriteQueue = update.catch(() => undefined);
    await update;
    return lease;
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
    const expectedProcess = this.process;
    if (!expectedProcess || expectedProcess.exitCode !== null) {
      throw new Error("Bundled Windows node process is not running");
    }
    const nodeId = this.ensureIdentityNodeId();
    let approved = false;
    const deadline = Date.now() + 5 * 60_000;

    while (Date.now() < deadline) {
      if (this.process !== expectedProcess || expectedProcess.exitCode !== null) {
        throw new Error("Bundled Windows node generation changed during pairing");
      }
      try {
        if (!approved) {
          const pending = await gateway.request<unknown>("device.pair.list", {});
          const requestId = findBundledDevicePairRequest(pending, nodeId);
          if (requestId) {
            await gateway.request("device.pair.approve", { requestId });
            approved = true;
          }
        }
        const nodePairing = await gateway.request<unknown>("node.pair.list", {});
        const nodePairRequestId = findBundledNodePairRequest(nodePairing, nodeId);
        if (nodePairRequestId) {
          await gateway.request("node.pair.approve", { requestId: nodePairRequestId });
          approved = true;
        }

        const nodes = await gateway.request<unknown>("node.list", {});
        const connected = findBundledNode(nodes, nodeId);
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

  ensureIdentityNodeId(): string {
    assertBundledArtifacts(this.hostPath, this.wxcExecPath);
    const identityDirectory = path.join(app.getPath("userData"), "windows-node", "identity");
    const nodeId = execFileSync(this.hostPath, ["--identity", identityDirectory], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    }).trim();
    if (!/^[a-f0-9]{64}$/i.test(nodeId)) {
      throw new Error("Bundled Windows node returned an invalid identity");
    }
    return nodeId.toLowerCase();
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
      wxcExecPath: this.wxcExecPath,
      runtimeVersion: "0.7.0",
      cwdPolicyContract: BUNDLED_WINDOWS_NODE_CWD_CONTRACT,
      displayName: BUNDLED_WINDOWS_NODE_DISPLAY_NAME,
      helperRevision: BUNDLED_WINDOWS_NODE_REVISION,
      pendingApproval: this.pendingApproval?.request ?? null,
      lastError: this.lastError,
      nodeId: this.tryReadNodeId(),
      gatewayGeneration: this.gatewayGeneration,
      policyFingerprint: this.policyFingerprint,
      activationLease:
        this.activationLease && this.activationLease.expiresAtUnixMs > Date.now()
          ? { ...this.activationLease }
          : null,
    };
  }

  private tryReadNodeId(): string | null {
    try {
      return this.ensureIdentityNodeId();
    } catch {
      return null;
    }
  }
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
      hasExactBundledCommands(stringArrayField(entry, "commands"))
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

function findBundledNode(
  payload: unknown,
  nodeId: string,
): { connected: boolean; displayName: string; commands: string[] } | null {
  const nodes = Array.isArray(payload)
    ? records(payload)
    : getRecordArray(payload, "nodes", "paired");
  const match = nodes.find((node) => {
    const id = stringField(node, "nodeId") || stringField(node, "id");
    return id.toLowerCase() === nodeId.toLowerCase();
  });
  if (!match) return null;
  return {
    connected:
      match.connected === true ||
      match.isConnected === true ||
      stringField(match, "status").toLowerCase() === "connected",
    displayName: stringField(match, "displayName") || stringField(match, "name"),
    commands: stringArrayField(match, "commands"),
  };
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

function hasExactBundledCommands(commands: string[]): boolean {
  return (
    commands.length === WINDOWS_NODE_MXC_NODE_COMMANDS.length &&
    [...commands]
      .sort()
      .every((command, index) => command === [...WINDOWS_NODE_MXC_NODE_COMMANDS].sort()[index])
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

function assertBundledArtifacts(hostPath: string, wxcExecPath: string): void {
  if (!fs.existsSync(hostPath))
    throw new Error(`Bundled Windows node host is missing: ${hostPath}`);
  if (!fs.existsSync(wxcExecPath)) throw new Error(`Pinned MXC runtime is missing: ${wxcExecPath}`);
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`Bundled Windows node does not support architecture ${process.arch}`);
  }
  const resourceRoot = path.dirname(path.dirname(hostPath));
  const patchedHostPrepPath = path.join(resourceRoot, "host-prep", "microclaw-mxc-host-prep.exe");
  const officialHostPrepPath = path.join(path.dirname(wxcExecPath), "wxc-host-prep.exe");
  if (!fs.existsSync(patchedHostPrepPath)) {
    throw new Error(`MicroClaw MXC host-prep patch is missing: ${patchedHostPrepPath}`);
  }
  if (!fs.existsSync(officialHostPrepPath)) {
    throw new Error(`Official MXC host-prep runtime is missing: ${officialHostPrepPath}`);
  }
  const manifestPath = path.join(resourceRoot, "RUNTIME.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  if (
    manifest.architecture !== process.arch ||
    manifest.mxcVersion !== "0.7.0" ||
    manifest.windowsNodeRevision !== BUNDLED_WINDOWS_NODE_REVISION ||
    manifest.mxcHostPrepPatchRevision !== MXC_HOST_PREP_PATCH_REVISION ||
    manifest.microclawHostPrepOrigin !== "microclaw-built" ||
    JSON.stringify(manifest.microclawHostPrepOperations) !==
      JSON.stringify(["prepare-system-drive", "unprepare-system-drive"])
  ) {
    throw new Error("Bundled Windows node runtime manifest does not match this application");
  }
  const actualHash = createHash("sha256").update(fs.readFileSync(wxcExecPath)).digest("hex");
  if (actualHash !== MXC_WXC_EXEC_SHA256[process.arch]) {
    throw new Error(`Pinned MXC runtime hash mismatch: ${actualHash}`);
  }
  const officialHostPrepHash = createHash("sha256")
    .update(fs.readFileSync(officialHostPrepPath))
    .digest("hex");
  if (
    officialHostPrepHash !== MXC_OFFICIAL_HOST_PREP_SHA256[process.arch] ||
    manifest.officialWxcHostPrepSha256 !== officialHostPrepHash
  ) {
    throw new Error(`Official MXC host-prep hash mismatch: ${officialHostPrepHash}`);
  }
  const patchedHostPrepHash = createHash("sha256")
    .update(fs.readFileSync(patchedHostPrepPath))
    .digest("hex");
  if (
    typeof manifest.microclawHostPrepSha256 !== "string" ||
    manifest.microclawHostPrepSha256 !== patchedHostPrepHash
  ) {
    throw new Error(`MicroClaw MXC host-prep hash mismatch: ${patchedHostPrepHash}`);
  }
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
): NodeJS.ProcessEnv {
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("A valid Windows system root is required for the bundled Windows node");
  }
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATH: [
      path.win32.join(systemRoot, "System32"),
      path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    ].join(path.win32.delimiter),
    PATHEXT: ".COM;.EXE",
    TEMP: scratchRoot,
    TMP: scratchRoot,
  };
}

export function sensitiveWindowsRoots(...stateRoots: string[]): string[] {
  const home = os.homedir();
  const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  const roots = [
    path.join(home, ".ssh"),
    path.join(home, ".gnupg"),
    path.join(home, ".aws"),
    path.join(home, ".azure"),
    path.join(home, ".kube"),
    path.join(home, ".config", "gcloud"),
    path.join(appData, "openclaw"),
    path.join(appData, "Microsoft", "Credentials"),
    path.join(appData, "Mozilla", "Firefox", "Profiles"),
    path.join(appData, "Microsoft", "Windows", "PowerShell", "PSReadLine"),
    path.join(localAppData, "Google", "Chrome", "User Data"),
    path.join(localAppData, "Microsoft", "Edge", "User Data"),
    path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"),
    ...stateRoots,
  ];
  return roots.filter(
    (root, index) =>
      roots.findIndex((candidate) => candidate.toLowerCase() === root.toLowerCase()) === index,
  );
}

export function validateApprovalRequest(value: unknown): BundledApprovalRequest {
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
  return {
    id: request.id,
    executable: request.executable,
    arguments: request.arguments,
    agent: typeof request.agent === "string" ? request.agent : null,
    canonicalCwd: request.canonicalCwd,
    declaredAccess: request.declaredAccess,
  };
}
