import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_WARMUP_SESSION_KEY } from "./constants";
import { cleanupStoppedGatewayWarmupSession } from "./warmup-session-cleanup";

const tempDirs: string[] = [];

function createSessionStore() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-warmup-cleanup-"));
  tempDirs.push(stateDir);
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  return { stateDir, sessionsDir, storePath: path.join(sessionsDir, "sessions.json") };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("cleanupStoppedGatewayWarmupSession", () => {
  it("removes only the warm-up index entry and all known artifacts", () => {
    const { stateDir, sessionsDir, storePath } = createSessionStore();
    const sessionId = "7ab8d353-6a46-4b52-9b94-a526e5539a47";
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:main": { sessionId: "main-session" },
        [AGENT_WARMUP_SESSION_KEY]: { sessionId, sessionFile: `${sessionId}.jsonl` },
      }),
    );
    const warmupArtifacts = [
      `${sessionId}.jsonl`,
      `${sessionId}.trajectory.jsonl`,
      `${sessionId}.trajectory-path.json`,
      `${sessionId}.checkpoint.123.jsonl`,
      `${sessionId}.jsonl.deleted.2026-08-03T00-00-00.000Z`,
    ];
    for (const fileName of [...warmupArtifacts, "main-session.jsonl"]) {
      fs.writeFileSync(path.join(sessionsDir, fileName), fileName);
    }

    const result = cleanupStoppedGatewayWarmupSession(stateDir);

    expect(result).toEqual({
      indexEntryRemoved: true,
      artifactsRemoved: [...warmupArtifacts].sort(),
    });
    expect(JSON.parse(fs.readFileSync(storePath, "utf8"))).toEqual({
      "agent:main:main": { sessionId: "main-session" },
    });
    expect(fs.existsSync(path.join(sessionsDir, "main-session.jsonl"))).toBe(true);
  });

  it("does nothing when the reserved index entry is absent", () => {
    const { stateDir, storePath } = createSessionStore();
    fs.writeFileSync(storePath, JSON.stringify({ "agent:main:main": { sessionId: "main" } }));

    expect(cleanupStoppedGatewayWarmupSession(stateDir)).toEqual({
      indexEntryRemoved: false,
      artifactsRemoved: [],
    });
  });

  it("never follows a sessionFile path outside the sessions directory", () => {
    const { stateDir, sessionsDir, storePath } = createSessionStore();
    const outsideFile = path.join(stateDir, "outside.jsonl");
    fs.writeFileSync(outsideFile, "keep");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [AGENT_WARMUP_SESSION_KEY]: {
          sessionId: "safe-id",
          sessionFile: path.join("..", "..", "..", "outside.jsonl"),
        },
      }),
    );
    fs.writeFileSync(path.join(sessionsDir, "safe-id.jsonl"), "remove");

    cleanupStoppedGatewayWarmupSession(stateDir);

    expect(fs.readFileSync(outsideFile, "utf8")).toBe("keep");
    expect(fs.existsSync(path.join(sessionsDir, "safe-id.jsonl"))).toBe(false);
  });

  it("preserves artifacts referenced by another session entry", () => {
    const { stateDir, sessionsDir, storePath } = createSessionStore();
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:main": { sessionId: "shared-id", sessionFile: "shared-id.jsonl" },
        [AGENT_WARMUP_SESSION_KEY]: {
          sessionId: "shared-id",
          sessionFile: "shared-id.jsonl",
        },
      }),
    );
    fs.writeFileSync(path.join(sessionsDir, "shared-id.jsonl"), "main transcript");
    fs.writeFileSync(path.join(sessionsDir, "shared-id.trajectory.jsonl"), "main trajectory");

    const result = cleanupStoppedGatewayWarmupSession(stateDir);

    expect(result).toEqual({ indexEntryRemoved: true, artifactsRemoved: [] });
    expect(fs.readFileSync(path.join(sessionsDir, "shared-id.jsonl"), "utf8")).toBe(
      "main transcript",
    );
    expect(fs.existsSync(path.join(sessionsDir, "shared-id.trajectory.jsonl"))).toBe(true);
  });
});
