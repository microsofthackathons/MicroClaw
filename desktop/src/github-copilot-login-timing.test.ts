import { afterEach, describe, expect, it, vi } from "vitest";
import { channel } from "node:diagnostics_channel";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as ts from "typescript";
import {
  GitHubCopilotLoginTiming,
  observeGitHubDeviceCodeRequests,
  type GitHubCopilotWorkerTiming,
} from "./github-copilot-auth-worker";
import {
  GitHubCopilotAuthManager,
  parseGitHubCopilotWorkerLine,
  type GitHubCopilotAuthEvent,
} from "./github-copilot-auth";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Copilot login timing", () => {
  it("measures monotonic phase durations and closes incomplete phases on failure", () => {
    let now = 100;
    const records: GitHubCopilotWorkerTiming[] = [];
    const timing = new GitHubCopilotLoginTiming(
      (record) => records.push(record),
      () => now,
    );
    const imported = timing.begin("sdk-import");
    now = 112;
    imported();
    imported();
    timing.begin("config-read");
    now = 118;
    timing.finish("error");
    expect(
      records.map(({ phase, status, durationMs, elapsedMs }) => [
        phase,
        status,
        durationMs,
        elapsedMs,
      ]),
    ).toEqual([
      ["sdk-import", "started", undefined, 0],
      ["sdk-import", "success", 12, 12],
      ["config-read", "started", undefined, 12],
      ["config-read", "error", 6, 18],
    ]);
    const broken = new GitHubCopilotLoginTiming(() => {
      throw new Error("Disk unavailable");
    });
    expect(() => broken.begin("sdk-import")()).not.toThrow();
  });

  it("observes only device-code transport, without logging request or response content", () => {
    const records: GitHubCopilotWorkerTiming[] = [];
    const timing = new GitHubCopilotLoginTiming((record) => records.push(record));
    const unsubscribe = observeGitHubDeviceCodeRequests(timing);
    const request = {
      origin: "https://github.com",
      path: "/login/device/code",
      body: "private-device-secret",
    };
    try {
      channel("undici:request:create").publish({
        request: { ...request, origin: "https://other.invalid" },
      });
      channel("undici:request:create").publish({
        request: { ...request, path: "/login/oauth/access_token" },
      });
      expect(records).toEqual([]);
      channel("undici:request:create").publish({ request });
      channel("undici:request:headers").publish({
        request,
        response: { statusCode: 200, headers: "private-header" },
      });
      channel("undici:request:trailers").publish({ request, trailers: "private-trailer" });
      channel("undici:request:error").publish({
        request,
        error: new Error("private-network-error"),
      });
      expect(records).toHaveLength(2);
      expect(records[1]).toMatchObject({
        phase: "device-code-http",
        status: "success",
        attempt: 1,
        httpStatus: 200,
      });
      expect(JSON.stringify(records)).not.toMatch(/private|github\.com|access_token/);
    } finally {
      unsubscribe();
    }
    channel("undici:request:create").publish({ request });
    expect(records).toHaveLength(2);
  });

  it("drops malformed telemetry and strips arbitrary fields before persistence", () => {
    const frame = {
      type: "timing",
      phase: "sdk-import",
      status: "success",
      elapsedMs: 42,
      durationMs: 40,
    };
    expect(
      parseGitHubCopilotWorkerLine(
        `MICROCLAW_COPILOT_AUTH:${JSON.stringify({ ...frame, token: "private", userCode: "ABCD-1234" })}`,
      ),
    ).toEqual(frame);
    for (const patch of [
      { phase: "private" },
      { status: "private" },
      { status: { toString: 1 } },
      { elapsedMs: -1 },
      { durationMs: "private" },
    ]) {
      expect(
        parseGitHubCopilotWorkerLine(
          `MICROCLAW_COPILOT_AUTH:${JSON.stringify({ ...frame, ...patch })}`,
        ),
      ).toBeUndefined();
    }
  });

  it.each(["success", "failure", "cancelled"] as const)(
    "records a standalone worker's %s lifecycle without exposing its code or token",
    async (outcome) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-copilot-timing-"));
      roots.push(root);
      const runtimeRoot = path.join(root, "runtime");
      const sdk = path.join(runtimeRoot, "dist", "plugin-sdk");
      fs.mkdirSync(sdk, { recursive: true });
      fs.writeFileSync(path.join(runtimeRoot, "package.json"), '{"type":"module"}');
      fs.writeFileSync(
        path.join(sdk, "runtime-config-snapshot.js"),
        "export const getRuntimeConfig = () => ({});",
      );
      fs.writeFileSync(
        path.join(sdk, "provider-catalog-runtime.js"),
        "export const resolvePluginProviders = () => [{ id: 'github-copilot' }];",
      );
      fs.writeFileSync(
        path.join(sdk, "provider-auth-login-flow-runtime.js"),
        `
        import { channel } from 'node:diagnostics_channel';
        export async function runModelsAuthLoginFlow(options) {
          const request = { origin: 'https://github.com', path: '/login/device/code', body: 'private-token' };
          channel('undici:request:create').publish({ request });
          channel('undici:request:headers').publish({ request, response: { statusCode: 200 } });
          channel('undici:request:trailers').publish({ request });
          await options.prompter.note('URL: https://github.com/login/device\\nCode: ABCD-1234\\nCode expires in 15 minutes.');
          if (${JSON.stringify(outcome)} === 'cancelled') {
            await new Promise((resolve, reject) => {
              if (options.signal.aborted) reject(options.signal.reason);
              else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
            });
          }
          await options.beforePersistentEffect?.();
          if (${JSON.stringify(outcome)} === 'failure') throw new Error('Synthetic persistence failure');
          return { profiles: [{ profileId: 'private-profile' }], defaultModel: 'github-copilot/test' };
        }
      `,
      );
      const workerPath = path.join(root, "worker.cjs");
      fs.writeFileSync(
        workerPath,
        ts.transpileModule(
          fs.readFileSync(path.join(__dirname, "github-copilot-auth-worker.ts"), "utf8"),
          {
            compilerOptions: {
              module: ts.ModuleKind.CommonJS,
              target: ts.ScriptTarget.ES2022,
              esModuleInterop: true,
            },
          },
        ).outputText,
      );
      const events: GitHubCopilotAuthEvent[] = [];
      const records: Array<Record<string, string | number>> = [];
      const manager = new GitHubCopilotAuthManager(
        (event) => events.push(event),
        async () => {},
        (record) => {
          records.push(record);
          if (record.phase === "config-read") throw new Error("Synthetic diagnostic write failure");
        },
      );
      const sessionId = manager.start({
        nodePath: process.execPath,
        entryPath: path.join(runtimeRoot, "openclaw.mjs"),
        workerPath,
        openClawPackageDir: runtimeRoot,
        stateDir: path.join(root, "state"),
        compileCacheDir: path.join(root, "cache"),
      });
      try {
        // These assertions verify lifecycle outcomes, not cold process startup speed.
        // Allow parallel Windows test workers enough time to start and exit.
        const workerWait = { timeout: 10_000 };
        await vi.waitFor(
          () => expect(events.some((event) => event.status === "code")).toBe(true),
          workerWait,
        );
        if (outcome === "cancelled") await manager.cancel(sessionId);
        await vi.waitFor(
          () => expect(records.some((record) => record.phase === "worker-exit")).toBe(true),
          workerWait,
        );
        expect(events.at(-1)?.status).toBe(outcome === "failure" ? "error" : outcome);
        for (const phase of [
          "worker-startup",
          "sdk-import",
          "config-read",
          "provider-prepare",
          "device-code-http",
          "device-code-delivered",
        ]) {
          expect(
            records.some((record) => record.phase === phase && record.status === "success"),
          ).toBe(true);
        }
        expect(
          records.some(
            (record) =>
              record.phase === "login-total" &&
              record.status === (outcome === "failure" ? "error" : outcome),
          ),
        ).toBe(true);
        const save = records.filter((record) => record.phase === "credential-save-and-refresh");
        if (outcome === "cancelled") expect(save).toEqual([]);
        else expect(save.at(-1)?.status).toBe(outcome === "failure" ? "error" : "success");
        expect(
          records.every(
            (record) => record.sessionId === sessionId && Number.isFinite(record.totalElapsedMs),
          ),
        ).toBe(true);
        expect(JSON.stringify(records)).not.toMatch(/ABCD-1234|private-token|private-profile/);
      } finally {
        await manager.stop();
      }
    },
    30_000,
  );
});
