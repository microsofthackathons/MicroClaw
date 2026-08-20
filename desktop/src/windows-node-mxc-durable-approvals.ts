import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WindowsNodeMxcGatewayApproval } from "./windows-node-mxc";

export const WINDOWS_NODE_MXC_DURABLE_APPROVALS_CONTRACT =
  "microclaw.windows-node-mxc-durable-approvals.v1";
export const WINDOWS_NODE_MXC_DURABLE_APPROVAL_SCHEMA = 1;
export const WINDOWS_NODE_MXC_APPROVAL_PLAN_CONTRACT = "microclaw.windows-node-approval-plan.v2";

export interface WindowsNodeMxcDurableApproval {
  schemaVersion: typeof WINDOWS_NODE_MXC_DURABLE_APPROVAL_SCHEMA;
  id: string;
  executablePath: string;
  executableSha256: string;
  argv: string[];
  commandText: string;
  cwdBinding: string;
  declaredAccess: Array<{ access: "ro" | "rw"; path: string }>;
  agentId: string | null;
  sessionKey: string;
  policyFingerprint: string;
  approvalPlanContract: typeof WINDOWS_NODE_MXC_APPROVAL_PLAN_CONTRACT;
  createdAt: string;
  lastUsedAt: string | null;
}

interface DurableApprovalFile {
  contract: typeof WINDOWS_NODE_MXC_DURABLE_APPROVALS_CONTRACT;
  records: WindowsNodeMxcDurableApproval[];
}

export interface WindowsNodeMxcDurableApprovalInspection {
  records: WindowsNodeMxcDurableApproval[];
  invalidRecords: number;
  warning: string | null;
}

export type WindowsNodeMxcDurableApprovalIdentity = Omit<
  WindowsNodeMxcDurableApproval,
  "schemaVersion" | "id" | "createdAt" | "lastUsedAt" | "approvalPlanContract"
>;

interface DurableApprovalStoreDependencies {
  now?: () => Date;
  createId?: () => string;
  existsFile?: (filePath: string) => boolean;
  readFile?: (filePath: string) => string;
  writeFile?: (filePath: string, contents: string) => Promise<void>;
}

