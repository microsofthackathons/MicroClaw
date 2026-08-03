import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { AGENT_WARMUP_SESSION_KEY } from "./constants";

type SessionEntry = {
  sessionId?: unknown;
  sessionFile?: unknown;
};

export type WarmupSessionCleanupResult = {
  indexEntryRemoved: boolean;
  artifactsRemoved: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addArtifactBase(bases: Set<string>, value: string): void {
  if (/^[A-Za-z0-9._-]+$/.test(value)) bases.add(value);
}

function getArtifactBases(entry: SessionEntry, sessionsDir: string): Set<string> {
  const bases = new Set<string>();
  if (typeof entry.sessionId === "string") {
    addArtifactBase(bases, entry.sessionId);
  }
  if (typeof entry.sessionFile === "string") {
    const resolvedSessionFile = path.resolve(sessionsDir, entry.sessionFile);
    const relativeSessionFile = path.relative(sessionsDir, resolvedSessionFile);
    if (
      relativeSessionFile &&
      !relativeSessionFile.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeSessionFile) &&
      path.extname(relativeSessionFile) === ".jsonl"
    ) {
      addArtifactBase(bases, path.basename(relativeSessionFile, ".jsonl"));
    }
  }
  return bases;
}

/**
 * Remove the reserved warm-up session only while the Gateway is stopped.
 *
 * The running Gateway caches and serializes sessions.json itself, so callers
 * must never use this helper while a Gateway process can still access the store.
 */
export function cleanupStoppedGatewayWarmupSession(
  stateDir: string,
): WarmupSessionCleanupResult {
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  const storePath = path.join(sessionsDir, "sessions.json");
  if (!fs.existsSync(storePath)) {
    return { indexEntryRemoved: false, artifactsRemoved: [] };
  }

  const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("OpenClaw session store is not a JSON object");

  const entryValue = parsed[AGENT_WARMUP_SESSION_KEY];
  if (!isRecord(entryValue)) {
    return { indexEntryRemoved: false, artifactsRemoved: [] };
  }
  const entry = entryValue as SessionEntry;
  const artifactBases = getArtifactBases(entry, sessionsDir);
  const protectedArtifactBases = new Set<string>();
  for (const [sessionKey, sessionEntry] of Object.entries(parsed)) {
    if (sessionKey === AGENT_WARMUP_SESSION_KEY || !isRecord(sessionEntry)) continue;
    for (const base of getArtifactBases(sessionEntry as SessionEntry, sessionsDir)) {
      protectedArtifactBases.add(base);
    }
  }
  for (const protectedBase of protectedArtifactBases) {
    artifactBases.delete(protectedBase);
  }

  const updatedStore = { ...parsed };
  delete updatedStore[AGENT_WARMUP_SESSION_KEY];
  const tempPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(updatedStore, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, storePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }

  const artifactsRemoved: string[] = [];
  for (const fileName of fs.readdirSync(sessionsDir)) {
    const matchesWarmupArtifact = [...artifactBases].some(
      (base) =>
        fileName === `${base}.jsonl` ||
        fileName === `${base}.trajectory.jsonl` ||
        fileName === `${base}.trajectory-path.json` ||
        (fileName.startsWith(`${base}.checkpoint.`) && fileName.endsWith(".jsonl")) ||
        fileName.startsWith(`${base}.jsonl.deleted.`),
    );
    if (!matchesWarmupArtifact) continue;
    fs.unlinkSync(path.join(sessionsDir, fileName));
    artifactsRemoved.push(fileName);
  }

  return { indexEntryRemoved: true, artifactsRemoved: artifactsRemoved.sort() };
}
