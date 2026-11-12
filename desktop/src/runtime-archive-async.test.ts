import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitRuntimeArchive,
  materializeRuntimeArchive,
  materializeRuntimeArchiveAsync,
  type RuntimeArchiveRequest,
} from "./runtime-archive";
import {
  RUNTIME_PREPARATION_TIMING_PREFIX,
  RuntimePreparationTiming,
  type RuntimePreparationTimingEvent,
} from "./runtime-preparation-timing";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-async-runtime-"));
  roots.push(root);
  const runtimeRoot = path.join(root, "runtime");
  const worker = new EventEmitter() as unknown as Worker;
  const startWorker = vi.fn<(request: RuntimeArchiveRequest) => Worker>(() => worker);
  const extract = (_archive: string, destination: string) => {
    const packageRoot = path.join(destination, "node_modules", "openclaw");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "openclaw.mjs"), "export {};");
  };
  return { runtimeRoot, worker, startWorker, extract };
}

describe("asynchronous bundled runtime preparation", () => {
  it("reports worker startup through module readiness and validates its result", async () => {
    const { runtimeRoot, worker, startWorker, extract } = fixture();
    const events: RuntimePreparationTimingEvent[] = [];
    const timing = new RuntimePreparationTiming("desktop", (message) => {
      events.push(JSON.parse(message.slice(RUNTIME_PREPARATION_TIMING_PREFIX.length)));
    });
    const preparation = materializeRuntimeArchiveAsync(
      "archive",
      runtimeRoot,
      "current",
      startWorker,
      timing,
    );
    expect(startWorker).toHaveBeenCalledWith({
      archivePath: "archive",
      runtimeRoot,
      version: "current",
      timing: true,
    });
    worker.emit("online");
    expect(
      events.some((event) => event.phase === "worker-startup" && event.status === "success"),
    ).toBe(false);
    worker.emit("message", { type: "runtime-preparation-ready" });
    worker.emit("message", { type: "runtime-preparation-timing", message: "unrelated output" });
    const workerEvent = {
      scope: "worker",
      phase: "archive-extract",
      kind: "phase",
      status: "success",
      elapsedMs: 200,
      durationMs: 90,
    };
    worker.emit("message", {
      type: "runtime-preparation-timing",
      message: RUNTIME_PREPARATION_TIMING_PREFIX + JSON.stringify(workerEvent),
    });
    materializeRuntimeArchive("archive", runtimeRoot, "current", extract);
    worker.emit("exit", 0);
    await expect(preparation).resolves.toBe(runtimeRoot);
    expect(events).toContainEqual(workerEvent);
    expect(events).toContainEqual(expect.objectContaining({ phase: "cache-check", cache: "miss" }));
    expect(events).toContainEqual(
      expect.objectContaining({ phase: "worker-startup", status: "success" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ phase: "worker-result-validation", status: "success" }),
    );
    expect(events.at(-1)).toMatchObject({
      phase: "worker-total",
      kind: "summary",
      status: "success",
    });
    events.length = 0;
    startWorker.mockClear();
    await materializeRuntimeArchiveAsync("archive", runtimeRoot, "current", startWorker, timing);
    expect(startWorker).not.toHaveBeenCalled();
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ phase: "cache-check", cache: "hit" });
  });

  it("records a worker failure once even when error is followed by exit", async () => {
    const { runtimeRoot, worker, startWorker } = fixture();
    const events: RuntimePreparationTimingEvent[] = [];
    const timing = new RuntimePreparationTiming("desktop", (message) => {
      events.push(JSON.parse(message.slice(RUNTIME_PREPARATION_TIMING_PREFIX.length)));
    });
    const preparation = materializeRuntimeArchiveAsync(
      "archive",
      runtimeRoot,
      "current",
      startWorker,
      timing,
    );
    const assertion = expect(preparation).rejects.toThrow("worker failed");
    worker.emit("error", new Error("worker failed"));
    worker.emit("exit", 1);
    await assertion;
    expect(
      events.filter((event) => event.phase === "worker-total" && event.status === "failed"),
    ).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({ phase: "worker-startup", status: "failed" }),
    );
  });

  it("records bounded publish retry waits without changing the retry policy", () => {
    let milliseconds = 0;
    const events: RuntimePreparationTimingEvent[] = [];
    const timing = new RuntimePreparationTiming(
      "worker",
      (message) => {
        events.push(JSON.parse(message.slice(RUNTIME_PREPARATION_TIMING_PREFIX.length)));
      },
      () => milliseconds,
    );
    const failure = Object.assign(new Error("locked"), { code: "EPERM" });
    const renameDirectory = vi.fn(() => {
      throw failure;
    });
    expect(() =>
      commitRuntimeArchive(
        "staging",
        "runtime",
        renameDirectory,
        (delay) => {
          milliseconds += delay;
        },
        timing,
      ),
    ).toThrow(failure);
    expect(renameDirectory).toHaveBeenCalledTimes(11);
    const waits = events.filter((event) => event.status === "success");
    expect(waits).toHaveLength(10);
    expect(waits.at(-1)).toMatchObject({
      phase: "publish-retry-wait",
      durationMs: 1000,
      attempt: 10,
      errorCode: "EPERM",
    });
    expect(waits.reduce((total, event) => total + (event.durationMs ?? 0), 0)).toBe(5500);
  });

  it.each(["EPERM", "EACCES", "EBUSY"])("retries temporary rename failures: %s", (code) => {
    const failure = Object.assign(new Error("temporarily locked"), { code });
    const renameDirectory = vi.fn().mockImplementationOnce(() => {
      throw failure;
    });
    const wait = vi.fn();
    commitRuntimeArchive("staging", "runtime", renameDirectory, wait);
    expect(renameDirectory).toHaveBeenCalledTimes(2);
    expect(renameDirectory).toHaveBeenCalledWith("staging", "runtime");
    expect(wait).toHaveBeenCalledExactlyOnceWith(100);
  });

  it("bounds rename retries and preserves the final error", () => {
    const failure = Object.assign(new Error("still locked"), { code: "EPERM" });
    const renameDirectory = vi.fn(() => {
      throw failure;
    });
    const wait = vi.fn();
    expect(() => commitRuntimeArchive("staging", "runtime", renameDirectory, wait)).toThrow(
      failure,
    );
    expect(renameDirectory).toHaveBeenCalledTimes(11);
    expect(wait).toHaveBeenCalledTimes(10);
    expect(wait.mock.calls.flat().reduce((total, milliseconds) => total + milliseconds, 0)).toBe(
      5500,
    );
  });

  it("does not retry unrelated rename failures", () => {
    const failure = Object.assign(new Error("missing directory"), { code: "ENOENT" });
    const renameDirectory = vi.fn(() => {
      throw failure;
    });
    const wait = vi.fn();
    expect(() => commitRuntimeArchive("staging", "runtime", renameDirectory, wait)).toThrow(
      failure,
    );
    expect(renameDirectory).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("reuses a current cache without starting a worker", async () => {
    const { runtimeRoot, startWorker, extract } = fixture();
    materializeRuntimeArchive("archive", runtimeRoot, "current", extract);
    await expect(
      materializeRuntimeArchiveAsync("archive", runtimeRoot, "current", startWorker),
    ).resolves.toBe(runtimeRoot);
    expect(startWorker).not.toHaveBeenCalled();
  });

  it("keeps the event loop responsive and waits for a verified worker result", async () => {
    const { runtimeRoot, worker, startWorker, extract } = fixture();
    let completed = false;
    const preparation = materializeRuntimeArchiveAsync(
      "archive",
      runtimeRoot,
      "current",
      startWorker,
    ).then((result) => {
      completed = true;
      return result;
    });
    expect(startWorker).toHaveBeenCalledWith({
      archivePath: "archive",
      runtimeRoot,
      version: "current",
    });
    await setImmediate();
    expect(completed).toBe(false);
    expect(fs.existsSync(runtimeRoot)).toBe(false);
    materializeRuntimeArchive("archive", runtimeRoot, "current", extract);
    worker.emit("exit", 0);
    await expect(preparation).resolves.toBe(runtimeRoot);
  });

  it("propagates worker errors without discarding the previous runtime", async () => {
    const { runtimeRoot, worker, startWorker, extract } = fixture();
    materializeRuntimeArchive("archive", runtimeRoot, "previous", extract);
    const preparation = materializeRuntimeArchiveAsync("archive", runtimeRoot, "next", startWorker);
    const assertion = expect(preparation).rejects.toThrow("disk full");
    worker.emit("error", new Error("disk full"));
    worker.emit("exit", 1);
    await assertion;
    expect(fs.readFileSync(path.join(runtimeRoot, ".microclaw-version"), "utf8").trim()).toBe(
      "previous",
    );
  });

  it("rejects abnormal worker exits", async () => {
    const { runtimeRoot, worker, startWorker } = fixture();
    const preparation = materializeRuntimeArchiveAsync(
      "archive",
      runtimeRoot,
      "current",
      startWorker,
    );
    const assertion = expect(preparation).rejects.toThrow("exited with code 7");
    worker.emit("exit", 7);
    await assertion;
  });

  it("rejects a clean exit with a missing or stale result", async () => {
    const { runtimeRoot, worker, startWorker, extract } = fixture();
    materializeRuntimeArchive("archive", runtimeRoot, "previous", extract);
    const preparation = materializeRuntimeArchiveAsync(
      "archive",
      runtimeRoot,
      "current",
      startWorker,
    );
    const assertion = expect(preparation).rejects.toThrow("did not produce a valid runtime");
    worker.emit("exit", 0);
    await assertion;
  });

  it("rejects worker construction failures", async () => {
    const { runtimeRoot } = fixture();
    await expect(
      materializeRuntimeArchiveAsync("archive", runtimeRoot, "current", () => {
        throw new Error("worker unavailable");
      }),
    ).rejects.toThrow("worker unavailable");
  });

  it("cleans failed staging without changing a previous cache", () => {
    const { runtimeRoot, extract } = fixture();
    materializeRuntimeArchive("archive", runtimeRoot, "previous", extract);
    expect(() =>
      materializeRuntimeArchive("archive", runtimeRoot, "current", (_archive, stagingRoot) => {
        fs.mkdirSync(stagingRoot, { recursive: true });
        fs.writeFileSync(path.join(stagingRoot, "partial"), "incomplete");
        throw new Error("disk full");
      }),
    ).toThrow("Failed to prepare");
    expect(fs.existsSync(`${runtimeRoot}.staging-${process.pid}`)).toBe(false);
    expect(fs.readFileSync(path.join(runtimeRoot, ".microclaw-version"), "utf8").trim()).toBe(
      "previous",
    );
  });
});