export class WindowsNodeMxcDurableApprovalStore {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly existsFile: (filePath: string) => boolean;
  private readonly readFile: (filePath: string) => string;
  private readonly writeFile: (filePath: string, contents: string) => Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    dependencies: DurableApprovalStoreDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.createId = dependencies.createId ?? randomUUID;
    this.existsFile = dependencies.existsFile ?? fs.existsSync;
    this.readFile = dependencies.readFile ?? ((target) => fs.readFileSync(target, "utf8"));
    this.writeFile = dependencies.writeFile ?? writePrivateTextAtomically;
  }

  inspect(): WindowsNodeMxcDurableApprovalInspection {
    if (!this.existsFile(this.filePath)) {
      return { records: [], invalidRecords: 0, warning: null };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.readFile(this.filePath));
    } catch (error) {
      return {
        records: [],
        invalidRecords: 1,
        warning: `Durable approval storage is malformed and authorizes nothing: ${messageOf(error)}`,
      };
    }
    if (
      !isRecord(parsed) ||
      parsed.contract !== WINDOWS_NODE_MXC_DURABLE_APPROVALS_CONTRACT ||
      !Array.isArray(parsed.records)
    ) {
      return {
        records: [],
        invalidRecords: 1,
        warning: "Legacy or unsupported durable approval storage authorizes nothing",
      };
    }
    const records = parsed.records.filter(isCurrentDurableApproval);
    const invalidRecords = parsed.records.length - records.length;
    return {
      records,
      invalidRecords,
      warning:
        invalidRecords > 0
          ? `${invalidRecords} malformed or stale durable approval record(s) authorize nothing`
          : null,
    };
  }

  findExact(identity: WindowsNodeMxcDurableApprovalIdentity): WindowsNodeMxcDurableApproval | null {
    return (
      this.inspect().records.find((record) => durableApprovalMatches(record, identity)) ?? null
    );
  }

  list(): WindowsNodeMxcDurableApproval[] {
    return this.inspect().records;
  }

  async add(
    identity: WindowsNodeMxcDurableApprovalIdentity,
  ): Promise<WindowsNodeMxcDurableApproval> {
    const now = this.now().toISOString();
    const record: WindowsNodeMxcDurableApproval = {
      ...cloneIdentity(identity),
      schemaVersion: WINDOWS_NODE_MXC_DURABLE_APPROVAL_SCHEMA,
      id: this.createId(),
      approvalPlanContract: WINDOWS_NODE_MXC_APPROVAL_PLAN_CONTRACT,
      createdAt: now,
      lastUsedAt: null,
    };
    await this.enqueueWrite((records) => {
      const withoutDuplicate = records.filter((entry) => !durableApprovalMatches(entry, identity));
      return [...withoutDuplicate, record];
    });
    return record;
  }

  async touch(id: string): Promise<void> {
    const lastUsedAt = this.now().toISOString();
    await this.enqueueWrite((records) =>
      records.map((record) => (record.id === id ? { ...record, lastUsedAt } : record)),
    );
  }

  async revoke(id: string): Promise<void> {
    await this.enqueueWrite((records) => records.filter((record) => record.id !== id));
  }

  async revokeAll(): Promise<void> {
    await this.enqueueWrite(() => []);
  }

  private async enqueueWrite(
    update: (current: WindowsNodeMxcDurableApproval[]) => WindowsNodeMxcDurableApproval[],
  ): Promise<void> {
    const write = this.writeQueue.then(async () => {
      const next: DurableApprovalFile = {
        contract: WINDOWS_NODE_MXC_DURABLE_APPROVALS_CONTRACT,
        records: update(this.inspect().records),
      };
      await this.writeFile(this.filePath, JSON.stringify(next, null, 2));
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }
}

export function durableApprovalIdentityFromGateway(
  approval: WindowsNodeMxcGatewayApproval,
  policyFingerprint: string,
): WindowsNodeMxcDurableApprovalIdentity | null {
  if (
    !/^[a-f0-9]{64}$/i.test(approval.executableSha256) ||
    !/^[a-f0-9]{64}$/i.test(policyFingerprint) ||
    !path.win32.isAbsolute(approval.executablePath) ||
    !approval.sessionKey
  ) {
    return null;
  }
  return {
    executablePath: path.win32.normalize(approval.executablePath),
    executableSha256: approval.executableSha256.toLowerCase(),
    argv: [approval.executable, ...approval.arguments],
    commandText: approval.command,
    cwdBinding: approval.canonicalCwd,
    declaredAccess: approval.declaredAccess.map((entry) => ({ ...entry })),
    agentId: approval.agent,
    sessionKey: approval.sessionKey,
    policyFingerprint: policyFingerprint.toLowerCase(),
  };
}

export function durableApprovalMatches(
  record: WindowsNodeMxcDurableApproval,
  identity: WindowsNodeMxcDurableApprovalIdentity,
): boolean {
  return (
    record.schemaVersion === WINDOWS_NODE_MXC_DURABLE_APPROVAL_SCHEMA &&
    record.approvalPlanContract === WINDOWS_NODE_MXC_APPROVAL_PLAN_CONTRACT &&
    equalWindowsPath(record.executablePath, identity.executablePath) &&
    record.executableSha256 === identity.executableSha256.toLowerCase() &&
    equalStrings(record.argv, identity.argv) &&
    record.commandText === identity.commandText &&
    equalWindowsBinding(record.cwdBinding, identity.cwdBinding) &&
    equalDeclaredAccess(record.declaredAccess, identity.declaredAccess) &&
    record.agentId === identity.agentId &&
    record.sessionKey === identity.sessionKey &&
    record.policyFingerprint === identity.policyFingerprint.toLowerCase()
  );
}

export async function consumeExactDurableApproval(
  store: WindowsNodeMxcDurableApprovalStore,
  identity: WindowsNodeMxcDurableApprovalIdentity,
  expectedId: string,
  resolveOnce: () => Promise<void>,
  onUsageError: (error: unknown) => void,
): Promise<boolean> {
  const current = store.findExact(identity);
  if (!current || current.id !== expectedId) return false;
  await resolveOnce();
  try {
    await store.touch(current.id);
  } catch (error) {
    onUsageError(error);
  }
  return true;
}

async function writePrivateTextAtomically(filePath: string, contents: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.promises.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(temporary, filePath);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

function isCurrentDurableApproval(value: unknown): value is WindowsNodeMxcDurableApproval {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === WINDOWS_NODE_MXC_DURABLE_APPROVAL_SCHEMA &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.executablePath === "string" &&
    path.win32.isAbsolute(value.executablePath) &&
    typeof value.executableSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.executableSha256) &&
    isStringArray(value.argv) &&
    typeof value.commandText === "string" &&
    value.commandText.length > 0 &&
    typeof value.cwdBinding === "string" &&
    value.cwdBinding.length > 0 &&
    isDeclaredAccess(value.declaredAccess) &&
    (value.agentId === null || typeof value.agentId === "string") &&
    typeof value.sessionKey === "string" &&
    value.sessionKey.length > 0 &&
    typeof value.policyFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(value.policyFingerprint) &&
    value.approvalPlanContract === WINDOWS_NODE_MXC_APPROVAL_PLAN_CONTRACT &&
    typeof value.createdAt === "string" &&
    !Number.isNaN(Date.parse(value.createdAt)) &&
    (value.lastUsedAt === null ||
      (typeof value.lastUsedAt === "string" && !Number.isNaN(Date.parse(value.lastUsedAt))))
  );
}

function cloneIdentity(
  identity: WindowsNodeMxcDurableApprovalIdentity,
): WindowsNodeMxcDurableApprovalIdentity {
  return {
    ...identity,
    argv: [...identity.argv],
    declaredAccess: identity.declaredAccess.map((entry) => ({ ...entry })),
  };
}

function equalStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function equalWindowsPath(left: string, right: string): boolean {
  return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

function equalWindowsBinding(left: string, right: string): boolean {
  if (left === "isolated-scratch:v1" || right === "isolated-scratch:v1") return left === right;
  return equalWindowsPath(left, right);
}

function equalDeclaredAccess(
  left: Array<{ access: "ro" | "rw"; path: string }>,
  right: Array<{ access: "ro" | "rw"; path: string }>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.access === right[index]?.access && equalWindowsPath(entry.path, right[index].path),
    )
  );
}

function isDeclaredAccess(value: unknown): value is Array<{ access: "ro" | "rw"; path: string }> {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        (entry.access === "ro" || entry.access === "rw") &&
        typeof entry.path === "string" &&
        path.win32.isAbsolute(entry.path),
    )
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
